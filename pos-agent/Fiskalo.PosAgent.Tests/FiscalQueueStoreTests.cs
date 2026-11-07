using System.Security.Cryptography;
using System.Text;
using Fiskalo.PosAgent.Core.Queue;
using Xunit;

namespace Fiskalo.PosAgent.Tests;

public sealed class FiscalQueueStoreTests
{
    [Fact]
    public async Task Enqueue_IsIdempotent_AndRejectsDifferentContentForSameKey()
    {
        using var fixture = new QueueFixture();
        var first = await fixture.Store.EnqueueAsync("sale-100", "Sale", "cGF5bG9hZA==", "c2ln");
        var repeated = await fixture.Store.EnqueueAsync("sale-100", "Sale", "cGF5bG9hZA==", "c2ln");

        Assert.Equal(first.CreatedAtUtc, repeated.CreatedAtUtc);
        await Assert.ThrowsAsync<InvalidOperationException>(() =>
            fixture.Store.EnqueueAsync("sale-100", "Sale", "b3RoZXI=", "c2ln"));
    }

    [Fact]
    public async Task Failure_SchedulesExponentialRetry_AndDueQueryReturnsAfterDelay()
    {
        using var fixture = new QueueFixture();
        var now = DateTimeOffset.Parse("2026-11-02T12:00:00Z");
        await fixture.Store.EnqueueAsync("sale-101", "Sale", "cGF5bG9hZA==", "c2ln", now);

        var failed = await fixture.Store.RecordFailureAsync("sale-101", "network unavailable", now);
        Assert.Equal(1, failed.AttemptCount);
        Assert.Equal(now.AddSeconds(15), failed.NextAttemptAtUtc);
        Assert.Empty(await fixture.Store.GetDueAsync(now.AddSeconds(14)));
        Assert.Single(await fixture.Store.GetDueAsync(now.AddSeconds(15)));
    }

    [Fact]
    public async Task RecoveryDeadline_DoesNotDiscardOrBlockQueuedFiscalDocuments()
    {
        using var fixture = new QueueFixture();
        var now = DateTimeOffset.Parse("2026-11-02T12:00:00Z");
        await fixture.Store.EnqueueAsync("sale-102", "Sale", "cGF5bG9hZA==", "c2ln", now);

        var due = await fixture.Store.GetDueAsync(now.AddHours(49));
        var saved = Assert.Single(await fixture.Store.GetAllAsync());
        Assert.Single(due);
        Assert.Equal(FiscalQueueStatus.Queued, saved.Status);
        Assert.Equal(now.AddHours(48), saved.RecoveryDeadlineUtc);
    }

    [Fact]
    public async Task FailedRetryAfterRecoveryDeadline_RemainsQueued()
    {
        using var fixture = new QueueFixture();
        var now = DateTimeOffset.Parse("2026-11-02T12:00:00Z");
        await fixture.Store.EnqueueAsync("sale-102b", "Sale", "cGF5bG9hZA==", "c2ln", now);

        var failed = await fixture.Store.RecordFailureAsync("sale-102b", "still offline", now.AddHours(49));
        Assert.Equal(FiscalQueueStatus.Queued, failed.Status);
        Assert.Equal(now.AddHours(49).AddSeconds(15), failed.NextAttemptAtUtc);
    }

    [Fact]
    public async Task AcceptedDocumentCannotBeChangedToRejected()
    {
        using var fixture = new QueueFixture();
        await fixture.Store.EnqueueAsync("sale-103", "Sale", "cGF5bG9hZA==", "c2ln");
        await fixture.Store.MarkSubmittingAsync("sale-103");
        var accepted = await fixture.Store.MarkAcceptedAsync("sale-103", "ATK-TX-123");

        Assert.Equal(FiscalQueueStatus.Accepted, accepted.Status);
        Assert.Equal("ATK-TX-123", accepted.AtkTransactionId);
        await Assert.ThrowsAsync<InvalidOperationException>(() =>
            fixture.Store.MarkRejectedAsync("sale-103", "late rejection"));
    }


    [Fact]
    public async Task InterruptedSubmissionRequiresReconciliationAndIsNotDueForRetry()
    {
        using var fixture = new QueueFixture();
        await fixture.Store.EnqueueAsync("sale-105", "Sale", "cGF5bG9hZA==", "c2ln");
        await fixture.Store.MarkSubmittingAsync("sale-105");

        var recovered = await fixture.Store.RecoverInterruptedSubmissionsAsync();
        var item = Assert.Single(await fixture.Store.GetAllAsync());

        Assert.Equal(1, recovered);
        Assert.Equal(FiscalQueueStatus.NeedsReconciliation, item.Status);
        Assert.Empty(await fixture.Store.GetDueAsync());
        await Assert.ThrowsAsync<InvalidOperationException>(() =>
            fixture.Store.MarkSubmittingAsync("sale-105"));
    }

    [Fact]
    public async Task UncertainSubmissionCannotBeAutomaticallyRetried()
    {
        using var fixture = new QueueFixture();
        await fixture.Store.EnqueueAsync("sale-106", "Sale", "cGF5bG9hZA==", "c2ln");
        await fixture.Store.MarkSubmittingAsync("sale-106");
        var item = await fixture.Store.MarkNeedsReconciliationAsync("sale-106", "Connection dropped after request.");

        Assert.Equal(FiscalQueueStatus.NeedsReconciliation, item.Status);
        Assert.Empty(await fixture.Store.GetDueAsync());
    }

