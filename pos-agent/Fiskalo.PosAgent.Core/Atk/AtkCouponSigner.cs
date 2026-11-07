using System.Security.Cryptography;
using System.Text;
using Atk;
using Google.Protobuf;

namespace Fiskalo.PosAgent.Core.Atk;

public sealed record SignedAtkCoupon(string DetailsBase64, string SignatureBase64, string Sha256Hex)
{
    public string CitizenQrPayload { get; init; } = "";
}

public static class AtkCouponSigner
{
    public static SignedAtkCoupon SignPosCoupon(PosCoupon coupon, ECDsa privateKey)
    {
        ArgumentNullException.ThrowIfNull(coupon);
        ArgumentNullException.ThrowIfNull(privateKey);
        var details = Convert.ToBase64String(coupon.ToByteArray());
        var signature = SignBase64Payload(details, privateKey);
        var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(details))).ToLowerInvariant();
        return new SignedAtkCoupon(details, signature, hash);
    }

    public static SignedAtkCoupon SignCitizenCoupon(CitizenCoupon coupon, ECDsa privateKey)
    {
        ArgumentNullException.ThrowIfNull(coupon);
        ArgumentNullException.ThrowIfNull(privateKey);
        var details = Convert.ToBase64String(coupon.ToByteArray());
        var signature = SignBase64Payload(details, privateKey);
        var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(details))).ToLowerInvariant();
        return new SignedAtkCoupon(details, signature, hash) { CitizenQrPayload = details + "|" + signature };
    }

    public static CitizenCoupon CreateCitizenCoupon(PosCoupon pos)
    {
        ArgumentNullException.ThrowIfNull(pos);
        var citizen = new CitizenCoupon
        {
            BusinessId = pos.BusinessId,
            CouponId = pos.CouponId,
            BranchId = pos.BranchId,
            PosId = pos.PosId,
            VerificationNo = pos.VerificationNo,
            Type = pos.Type,
            Time = pos.Time,
            Total = pos.Total,
            TotalTax = pos.TotalTax,
            TotalNoTax = pos.TotalNoTax
        };
        citizen.TaxGroups.Add(pos.TaxGroups);
        return citizen;
    }

    private static string SignBase64Payload(string base64Payload, ECDsa privateKey)
    {
        var digest = SHA256.HashData(Encoding.UTF8.GetBytes(base64Payload));
        return Convert.ToBase64String(privateKey.SignHash(digest));
    }
}
