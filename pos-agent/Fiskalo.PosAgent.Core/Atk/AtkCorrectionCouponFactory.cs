using Atk;

namespace Fiskalo.PosAgent.Core.Atk;

/// <summary>
/// Creates immutable, full-document corrections from an accepted Sale coupon.
/// Partial returns require a separate refund calculation and must not use this helper.
/// </summary>
public static class AtkCorrectionCouponFactory
{
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
