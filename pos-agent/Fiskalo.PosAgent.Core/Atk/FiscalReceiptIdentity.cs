using System.Security.Cryptography;
using System.Text;
using Atk;
using Google.Protobuf;

namespace Fiskalo.PosAgent.Core.Atk;

/// <summary>
/// Generates the per-coupon NUIKF/VerificationNo required by the current ATK SEF
/// technical specification: unique, alphanumeric, no separators, max 16 characters.
/// </summary>
public static class FiscalReceiptIdentity
{
    private const string Alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    public const int NuiKfLength = 16;

    public static string CreateNuiKf()
    {
        Span<byte> random = stackalloc byte[32];
        Span<char> result = stackalloc char[NuiKfLength];
        var written = 0;
        while (written < result.Length)
        {
            RandomNumberGenerator.Fill(random);
            foreach (var value in random)
            {
                // Reject the top four values to avoid modulo bias (256 mod 36 = 4).
                if (value >= 252) continue;
                result[written++] = Alphabet[value % Alphabet.Length];
                if (written == result.Length) break;
            }
        }
        return new string(result);
    }

    public static bool IsValidNuiKf(string? value) =>
        value is { Length: NuiKfLength } &&
        value.All(c => c is >= '0' and <= '9' or >= 'A' and <= 'Z');

    public static bool IsPosCouponPayload(string? posPayloadBase64)
    {
        if (string.IsNullOrWhiteSpace(posPayloadBase64)) return false;
        try
        {
            var pos = PosCoupon.Parser.ParseFrom(Convert.FromBase64String(posPayloadBase64));
            return pos.BusinessId > 0 && pos.CouponId > 0;
        }
        catch (Exception ex) when (ex is FormatException or InvalidProtocolBufferException)
        {
            return false;
        }
    }

    public static bool IsNuiKfEmbeddedInSignedCoupons(
        string? posPayloadBase64,
        string? citizenPayloadBase64,
        string? nuiKf)
    {
        if (!IsValidNuiKf(nuiKf) ||
            string.IsNullOrWhiteSpace(posPayloadBase64) ||
            string.IsNullOrWhiteSpace(citizenPayloadBase64))
            return false;

        try
        {
            var pos = PosCoupon.Parser.ParseFrom(Convert.FromBase64String(posPayloadBase64));
            var citizen = CitizenCoupon.Parser.ParseFrom(Convert.FromBase64String(citizenPayloadBase64));
            return pos.VerificationNo == nuiKf &&
                   citizen.VerificationNo == nuiKf &&
                   pos.BusinessId == citizen.BusinessId &&
                   pos.CouponId == citizen.CouponId &&
                   pos.BranchId == citizen.BranchId &&
                   pos.PosId == citizen.PosId;
        }
        catch (Exception ex) when (ex is FormatException or InvalidProtocolBufferException)
        {
            return false;
        }
    }

    public static string BuildCitizenQrPayload(SignedAtkCoupon signedCitizenCoupon)
    {
        ArgumentNullException.ThrowIfNull(signedCitizenCoupon);
        if (string.IsNullOrWhiteSpace(signedCitizenCoupon.DetailsBase64) ||
            string.IsNullOrWhiteSpace(signedCitizenCoupon.SignatureBase64))
            throw new ArgumentException("Citizen coupon data and digital signature are required.", nameof(signedCitizenCoupon));
        return signedCitizenCoupon.DetailsBase64 + "|" + signedCitizenCoupon.SignatureBase64;
    }
}
