using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.Json.Serialization;
using System.Globalization;
using Google.Protobuf;
using Fiskalo.PosAgent.Core.Atk;
using Fiskalo.PosAgent.Core.Queue;
using Fiskalo.PosAgent.Core.Security;
using Atk;
using Fiskalo.PosAgent.Host.Printing;

const string AgentVersion = "0.1.0";
const string PairPath = "/api/v1/pair";
const string StatusPath = "/api/v1/status";
const string HealthPath = "/health";
const string CsrPath = "/api/v1/keys/csr";
const string QueuePath = "/api/v1/queue";
const string QueueReconcilePath = "/api/v1/queue/reconcile";
const string AtkVerifyPath = "/api/v1/atk/test/verify";
const string AtkSignCsrPath = "/api/v1/atk/test/sign-csr";
const string AtkCouponPath = "/api/v1/atk/test/coupon";
const string AtkCorrectionPath = "/api/v1/atk/test/correction";
const string PrintersPath = "/api/v1/printers";
const string PrinterPrintPath = "/api/v1/printers/print";
const string PrinterTestPath = "/api/v1/printers/test";

var allowedOrigins = (Environment.GetEnvironmentVariable("FISKALO_ALLOWED_ORIGINS")
    ?? "https://fiskalo.shqiptare.workers.dev;https://fiskalo.pages.dev;http://localhost:3000")
    .Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
    .ToHashSet(StringComparer.Ordinal);

var pairingCode = Base64Url(RandomNumberGenerator.GetBytes(32));
string? sessionToken = null;
var failedPairAttempts = 0;
var pairLockedUntil = DateTimeOffset.MinValue;
var dataDirectory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Fiskalo", "PosAgent");
var keyPath = Path.Combine(dataDirectory, "pos-signing-key.dpapi");
var queuePath = Path.Combine(dataDirectory, "fiscal-queue.bin");
var certificatePath = Path.Combine(dataDirectory, "atk-test-certificate.pem");
var installationPath = Path.Combine(dataDirectory, "atk-test-installation.dpapi");
var installationStore = new WindowsDpapiInstallationStore(installationPath);
var keyStore = new WindowsDpapiEcdsaKeyStore();
var queueStore = new FiscalQueueStore(queuePath, new WindowsDpapiFiscalQueueProtector());
var correctionGate = new SemaphoreSlim(1, 1);

Console.WriteLine("Fiskalo POS Agent " + AgentVersion);
Console.WriteLine("Local endpoint: http://127.0.0.1:17843");
Console.WriteLine("One-time pairing code (keep private): " + pairingCode);
Console.WriteLine("Allowed browser origins: " + string.Join(", ", allowedOrigins));

var builder = WebApplication.CreateBuilder(args);
builder.WebHost.ConfigureKestrel(options => options.Listen(IPAddress.Loopback, 17843));
var app = builder.Build();

app.Use(async (context, next) =>
{
    if (context.Connection.RemoteIpAddress is not { } remote || !IPAddress.IsLoopback(remote))
    {
        context.Response.StatusCode = StatusCodes.Status403Forbidden;
        return;
    }

    // Reject unexpected Host values to reduce DNS-rebinding exposure.
    var host = context.Request.Host;
    if (!host.Host.Equals("127.0.0.1", StringComparison.OrdinalIgnoreCase) ||
        host.Port != 17843)
    {
        context.Response.StatusCode = StatusCodes.Status400BadRequest;
        return;
    }

    var origin = context.Request.Headers["Origin"].ToString();
    if (!string.IsNullOrEmpty(origin) && !allowedOrigins.Contains(origin))
    {
        context.Response.StatusCode = StatusCodes.Status403Forbidden;
        return;
    }

    if (context.Request.Method == HttpMethods.Options)
    {
        if (string.IsNullOrEmpty(origin) || !allowedOrigins.Contains(origin))
        {
            context.Response.StatusCode = StatusCodes.Status403Forbidden;
            return;
        }

        context.Response.Headers["Access-Control-Allow-Origin"] = origin;
        context.Response.Headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
        context.Response.Headers["Access-Control-Allow-Headers"] = "Authorization, Content-Type";
        if (context.Request.Headers.ContainsKey("Access-Control-Request-Private-Network"))
            context.Response.Headers["Access-Control-Allow-Private-Network"] = "true";
        context.Response.Headers["Vary"] = "Origin";
        context.Response.StatusCode = StatusCodes.Status204NoContent;
        return;
    }

    if (!string.IsNullOrEmpty(origin) && allowedOrigins.Contains(origin))
    {
        context.Response.Headers["Access-Control-Allow-Origin"] = origin;
        context.Response.Headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
        context.Response.Headers["Access-Control-Allow-Headers"] = "Authorization, Content-Type";
        context.Response.Headers["Vary"] = "Origin";
    }

    await next();
});

app.MapGet(HealthPath, () => Results.Ok(new
{
    service = "fiskalo-pos-agent",
    version = AgentVersion,
    state = "running",
    fiscalizationEnabled = false
}));

app.MapPost(PairPath, (PairRequest request, HttpContext context) =>
{
    var origin = context.Request.Headers["Origin"].ToString();
    if (string.IsNullOrEmpty(origin) || !allowedOrigins.Contains(origin))
        return Results.StatusCode(StatusCodes.Status403Forbidden);

    if (DateTimeOffset.UtcNow < pairLockedUntil)
        return Results.StatusCode(StatusCodes.Status429TooManyRequests);

    if (sessionToken is not null)
        return Results.Conflict(new { error = "already_paired", message = "Agent is already paired. Restart it to create a new pairing session." });

    var supplied = Encoding.UTF8.GetBytes(request.PairingCode ?? "");
    var expected = Encoding.UTF8.GetBytes(pairingCode);
    var valid = supplied.Length == expected.Length &&
        CryptographicOperations.FixedTimeEquals(supplied, expected);

    if (!valid)
    {
        failedPairAttempts++;
        if (failedPairAttempts >= 5)
        {
            pairLockedUntil = DateTimeOffset.UtcNow.AddMinutes(5);
            failedPairAttempts = 0;
        }
        return Results.Unauthorized();
    }

    sessionToken = Base64Url(RandomNumberGenerator.GetBytes(32));
    pairingCode = ""; // One-time code cannot be reused after successful pairing.
    failedPairAttempts = 0;
    return Results.Ok(new PairResponse(sessionToken, AgentVersion));
});

