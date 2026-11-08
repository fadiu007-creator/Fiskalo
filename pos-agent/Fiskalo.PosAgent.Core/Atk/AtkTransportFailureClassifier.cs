using System.Net;
using System.Net.Http;
using System.Net.Sockets;

namespace Fiskalo.PosAgent.Core.Atk;

/// <summary>
/// Only transport failures that occur before a TCP connection is established are
/// safe for automatic retry. Timeouts, connection resets and HTTP 5xx responses
/// remain ambiguous because ATK may already have committed the coupon.
/// </summary>
public static class AtkTransportFailureClassifier
{
    public static bool IsDefinitiveRejection(HttpStatusCode statusCode) =>
        statusCode is HttpStatusCode.BadRequest or HttpStatusCode.Unauthorized or
            HttpStatusCode.Forbidden or HttpStatusCode.NotFound or HttpStatusCode.UnprocessableEntity;

    public static bool IsDefinitelyNotSent(HttpRequestException exception)
    {
        ArgumentNullException.ThrowIfNull(exception);
        if (exception.InnerException is not SocketException socket) return false;
        return socket.SocketErrorCode is SocketError.HostNotFound or SocketError.NoData or
            SocketError.TryAgain or SocketError.ConnectionRefused or SocketError.NetworkUnreachable or
            SocketError.HostUnreachable or SocketError.NetworkDown or SocketError.AddressNotAvailable;
    }
}