    [Fact]
    public async Task QueueFileContainsEncryptedSnapshotNotFiscalPayload()
    {
        using var fixture = new QueueFixture();
        const string secretPayload = "eyJzZWNyZXQtZmlzY2FsLXBheWxvYWQiOiJub3QtZm9yLWxvZ3MifQ==";
        await fixture.Store.EnqueueAsync("sale-104", "Sale", secretPayload, "c2ln");

        var file = await File.ReadAllBytesAsync(fixture.Path);
        var raw = Encoding.UTF8.GetString(file);
        Assert.False(raw.Contains(secretPayload, StringComparison.Ordinal));
    }


    [Fact]
    public void CsrGenerationUsesP256AndDoesNotExportPrivateKey()
    {
        using var key = Fiskalo.PosAgent.Core.Atk.AtkPki.GenerateP256Key();
        var csr = Fiskalo.PosAgent.Core.Atk.AtkPki.CreateCsrPem(key, "Fiskalo Test Business", 123456789, 1, 1);

        Assert.StartsWith("-----BEGIN CERTIFICATE REQUEST-----", csr, StringComparison.Ordinal);
        Assert.Contains("-----END CERTIFICATE REQUEST-----", csr, StringComparison.Ordinal);
        Assert.Equal(256, key.KeySize);
    }

    [Fact]
    public void WindowsDpapiProtectsAndUnprotectsQueueData()
    {
        if (!OperatingSystem.IsWindows()) return;
        var protector = new Fiskalo.PosAgent.Core.Security.WindowsDpapiFiscalQueueProtector();
        var plaintext = Encoding.UTF8.GetBytes("private fiscal queue content");
        var protectedBytes = protector.Protect(plaintext);
        Assert.NotEqual(plaintext, protectedBytes);
        Assert.Equal(plaintext, protector.Unprotect(protectedBytes));
    }


    [Fact]
    public void WindowsDpapiInstallationStorePersistsVerifiedPosBinding()
    {
        if (!OperatingSystem.IsWindows()) return;
        var directory = Path.Combine(Path.GetTempPath(), "fiskalo-install-tests-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        var path = Path.Combine(directory, "installation.dpapi");
        try
        {
            var store = new Fiskalo.PosAgent.Core.Security.WindowsDpapiInstallationStore(path);
            var profile = new Fiskalo.PosAgent.Core.Security.AtkTestInstallationProfile(
                123456789, "Test Business", "EDI-FISCAL-TEST", 2, 7, 99,
                "ATK-VERIFY-CODE", DateTimeOffset.UtcNow, "TEST-THUMBPRINT", DateTimeOffset.UtcNow);
            store.Save(profile);
            var loaded = store.Load();

            Assert.NotNull(loaded);
            Assert.Equal(profile.Nui, loaded!.Nui);
            Assert.Equal(profile.BranchId, loaded.BranchId);
            Assert.Equal(profile.PosId, loaded.PosId);
            Assert.Equal(profile.ApplicationId, loaded.ApplicationId);
            Assert.Equal(profile.VerificationCode, loaded.VerificationCode);
            Assert.Equal(profile.CertificateThumbprint, loaded.CertificateThumbprint);
        }
        finally
        {
            if (Directory.Exists(directory)) Directory.Delete(directory, recursive: true);
        }
    }

    [Fact]
    public void WindowsDpapiKeyStoreReloadsSameP256PrivateKey()
    {
        if (!OperatingSystem.IsWindows()) return;
        var directory = Path.Combine(Path.GetTempPath(), "fiskalo-key-tests-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        var path = Path.Combine(directory, "pos-key.dpapi");
        try
        {
            var store = new Fiskalo.PosAgent.Core.Security.WindowsDpapiEcdsaKeyStore();
            byte[] signature;
            var data = Encoding.UTF8.GetBytes("ATK test signature");
            using (var first = store.LoadOrCreate(path))
                signature = first.SignData(data, HashAlgorithmName.SHA256);

            using var reloaded = store.LoadOrCreate(path);
            Assert.True(reloaded.VerifyData(data, signature, HashAlgorithmName.SHA256));
        }
        finally
        {
            if (Directory.Exists(directory)) Directory.Delete(directory, recursive: true);
        }
    }

    private sealed class QueueFixture : IDisposable
    {
        public string Path { get; } = System.IO.Path.Combine(
            System.IO.Path.GetTempPath(), "fiskalo-queue-tests-" + Guid.NewGuid().ToString("N"), "queue.bin");
        public FiscalQueueStore Store { get; } = null!;

        public QueueFixture()
        {
            Store = new FiscalQueueStore(Path, new TestProtector());
        }

        public void Dispose()
        {
            var directory = System.IO.Path.GetDirectoryName(Path);
            if (directory is not null && Directory.Exists(directory))
                Directory.Delete(directory, recursive: true);
        }
    }

    private sealed class TestProtector : IFiscalQueueProtector
    {
        private readonly byte[] _key = RandomNumberGenerator.GetBytes(32);

        public byte[] Protect(byte[] plaintext)
        {
            var nonce = RandomNumberGenerator.GetBytes(12);
            var tag = new byte[16];
            var ciphertext = new byte[plaintext.Length];
            using var aes = new AesGcm(_key, 16);
            aes.Encrypt(nonce, plaintext, ciphertext, tag);
            return [.. nonce, .. tag, .. ciphertext];
        }

        public byte[] Unprotect(byte[] protectedData)
        {
            if (protectedData.Length < 28) throw new CryptographicException("Invalid protected queue data.");
            var nonce = protectedData[..12];
            var tag = protectedData[12..28];
            var ciphertext = protectedData[28..];
            var plaintext = new byte[ciphertext.Length];
            using var aes = new AesGcm(_key, 16);
            aes.Decrypt(nonce, ciphertext, tag, plaintext);
            return plaintext;
        }
    }
}