app.MapGet(StatusPath, (HttpContext context) =>
{
    if (!HasValidSession(context, sessionToken))
        return Results.Unauthorized();

    return Results.Ok(new
    {
        service = "fiskalo-pos-agent",
        version = AgentVersion,
        paired = true,
        fiscalizationEnabled = false,
        capabilities = new[] { "health", "secure-local-pairing", "windows-dpapi-key-csr", "encrypted-queue-inspection", "manual-queue-reconciliation", "atk-test-coupon-submission", "thermal-printer-windows-spooler", "thermal-printer-lan-9100", "thermal-printer-test" },
        windowsKeyStoreAvailable = OperatingSystem.IsWindows(),
        signingKeyInitialized = OperatingSystem.IsWindows() && File.Exists(keyPath),
        queueInitialized = OperatingSystem.IsWindows() && File.Exists(queuePath),
        testCertificateInstalled = OperatingSystem.IsWindows() && File.Exists(certificatePath),
        testInstallationVerified = OperatingSystem.IsWindows() && File.Exists(installationPath),
        nextStep = "ATK-test-certificate-onboarding-required"
    });
});

app.MapPost(CsrPath, (CsrRequest request, HttpContext context) => {
    if (!HasValidSession(context, sessionToken)) return Results.Unauthorized();
    if (!OperatingSystem.IsWindows()) return Results.Problem("Local signing-key storage currently requires Windows DPAPI.", statusCode: StatusCodes.Status501NotImplemented);
    if (request.BusinessNui == 0 || request.BranchId == 0 || request.PosId == 0 || string.IsNullOrWhiteSpace(request.BusinessName)) return Results.BadRequest(new { error = "business_name, business_nui, branch_id and pos_id are required" });
    try {
        Directory.CreateDirectory(dataDirectory);
        using var key = keyStore.LoadOrCreate(keyPath);
        var csr = AtkPki.CreateCsrPem(key, request.BusinessName, request.BusinessNui, request.BranchId, request.PosId);
        return Results.Ok(new { csrPem = csr, keyAlgorithm = "ECDSA-P256", privateKeyExported = false, storage = "Windows DPAPI CurrentUser", certificateStatus = "not-issued", fiscalizationEnabled = false });
    } catch (Exception ex) when (ex is CryptographicException or IOException or UnauthorizedAccessException) {
        return Results.Problem("Unable to create or load the locally protected signing key.", statusCode: StatusCodes.Status500InternalServerError);
    }
});

app.MapGet(QueuePath, async (HttpContext context, CancellationToken cancellationToken) => {
    if (!HasValidSession(context, sessionToken)) return Results.Unauthorized();
    if (!OperatingSystem.IsWindows()) return Results.Problem("Local encrypted queue currently requires Windows DPAPI.", statusCode: StatusCodes.Status501NotImplemented);
    try {
        var items = await queueStore.GetAllAsync(cancellationToken);
        var now = DateTimeOffset.UtcNow;
        var visible = items.Select(item =>
        {
            var nuiKfValid = FiscalReceiptIdentity.IsNuiKfEmbeddedInSignedCoupons(
                item.PayloadBase64, item.CitizenPayloadBase64, item.NuiKf);
            return new
            {
                item.IdempotencyKey,
                item.DocumentType,
                item.CreatedAtUtc,
                item.RecoveryDeadlineUtc,
                item.NextAttemptAtUtc,
                status = item.Status.ToString(),
                item.AttemptCount,
                item.LastError,
                item.AtkTransactionId,
                nuiKf = nuiKfValid ? item.NuiKf : null,
                legacyNuiKf = item.LegacyNuiKf ?? (!nuiKfValid ? item.NuiKf : null),
                item.DailyNumber,
                item.OfflineIssuedAtUtc,
                citizenPayloadBase64 = item.CitizenPayloadBase64,
                citizenSignatureBase64 = item.CitizenSignatureBase64,
                citizenQrPayload = item.CitizenPayloadBase64 is not null && item.CitizenSignatureBase64 is not null
                    ? item.CitizenPayloadBase64 + "|" + item.CitizenSignatureBase64 : null,
                qrSvgBase64 = item.CitizenPayloadBase64 is not null && item.CitizenSignatureBase64 is not null
                    ? Convert.ToBase64String(Encoding.UTF8.GetBytes(FiscalReceiptQrCode.CreateSvgData(item.CitizenPayloadBase64 + "|" + item.CitizenSignatureBase64))) : null,
                detailsBase64 = item.Status == FiscalQueueStatus.Accepted ? item.PayloadBase64 : null,
                signatureBase64 = item.Status == FiscalQueueStatus.Accepted ? item.SignatureBase64 : null,
                recoveryDeadlineExceeded = item.Status is FiscalQueueStatus.Queued or FiscalQueueStatus.NeedsReconciliation &&
                    item.RecoveryDeadlineUtc <= now
            };
        }).ToArray();
        return Results.Ok(new
        {
            count = visible.Length,
            overdueCount = visible.Count(item => item.recoveryDeadlineExceeded),
            items = visible
        });
    } catch (Exception ex) when (ex is CryptographicException or IOException or UnauthorizedAccessException) {
        return Results.Problem("Unable to read the protected local fiscal queue.", statusCode: StatusCodes.Status500InternalServerError);
    }
});

app.MapPost(QueueReconcilePath, async (QueueReconcileRequest request, HttpContext context, CancellationToken cancellationToken) =>
{
    if (!HasValidSession(context, sessionToken)) return Results.Unauthorized();
    if (!OperatingSystem.IsWindows()) return Results.Problem("Protected queue reconciliation currently requires Windows DPAPI.", statusCode: StatusCodes.Status501NotImplemented);
    if (string.IsNullOrWhiteSpace(request.IdempotencyKey) || string.IsNullOrWhiteSpace(request.Decision))
        return Results.BadRequest(new { error = "idempotencyKey and decision are required." });
    try
    {
        var resolved = request.Decision.Trim().ToLowerInvariant() switch
        {
            "accepted" => await queueStore.ResolveAsAcceptedAsync(request.IdempotencyKey, request.AtkTransactionId ?? "", cancellationToken),
            "rejected" => await queueStore.ResolveAsRejectedAsync(request.IdempotencyKey, request.OperatorNote ?? "", cancellationToken),
            "not_found_confirmed" => await queueStore.ResolveNotFoundAndRequeueAsync(request.IdempotencyKey, request.ConfirmedNoAtkRecord, cancellationToken: cancellationToken),
            _ => null
        };
        if (resolved is null)
            return Results.BadRequest(new { error = "decision_must_be_accepted_rejected_or_not_found_confirmed" });
        return Results.Ok(new
        {
            idempotencyKey = resolved.IdempotencyKey,
            status = resolved.Status.ToString(),
            transactionId = resolved.AtkTransactionId,
            lastError = resolved.LastError,
            manualResubmissionPermitted = resolved.Status == FiscalQueueStatus.Queued,
            automaticRetryEnabled = false
        });
    }
    catch (ArgumentException ex) { return Results.BadRequest(new { error = ex.Message }); }
    catch (InvalidOperationException ex) { return Results.Conflict(new { error = ex.Message }); }
    catch (KeyNotFoundException) { return Results.NotFound(new { error = "fiscal_queue_item_not_found" }); }
    catch (Exception ex) when (ex is CryptographicException or IOException or UnauthorizedAccessException)
    {
        return Results.Problem("Unable to update the protected fiscal queue.", statusCode: StatusCodes.Status500InternalServerError);
    }
});

