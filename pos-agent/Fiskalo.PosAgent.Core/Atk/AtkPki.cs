using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;

namespace Fiskalo.PosAgent.Core.Atk;

public static class AtkPki
{
    public static ECDsa GenerateP256Key() => ECDsa.Create(ECCurve.NamedCurves.nistP256);

    public static string CreateCsrPem(ECDsa privateKey, string businessName, ulong businessNui, ulong branchId, ulong posId)
    {
        ArgumentNullException.ThrowIfNull(privateKey);
        if (string.IsNullOrWhiteSpace(businessName)) throw new ArgumentException("Business name is required.", nameof(businessName));
        if (businessNui == 0 || branchId == 0 || posId == 0) throw new ArgumentOutOfRangeException(nameof(businessNui));
        var subject = new X500DistinguishedName(
            "C=RKS, O=" + businessNui + ", OU=" + posId + ", L=" + branchId + ", CN=" + EscapeDn(businessName));
        var request = new CertificateRequest(subject, privateKey, HashAlgorithmName.SHA256);
        return request.CreateSigningRequestPem();
    }

    // The caller must provide an OS-protected local key handle. This library never persists private keys.
    private static string EscapeDn(string value) => value
        .Replace("\\", "\\\\", StringComparison.Ordinal)
        .Replace(",", "\\,", StringComparison.Ordinal)
        .Replace("+", "\\+", StringComparison.Ordinal)
        .Replace("\"", "\\\"", StringComparison.Ordinal)
        .Replace("<", "\\<", StringComparison.Ordinal)
        .Replace(">", "\\>", StringComparison.Ordinal)
        .Replace(";", "\\;", StringComparison.Ordinal)
        .Trim();
}
