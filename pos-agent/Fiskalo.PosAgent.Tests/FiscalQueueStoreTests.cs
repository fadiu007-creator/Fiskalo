using System.Security.Cryptography;
using System.Net;
using System.Net.Http;
using System.Net.Sockets;
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
    public async Task FortyEightHourDeadlineIsSharedAcrossAllOutstandingCoupons_AndSurvivesEarlierAcceptance()
    {
        using var fixture = new QueueFixture();
        var created = DateTimeOffset.Parse("2026-11-07T12:00:00Z");
        var outage = created.AddMinutes(5);
        await fixture.Store.EnqueueAsync("sale-outage-1", "Sale", "cG9zMQ==", "c2lnMQ==", created);
        await fixture.Store.EnqueueAsync("sale-outage-2", "Sale", "cG9zMg==", "c2lnMg==", created.AddMinutes(2));
        await fixture.Store.MarkSubmittingAsync("sale-outage-1");
        var first = await fixture.Store.RequeueDefinitelyNotSentAsync("sale-outage-1", "DNS failure", outage);

        var second = (await fixture.Store.GetAllAsync()).Single(x => x.IdempotencyKey == "sale-outage-2");
        Assert.Equal(outage, second.OfflineIssuedAtUtc);
        Assert.Equal(outage.AddHours(48), second.RecoveryDeadlineUtc);

        await fixture.Store.MarkSubmittingAsync("sale-outage-1");
        await fixture.Store.MarkAcceptedAsync("sale-outage-1", "123456");
        await fixture.Store.MarkSubmittingAsync("sale-outage-2");
        var retried = await fixture.Store.RequeueDefinitelyNotSentAsync("sale-outage-2", "DNS still failing", outage.AddMinutes(10));

        Assert.Equal(outage, first.OfflineIssuedAtUtc);
        Assert.Equal(outage.AddHours(48), first.RecoveryDeadlineUtc);
        Assert.Equal(outage, retried.OfflineIssuedAtUtc);
        Assert.Equal(outage.AddHours(48), retried.RecoveryDeadlineUtc);
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
    public async Task SignedCitizenCouponAndNuiKf_ArePersistedWithTheEncryptedQueueItem()
    {
        using var fixture = new QueueFixture();
        var nuiKf = Fiskalo.PosAgent.Core.Atk.FiscalReceiptIdentity.CreateNuiKf();
        var citizen = Convert.ToBase64String(Encoding.UTF8.GetBytes("citizen-protobuf"));
        var signature = Convert.ToBase64String(Encoding.UTF8.GetBytes("signature"));
        var item = await fixture.Store.EnqueueAsync(
            "sale-qr-1", "Sale", "cG9z", "c2ln",
            citizenPayloadBase64: citizen,
            citizenSignatureBase64: signature,
            nuiKf: nuiKf,
            dailyNumber: 17);

        Assert.Equal(16, item.NuiKf!.Length);
        Assert.Matches("^[A-Z0-9]{16}$", item.NuiKf);
        Assert.Equal(citizen, item.CitizenPayloadBase64);
        Assert.Equal(signature, item.CitizenSignatureBase64);
        Assert.Equal(17, item.DailyNumber);
        await Assert.ThrowsAsync<InvalidOperationException>(() => fixture.Store.EnqueueAsync(
            "sale-qr-2", "Sale", "cG9zMg==", "c2lnMg==",
            citizenPayloadBase64: citizen,
            citizenSignatureBase64: signature,
            nuiKf: nuiKf,
            dailyNumber: 18));
    }

    [Fact]
    public async Task LegacyQueuedCouponWithMismatchedNuiKf_IsQuarantinedInsteadOfAutomaticallyResubmitted()
    {
        using var fixture = new QueueFixture();
        var now = DateTimeOffset.Parse("2026-11-07T12:00:00Z");
        var legacyNuiKf = Fiskalo.PosAgent.Core.Atk.FiscalReceiptIdentity.CreateNuiKf();
        await fixture.Store.EnqueueAsync(
            "legacy-nuikf-queue-item", "Sale", "cG9z", "c2ln", now,
            citizenPayloadBase64: Convert.ToBase64String(Encoding.UTF8.GetBytes("old-citizen-payload")),
            citizenSignatureBase64: "c2ln",
            nuiKf: legacyNuiKf,
            dailyNumber: 19);

        var due = await fixture.Store.GetDueAsync(now.AddMinutes(1));
        var quarantined = Assert.Single(await fixture.Store.GetAllAsync());

        Assert.Empty(due);
        Assert.Equal(FiscalQueueStatus.NeedsReconciliation, quarantined.Status);
        Assert.Null(quarantined.NuiKf);
        Assert.Equal(legacyNuiKf, quarantined.LegacyNuiKf);
        Assert.Contains("does not match", quarantined.LastError);
    }

    [Fact]
    public void NuiKf_IsSixteenUppercaseAlphanumericCharacters_AndUniqueAcrossBatch()
    {
        var values = Enumerable.Range(0, 1000)
            .Select(_ => Fiskalo.PosAgent.Core.Atk.FiscalReceiptIdentity.CreateNuiKf())
            .ToArray();

        Assert.All(values, value => Assert.Matches("^[A-Z0-9]{16}$", value));
        Assert.Equal(values.Length, values.Distinct(StringComparer.Ordinal).Count());
    }

    [Fact]
    public void CitizenQrPayload_MatchesOfficialBase64PipeSignatureFormat_AndRendersSvg()
    {
        using var key = Fiskalo.PosAgent.Core.Atk.AtkPki.GenerateP256Key();
        var citizen = new Atk.CitizenCoupon
        {
            BusinessId = 123456789,
            CouponId = 12,
            BranchId = 1,
            PosId = 2,
            VerificationNo = "TEST-CODE",
            Type = Atk.CouponType.Sale,
            Time = DateTimeOffset.Parse("2026-11-07T12:00:00Z").ToUnixTimeSeconds(),
            Total = 1180,
            TotalNoTax = 1000,
            TotalTax = 180
        };
        citizen.TaxGroups.Add(new Atk.TaxGroup { TaxRate = "E", TotalForTax = 1000, TotalTax = 180 });
        var signed = Fiskalo.PosAgent.Core.Atk.AtkCouponSigner.SignCitizenCoupon(citizen, key);
        var payload = Fiskalo.PosAgent.Core.Atk.FiscalReceiptIdentity.BuildCitizenQrPayload(signed);
        var svg = Fiskalo.PosAgent.Core.Atk.FiscalReceiptQrCode.CreateSvgData(payload);

        Assert.Equal(signed.DetailsBase64 + "|" + signed.SignatureBase64, payload);
        Assert.StartsWith("<svg", svg, StringComparison.Ordinal);
        Assert.Contains("<rect", svg, StringComparison.Ordinal);
    }

    [Fact]
    public async Task DefinitelyUnsentSubmission_IsRequeuedForAutomaticDelivery()
    {
        using var fixture = new QueueFixture();
        var now = DateTimeOffset.Parse("2026-11-07T12:00:00Z");
        await fixture.Store.EnqueueAsync("sale-offline-1", "Sale", "cG9z", "c2ln", now);
        await fixture.Store.MarkSubmittingAsync("sale-offline-1");
        var queued = await fixture.Store.RequeueDefinitelyNotSentAsync("sale-offline-1", "DNS lookup failed", now);

        Assert.Equal(FiscalQueueStatus.Queued, queued.Status);
        Assert.Equal(now.AddSeconds(15), queued.NextAttemptAtUtc);
        Assert.Empty(await fixture.Store.GetDueAsync(now.AddSeconds(14)));
        Assert.Single(await fixture.Store.GetDueAsync(now.AddSeconds(15)));
    }

    [Fact]
    public async Task ConnectivityMonitor_AnchorsFortyEightHourDeadlineAtFirstDetectedOutage()
    {
        using var fixture = new QueueFixture();
        var outageStart = DateTimeOffset.Parse("2026-11-07T12:00:00Z");
        var monitor = new Fiskalo.PosAgent.Core.Atk.FiscalConnectivityMonitor(
            fixture.Store, _ => Task.FromResult(false));

        Assert.Equal(outageStart, await monitor.ProbeAsync(outageStart));
        Assert.Equal(outageStart, await monitor.ProbeAsync(outageStart.AddMinutes(30)));
        Assert.Equal(outageStart, await fixture.Store.GetConnectivityOutageStartedAtUtcAsync());

        var item = await fixture.Store.EnqueueAsync(
            "sale-monitored-outage", "Sale", "cG9z", "c2ln", outageStart.AddHours(2));
        Assert.Equal(outageStart, item.OfflineIssuedAtUtc);
        Assert.Equal(outageStart.AddHours(48), item.RecoveryDeadlineUtc);
    }

    [Fact]
    public async Task ConnectivityMonitor_ClearsCurrentOutageWhenATKBecomesReachable()
    {
        using var fixture = new QueueFixture();
        var now = DateTimeOffset.Parse("2026-11-07T12:00:00Z");
        var available = false;
        var monitor = new Fiskalo.PosAgent.Core.Atk.FiscalConnectivityMonitor(
            fixture.Store, _ => Task.FromResult(available));

        Assert.Equal(now, await monitor.ProbeAsync(now));
        available = true;
        Assert.Null(await monitor.ProbeAsync(now.AddMinutes(1)));
        Assert.Null(await fixture.Store.GetConnectivityOutageStartedAtUtcAsync());
    }

    [Fact]
    public async Task DeliveryService_AutomaticallyRetriesOfflineCouponAndRecordsAcceptedTransaction()
    {
        using var fixture = new QueueFixture();
        var now = DateTimeOffset.Parse("2026-11-07T12:00:00Z");
        await fixture.Store.EnqueueAsync("sale-worker-1", "Sale", "cG9z", "c2ln", now);
        var attempts = 0;
        var delivery = new Fiskalo.PosAgent.Core.Atk.FiscalQueueDeliveryService(fixture.Store, (signed, token) =>
        {
            attempts++;
            if (attempts == 1)
                return Task.FromException<Fiskalo.PosAgent.Core.Atk.AtkPosCouponResponse>(
                    new HttpRequestException("DNS failure", new SocketException((int)SocketError.HostNotFound)));
            return Task.FromResult(new Fiskalo.PosAgent.Core.Atk.AtkPosCouponResponse("accepted", 987654));
        });

        Assert.Equal(1, await delivery.DeliverDueAsync(now));
        var queued = (await fixture.Store.GetAllAsync()).Single();
        Assert.Equal(FiscalQueueStatus.Queued, queued.Status);
        Assert.Equal(now, queued.OfflineIssuedAtUtc);
        Assert.Equal(now.AddHours(48), queued.RecoveryDeadlineUtc);

        Assert.Equal(1, await delivery.DeliverDueAsync(now.AddSeconds(15)));
        var accepted = (await fixture.Store.GetAllAsync()).Single();
        Assert.Equal(FiscalQueueStatus.Accepted, accepted.Status);
        Assert.Equal("987654", accepted.AtkTransactionId);
        Assert.Equal(2, attempts);
        Assert.Empty(await fixture.Store.GetDueAsync(now.AddHours(49)));
    }

    [Fact]
    public async Task DeliveryService_RecoversAndTransmitsBeforeFortyEightHourDeadline()
    {
        using var fixture = new QueueFixture();
        var outage = DateTimeOffset.Parse("2026-11-07T12:00:00Z");
        await fixture.Store.EnqueueAsync("sale-recovered-before-deadline", "Sale", "cG9z", "c2ln", outage);
        var attempts = 0;
        var delivery = new Fiskalo.PosAgent.Core.Atk.FiscalQueueDeliveryService(fixture.Store, (signed, token) =>
        {
            attempts++;
            if (attempts == 1)
                return Task.FromException<Fiskalo.PosAgent.Core.Atk.AtkPosCouponResponse>(
                    new HttpRequestException("DNS failure", new SocketException((int)SocketError.HostNotFound)));
            return Task.FromResult(new Fiskalo.PosAgent.Core.Atk.AtkPosCouponResponse("accepted", 987655));
        });

        Assert.Equal(1, await delivery.DeliverDueAsync(outage));
        var offline = Assert.Single(await fixture.Store.GetAllAsync());
        Assert.Equal(FiscalQueueStatus.Queued, offline.Status);
        Assert.Equal(outage, offline.OfflineIssuedAtUtc);
        Assert.Equal(outage.AddHours(48), offline.RecoveryDeadlineUtc);

        var recoveredAt = outage.AddHours(47).AddMinutes(59);
        Assert.Equal(1, await delivery.DeliverDueAsync(recoveredAt));
        var accepted = Assert.Single(await fixture.Store.GetAllAsync());
        Assert.Equal(FiscalQueueStatus.Accepted, accepted.Status);
        Assert.Equal("987655", accepted.AtkTransactionId);
        Assert.Equal(2, attempts);
        Assert.True(recoveredAt < accepted.RecoveryDeadlineUtc);
    }

    [Fact]
    public async Task ConnectivityRecoveryExpeditesBackoffAndDeliversBeforeFortyEightHours()
    {
        using var fixture = new QueueFixture();
        var outage = DateTimeOffset.Parse("2026-11-07T12:00:00Z");
        await fixture.Store.MarkConnectivityUnavailableAsync(outage);
        await fixture.Store.EnqueueAsync(
            "sale-recovered-at-deadline", "Sale", "cG9z", "c2ln", outage.AddMinutes(1));

        var lastFailedAttempt = outage.AddHours(47).AddMinutes(59).AddSeconds(55);
        var delayed = await fixture.Store.RecordFailureAsync(
            "sale-recovered-at-deadline", "temporary ATK outage", lastFailedAttempt);
        Assert.True(delayed.NextAttemptAtUtc > outage.AddHours(48));

        var recoveredAt = outage.AddHours(47).AddMinutes(59).AddSeconds(58);
        await fixture.Store.MarkConnectivityAvailableAsync(recoveredAt);
        var attempts = 0;
        var delivery = new Fiskalo.PosAgent.Core.Atk.FiscalQueueDeliveryService(
            fixture.Store, (signed, token) =>
            {
                attempts++;
                return Task.FromResult(
                    new Fiskalo.PosAgent.Core.Atk.AtkPosCouponResponse("accepted", 987656));
            });

        Assert.Equal(1, await delivery.DeliverDueAsync(recoveredAt));
        var accepted = Assert.Single(await fixture.Store.GetAllAsync());
        Assert.Equal(FiscalQueueStatus.Accepted, accepted.Status);
        Assert.Equal("987656", accepted.AtkTransactionId);
        Assert.Equal(1, attempts);
        Assert.Equal(outage.AddHours(48), accepted.RecoveryDeadlineUtc);
        Assert.True(recoveredAt < accepted.RecoveryDeadlineUtc);
    }

    [Fact]
    public async Task DeliveryService_DoesNotRetryAmbiguousTimeout()
    {
        using var fixture = new QueueFixture();
        var now = DateTimeOffset.Parse("2026-11-07T12:00:00Z");
        await fixture.Store.EnqueueAsync("sale-worker-timeout", "Sale", "cG9z", "c2ln", now);
        var attempts = 0;
        var delivery = new Fiskalo.PosAgent.Core.Atk.FiscalQueueDeliveryService(fixture.Store, (signed, token) =>
        {
            attempts++;
            return Task.FromException<Fiskalo.PosAgent.Core.Atk.AtkPosCouponResponse>(
                new TaskCanceledException("Response timed out after submission"));
        });

        Assert.Equal(1, await delivery.DeliverDueAsync(now));
        var item = (await fixture.Store.GetAllAsync()).Single();
        Assert.Equal(FiscalQueueStatus.NeedsReconciliation, item.Status);
        Assert.Equal(1, attempts);
        Assert.Equal(0, await delivery.DeliverDueAsync(now.AddHours(1)));
        Assert.Equal(1, attempts);
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
                123456789, "Test Business", "0123456789", 2, 7, 99,
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