app.MapPost(AtkVerifyPath, async (AtkVerifyRequest request, HttpContext context, CancellationToken cancellationToken) => {
    if (!HasValidSession(context, sessionToken)) return Results.Unauthorized();
    if (request.Nui == 0 || request.PosId == 0 || request.BranchId == 0 || request.ApplicationId == 0 || string.IsNullOrWhiteSpace(request.FiscalizationNumber)) return Results.BadRequest(new { error = "NUI, fiscalization number, POS ID, branch ID and ATK application ID are required." });
    try {
        using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(20) };
        var result = await new AtkTestClient(http).VerifyPosAsync(request.Nui, request.FiscalizationNumber, request.PosId, request.BranchId, request.ApplicationId, cancellationToken);
        installationStore.Save(new AtkTestInstallationProfile(
            request.Nui, result.BusinessName, request.FiscalizationNumber, request.BranchId,
            request.PosId, request.ApplicationId, result.VerificationCode, DateTimeOffset.UtcNow));
        return Results.Ok(new { businessName = result.BusinessName, verificationCode = result.VerificationCode, environment = "ATK TEST", profileProtectedAtRest = true, productionEnabled = false });
    } catch (AtkApiException ex) {
        return Results.Problem("ATK test verification failed (HTTP " + (int)ex.StatusCode + "). Check the supplied test identifiers and ATK test-service availability.", statusCode: StatusCodes.Status502BadGateway);
    } catch (HttpRequestException) {
        return Results.Problem("Could not reach the ATK test service.", statusCode: StatusCodes.Status502BadGateway);
    } catch (TaskCanceledException) {
        return Results.Problem("ATK test request timed out.", statusCode: StatusCodes.Status504GatewayTimeout);
    }
});

app.MapPost(AtkSignCsrPath, async (AtkSignCsrRequest request, HttpContext context, CancellationToken cancellationToken) => {
    if (!HasValidSession(context, sessionToken)) return Results.Unauthorized();
    if (!OperatingSystem.IsWindows()) return Results.Problem("Local signing-key storage currently requires Windows DPAPI.", statusCode: StatusCodes.Status501NotImplemented);
    if (request.BusinessNui == 0 || request.BranchId == 0 || request.PosId == 0 || request.ApplicationId == 0 || string.IsNullOrWhiteSpace(request.BusinessName) || string.IsNullOrWhiteSpace(request.VerificationCode)) return Results.BadRequest(new { error = "Business identity, ATK verification code and POS identifiers are required." });
    try {
        var verified = installationStore.Load();
        if (verified is null || verified.Nui != request.BusinessNui || verified.BranchId != request.BranchId ||
            verified.PosId != request.PosId || verified.ApplicationId != request.ApplicationId ||
            !string.Equals(verified.BusinessName, request.BusinessName, StringComparison.Ordinal) ||
            !string.Equals(verified.VerificationCode, request.VerificationCode, StringComparison.Ordinal))
            return Results.Conflict(new { error = "atk_verification_profile_mismatch", message = "Run ATK test verification first and use the exact returned business identity and identifiers." });
        Directory.CreateDirectory(dataDirectory);
        using var key = keyStore.LoadOrCreate(keyPath);
        var csr = AtkPki.CreateCsrPem(key, request.BusinessName, request.BusinessNui, request.BranchId, request.PosId);
        using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(30) };
        var response = await new AtkTestClient(http).SignCsrAsync(request.BusinessName, request.BusinessNui, request.BranchId, request.VerificationCode, request.PosId, request.ApplicationId, csr, cancellationToken);
        using var certificate = ParseCertificate(response.SignedCertificate);
        using var certificateKey = certificate.GetECDsaPublicKey();
        if (certificateKey is null || !SamePublicKey(key, certificateKey)) return Results.Problem("ATK returned a certificate whose public key does not match this POS private key. It was not saved.", statusCode: StatusCodes.Status502BadGateway);
        var pem = certificate.ExportCertificatePem();
        await File.WriteAllTextAsync(certificatePath, pem, cancellationToken);
        installationStore.Save(verified with { CertificateThumbprint = certificate.Thumbprint, CertificateIssuedAtUtc = DateTimeOffset.UtcNow });
        return Results.Ok(new { certificateStatus = "ATK_TEST_CERTIFICATE_RECEIVED_AND_KEY_MATCHED", subject = certificate.Subject, thumbprint = certificate.Thumbprint, environment = "ATK TEST", privateKeyExported = false, installationProfileProtectedAtRest = true, productionEnabled = false });
    } catch (AtkApiException ex) {
        return Results.Problem("ATK test certificate request failed (HTTP " + (int)ex.StatusCode + "). Check the verification code and test identifiers.", statusCode: StatusCodes.Status502BadGateway);
    } catch (HttpRequestException) {
        return Results.Problem("Could not reach the ATK test service.", statusCode: StatusCodes.Status502BadGateway);
    } catch (TaskCanceledException) {
        return Results.Problem("ATK certificate request timed out.", statusCode: StatusCodes.Status504GatewayTimeout);
    } catch (CryptographicException) {
        return Results.Problem("ATK response was not a valid certificate matching the locally protected POS key.", statusCode: StatusCodes.Status502BadGateway);
    }
});
static X509Certificate2 ParseCertificate(string certificate)
{
    if (string.IsNullOrWhiteSpace(certificate))
        throw new CryptographicException("ATK returned an empty certificate.");
    if (certificate.Contains("-----BEGIN CERTIFICATE-----", StringComparison.Ordinal))
        return X509Certificate2.CreateFromPem(certificate);
    try
    {
        return new X509Certificate2(Convert.FromBase64String(certificate));
    }
    catch (FormatException ex)
    {
        throw new CryptographicException("ATK certificate encoding is not PEM or Base64 DER.", ex);
    }
}

static bool SamePublicKey(ECDsa first, ECDsa second)
{
    var a = first.ExportParameters(false);
    var b = second.ExportParameters(false);
    return a.Curve.Oid.Value == b.Curve.Oid.Value &&
        a.Q.X is not null && a.Q.Y is not null &&
        b.Q.X is not null && b.Q.Y is not null &&
        CryptographicOperations.FixedTimeEquals(a.Q.X, b.Q.X) &&
        CryptographicOperations.FixedTimeEquals(a.Q.Y, b.Q.Y);
}


