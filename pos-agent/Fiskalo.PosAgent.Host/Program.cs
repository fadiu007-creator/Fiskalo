using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.Json.Serialization;
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
const string PrintersPath = "/api/v1/printers";
const string PrinterPrintPath = "/api/v1/printers/print";
const string PrinterTestPath = "/api/v1/printers/test";

var allowedOrigins = (Environment.GetEnvironmentVariable("FISKALO_ALLOWED_ORIGINS")
    ?? "https://fiskalo.shqiptare.workers.dev")
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
        var visible = items.Select(item => new
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
            recoveryDeadlineExceeded = item.Status is FiscalQueueStatus.Queued or FiscalQueueStatus.NeedsReconciliation &&
                item.RecoveryDeadlineUtc <= now
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
        var coupon = PosCouponBuilder.Build(request.Coupon);
        if (coupon.BusinessId != installation.Nui || coupon.BranchId != installation.BranchId ||
            coupon.PosId != installation.PosId || coupon.ApplicationId != installation.ApplicationId ||
            !string.Equals(coupon.VerificationNo, installation.VerificationCode, StringComparison.Ordinal))
            return Results.BadRequest(new { error = "coupon_identity_does_not_match_verified_pos_installation" });
        var expectedIdempotencyKey = coupon.BusinessId + ":" + coupon.BranchId + ":" + coupon.PosId + ":" + coupon.CouponId;
        if (!string.Equals(request.IdempotencyKey, expectedIdempotencyKey, StringComparison.Ordinal)) return Results.BadRequest(new { error = "idempotencyKey_must_match_business_branch_pos_coupon_ids", expected = expectedIdempotencyKey });
        var signed = AtkCouponSigner.SignPosCoupon(coupon, key);
        var existing = (await queueStore.GetAllAsync(cancellationToken)).SingleOrDefault(x => x.IdempotencyKey == request.IdempotencyKey);
        if (existing is not null && (existing.PayloadBase64 != signed.DetailsBase64 || existing.DocumentType != coupon.Type.ToString()))
            return Results.Conflict(new { error = "idempotency_key_reused_with_different_coupon_content" });
        if (existing?.Status == FiscalQueueStatus.Accepted) return Results.Ok(new { status = "accepted", transactionId = existing.AtkTransactionId, duplicateRequest = true, environment = "ATK TEST" });
        if (existing is not null && existing.Status != FiscalQueueStatus.Queued) return Results.Conflict(new { status = existing.Status.ToString(), error = "document_requires_reconciliation_or_operator_review", existing.LastError });
        if (existing is null) await queueStore.EnqueueAsync(request.IdempotencyKey, coupon.Type.ToString(), signed.DetailsBase64, signed.SignatureBase64, cancellationToken: cancellationToken);
        var persisted = existing ?? (await queueStore.GetAllAsync(cancellationToken)).Single(x => x.IdempotencyKey == request.IdempotencyKey);
        var signedToSubmit = new SignedAtkCoupon(persisted.PayloadBase64, persisted.SignatureBase64, "");
        await queueStore.MarkSubmittingAsync(request.IdempotencyKey, cancellationToken);
        try {
            using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(30) };
            var result = await new AtkTestClient(http).SubmitSignedPosCouponAsync(signedToSubmit, cancellationToken);
            await queueStore.MarkAcceptedAsync(request.IdempotencyKey, result.TransactionId.ToString(), cancellationToken);
            return Results.Ok(new { status = "accepted", transactionId = result.TransactionId, message = result.Message, environment = "ATK TEST", productionEnabled = false });
        } catch (AtkApiException ex) when ((int)ex.StatusCode >= 400 && (int)ex.StatusCode < 500) {
            await queueStore.MarkRejectedAsync(request.IdempotencyKey, "ATK rejected the test coupon with HTTP " + (int)ex.StatusCode, cancellationToken);
            return Results.Problem("ATK rejected the test coupon (HTTP " + (int)ex.StatusCode + "). Review the payload and ATK response before creating a corrected test document.", statusCode: StatusCodes.Status422UnprocessableEntity);
        } catch (Exception ex) when (ex is AtkApiException or HttpRequestException or TaskCanceledException) {
            await queueStore.MarkNeedsReconciliationAsync(request.IdempotencyKey, "Submission outcome is uncertain. Check ATK test records before any retry.", cancellationToken);
            return Results.Problem("ATK submission outcome is uncertain. The document is locked for reconciliation to prevent duplicate fiscalization.", statusCode: StatusCodes.Status502BadGateway);
        }
    } catch (ArgumentException ex) {
        return Results.BadRequest(new { error = ex.Message });
    } catch (InvalidOperationException ex) {
        return Results.Conflict(new { error = ex.Message });
    } catch (CryptographicException) {
        return Results.Problem("Local test certificate or signing key could not be validated.", statusCode: StatusCodes.Status500InternalServerError);
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
    // Deliver durable, previously-unsent fiscal records automatically after
    // connectivity returns. Ambiguous in-flight submissions are moved to
    // NeedsReconciliation and are deliberately excluded from this worker.
    app.Lifetime.ApplicationStarted.Register(() =>
    {
        _ = Task.Run(async () =>
        {
            using var timer = new PeriodicTimer(TimeSpan.FromSeconds(15));
            var stoppingToken = app.Lifetime.ApplicationStopping;
            while (!stoppingToken.IsCancellationRequested)
            {
                try
                {
                    var dueItems = await queueStore.GetDueAsync(cancellationToken: stoppingToken);
                    foreach (var item in dueItems)
                    {
                        try
                        {
                            // Atomic state transition prevents two workers or a
                            // foreground request from submitting the same item.
                            await queueStore.MarkSubmittingAsync(item.IdempotencyKey, stoppingToken);
                            using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(30) };
                            var signed = new SignedAtkCoupon(item.PayloadBase64, item.SignatureBase64, "");
                            var result = await new AtkTestClient(http).SubmitSignedPosCouponAsync(signed, stoppingToken);
                            await queueStore.MarkAcceptedAsync(item.IdempotencyKey, result.TransactionId.ToString(), stoppingToken);
                            Console.WriteLine("ATK TEST queued document accepted: " + item.IdempotencyKey);
                        }
                        catch (AtkApiException ex) when ((int)ex.StatusCode >= 400 && (int)ex.StatusCode < 500)
                        {
                            await queueStore.MarkRejectedAsync(item.IdempotencyKey,
                                "ATK rejected the queued test coupon with HTTP " + (int)ex.StatusCode, stoppingToken);
                        }
                        catch (Exception ex) when (ex is AtkApiException or HttpRequestException or TaskCanceledException or IOException)
                        {
                            // A timeout or dropped connection can happen after ATK
                            // received the request. Never auto-resubmit an uncertain
                            // transaction; require reconciliation against ATK first.
                            await queueStore.MarkNeedsReconciliationAsync(item.IdempotencyKey,
                                "Automatic delivery outcome is uncertain. Check ATK before retrying.", stoppingToken);
                        }
                    }
                }
                catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { break; }
                catch (Exception ex) when (ex is IOException or CryptographicException or UnauthorizedAccessException)
                {
                    Console.Error.WriteLine("Fiscal queue worker could not access the protected queue; records remain stored.");
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

internal sealed record PrinterPrintRequest(
    [property: JsonPropertyName("printerName")] string? PrinterName,
    [property: JsonPropertyName("networkHost")] string? NetworkHost,
    [property: JsonPropertyName("dataBase64")] string DataBase64);

internal sealed record PrinterTestRequest(
    [property: JsonPropertyName("printerName")] string? PrinterName,
    [property: JsonPropertyName("networkHost")] string? NetworkHost,
    [property: JsonPropertyName("paperWidthMm")] int PaperWidthMm);
