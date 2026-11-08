using System.Net.Http;
using Fiskalo.PosAgent.Core.Queue;

namespace Fiskalo.PosAgent.Core.Atk;

/// <summary>
/// Tracks ATK reachability. The last successful probe is used as a conservative
/// lower bound for the outage start so probe latency/interval cannot extend the
/// statutory 48-hour transmission window.
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
        try
        {
            var available = await _probe(cancellationToken);
            if (available)
            {
                await _queue.MarkConnectivityAvailableAsync(probeStartedAt, cancellationToken);
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
        var conservativeOutageStart = probeStartedAt.Subtract(InitialOutageSafetyMargin);
        return await _queue.MarkConnectivityUnavailableAsync(conservativeOutageStart, cancellationToken);
    }
}