app.MapPost(AtkCouponPath, async (AtkCouponRequest request, HttpContext context, CancellationToken cancellationToken) => {
    if (!HasValidSession(context, sessionToken)) return Results.Unauthorized();
    if (!OperatingSystem.IsWindows()) return Results.Problem("ATK coupon signing and encrypted queue currently require Windows DPAPI.", statusCode: StatusCodes.Status501NotImplemented);
    if (string.IsNullOrWhiteSpace(request.IdempotencyKey)) return Results.BadRequest(new { error = "idempotencyKey is required." });
    if (!File.Exists(certificatePath) || !File.Exists(keyPath)) return Results.Conflict(new { error = "test_certificate_and_local_key_required", fiscalizationEnabled = false });
    try {
        using var key = keyStore.LoadOrCreate(keyPath);
        using var certificate = X509Certificate2.CreateFromPem(await File.ReadAllTextAsync(certificatePath, cancellationToken));
        if (DateTime.UtcNow < certificate.NotBefore.ToUniversalTime() || DateTime.UtcNow > certificate.NotAfter.ToUniversalTime()) return Results.Conflict(new { error = "test_certificate_not_current" });
        using var certificateKey = certificate.GetECDsaPublicKey();
        if (certificateKey is null || !SamePublicKey(key, certificateKey)) return Results.Conflict(new { error = "certificate_key_mismatch" });
        var installation = installationStore.Load();
        if (installation is null || string.IsNullOrWhiteSpace(installation.CertificateThumbprint) ||
            !string.Equals(installation.CertificateThumbprint, certificate.Thumbprint, StringComparison.OrdinalIgnoreCase))
            return Results.Conflict(new { error = "verified_atk_test_installation_required" });
        if (request.Coupon.DailyNumber <= 0) return Results.BadRequest(new { error = "dailyNumber_must_be_positive_for_fiscal_receipt" });
        if (!string.IsNullOrEmpty(request.Coupon.VerificationNo))
            return Results.BadRequest(new { error = "nui_kf_verification_no_is_generated_by_the_pos_agent_not_supplied_by_the_browser" });
        if (request.Coupon.BusinessId != installation.Nui || request.Coupon.BranchId != installation.BranchId ||
            request.Coupon.PosId != installation.PosId || request.Coupon.ApplicationId != installation.ApplicationId)
            return Results.BadRequest(new { error = "coupon_identity_does_not_match_verified_pos_installation" });
        var expectedIdempotencyKey = request.Coupon.BusinessId + ":" + request.Coupon.BranchId + ":" + request.Coupon.PosId + ":" + request.Coupon.CouponId;
        if (!string.Equals(request.IdempotencyKey, expectedIdempotencyKey, StringComparison.Ordinal)) return Results.BadRequest(new { error = "idempotencyKey_must_match_business_branch_pos_coupon_ids", expected = expectedIdempotencyKey });
        var existing = (await queueStore.GetAllAsync(cancellationToken)).SingleOrDefault(x => x.IdempotencyKey == request.IdempotencyKey);
        if (existing is not null && (existing.NuiKf is null || existing.CitizenPayloadBase64 is null || existing.CitizenSignatureBase64 is null))
            return Results.Conflict(new { status = existing.Status.ToString(), error = "legacy_queue_item_missing_signed_citizen_receipt_requires_operator_reconciliation" });
        if (existing is not null && !FiscalReceiptIdentity.IsValidNuiKf(existing.NuiKf))
            return Results.Conflict(new { status = existing.Status.ToString(), error = "queue_item_has_invalid_nuikf_requires_operator_reconciliation" });

        var nuiKf = existing?.NuiKf ?? FiscalReceiptIdentity.CreateNuiKf();
        var coupon = PosCouponBuilder.Build(request.Coupon, nuiKf);
        var signed = AtkCouponSigner.SignPosCoupon(coupon, key);
        if (existing is not null && (existing.PayloadBase64 != signed.DetailsBase64 || existing.DocumentType != coupon.Type.ToString()))
            return Results.Conflict(new { error = "idempotency_key_reused_with_different_coupon_content" });
        var signedCitizen = existing is null
            ? AtkCouponSigner.SignCitizenCoupon(AtkCouponSigner.CreateCitizenCoupon(coupon), key)
            : null;
        var citizenPayload = existing?.CitizenPayloadBase64 ?? signedCitizen!.DetailsBase64;
        var citizenSignature = existing?.CitizenSignatureBase64 ?? signedCitizen!.SignatureBase64;
        var citizenQrPayload = FiscalReceiptIdentity.BuildCitizenQrPayload(
            new SignedAtkCoupon(citizenPayload, citizenSignature, ""));
        var qrSvg = FiscalReceiptQrCode.CreateSvgData(citizenQrPayload);
        var qrSvgBase64 = Convert.ToBase64String(Encoding.UTF8.GetBytes(qrSvg));

        if (existing?.Status == FiscalQueueStatus.Accepted)
            return Results.Ok(new { status = "accepted", transactionId = existing.AtkTransactionId,
                detailsBase64 = existing.PayloadBase64, signatureBase64 = existing.SignatureBase64,
                nuiKf, dailyNumber = existing.DailyNumber, citizenQrPayload, qrSvgBase64,
                duplicateRequest = true, environment = "ATK TEST", offline = false });

        if (existing is not null && existing.Status != FiscalQueueStatus.Queued)
            return Results.Conflict(new { status = existing.Status.ToString(), error = "document_requires_reconciliation_or_operator_review", existing.LastError });

        if (existing is null)
            await queueStore.EnqueueAsync(request.IdempotencyKey, coupon.Type.ToString(), signed.DetailsBase64,
                signed.SignatureBase64, cancellationToken: cancellationToken, nuiKf: nuiKf,
                citizenPayloadBase64: citizenPayload, citizenSignatureBase64: citizenSignature,
                dailyNumber: request.Coupon.DailyNumber);

        var persisted = existing ?? (await queueStore.GetAllAsync(cancellationToken)).Single(x => x.IdempotencyKey == request.IdempotencyKey);
        var signedToSubmit = new SignedAtkCoupon(persisted.PayloadBase64, persisted.SignatureBase64, "");
        await queueStore.MarkSubmittingAsync(request.IdempotencyKey, cancellationToken);
        try {
            using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(30) };
            var result = await new AtkTestClient(http).SubmitSignedPosCouponAsync(signedToSubmit, cancellationToken);
            await queueStore.MarkAcceptedAsync(request.IdempotencyKey, result.TransactionId.ToString(), cancellationToken);
            return Results.Ok(new { status = "accepted", transactionId = result.TransactionId.ToString(),
                detailsBase64 = persisted.PayloadBase64, signatureBase64 = persisted.SignatureBase64,
                nuiKf, dailyNumber = persisted.DailyNumber, citizenQrPayload, qrSvgBase64,
                message = result.Message, environment = "ATK TEST", productionEnabled = false, offline = false });
        } catch (AtkApiException ex) when (AtkTransportFailureClassifier.IsDefinitiveRejection(ex.StatusCode)) {
            await queueStore.MarkRejectedAsync(request.IdempotencyKey, "ATK rejected the test coupon with HTTP " + (int)ex.StatusCode, cancellationToken);
            return Results.Problem("ATK rejected the test coupon (HTTP " + (int)ex.StatusCode + "). Review the payload and ATK response before creating a corrected test document.", statusCode: StatusCodes.Status422UnprocessableEntity);
        } catch (HttpRequestException ex) when (IsDefinitelyNotSent(ex)) {
            var queued = await queueStore.RequeueDefinitelyNotSentAsync(request.IdempotencyKey,
                "ATK connection unavailable before request delivery; automatic retry is scheduled.", cancellationToken: cancellationToken);
            return Results.Ok(new { status = "queued_offline", transactionId = (string?)null,
                detailsBase64 = queued.PayloadBase64, signatureBase64 = queued.SignatureBase64,
                nuiKf = queued.NuiKf, dailyNumber = queued.DailyNumber, citizenQrPayload, qrSvgBase64,
                recoveryDeadlineUtc = queued.RecoveryDeadlineUtc, offlineIssuedAtUtc = queued.OfflineIssuedAtUtc, retryScheduled = true,
                environment = "ATK TEST", productionEnabled = false, offline = true });
        } catch (Exception ex) when (ex is AtkApiException or HttpRequestException or TaskCanceledException) {
            await queueStore.MarkNeedsReconciliationAsync(request.IdempotencyKey,
                "Submission outcome is uncertain. Check ATK test records before any retry.", cancellationToken);
            return Results.Problem("ATK submission outcome is uncertain. The signed offline receipt is preserved, but this request is locked for reconciliation to prevent duplicate fiscalization.", statusCode: StatusCodes.Status502BadGateway);
        }
    } catch (ArgumentException ex) {
        return Results.BadRequest(new { error = ex.Message });
    } catch (InvalidOperationException ex) {
        return Results.Conflict(new { error = ex.Message });
    } catch (CryptographicException) {
        return Results.Problem("Local test certificate or signing key could not be validated.", statusCode: StatusCodes.Status500InternalServerError);
    }
});

