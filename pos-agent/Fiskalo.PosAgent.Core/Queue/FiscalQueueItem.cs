namespace Fiskalo.PosAgent.Core.Queue;

public enum FiscalQueueStatus
{
    Queued,
    Submitting,
    NeedsReconciliation,
    Accepted,
    Rejected,
    Expired
}

public sealed record FiscalQueueItem
{
    public required string IdempotencyKey { get; init; }
    public required string DocumentType { get; init; }
    public required string PayloadBase64 { get; init; }
    public required string SignatureBase64 { get; init; }
    public required DateTimeOffset CreatedAtUtc { get; init; }
    public required DateTimeOffset RecoveryDeadlineUtc { get; init; }
    public required DateTimeOffset NextAttemptAtUtc { get; init; }
    public FiscalQueueStatus Status { get; init; } = FiscalQueueStatus.Queued;
    public int AttemptCount { get; init; }
    public string? LastError { get; init; }
    public string? AtkTransactionId { get; init; }
}
