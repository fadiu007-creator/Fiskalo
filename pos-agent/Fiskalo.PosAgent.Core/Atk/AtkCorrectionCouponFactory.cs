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
        ArgumentException.ThrowIfNullOrWhiteSpace(verificationNo);

        if (acceptedSale.Type != CouponType.Sale)
            throw new ArgumentException("A correction must reference an original Sale coupon.", nameof(acceptedSale));
        if (acceptedSale.CouponId == 0)
            throw new ArgumentException("The original Sale coupon must have a non-zero coupon ID.", nameof(acceptedSale));
        if (correctionCouponId == 0 || correctionCouponId == acceptedSale.CouponId)
            throw new ArgumentOutOfRangeException(nameof(correctionCouponId), "The correction needs its own non-zero coupon ID.");
        if (verificationNo.Length > 16)
            throw new ArgumentOutOfRangeException(nameof(verificationNo), "ATK verification numbers must not exceed 16 characters.");
        if (issuedAt.Offset != TimeSpan.Zero)
            throw new ArgumentException("Correction issue time must be supplied in UTC.", nameof(issuedAt));

        // Protobuf Clone preserves the original tax groups, items and payment allocations.
        // The original object is never mutated; the new document links to it through ReferenceNo.
        var correction = acceptedSale.Clone();
        correction.CouponId = correctionCouponId;
        correction.ReferenceNo = acceptedSale.CouponId;
        correction.VerificationNo = verificationNo;
        correction.Type = correctionType;
        correction.Time = issuedAt.ToUnixTimeSeconds();
        return correction;
    }
}
