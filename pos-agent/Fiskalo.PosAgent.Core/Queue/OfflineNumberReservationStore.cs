using System.Security.Cryptography;
using System.Text.Json;

namespace Fiskalo.PosAgent.Core.Queue;

public sealed record OfflineDailyNumberPool(string BusinessDate, long NextNumber, long LastNumber);
public sealed record OfflineNumberClaim(string CheckoutIdempotencyKey, ulong CouponId, long DailyNumber, string BusinessDate);
public sealed record OfflineNumberReservationState(
    string BusinessId, string PosUuid, ulong BusinessNui, ulong BranchId, ulong PosId, ulong ApplicationId,
    List<ulong> AvailableCouponIds, List<OfflineDailyNumberPool> DailyPools,
    Dictionary<string, OfflineNumberClaim> Claims);
public sealed record OfflineNumberReservationSummary(int AvailableCouponIds, IReadOnlyDictionary<string, int> AvailableDailyNumbers);

/// <summary>Encrypted, crash-safe store for server-reserved offline fiscal identities. Claimed numbers are never returned to the pool.</summary>
public sealed class OfflineNumberReservationStore
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
    private readonly string _path;
    private readonly IFiscalQueueProtector _protector;
    private readonly SemaphoreSlim _gate = new(1, 1);

    public OfflineNumberReservationStore(string path, IFiscalQueueProtector protector)
    {
        if (string.IsNullOrWhiteSpace(path)) throw new ArgumentException("Reservation path is required.", nameof(path));
        _path = Path.GetFullPath(path);
        _protector = protector ?? throw new ArgumentNullException(nameof(protector));
    }

    public async Task ImportAsync(
        string businessId, string posUuid, ulong businessNui, ulong branchId, ulong posId, ulong applicationId,
        IReadOnlyCollection<ulong> couponIds, IReadOnlyCollection<OfflineDailyNumberPool> dailyRanges,
        CancellationToken cancellationToken = default)
    {
        if (!Guid.TryParse(businessId, out _) || !Guid.TryParse(posUuid, out _))
            throw new ArgumentException("Business and POS UUIDs must be valid.");
        if (businessNui == 0 || branchId == 0 || posId == 0 || applicationId == 0)
            throw new ArgumentException("Verified ATK installation identity is required.");
        if (couponIds.Count is < 1 or > 500 || couponIds.Any(x => x == 0) || couponIds.Distinct().Count() != couponIds.Count)
            throw new ArgumentException("Coupon reservation must contain 1 to 500 unique positive IDs.");
        if (dailyRanges.Count is < 1 or > 8 || dailyRanges.Any(p =>
            !DateOnly.TryParseExact(p.BusinessDate, "yyyy-MM-dd", out _) || p.NextNumber <= 0 ||
            p.LastNumber < p.NextNumber || p.LastNumber - p.NextNumber + 1 > 500))
            throw new ArgumentException("Daily-number reservations are invalid.");

        await _gate.WaitAsync(cancellationToken);
        try
        {
            var state = await LoadAsync(cancellationToken);
            if (state is null)
                state = new OfflineNumberReservationState(businessId, posUuid, businessNui, branchId, posId, applicationId, [], [], new(StringComparer.Ordinal));
            if (state.BusinessId != businessId || state.PosUuid != posUuid || state.BusinessNui != businessNui ||
                state.BranchId != branchId || state.PosId != posId || state.ApplicationId != applicationId)
                throw new InvalidOperationException("Offline number reservations are already bound to another business or POS.");
            if (couponIds.Any(id => state.AvailableCouponIds.Contains(id) || state.Claims.Values.Any(c => c.CouponId == id)))
                throw new InvalidOperationException("A coupon ID was already provisioned or claimed on this POS.");
            foreach (var range in dailyRanges)
            {
                if (state.DailyPools.Any(p => p.BusinessDate == range.BusinessDate &&
                    range.NextNumber <= p.LastNumber && range.LastNumber >= p.NextNumber))
                    throw new InvalidOperationException("Daily-number reservation overlaps an existing local reservation.");
            }
            state.AvailableCouponIds.AddRange(couponIds);
            state.DailyPools.AddRange(dailyRanges);
            await SaveAsync(state, cancellationToken);
        }
        finally { _gate.Release(); }
    }

    public async Task<OfflineNumberClaim> ClaimAsync(
        string checkoutIdempotencyKey, string businessId, string posUuid,
        ulong businessNui, ulong branchId, ulong posId, ulong applicationId, string businessDate,
        CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(checkoutIdempotencyKey) || checkoutIdempotencyKey.Length > 128)
            throw new ArgumentException("Checkout idempotency key is required.", nameof(checkoutIdempotencyKey));
        await _gate.WaitAsync(cancellationToken);
        try
        {
            var state = await LoadAsync(cancellationToken)
                ?? throw new InvalidOperationException("No offline number reservations are installed. Connect online and prepare offline capacity first.");
            if (state.BusinessId != businessId || state.PosUuid != posUuid || state.BusinessNui != businessNui ||
                state.BranchId != branchId || state.PosId != posId || state.ApplicationId != applicationId)
                throw new InvalidOperationException("Offline reservations do not belong to the selected business and POS.");
            if (state.Claims.TryGetValue(checkoutIdempotencyKey, out var existing)) return existing;
            var localDate = TimeZoneInfo.ConvertTime(DateTimeOffset.UtcNow,
                TimeZoneInfo.FindSystemTimeZoneById("Europe/Belgrade")).ToString("yyyy-MM-dd");
            if (!string.Equals(businessDate, localDate, StringComparison.Ordinal))
                throw new InvalidOperationException("A new offline checkout must use the current Kosovo business date.");
            if (state.AvailableCouponIds.Count == 0)
                throw new InvalidOperationException("No reserved offline coupon IDs remain. Reconnect and replenish offline capacity.");
            var poolIndex = state.DailyPools.FindIndex(p => p.BusinessDate == businessDate && p.NextNumber <= p.LastNumber);
            if (poolIndex < 0)
                throw new InvalidOperationException("No daily numbers remain reserved for the Kosovo business date. Reconnect and replenish before the next day.");
            var couponId = state.AvailableCouponIds[0];
            state.AvailableCouponIds.RemoveAt(0);
            var pool = state.DailyPools[poolIndex];
            var claim = new OfflineNumberClaim(checkoutIdempotencyKey, couponId, pool.NextNumber, businessDate);
            state.DailyPools[poolIndex] = pool with { NextNumber = checked(pool.NextNumber + 1) };
            state.Claims.Add(checkoutIdempotencyKey, claim);
            await SaveAsync(state, cancellationToken);
            return claim;
        }
        finally { _gate.Release(); }
    }

    public async Task<OfflineNumberReservationSummary> GetSummaryAsync(CancellationToken cancellationToken = default)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            var state = await LoadAsync(cancellationToken);
            var daily = state?.DailyPools.GroupBy(p => p.BusinessDate, StringComparer.Ordinal)
                .ToDictionary(g => g.Key, g => g.Sum(p => (int)Math.Max(0, p.LastNumber - p.NextNumber + 1)), StringComparer.Ordinal)
                ?? new Dictionary<string, int>();
            return new OfflineNumberReservationSummary(state?.AvailableCouponIds.Count ?? 0, daily);
        }
        finally { _gate.Release(); }
    }

    private async Task<OfflineNumberReservationState?> LoadAsync(CancellationToken cancellationToken)
    {
        if (!File.Exists(_path)) return null;
        var protectedBytes = await File.ReadAllBytesAsync(_path, cancellationToken);
        byte[]? plaintext = null;
        try
        {
            plaintext = _protector.Unprotect(protectedBytes);
            return JsonSerializer.Deserialize<OfflineNumberReservationState>(plaintext, JsonOptions)
                ?? throw new CryptographicException("Offline reservation store is empty.");
        }
        finally
        {
            CryptographicOperations.ZeroMemory(protectedBytes);
            if (plaintext is not null) CryptographicOperations.ZeroMemory(plaintext);
        }
    }

    private async Task SaveAsync(OfflineNumberReservationState state, CancellationToken cancellationToken)
    {
        var directory = Path.GetDirectoryName(_path) ?? throw new InvalidOperationException("Reservation path must include a directory.");
        Directory.CreateDirectory(directory);
        var plaintext = JsonSerializer.SerializeToUtf8Bytes(state, JsonOptions);
        byte[]? protectedBytes = null;
        var temporaryPath = _path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            protectedBytes = _protector.Protect(plaintext);
            await using (var stream = new FileStream(temporaryPath, FileMode.CreateNew, FileAccess.Write,
                FileShare.None, 4096, FileOptions.Asynchronous | FileOptions.WriteThrough))
            {
                await stream.WriteAsync(protectedBytes, cancellationToken);
                await stream.FlushAsync(cancellationToken);
                stream.Flush(flushToDisk: true);
            }
            File.Move(temporaryPath, _path, overwrite: true);
        }
        finally
        {
            if (File.Exists(temporaryPath)) File.Delete(temporaryPath);
            CryptographicOperations.ZeroMemory(plaintext);
            if (protectedBytes is not null) CryptographicOperations.ZeroMemory(protectedBytes);
        }
    }
}
