using System.Net;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;
using Atk;

namespace Fiskalo.PosAgent.Core.Atk;

public sealed class AtkTestClient
{
    public const string TestBaseUrl = "https://fiskalizimi-test.atk-ks.org";
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
    private readonly HttpClient _http;

    public AtkTestClient(HttpClient httpClient)
    {
        _http = httpClient ?? throw new ArgumentNullException(nameof(httpClient));
    }

    public Task<AtkVerificationResponse> VerifyPosAsync(
        ulong nui, string fiscalizationNumber, ulong posId, ulong branchId, ulong applicationId,
        CancellationToken cancellationToken = default)
    {
        if (nui == 0 || posId == 0 || branchId == 0 || applicationId == 0)
            throw new ArgumentOutOfRangeException(nameof(nui), "NUI, POS ID, branch ID and application ID must be positive.");
        if (string.IsNullOrWhiteSpace(fiscalizationNumber))
            throw new ArgumentException("ATK EDI fiscalization number is required.", nameof(fiscalizationNumber));

        var body = new VerifyRequest(fiscalizationNumber, posId, branchId, applicationId);
        return PostAsync<AtkVerificationResponse>("/ca/verify/" + nui, body, cancellationToken);
    }

    public Task<AtkCertificateResponse> SignCsrAsync(
        string businessName, ulong businessNui, ulong branchId, string verificationCode,
        ulong posId, ulong applicationId, string csrPem, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(businessName) || string.IsNullOrWhiteSpace(verificationCode) ||
            string.IsNullOrWhiteSpace(csrPem))
            throw new ArgumentException("Business name, verification code and CSR are required.");
        if (businessNui == 0 || branchId == 0 || posId == 0 || applicationId == 0)
            throw new ArgumentOutOfRangeException(nameof(businessNui));

        var body = new SignCsrRequest(businessName, businessNui, branchId, verificationCode, posId, applicationId, csrPem);
        return PostAsync<AtkCertificateResponse>("/ca/signcsr", body, cancellationToken);
    }

    public Task<AtkPosCouponResponse> SubmitPosCouponAsync(
        PosCoupon coupon, ECDsa privateKey, CancellationToken cancellationToken = default)
    {
        var signed = AtkCouponSigner.SignPosCoupon(coupon, privateKey);
        return SubmitSignedPosCouponAsync(signed, cancellationToken);
    }

    public async Task<AtkPosCouponResponse> SubmitSignedPosCouponAsync(
        SignedAtkCoupon signed, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(signed);
        if (string.IsNullOrWhiteSpace(signed.DetailsBase64) || string.IsNullOrWhiteSpace(signed.SignatureBase64))
            throw new ArgumentException("Signed coupon details and signature are required.", nameof(signed));

        var response = await PostAsync<AtkPosCouponResponse>(
            "/pos/coupon", new PosCouponRequest(signed.DetailsBase64, signed.SignatureBase64), cancellationToken);
        if (response.TransactionId == 0)
            throw new AtkApiException("ATK test endpoint returned no transaction_id.", HttpStatusCode.BadGateway, "");
        return response;
    }

    private async Task<T> PostAsync<T>(string path, object body, CancellationToken cancellationToken)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, new Uri(new Uri(TestBaseUrl), path))
        {
            Content = JsonContent.Create(body, options: JsonOptions)
        };
        using var response = await _http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
        var responseBody = await response.Content.ReadAsStringAsync(cancellationToken);
        if (!response.IsSuccessStatusCode)
            throw new AtkApiException("ATK test request failed with HTTP " + (int)response.StatusCode + ": " + responseBody,
                response.StatusCode, responseBody);

        try
        {
            return JsonSerializer.Deserialize<T>(responseBody, JsonOptions)
                ?? throw new JsonException("ATK returned an empty response.");
        }
        catch (JsonException ex)
        {
            throw new AtkApiException("ATK test endpoint returned an unexpected response format.",
                HttpStatusCode.BadGateway, responseBody, ex);
        }
    }

    private sealed record VerifyRequest(
        [property: JsonPropertyName("fiscalization_no")] string FiscalizationNumber,
        [property: JsonPropertyName("pos_id")] ulong PosId,
        [property: JsonPropertyName("branch_id")] ulong BranchId,
        [property: JsonPropertyName("application_id")] ulong ApplicationId);

    private sealed record SignCsrRequest(
        [property: JsonPropertyName("business_name")] string BusinessName,
        [property: JsonPropertyName("business_id")] ulong BusinessId,
        [property: JsonPropertyName("branch_id")] ulong BranchId,
        [property: JsonPropertyName("verification_code")] string VerificationCode,
        [property: JsonPropertyName("pos_id")] ulong PosId,
        [property: JsonPropertyName("application_id")] ulong ApplicationId,
        [property: JsonPropertyName("csr")] string Csr);

    private sealed record PosCouponRequest(
        [property: JsonPropertyName("details")] string Details,
        [property: JsonPropertyName("signature")] string Signature);
}

public sealed record AtkVerificationResponse(
    [property: JsonPropertyName("business_name")] string BusinessName,
    [property: JsonPropertyName("verification_code")] string VerificationCode);

public sealed record AtkCertificateResponse(
    [property: JsonPropertyName("signed_certificate")] string SignedCertificate);

public sealed record AtkPosCouponResponse(
    [property: JsonPropertyName("message")] string Message,
    [property: JsonPropertyName("transaction_id")] ulong TransactionId);

public sealed class AtkApiException : Exception
{
    public HttpStatusCode StatusCode { get; }
    public string ResponseBody { get; }

    public AtkApiException(string message, HttpStatusCode statusCode, string responseBody, Exception? inner = null)
        : base(message, inner)
    {
        StatusCode = statusCode;
        ResponseBody = responseBody;
    }
}
