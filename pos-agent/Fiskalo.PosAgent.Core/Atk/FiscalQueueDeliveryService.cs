using System.IO;
using System.Net.Http;
using Fiskalo.PosAgent.Core.Queue;

namespace Fiskalo.PosAgent.Core.Atk;

public sealed class FiscalQueueDeliveryService
{
    private readonly FiscalQueueStore _queue;
    private readonly Func<SignedAtkCoupon,CancellationToken,Task<AtkPosCouponResponse>> _submit;

    public FiscalQueueDeliveryService(
        FiscalQueueStore queue,
        Func<SignedAtkCoupon,CancellationToken,Task<AtkPosCouponResponse>> submit)
    {
        _queue = queue ?? throw new ArgumentNullException(nameof(queue));
        _submit = submit ?? throw new ArgumentNullException(nameof(submit));
    }

    public async Task<int> DeliverDueAsync(
        DateTimeOffset? now = null,
        CancellationToken cancellationToken = default)
    {
        var timestamp = (now ?? DateTimeOffset.UtcNow).ToUniversalTime();
        var dueItems = await _queue.GetDueAsync(timestamp, cancellationToken);
        var processed = 0;
        foreach (var item in dueItems)
        {
            cancellationToken.ThrowIfCancellationRequested();
            try
            {
                await _queue.MarkSubmittingAsync(item.IdempotencyKey, cancellationToken);
            }
            catch (InvalidOperationException)
            {
                // A foreground request or another worker already claimed this item.
                continue;
            }

            try
            {
                var signed = new SignedAtkCoupon(item.PayloadBase64, item.SignatureBase64, "");
                var response = await _submit(signed, cancellationToken);
                if (response.TransactionId == 0)
                    throw new AtkApiException("ATK returned no transaction_id.", System.Net.HttpStatusCode.BadGateway, "");
                await _queue.MarkAcceptedAsync(item.IdempotencyKey, response.TransactionId.ToString(), cancellationToken);
            }
            catch (AtkApiException ex) when (AtkTransportFailureClassifier.IsDefinitiveRejection(ex.StatusCode))
            {
                await _queue.MarkRejectedAsync(item.IdempotencyKey,
                    "ATK rejected the queued test coupon with HTTP " + (int)ex.StatusCode, cancellationToken);
            }
            catch (HttpRequestException ex) when (AtkTransportFailureClassifier.IsDefinitelyNotSent(ex))
            {
                await _queue.RequeueDefinitelyNotSentAsync(item.IdempotencyKey,
                    "ATK connection unavailable before request delivery; automatic retry remains scheduled.",
                    timestamp, cancellationToken);
            }
            catch (Exception ex) when (ex is AtkApiException or HttpRequestException or TaskCanceledException or IOException)
            {
                // A timeout, reset or server response can happen after ATK has committed.
                // Keep the signed coupon, but never auto-resubmit an ambiguous transaction.
                await _queue.MarkNeedsReconciliationAsync(item.IdempotencyKey,
                    "Automatic delivery outcome is uncertain. Check ATK before retrying.", cancellationToken);
            }
            processed++;
        }
        return processed;
    }
}