app.MapPost(AtkCorrectionPath, async (AtkCorrectionRequest request, HttpContext context, CancellationToken cancellationToken) =>
{
    if (!HasValidSession(context, sessionToken)) return Results.Unauthorized();
    if (!OperatingSystem.IsWindows()) return Results.Problem("ATK correction signing and encrypted queue currently require Windows DPAPI.", statusCode: StatusCodes.Status501NotImplemented);
    if (string.IsNullOrWhiteSpace(request.IdempotencyKey) ||
        string.IsNullOrWhiteSpace(request.DocumentType) ||
        string.IsNullOrWhiteSpace(request.OriginalDetailsBase64) ||
        string.IsNullOrWhiteSpace(request.OriginalSignatureBase64) ||
        string.IsNullOrWhiteSpace(request.OriginalTransactionId))
        return Results.BadRequest(new { error = "idempotencyKey_and_signed_original_sale_are_required" });
    if (request.CorrectionCouponId == 0 || request.OriginalCouponId == 0 ||
        request.CorrectionCouponId == request.OriginalCouponId || request.DailyNumber <= 0)
        return Results.BadRequest(new { error = "correction_coupon_id_daily_number_and_original_coupon_id_must_be_valid" });
    if (!File.Exists(certificatePath) || !File.Exists(keyPath))
        return Results.Conflict(new { error = "test_certificate_and_local_key_required", fiscalizationEnabled = false });

    await correctionGate.WaitAsync(cancellationToken);
    try
    {
        using var key = keyStore.LoadOrCreate(keyPath);
        using var certificate = X509Certificate2.CreateFromPem(await File.ReadAllTextAsync(certificatePath, cancellationToken));
        if (DateTime.UtcNow < certificate.NotBefore.ToUniversalTime() || DateTime.UtcNow > certificate.NotAfter.ToUniversalTime())
            return Results.Conflict(new { error = "test_certificate_not_current" });
        using var certificateKey = certificate.GetECDsaPublicKey();
        if (certificateKey is null || !SamePublicKey(key, certificateKey))
            return Results.Conflict(new { error = "certificate_key_mismatch" });
        var installation = installationStore.Load();
        if (installation is null || string.IsNullOrWhiteSpace(installation.CertificateThumbprint) ||
            !string.Equals(installation.CertificateThumbprint, certificate.Thumbprint, StringComparison.OrdinalIgnoreCase))
            return Results.Conflict(new { error = "verified_atk_test_installation_required" });

        var correctionType = request.DocumentType.Trim().ToLowerInvariant() switch
        {
            "cancel" => CouponType.Cancel,
            "return" => CouponType.Return,
            _ => CouponType.UnknownType
        };
        if (correctionType == CouponType.UnknownType)
            return Results.BadRequest(new { error = "documentType_must_be_Cancel_or_Return" });
        if (request.OriginalCouponId == 0 || request.CorrectionCouponId == 0)
            return Results.BadRequest(new { error = "original_and_correction_coupon_ids_are_required" });

        var expectedIdempotencyKey = installation.Nui + ":" + installation.BranchId + ":" +
            installation.PosId + ":" + request.CorrectionCouponId;
        if (!string.Equals(request.IdempotencyKey, expectedIdempotencyKey, StringComparison.Ordinal))
            return Results.BadRequest(new { error = "idempotencyKey_must_match_business_branch_pos_correction_coupon_ids", expected = expectedIdempotencyKey });

        var existing = (await queueStore.GetAllAsync(cancellationToken))
            .SingleOrDefault(x => x.IdempotencyKey == request.IdempotencyKey);
        if (existing is not null)
        {
            if (existing.NuiKf is null || existing.CitizenPayloadBase64 is null ||
                existing.CitizenSignatureBase64 is null || !FiscalReceiptIdentity.IsValidNuiKf(existing.NuiKf))
                return Results.Conflict(new { status = existing.Status.ToString(), error = "existing_correction_queue_item_requires_operator_reconciliation" });

            PosCoupon existingCoupon;
            try
            {
                existingCoupon = PosCoupon.Parser.ParseFrom(Convert.FromBase64String(existing.PayloadBase64));
            }
            catch (Exception ex) when (ex is FormatException or InvalidProtocolBufferException)
            {
                return Results.Conflict(new { status = existing.Status.ToString(), error = "existing_correction_payload_is_invalid_requires_reconciliation" });
            }
            if (existing.DocumentType != correctionType.ToString() ||
                existingCoupon.Type != correctionType ||
                existingCoupon.CouponId != request.CorrectionCouponId ||
                existingCoupon.ReferenceNo != request.OriginalCouponId ||
                existingCoupon.BusinessId != installation.Nui ||
                existingCoupon.BranchId != installation.BranchId ||
                existingCoupon.PosId != installation.PosId ||
                existingCoupon.ApplicationId != installation.ApplicationId ||
                existing.DailyNumber != request.DailyNumber)
                return Results.Conflict(new { status = existing.Status.ToString(), error = "idempotency_key_reused_with_different_correction_identity" });

            var expectedExisting = AtkCorrectionCouponFactory.CreateFromSignedOriginal(
                request.OriginalDetailsBase64,request.OriginalSignatureBase64,certificateKey,
                installation.Nui,installation.BranchId,installation.PosId,installation.ApplicationId,
                request.OriginalCouponId,request.CorrectionCouponId,request.OriginalTransactionId,
                existingCoupon.VerificationNo,DateTimeOffset.FromUnixTimeSeconds(existingCoupon.Time),correctionType);
            if (!expectedExisting.ToByteArray().SequenceEqual(existingCoupon.ToByteArray()))
                return Results.Conflict(new { status = existing.Status.ToString(), error = "idempotency_key_reused_with_different_original_sale" });

            var existingQrPayload = FiscalReceiptIdentity.BuildCitizenQrPayload(
                new SignedAtkCoupon(existing.CitizenPayloadBase64,existing.CitizenSignatureBase64,certificate.Thumbprint));
            var existingQrSvg = Convert.ToBase64String(Encoding.UTF8.GetBytes(FiscalReceiptQrCode.CreateSvgData(existingQrPayload)));
            var existingIssuedAt = DateTimeOffset.FromUnixTimeSeconds(existingCoupon.Time);
            if (existing.Status == FiscalQueueStatus.Accepted && !string.IsNullOrWhiteSpace(existing.AtkTransactionId))
                return Results.Ok(new
                {
                    status = "accepted", transactionId = existing.AtkTransactionId,
                    detailsBase64 = existing.PayloadBase64, signatureBase64 = existing.SignatureBase64,
                    nuiKf = existing.NuiKf, dailyNumber = existing.DailyNumber,
                    citizenQrPayload = existingQrPayload, qrSvgBase64 = existingQrSvg,
                    issuedAtUtc = existingIssuedAt, duplicateRequest = true,
                    environment = "ATK TEST", productionEnabled = false, offline = false
                });
            if (existing.Status == FiscalQueueStatus.Queued)
                return Results.Ok(new
                {
                    status = "queued_offline", transactionId = (string?)null,
                    detailsBase64 = existing.PayloadBase64, signatureBase64 = existing.SignatureBase64,
                    nuiKf = existing.NuiKf, dailyNumber = existing.DailyNumber,
                    citizenQrPayload = existingQrPayload, qrSvgBase64 = existingQrSvg,
                    issuedAtUtc = existingIssuedAt, recoveryDeadlineUtc = existing.RecoveryDeadlineUtc,
                    offlineIssuedAtUtc = existing.OfflineIssuedAtUtc, retryScheduled = true,
                    duplicateRequest = true, environment = "ATK TEST", productionEnabled = false, offline = true
                });
            if (existing.Status == FiscalQueueStatus.Rejected)
                return Results.Ok(new
                {
                    status = "rejected", transactionId = (string?)null,
                    detailsBase64 = existing.PayloadBase64, signatureBase64 = existing.SignatureBase64,
                    nuiKf = existing.NuiKf, dailyNumber = existing.DailyNumber,
                    citizenQrPayload = existingQrPayload, qrSvgBase64 = existingQrSvg,
                    issuedAtUtc = existingIssuedAt, lastError = existing.LastError,
                    duplicateRequest = true, environment = "ATK TEST", productionEnabled = false, offline = false
                });
            if (existing.Status == FiscalQueueStatus.NeedsReconciliation)
                return Results.Ok(new
                {
                    status = "needs_reconciliation", transactionId = (string?)null,
                    detailsBase64 = existing.PayloadBase64, signatureBase64 = existing.SignatureBase64,
                    nuiKf = existing.NuiKf, dailyNumber = existing.DailyNumber,
                    citizenQrPayload = existingQrPayload, qrSvgBase64 = existingQrSvg,
                    issuedAtUtc = existingIssuedAt, lastError = existing.LastError,
                    duplicateRequest = true, environment = "ATK TEST", productionEnabled = false, offline = false
                });
            return Results.Conflict(new { status = existing.Status.ToString(), error = "correction_submission_is_already_in_progress" });
        }

        var issuedAt = DateTimeOffset.UtcNow;
        var nuiKf = FiscalReceiptIdentity.CreateNuiKf();
        var correction = AtkCorrectionCouponFactory.CreateFromSignedOriginal(
            request.OriginalDetailsBase64,request.OriginalSignatureBase64,certificateKey,
            installation.Nui,installation.BranchId,installation.PosId,installation.ApplicationId,
            request.OriginalCouponId,request.CorrectionCouponId,request.OriginalTransactionId,
            nuiKf,issuedAt,correctionType);
        var signed = AtkCouponSigner.SignPosCoupon(correction,key);
        var citizen = AtkCouponSigner.SignCitizenCoupon(AtkCouponSigner.CreateCitizenCoupon(correction),key);
        var citizenQrPayload = FiscalReceiptIdentity.BuildCitizenQrPayload(citizen);
        var qrSvgBase64 = Convert.ToBase64String(Encoding.UTF8.GetBytes(FiscalReceiptQrCode.CreateSvgData(citizenQrPayload)));

        var queued = await queueStore.EnqueueAsync(
            request.IdempotencyKey,correctionType.ToString(),signed.DetailsBase64,signed.SignatureBase64,
            cancellationToken:cancellationToken,nuiKf:nuiKf,
            citizenPayloadBase64:citizen.DetailsBase64,citizenSignatureBase64:citizen.SignatureBase64,
            dailyNumber:request.DailyNumber);
        await queueStore.MarkSubmittingAsync(request.IdempotencyKey,cancellationToken);
        try
        {
            using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(30) };
            var result = await new AtkTestClient(http).SubmitSignedPosCouponAsync(
                new SignedAtkCoupon(queued.PayloadBase64,queued.SignatureBase64,certificate.Thumbprint),cancellationToken);
            await queueStore.MarkAcceptedAsync(request.IdempotencyKey,result.TransactionId.ToString(CultureInfo.InvariantCulture),cancellationToken);
            return Results.Ok(new
            {
                status = "accepted", transactionId = result.TransactionId.ToString(CultureInfo.InvariantCulture),
                detailsBase64 = queued.PayloadBase64, signatureBase64 = queued.SignatureBase64,
                nuiKf, dailyNumber = queued.DailyNumber, citizenQrPayload, qrSvgBase64,
                issuedAtUtc = issuedAt, message = result.Message,
                environment = "ATK TEST", productionEnabled = false, offline = false
            });
        }
        catch (AtkApiException ex) when (AtkTransportFailureClassifier.IsDefinitiveRejection(ex.StatusCode))
        {
            await queueStore.MarkRejectedAsync(request.IdempotencyKey,
                "ATK rejected the TEST correction with HTTP " + (int)ex.StatusCode,cancellationToken);
            return Results.Ok(new
            {
                status = "rejected", transactionId = (string?)null,
                detailsBase64 = queued.PayloadBase64, signatureBase64 = queued.SignatureBase64,
                nuiKf, dailyNumber = queued.DailyNumber, citizenQrPayload, qrSvgBase64,
                issuedAtUtc = issuedAt, lastError = "ATK rejected the TEST correction with HTTP " + (int)ex.StatusCode,
                environment = "ATK TEST", productionEnabled = false, offline = false
            });
        }
        catch (HttpRequestException ex) when (IsDefinitelyNotSent(ex))
        {
            var offline = await queueStore.RequeueDefinitelyNotSentAsync(
                request.IdempotencyKey,"ATK connection unavailable before request delivery; automatic retry is scheduled.",
                cancellationToken:cancellationToken);
            return Results.Ok(new
            {
                status = "queued_offline", transactionId = (string?)null,
                detailsBase64 = offline.PayloadBase64, signatureBase64 = offline.SignatureBase64,
                nuiKf = offline.NuiKf, dailyNumber = offline.DailyNumber,
                citizenQrPayload, qrSvgBase64, issuedAtUtc = issuedAt,
                recoveryDeadlineUtc = offline.RecoveryDeadlineUtc,offlineIssuedAtUtc = offline.OfflineIssuedAtUtc,
                retryScheduled = true,environment = "ATK TEST",productionEnabled = false,offline = true
            });
        }
        catch (Exception ex) when (ex is AtkApiException or HttpRequestException or TaskCanceledException)
        {
            await queueStore.MarkNeedsReconciliationAsync(
                request.IdempotencyKey,"Correction submission outcome is uncertain. Check ATK before any retry.",cancellationToken);
            return Results.Ok(new
            {
                status = "needs_reconciliation", transactionId = (string?)null,
                detailsBase64 = queued.PayloadBase64, signatureBase64 = queued.SignatureBase64,
                nuiKf, dailyNumber = queued.DailyNumber, citizenQrPayload, qrSvgBase64,
                issuedAtUtc = issuedAt,
                lastError = "Correction submission outcome is uncertain. Check ATK before any retry.",
                environment = "ATK TEST",productionEnabled = false,offline = false
            });
        }
    }
    catch (ArgumentException ex)
    {
        return Results.BadRequest(new { error = ex.Message });
    }
    catch (CryptographicException)
    {
        return Results.Conflict(new { error = "original_sale_signature_or_local_certificate_validation_failed" });
    }
    catch (InvalidProtocolBufferException)
    {
        return Results.BadRequest(new { error = "original_signed_payload_is_not_a_valid_atk_coupon" });
    }
    catch (InvalidOperationException ex)
    {
        return Results.Conflict(new { error = ex.Message });
    }
    catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
    {
        return Results.Problem("Unable to persist the encrypted local correction queue.",statusCode:StatusCodes.Status500InternalServerError);
    }
    finally
    {
        correctionGate.Release();
    }
});

