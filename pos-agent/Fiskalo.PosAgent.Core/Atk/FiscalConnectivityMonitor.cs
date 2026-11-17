using System.Net.Http;
using Fiskalo.PosAgent.Core.Queue;

namespace Fiskalo.PosAgent.Core.Atk;

/// <summary>
/// Tracks ATK endpoint reachability for local queue retry/escalation. A recent,
/// verified server heartbeat is used as the time anchor when device/server clocks
/// agree within two minutes. Otherwise the device clock is only an operational fallback
/// and must not be treated as statutory Article 44 outage evidence.
/// </summary>
public sealed class FiscalConnectivityMonitor
{
    private static readonly TimeSpan InitialOutageSafetyMargin = TimeSpan.FromSeconds(20);
    private readonly FiscalQueueStore _queue;
    private readonly Func<CancellationToken,Task<bool>> _probe;

    public FiscalConnectivityMonitor(FiscalQueueStore queue, Func<CancellationToken,Task<bool>> probe)
    {
        _queue = queue ?? throw new ArgumentNullException(nameof(queue));
        _probe = probe ?? throw new ArgumentNullException(nameof(probe));
    }

    public async Task<DateTimeOffset?> ProbeAsync(
        DateTimeOffset? now = null,
        CancellationToken cancellationToken = default)
    {
        var probeStartedAt = (now ?? DateTimeOffset.UtcNow).ToUniversalTime();
        var trustedServerTime = await _queue.GetLastTrustedServerTimeAsync(cancellationToken);
        var timeAnchor = trustedServerTime is { } trusted &&
            Math.Abs((probeStartedAt - trusted).TotalSeconds) <= 120
            ? trusted
            : probeStartedAt;
        try
        {
            var available = await _probe(cancellationToken);
            if (available)
            {
                await _queue.MarkConnectivityAvailableAsync(timeAnchor, cancellationToken);
                return null;
            }
        }
        catch (HttpRequestException)
        {
            // DNS, TLS or connection failure means ATK is unreachable.
        }
        catch (TaskCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            // A probe timeout is an outage signal. Application shutdown is not.
        }

        // The queue store prefers the last persisted healthy probe, including
        // across process restarts. This fallback covers a first-ever probe.
        var conservativeOutageStart = timeAnchor.Subtract(InitialOutageSafetyMargin);
        return await _queue.MarkConnectivityUnavailableAsync(conservativeOutageStart, cancellationToken);
    }
}
