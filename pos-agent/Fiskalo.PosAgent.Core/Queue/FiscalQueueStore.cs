using System.Security.Cryptography;
using System.Text.Json;

namespace Fiskalo.PosAgent.Core.Queue;

/// <summary>
/// Encrypted, atomic local journal for fiscal submissions. The host must supply an
/// IFiscalQueueProtector backed by an OS-protected key; plaintext queue files are never written.
/// </summary>
public sealed class FiscalQueueStore
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
    private static readonly TimeSpan RecoveryWindow = TimeSpan.FromHours(48);
    private static readonly TimeSpan MaximumRetryDelay = TimeSpan.FromMinutes(15);

    private readonly string _path;
    private readonly IFiscalQueueProtector _protector;
    private readonly SemaphoreSlim _gate = new(1, 1);

    public FiscalQueueStore(string path, IFiscalQueueProtector protector)
    {
        if (string.IsNullOrWhiteSpace(path)) throw new ArgumentException("Queue path is required.", nameof(path));
        _path = Path.GetFullPath(path);
        _protector = protector ?? throw new ArgumentNullException(nameof(protector));
    }

    public async Task<FiscalQueueItem> EnqueueAsync(
        string idempotencyKey,
        string documentType,
        string payloadBase64,
        string signatureBase64,
        DateTimeOffset? now = null,
        CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(idempotencyKey)) throw new ArgumentException("Idempotency key is required.", nameof(idempotencyKey));
        if (string.IsNullOrWhiteSpace(documentType)) throw new ArgumentException("Document type is required.", nameof(documentType));
        if (string.IsNullOrWhiteSpace(payloadBase64) || string.IsNullOrWhiteSpace(signatureBase64))
            throw new ArgumentException("Signed payload and signature are required.");

        _ = Convert.FromBase64String(payloadBase64);
        _ = Convert.FromBase64String(signatureBase64);
        var timestamp = (now ?? DateTimeOffset.UtcNow).ToUniversalTime();

        await _gate.WaitAsync(cancellationToken);
        try
        {
            var items = await LoadAsync(cancellationToken);
            var existing = items.SingleOrDefault(x => x.IdempotencyKey == idempotencyKey);
            if (existing is not null)
            {
                if (existing.PayloadBase64 != payloadBase64 ||
                    existing.SignatureBase64 != signatureBase64 ||
                    existing.DocumentType != documentType)
                    throw new InvalidOperationException("Idempotency key already exists with different fiscal content.");
                return existing;
            }

            var item = new FiscalQueueItem
            {
                IdempotencyKey = idempotencyKey,
                DocumentType = documentType,
                PayloadBase64 = payloadBase64,
                SignatureBase64 = signatureBase64,
                CreatedAtUtc = timestamp,
                RecoveryDeadlineUtc = timestamp.Add(RecoveryWindow),
                NextAttemptAtUtc = timestamp
            };
            items.Add(item);
            await SaveAsync(items, cancellationToken);
            return item;
        }
        finally { _gate.Release(); }
    }

    public async Task<IReadOnlyList<FiscalQueueItem>> GetDueAsync(
        DateTimeOffset? now = null,
        CancellationToken cancellationToken = default)
    {
        var timestamp = (now ?? DateTimeOffset.UtcNow).ToUniversalTime();
        await _gate.WaitAsync(cancellationToken);
        try
        {
            var items = await LoadAsync(cancellationToken);
            // The 48-hour recovery deadline is an operational compliance target,
            // not permission to discard or stop transmitting an unsent fiscal record.
            // Keep overdue documents encrypted and eligible for automatic delivery;
            // the host exposes RecoveryDeadlineUtc so it can raise an overdue alert.
            return items.Where(x => x.Status == FiscalQueueStatus.Queued &&
                    x.NextAttemptAtUtc <= timestamp)
                .OrderBy(x => x.CreatedAtUtc)
                .ToArray();
        }
        finally { _gate.Release(); }
    }

    public async Task<FiscalQueueItem> RecordFailureAsync(
        string idempotencyKey,
        string error,
        DateTimeOffset? now = null,
        CancellationToken cancellationToken = default)
    {
        var timestamp = (now ?? DateTimeOffset.UtcNow).ToUniversalTime();
        return await MutateAsync(idempotencyKey, item =>
        {
            EnsureQueued(item);
            var attempts = checked(item.AttemptCount + 1);
            var delaySeconds = Math.Min(15 * Math.Pow(2, Math.Min(attempts - 1, 10)), MaximumRetryDelay.TotalSeconds);
            return item with
            {
                AttemptCount = attempts,
                NextAttemptAtUtc = timestamp.AddSeconds(delaySeconds),
                LastError = Truncate(error, 500),
                // Never discard an unsent fiscal document when the recovery
                // target is missed. Keep retrying and surface the overdue deadline.
                Status = FiscalQueueStatus.Queued
            };
        }, cancellationToken);
    }

    public Task<FiscalQueueItem> MarkSubmittingAsync(
        string idempotencyKey,
        CancellationToken cancellationToken = default) =>
        MutateAsync(idempotencyKey, item =>
        {
            if (item.Status != FiscalQueueStatus.Queued)
                throw new InvalidOperationException("Only a queued document can begin submission.");
            return item with { Status = FiscalQueueStatus.Submitting, AttemptCount = checked(item.AttemptCount + 1) };
        }, cancellationToken);

    public Task<FiscalQueueItem> MarkNeedsReconciliationAsync(
        string idempotencyKey,
        string reason,
        CancellationToken cancellationToken = default) =>
        MutateAsync(idempotencyKey, item =>
        {
            if (item.Status != FiscalQueueStatus.Submitting)
                throw new InvalidOperationException("Only an in-flight document can require reconciliation.");
            return item with
            {
                Status = FiscalQueueStatus.NeedsReconciliation,
                LastError = Truncate(reason, 500)
            };
        }, cancellationToken);

    public async Task<int> RecoverInterruptedSubmissionsAsync(CancellationToken cancellationToken = default)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            var items = await LoadAsync(cancellationToken);
            var recovered = 0;
            for (var i = 0; i < items.Count; i++)
            {
                if (items[i].Status == FiscalQueueStatus.Submitting)
                {
                    items[i] = items[i] with
                    {
                        Status = FiscalQueueStatus.NeedsReconciliation,
                        LastError = "Agent restarted during submission; reconcile with ATK before retrying."
                    };
                    recovered++;
                }
            }
            if (recovered > 0) await SaveAsync(items, cancellationToken);
            return recovered;
        }
        finally { _gate.Release(); }
    }

    public Task<FiscalQueueItem> MarkAcceptedAsync(
        string idempotencyKey,
        string atkTransactionId,
        CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(atkTransactionId))
            throw new ArgumentException("ATK transaction ID is required.", nameof(atkTransactionId));

        return MutateAsync(idempotencyKey, item =>
        {
            EnsureSubmitting(item);
            return item with
            {
                Status = FiscalQueueStatus.Accepted,
                AtkTransactionId = atkTransactionId,
                LastError = null
            };
        }, cancellationToken);
    }

    public Task<FiscalQueueItem> MarkRejectedAsync(
        string idempotencyKey,
        string reason,
        CancellationToken cancellationToken = default) =>
        MutateAsync(idempotencyKey, item =>
        {
            EnsureSubmitting(item);
            return item with
            {
                Status = FiscalQueueStatus.Rejected,
                LastError = Truncate(reason, 500)
            };
        }, cancellationToken);

    public async Task<IReadOnlyList<FiscalQueueItem>> GetAllAsync(CancellationToken cancellationToken = default)
    {
        await _gate.WaitAsync(cancellationToken);
        try { return (await LoadAsync(cancellationToken)).ToArray(); }
        finally { _gate.Release(); }
    }

    /// <summary>
    /// Operator-confirmed resolution after checking the ATK test records.
    /// This method never contacts ATK and must not be called automatically.
    /// </summary>
    public Task<FiscalQueueItem> ResolveAsAcceptedAsync(
        string idempotencyKey,
        string atkTransactionId,
        CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(atkTransactionId))
            throw new ArgumentException("ATK transaction ID is required.", nameof(atkTransactionId));
        return MutateAsync(idempotencyKey, item =>
        {
            EnsureNeedsReconciliation(item);
            return item with { Status = FiscalQueueStatus.Accepted, AtkTransactionId = atkTransactionId.Trim(), LastError = null };
        }, cancellationToken);
    }

    /// <summary>
    /// Operator-confirmed resolution after ATK has definitively rejected the document.
    /// </summary>
    public Task<FiscalQueueItem> ResolveAsRejectedAsync(
        string idempotencyKey,
        string operatorNote,
        CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(operatorNote))
            throw new ArgumentException("Record the ATK rejection or operator review note.", nameof(operatorNote));
        return MutateAsync(idempotencyKey, item =>
        {
            EnsureNeedsReconciliation(item);
            return item with { Status = FiscalQueueStatus.Rejected, LastError = Truncate(operatorNote, 500) };
        }, cancellationToken);
    }

    /// <summary>
    /// Re-queues a signed document only after an operator explicitly confirms
    /// that ATK records contain no matching transaction. No automatic retry occurs.
    /// </summary>
    public Task<FiscalQueueItem> ResolveNotFoundAndRequeueAsync(
        string idempotencyKey,
        bool confirmedNoAtkRecord,
        DateTimeOffset? now = null,
        CancellationToken cancellationToken = default)
    {
        if (!confirmedNoAtkRecord)
            throw new ArgumentException("Explicit confirmation that no ATK record exists is required.", nameof(confirmedNoAtkRecord));
        var timestamp = (now ?? DateTimeOffset.UtcNow).ToUniversalTime();
        return MutateAsync(idempotencyKey, item =>
        {
            EnsureNeedsReconciliation(item);
            // Even after the target window, preserve and submit the same
            // signed record once the operator has confirmed ATK has no matching
            // transaction. Never create a replacement solely because time elapsed.
            return item with
            {
                Status = FiscalQueueStatus.Queued,
                NextAttemptAtUtc = timestamp,
                LastError = "Operator confirmed no matching ATK test transaction. Manual resubmission is now permitted."
            };
        }, cancellationToken);
    }

    private static void EnsureNeedsReconciliation(FiscalQueueItem item)
    {
        if (item.Status != FiscalQueueStatus.NeedsReconciliation)
            throw new InvalidOperationException("Only a document awaiting reconciliation can be resolved by an operator.");
    }

    private async Task<FiscalQueueItem> MutateAsync(
        string idempotencyKey,
        Func<FiscalQueueItem, FiscalQueueItem> mutation,
        CancellationToken cancellationToken)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            var items = await LoadAsync(cancellationToken);
            var index = items.FindIndex(x => x.IdempotencyKey == idempotencyKey);
            if (index < 0) throw new KeyNotFoundException("Fiscal queue item was not found.");
            var updated = mutation(items[index]);
            items[index] = updated;
            await SaveAsync(items, cancellationToken);
            return updated;
        }
        finally { _gate.Release(); }
    }

    private async Task<List<FiscalQueueItem>> LoadAsync(CancellationToken cancellationToken)
    {
        if (!File.Exists(_path)) return [];
        var encrypted = await File.ReadAllBytesAsync(_path, cancellationToken);
        byte[]? plaintext = null;
        try
        {
            plaintext = _protector.Unprotect(encrypted);
            return JsonSerializer.Deserialize<List<FiscalQueueItem>>(plaintext, JsonOptions) ?? [];
        }
        finally
        {
            CryptographicOperations.ZeroMemory(encrypted);
            if (plaintext is not null) CryptographicOperations.ZeroMemory(plaintext);
        }
    }

    private async Task SaveAsync(List<FiscalQueueItem> items, CancellationToken cancellationToken)
    {
        var directory = Path.GetDirectoryName(_path)
            ?? throw new InvalidOperationException("Queue path must include a directory.");
        Directory.CreateDirectory(directory);

        var plaintext = JsonSerializer.SerializeToUtf8Bytes(items, JsonOptions);
        byte[]? encrypted = null;
        var temporaryPath = _path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            encrypted = _protector.Protect(plaintext);
            await using (var stream = new FileStream(temporaryPath, FileMode.CreateNew, FileAccess.Write,
                FileShare.None, 4096, FileOptions.Asynchronous | FileOptions.WriteThrough))
            {
                await stream.WriteAsync(encrypted, cancellationToken);
                await stream.FlushAsync(cancellationToken);
                stream.Flush(flushToDisk: true);
            }
            File.Move(temporaryPath, _path, overwrite: true);
        }
        finally
        {
            if (File.Exists(temporaryPath)) File.Delete(temporaryPath);
            CryptographicOperations.ZeroMemory(plaintext);
            if (encrypted is not null) CryptographicOperations.ZeroMemory(encrypted);
        }
    }

    private static void EnsureQueued(FiscalQueueItem item)
    {
        if (item.Status != FiscalQueueStatus.Queued)
            throw new InvalidOperationException("Only queued fiscal documents can be rescheduled.");
    }

    private static void EnsureSubmitting(FiscalQueueItem item)
    {
        if (item.Status != FiscalQueueStatus.Submitting)
            throw new InvalidOperationException("Only an in-flight fiscal document can receive an ATK result.");
    }

    private static string Truncate(string? value, int maxLength)
    {
        if (string.IsNullOrWhiteSpace(value)) return "Unspecified submission error.";
        return value.Length <= maxLength ? value : value[..maxLength];
    }
}
