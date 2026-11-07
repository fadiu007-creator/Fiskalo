using System.Net;
using System.Text;
using Fiskalo.PosAgent.Core.Atk;
using Xunit;

namespace Fiskalo.PosAgent.Tests;

public sealed class AtkTestClientTests
{
    [Fact]
    public async Task VerifyPos_UsesOnlyOfficialTestHostAndExpectedRoute()
    {
        var handler = new StubHandler(request =>
        {
            Assert.Equal("https://fiskalizimi-test.atk-ks.org/ca/verify/123456789", request.RequestUri!.ToString());
            Assert.Equal(HttpMethod.Post, request.Method);
            return Json("{\"business_name\":\"Test Business\",\"verification_code\":\"TEST-CODE\"}");
        });
        using var http = new HttpClient(handler);
        var result = await new AtkTestClient(http).VerifyPosAsync(123456789, "EDI-TEST-CODE", 7, 2, 99);

        Assert.Equal("Test Business", result.BusinessName);
        Assert.Equal("TEST-CODE", result.VerificationCode);
    }

    [Fact]
    public async Task SignCsr_UsesOfficialTestHost()
    {
        var handler = new StubHandler(request =>
        {
            Assert.Equal("https://fiskalizimi-test.atk-ks.org/ca/signcsr", request.RequestUri!.ToString());
            return Json("{\"signed_certificate\":\"TEST-CERT\"}");
        });
        using var http = new HttpClient(handler);
        var result = await new AtkTestClient(http).SignCsrAsync(
            "Test Business", 123456789, 2, "VERIFY", 7, 99, "-----BEGIN CERTIFICATE REQUEST-----\nTEST\n-----END CERTIFICATE REQUEST-----");

        Assert.Equal("TEST-CERT", result.SignedCertificate);
    }


    [Fact]
    public async Task SubmitSignedCoupon_UsesPosCouponEndpointAndReturnsTransactionId()
    {
        var handler = new StubHandler(request =>
        {
            Assert.Equal("https://fiskalizimi-test.atk-ks.org/pos/coupon", request.RequestUri!.ToString());
            return Json("{\"message\":\"accepted\",\"transaction_id\":987654}");
        });
        using var http = new HttpClient(handler);
        var result = await new AtkTestClient(http).SubmitSignedPosCouponAsync(
            new SignedAtkCoupon("cG9zLWNvdXBvbg==", "c2lnbmF0dXJl", "hash"));

        Assert.Equal((ulong)987654, result.TransactionId);
    }

    [Fact]
    public async Task NonSuccessResponse_IsReturnedAsTypedAtkError()
    {
        var handler = new StubHandler(_ => new HttpResponseMessage(HttpStatusCode.BadRequest)
        {
            Content = new StringContent("invalid test identifiers")
        });
        using var http = new HttpClient(handler);

        var error = await Assert.ThrowsAsync<AtkApiException>(() =>
            new AtkTestClient(http).VerifyPosAsync(123456789, "EDI", 7, 2, 99));

        Assert.Equal(HttpStatusCode.BadRequest, error.StatusCode);
    }

    private static HttpResponseMessage Json(string body) => new(HttpStatusCode.OK)
    {
        Content = new StringContent(body, Encoding.UTF8, "application/json")
    };

    private sealed class StubHandler(Func<HttpRequestMessage, HttpResponseMessage> responder) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) =>
            Task.FromResult(responder(request));
    }
}
