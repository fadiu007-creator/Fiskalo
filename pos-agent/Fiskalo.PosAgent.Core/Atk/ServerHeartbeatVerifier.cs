using System.Security.Cryptography;
using System.Text;

namespace Fiskalo.PosAgent.Core.Atk;

/// <summary>
/// Verifies a server-authenticated connectivity heartbeat. The production public
/// key is pinned in the Agent; the corresponding private key is a Cloudflare secret.
/// </summary>
public sealed class ServerHeartbeatVerifier
{
    private const string ProductionPublicKeyBase64 =
        "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEk7Kh22GR/MCr1G1QizihiqiMMTcpBBbWA+xzJfXOLnQogcm5FstM26nOyg6hagbuhgNcksl7WAXVlbBWIfUqXA==";
    private readonly byte[] _publicKey;

    public ServerHeartbeatVerifier() : this(Convert.FromBase64String(ProductionPublicKeyBase64)) { }

    public ServerHeartbeatVerifier(byte[] subjectPublicKeyInfo)
    {
        ArgumentNullException.ThrowIfNull(subjectPublicKeyInfo);
        if (subjectPublicKeyInfo.Length is < 64 or > 512)
            throw new ArgumentException("Heartbeat public key has an invalid size.", nameof(subjectPublicKeyInfo));
        _publicKey = subjectPublicKeyInfo.ToArray();
        using var key = ECDsa.Create();
        key.ImportSubjectPublicKeyInfo(_publicKey, out var read);
        if (read != _publicKey.Length || key.KeySize != 256)
            throw new ArgumentException("Heartbeat key must be a complete P-256 SubjectPublicKeyInfo.", nameof(subjectPublicKeyInfo));
    }

    public static string CreateCanonicalMessage(
        string businessId,
        string posUuid,
        string nonce,
        long issuedAtUnixMilliseconds)
    {
        if (!Guid.TryParse(businessId, out var businessGuid))
            throw new ArgumentException("A valid business UUID is required.", nameof(businessId));
        if (!Guid.TryParse(posUuid, out var posGuid))
            throw new ArgumentException("A valid POS UUID is required.", nameof(posUuid));
        if (string.IsNullOrWhiteSpace(nonce) || nonce.Length != 43 ||
            nonce.Any(c => !(char.IsAsciiLetterOrDigit(c) || c is '-' or '_')))
            throw new ArgumentException("Heartbeat nonce must be a 32-byte base64url value.", nameof(nonce));
        if (issuedAtUnixMilliseconds <= 0)
            throw new ArgumentOutOfRangeException(nameof(issuedAtUnixMilliseconds));

        return string.Join("\n",
            "fiskalo-atk-heartbeat-v1",
            "ATK TEST",
            businessGuid.ToString("D").ToLowerInvariant(),
            posGuid.ToString("D").ToLowerInvariant(),
            nonce,
            issuedAtUnixMilliseconds.ToString(System.Globalization.CultureInfo.InvariantCulture));
    }

    public bool Verify(
        string businessId,
        string posUuid,
        string nonce,
        long issuedAtUnixMilliseconds,
        string signatureBase64)
    {
        if (string.IsNullOrWhiteSpace(signatureBase64)) return false;
        byte[] signature;
        try { signature = Convert.FromBase64String(signatureBase64); }
        catch (FormatException) { return false; }
        if (signature.Length != 64) return false;

        string message;
        try { message = CreateCanonicalMessage(businessId, posUuid, nonce, issuedAtUnixMilliseconds); }
        catch (ArgumentException) { return false; }

        using var key = ECDsa.Create();
        key.ImportSubjectPublicKeyInfo(_publicKey, out _);
        return key.VerifyData(
            Encoding.UTF8.GetBytes(message),
            signature,
            HashAlgorithmName.SHA256,
            DSASignatureFormat.IeeeP1363FixedFieldConcatenation);
    }
}
