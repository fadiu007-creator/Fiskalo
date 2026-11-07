using System.Net.Http;
using Fiskalo.PosAgent.Core.Queue;

namespace Fiskalo.PosAgent.Core.Atk;

/// <summary>
/// Continuously tracks reachability of the ATK endpoint so the statutory offline
/// recovery clock begins at the first observed interruption, not at a later sale.
/// </summary>
public sealed class FiscalConnectivityMonitor
{
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
        try
        {
            var available = await _probe(cancellationToken);
            if (available)
            {
                await _queue.MarkConnectivityAvailableAsync(cancellationToken);
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

        return await _queue.MarkConnectivityUnavailableAsync(now, cancellationToken);
    }
}