app.MapGet(PrintersPath, (HttpContext context) =>
{
    if (!HasValidSession(context, sessionToken)) return Results.Unauthorized();
    if (!OperatingSystem.IsWindows()) return Results.Problem("Installed USB and Windows queue printers are available through the Windows POS Agent.", statusCode: StatusCodes.Status501NotImplemented);
    try
    {
        return Results.Ok(new { printers = ThermalPrinterService.GetInstalledPrinters(), networkPrinting = true, networkPort = 9100 });
    }
    catch (Exception ex) when (ex is InvalidOperationException or DllNotFoundException or EntryPointNotFoundException)
    {
        return Results.Problem("Windows could not enumerate installed printers.", statusCode: StatusCodes.Status500InternalServerError);
    }
});

app.MapPost(PrinterPrintPath, async (PrinterPrintRequest request, HttpContext context, CancellationToken cancellationToken) =>
{
    if (!HasValidSession(context, sessionToken)) return Results.Unauthorized();
    if (!OperatingSystem.IsWindows()) return Results.Problem("The Windows POS Agent is required for this print route.", statusCode: StatusCodes.Status501NotImplemented);
    if (string.IsNullOrWhiteSpace(request.DataBase64)) return Results.BadRequest(new { error = "print_data_required" });
    if ((!string.IsNullOrWhiteSpace(request.PrinterName)) == (!string.IsNullOrWhiteSpace(request.NetworkHost)))
        return Results.BadRequest(new { error = "choose_exactly_one_printer_name_or_network_host" });
    try
    {
        var data = Convert.FromBase64String(request.DataBase64);
        if (data.Length is < 1 or > 262144) return Results.BadRequest(new { error = "print_data_must_be_between_1_byte_and_256_kb" });
        if (!string.IsNullOrWhiteSpace(request.PrinterName))
            ThermalPrinterService.PrintToWindowsQueue(request.PrinterName, data);
        else
            await ThermalPrinterService.PrintToNetworkPrinterAsync(request.NetworkHost!, data, cancellationToken);
        return Results.Ok(new { printed = true, transport = request.PrinterName is not null ? "windows-spooler" : "lan-9100" });
    }
    catch (FormatException) { return Results.BadRequest(new { error = "print_data_must_be_base64" }); }
    catch (ArgumentException ex) { return Results.BadRequest(new { error = ex.Message }); }
    catch (PlatformNotSupportedException ex) { return Results.Problem(ex.Message, statusCode: StatusCodes.Status501NotImplemented); }
    catch (Exception ex) when (ex is InvalidOperationException or SocketException or IOException or DllNotFoundException)
    {
        return Results.Problem("Printer job failed. Check printer selection, paper, connection and Windows printer status.", statusCode: StatusCodes.Status502BadGateway);
    }
});

