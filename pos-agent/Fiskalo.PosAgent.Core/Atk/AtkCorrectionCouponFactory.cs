using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using Atk;
using Google.Protobuf;

namespace Fiskalo.PosAgent.Core.Atk;

/// <summary>
/// Creates immutable, full-document corrections from an accepted Sale coupon.
/// Partial returns require a separate refund calculation and must not use this helper.
/// </summary>
public static class AtkCorrectionCouponFactory
{

    public static PosCoupon CreateFromSignedOriginal(
        string originalDetailsBase64,
        string originalSignatureBase64,
        ECDsa certificatePublicKey,
        ulong expectedBusinessId,
        ulong expectedBranchId,
        ulong expectedPosId,
        ulong expectedApplicationId,
        ulong originalCouponId,
        ulong correctionCouponId,
        string originalTransactionId,
        string verificationNo,
        DateTimeOffset issuedAt,
        CouponType correctionType)
    {
        ArgumentNullException.ThrowIfNull(certificatePublicKey);
        if (string.IsNullOrWhiteSpace(originalDetailsBase64) ||
            string.IsNullOrWhiteSpace(originalSignatureBase64))
            throw new ArgumentException("The original signed ATK coupon is required.");
        if (expectedBusinessId == 0 || expectedBranchId == 0 ||
            expectedPosId == 0 || expectedApplicationId == 0)
            throw new ArgumentOutOfRangeException(nameof(expectedBusinessId), "Verified POS identity is required.");
        if (originalCouponId == 0)
            throw new ArgumentOutOfRangeException(nameof(originalCouponId));
        if (!ulong.TryParse(originalTransactionId, NumberStyles.None, CultureInfo.InvariantCulture, out var transactionId) ||
            transactionId == 0)
            throw new ArgumentException("The original sale must have a positive ATK transaction_id.", nameof(originalTransactionId));

        byte[] originalBytes;
        byte[] signatureBytes;
        try
        {
            originalBytes = Convert.FromBase64String(originalDetailsBase64);
            signatureBytes = Convert.FromBase64String(originalSignatureBase64);
        }
        catch (FormatException ex)
        {
            throw new ArgumentException("The original ATK coupon or signature is not valid Base64.", ex);
        }

        var digest = SHA256.HashData(Encoding.UTF8.GetBytes(originalDetailsBase64));
        if (!certificatePublicKey.VerifyHash(digest, signatureBytes))
            throw new CryptographicException("The original sale signature does not match this POS certificate.");

        PosCoupon original;
        try
        {
            original = PosCoupon.Parser.ParseFrom(originalBytes);
        }
        catch (InvalidProtocolBufferException ex)
        {
            throw new ArgumentException("The original signed payload is not a valid ATK PosCoupon.", ex);
        }

        if (original.BusinessId != expectedBusinessId ||
            original.BranchId != expectedBranchId ||
            original.PosId != expectedPosId ||
            original.ApplicationId != expectedApplicationId ||
            original.CouponId != originalCouponId)
            throw new ArgumentException("The original signed coupon does not match the verified POS and original coupon identifiers.");
        if (original.Type != CouponType.Sale || original.ReferenceNo != 0)
            throw new ArgumentException("Only an original Sale coupon can be fully cancelled or returned.");
        if (!FiscalReceiptIdentity.IsValidNuiKf(original.VerificationNo))
            throw new ArgumentException("The original sale does not contain a valid 16-character NUIKF.");
        if (correctionType is not (CouponType.Cancel or CouponType.Return))
            throw new ArgumentException("Correction type must be Cancel or Return.", nameof(correctionType));

        return correctionType switch
        {
            CouponType.Cancel => CreateFullCancellation(original, correctionCouponId, verificationNo, issuedAt),
            CouponType.Return => CreateFullReturn(original, correctionCouponId, verificationNo, issuedAt),
            _ => throw new ArgumentOutOfRangeException(nameof(correctionType))
        };
    }

    public static PosCoupon CreateFullCancellation(
        PosCoupon acceptedSale,
        ulong correctionCouponId,
        string verificationNo,
        DateTimeOffset issuedAt) =>
        CreateFullCorrection(acceptedSale, correctionCouponId, verificationNo, issuedAt, CouponType.Cancel);

    public static PosCoupon CreateFullReturn(
        PosCoupon acceptedSale,
        ulong correctionCouponId,
        string verificationNo,
        DateTimeOffset issuedAt) =>
        CreateFullCorrection(acceptedSale, correctionCouponId, verificationNo, issuedAt, CouponType.Return);

    private static PosCoupon CreateFullCorrection(
        PosCoupon acceptedSale,
        ulong correctionCouponId,
        string verificationNo,
        DateTimeOffset issuedAt,
        CouponType correctionType)
    {
        ArgumentNullException.ThrowIfNull(acceptedSale);

        if (acceptedSale.Type != CouponType.Sale)
            throw new ArgumentException("A correction must reference an original Sale coupon.", nameof(acceptedSale));
        if (acceptedSale.BusinessId == 0 || acceptedSale.CouponId == 0 ||
            acceptedSale.BranchId == 0 || acceptedSale.PosId == 0 || acceptedSale.ApplicationId == 0)
            throw new ArgumentException("The original Sale coupon must contain complete ATK business, branch, POS, application and coupon identifiers.", nameof(acceptedSale));
        if (correctionCouponId == 0 || correctionCouponId == acceptedSale.CouponId)
            throw new ArgumentOutOfRangeException(nameof(correctionCouponId), "The correction needs its own non-zero coupon ID.");
        if (!FiscalReceiptIdentity.IsValidNuiKf(verificationNo))
            throw new ArgumentException("The correction needs a unique 16-character uppercase alphanumeric NUIKF.", nameof(verificationNo));
        if (issuedAt.Offset != TimeSpan.Zero)
            throw new ArgumentException("Correction issue time must be supplied in UTC.", nameof(issuedAt));

        // Protobuf Clone preserves the original tax groups, items and payment allocations.
        // TransactionNo is assigned by ATK in its response and must not be copied into
        // the newly submitted correction request.
        var correction = acceptedSale.Clone();
        correction.CouponId = correctionCouponId;
        correction.ReferenceNo = acceptedSale.CouponId;
        correction.VerificationNo = verificationNo;
        correction.Type = correctionType;
        correction.Time = issuedAt.ToUnixTimeSeconds();
        correction.TransactionNo = 0;
        return correction;
    }
}
