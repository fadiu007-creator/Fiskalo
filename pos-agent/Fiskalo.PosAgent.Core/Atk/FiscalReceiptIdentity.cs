using System.Security.Cryptography;
using System.Text;

namespace Fiskalo.PosAgent.Core.Atk;

/// <summary>Creates the 16-character, uppercase alphanumeric NUIKF used on fiscal receipts.</summary>
public static class FiscalReceiptIdentity
{
    private const string Alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

    public static string CreateNuiKf()
    {
        Span<byte> random = stackalloc byte[32];
        Span<char> result = stackalloc char[16];
        var written = 0;
        while (written < result.Length)
        {
            RandomNumberGenerator.Fill(random);
            foreach (var value in random)
            {
                // Reject the top two values to avoid modulo bias (256 mod 36 = 4).
                if (value >= 252) continue;
                result[written++] = Alphabet[value % Alphabet.Length];
                if (written == result.Length) break;
            }
        }
        return new string(result);
    }

    public static bool IsValidNuiKf(string? value) =>
        value is { Length: 16 } && value.All(c => c is >= '0' and <= '9' or >= 'A' and <= 'Z');

    public static string BuildCitizenQrPayload(SignedAtkCoupon signedCitizenCoupon)
    {
        ArgumentNullException.ThrowIfNull(signedCitizenCoupon);
        if (string.IsNullOrWhiteSpace(signedCitizenCoupon.DetailsBase64) ||
            string.IsNullOrWhiteSpace(signedCitizenCoupon.SignatureBase64))
            throw new ArgumentException("Citizen coupon data and digital signature are required.", nameof(signedCitizenCoupon));
        return signedCitizenCoupon.DetailsBase64 + "|" + signedCitizenCoupon.SignatureBase64;
    }
}