app.MapPost(PrinterTestPath, async (PrinterTestRequest request, HttpContext context, CancellationToken cancellationToken) =>
{
    if (!HasValidSession(context, sessionToken)) return Results.Unauthorized();
    if (!OperatingSystem.IsWindows()) return Results.Problem("The Windows POS Agent is required for this print route.", statusCode: StatusCodes.Status501NotImplemented);
    if ((!string.IsNullOrWhiteSpace(request.PrinterName)) == (!string.IsNullOrWhiteSpace(request.NetworkHost)))
        return Results.BadRequest(new { error = "choose_exactly_one_printer_name_or_network_host" });
    if (request.PaperWidthMm is not (58 or 80)) return Results.BadRequest(new { error = "paper_width_must_be_58_or_80" });
    try
    {
        var data = ThermalPrinterService.BuildTestReceipt(request.PaperWidthMm);
        if (!string.IsNullOrWhiteSpace(request.PrinterName))
            ThermalPrinterService.PrintToWindowsQueue(request.PrinterName, data);
        else
            await ThermalPrinterService.PrintToNetworkPrinterAsync(request.NetworkHost!, data, cancellationToken);
        return Results.Ok(new { printed = true, testOnly = true, paperWidthMm = request.PaperWidthMm });
    }
    catch (ArgumentException ex) { return Results.BadRequest(new { error = ex.Message }); }
    catch (Exception ex) when (ex is InvalidOperationException or SocketException or IOException or DllNotFoundException)
    {
        return Results.Problem("Test print failed. Check printer selection, paper, connection and Windows printer status.", statusCode: StatusCodes.Status502BadGateway);
    }
});

