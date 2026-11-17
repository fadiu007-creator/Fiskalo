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
    public string? NuiKf { get; init; }
    public string? LegacyNuiKf { get; init; }
    public string? CitizenPayloadBase64 { get; init; }
    public string? CitizenSignatureBase64 { get; init; }
    public long? DailyNumber { get; init; }
    /// <summary>The signed coupon's actual issuance time; never the start of an internet outage.</summary>
    public DateTimeOffset? OfflineIssuedAtUtc { get; init; }
    /// <summary>Local operational estimate of the connectivity outage start. Not legal proof without a trusted time anchor.</summary>
    public DateTimeOffset? OutageStartedAtUtc { get; init; }
    /// <summary>Version 2 separates coupon issue time from outage start; null marks legacy queue rows.</summary>
    public int? TimestampSemanticsVersion { get; init; }
    public string? BusinessUuid { get; init; }
    public string? PosUuid { get; init; }
    public string? BusinessDate { get; init; }
    public string? CheckoutIdempotencyKey { get; init; }
    public ulong? CouponId { get; init; }
    public ulong? BusinessNui { get; init; }
    public ulong? BranchId { get; init; }
    public ulong? PosNumber { get; init; }
    public ulong? ApplicationId { get; init; }
    public string? VerificationNo { get; init; }
    public string? QrSvgBase64 { get; init; }
    public string? CertificateThumbprint { get; init; }
    public string? CouponSnapshotSha256 { get; init; }
    public string? AtkResponseMessage { get; init; }
}
