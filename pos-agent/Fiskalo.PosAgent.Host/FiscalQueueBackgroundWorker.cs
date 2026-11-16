using Fiskalo.PosAgent.Core.Atk;
using Fiskalo.PosAgent.Core.Queue;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Fiskalo.PosAgent.Host;

/// <summary>
/// Keeps signed offline coupons moving when connectivity returns, even when the
/// browser tab is closed. Ambiguous ATK outcomes remain locked for reconciliation.
/// </summary>
public sealed class FiscalQueueBackgroundWorker : BackgroundService
{
    private static readonly TimeSpan PollInterval = TimeSpan.FromSeconds(30);
    private readonly FiscalQueueDeliveryService _delivery;
    private readonly ILogger<FiscalQueueBackgroundWorker> _logger;

    public FiscalQueueBackgroundWorker(
        FiscalQueueStore queue,
        ILogger<FiscalQueueBackgroundWorker> logger)
    {
        ArgumentNullException.ThrowIfNull(queue);
        _logger = logger ?? throw new ArgumentNullException(nameof(logger));
        _delivery = new FiscalQueueDeliveryService(queue, async (signed, cancellationToken) =>
        {
            using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(30) };
            return await new AtkTestClient(http).SubmitSignedPosCouponAsync(signed, cancellationToken);
        });
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!OperatingSystem.IsWindows())
        {
            _logger.LogWarning("Automatic offline fiscal delivery is disabled: Windows DPAPI POS Agent is required.");
            return;
        }

        _logger.LogInformation("Automatic ATK TEST offline fiscal queue delivery started.");
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                var processed = await _delivery.DeliverDueAsync(cancellationToken: stoppingToken);
                if (processed > 0)
                    _logger.LogInformation("Processed {Count} due offline fiscal documents.", processed);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception exception)
            {
                // A local storage/network fault must not terminate the Agent process.
                _logger.LogError(exception, "Offline fiscal delivery cycle failed; the queue remains persisted.");
            }

            try
            {
                await Task.Delay(PollInterval, stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
        }
        _logger.LogInformation("Automatic ATK TEST offline fiscal queue delivery stopped.");
    }
}