if (OperatingSystem.IsWindows())
{
    try
    {
        var recovered = await queueStore.RecoverInterruptedSubmissionsAsync();
        if (recovered > 0) Console.WriteLine("Recovered interrupted ATK submissions; operator reconciliation is required: " + recovered);
    }
    catch (Exception ex) when (ex is CryptographicException or IOException or UnauthorizedAccessException)
    {
        Console.Error.WriteLine("Could not recover the protected fiscal queue. Fiscal submission remains disabled.");
    }
}


if (OperatingSystem.IsWindows())
{
    // Connectivity is probed independently of sales so Article 44's 48-hour
    // recovery clock starts when the ATK connection first becomes unavailable.
    app.Lifetime.ApplicationStarted.Register(() =>
    {
        _ = Task.Run(async () =>
        {
            using var timer = new PeriodicTimer(TimeSpan.FromSeconds(15));
            var stoppingToken = app.Lifetime.ApplicationStopping;
            var connectivity = new FiscalConnectivityMonitor(queueStore, async token =>
            {
                using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(5) };
                using var request = new HttpRequestMessage(HttpMethod.Head, AtkTestClient.TestBaseUri);
                using var response = await http.SendAsync(request, token);
                return (int)response.StatusCode < 500;
            });
            var delivery = new FiscalQueueDeliveryService(queueStore, async (signed, token) =>
            {
                using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(30) };
                return await new AtkTestClient(http).SubmitSignedPosCouponAsync(signed, token);
            });
            while (!stoppingToken.IsCancellationRequested)
            {
                try
                {
                    await connectivity.ProbeAsync(cancellationToken: stoppingToken);
                    await delivery.DeliverDueAsync(cancellationToken: stoppingToken);
                }
                catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { break; }
                catch (Exception ex) when (ex is IOException or CryptographicException or UnauthorizedAccessException or HttpRequestException)
                {
                    Console.Error.WriteLine("ATK connectivity/queue worker failed; signed fiscal records remain stored.");
                }

                try
                {
                    if (!await timer.WaitForNextTickAsync(stoppingToken)) break;
                }
                catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { break; }
            }
        }, app.Lifetime.ApplicationStopping);
    });
}

app.Run();

static bool IsDefinitelyNotSent(HttpRequestException exception) =>
    AtkTransportFailureClassifier.IsDefinitelyNotSent(exception);

static bool HasValidSession(HttpContext context, string? expectedToken)
{
    if (string.IsNullOrEmpty(expectedToken)) return false;
    var header = context.Request.Headers["Authorization"].ToString();
    if (!header.StartsWith("Bearer ", StringComparison.Ordinal)) return false;

    var supplied = Encoding.UTF8.GetBytes(header[7..].Trim());
    var expected = Encoding.UTF8.GetBytes(expectedToken);
    return supplied.Length == expected.Length &&
        CryptographicOperations.FixedTimeEquals(supplied, expected);
}

static string Base64Url(byte[] bytes) =>
    Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');

internal sealed record PairRequest(
    [property: JsonPropertyName("pairingCode")] string? PairingCode);

internal sealed record PairResponse(
    [property: JsonPropertyName("sessionToken")] string SessionToken,
    [property: JsonPropertyName("agentVersion")] string AgentVersion);


internal sealed record CsrRequest(
    [property: JsonPropertyName("businessName")] string BusinessName,
    [property: JsonPropertyName("businessNui")] ulong BusinessNui,
    [property: JsonPropertyName("branchId")] ulong BranchId,
    [property: JsonPropertyName("posId")] ulong PosId);

internal sealed record QueueReconcileRequest(
    [property: JsonPropertyName("idempotencyKey")] string IdempotencyKey,
    [property: JsonPropertyName("decision")] string Decision,
    [property: JsonPropertyName("atkTransactionId")] string? AtkTransactionId,
    [property: JsonPropertyName("operatorNote")] string? OperatorNote,
    [property: JsonPropertyName("confirmedNoAtkRecord")] bool ConfirmedNoAtkRecord);

internal sealed record AtkVerifyRequest(
    [property: JsonPropertyName("nui")] ulong Nui,
    [property: JsonPropertyName("fiscalizationNumber")] string FiscalizationNumber,
    [property: JsonPropertyName("posId")] ulong PosId,
    [property: JsonPropertyName("branchId")] ulong BranchId,
    [property: JsonPropertyName("applicationId")] ulong ApplicationId);

internal sealed record AtkSignCsrRequest(
    [property: JsonPropertyName("businessName")] string BusinessName,
    [property: JsonPropertyName("businessNui")] ulong BusinessNui,
    [property: JsonPropertyName("branchId")] ulong BranchId,
    [property: JsonPropertyName("verificationCode")] string VerificationCode,
    [property: JsonPropertyName("posId")] ulong PosId,
    [property: JsonPropertyName("applicationId")] ulong ApplicationId);

internal sealed record AtkCouponRequest(
    [property: JsonPropertyName("idempotencyKey")] string IdempotencyKey,
    [property: JsonPropertyName("coupon")] PosCouponInput Coupon);

internal sealed record AtkCorrectionRequest(
    [property: JsonPropertyName("idempotencyKey")] string IdempotencyKey,
    [property: JsonPropertyName("documentType")] string DocumentType,
    [property: JsonPropertyName("originalCouponId")] ulong OriginalCouponId,
    [property: JsonPropertyName("originalTransactionId")] string OriginalTransactionId,
    [property: JsonPropertyName("originalDetailsBase64")] string OriginalDetailsBase64,
    [property: JsonPropertyName("originalSignatureBase64")] string OriginalSignatureBase64,
    [property: JsonPropertyName("correctionCouponId")] ulong CorrectionCouponId,
    [property: JsonPropertyName("dailyNumber")] long DailyNumber);

internal sealed record PrinterPrintRequest(
    [property: JsonPropertyName("printerName")] string? PrinterName,
    [property: JsonPropertyName("networkHost")] string? NetworkHost,
    [property: JsonPropertyName("dataBase64")] string DataBase64);

internal sealed record PrinterTestRequest(
    [property: JsonPropertyName("printerName")] string? PrinterName,
    [property: JsonPropertyName("networkHost")] string? NetworkHost,
    [property: JsonPropertyName("paperWidthMm")] int PaperWidthMm);
