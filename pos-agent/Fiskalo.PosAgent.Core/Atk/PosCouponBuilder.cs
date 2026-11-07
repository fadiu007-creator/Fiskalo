using Atk;

namespace Fiskalo.PosAgent.Core.Atk;

public sealed record PosCouponItemInput(
    string Name, decimal UnitPriceEuro, string Unit, decimal Quantity,
    long LineTotalCents, string TaxRate, string ItemType);

public sealed record PosCouponPaymentInput(PaymentType Type, long AmountCents);
public sealed record PosCouponTaxGroupInput(string TaxRate, long TotalForTaxCents, long TotalTaxCents);

public sealed record PosCouponInput(
    ulong BusinessId, ulong CouponId, ulong BranchId, string Location, string OperatorId,
    ulong PosId, ulong ApplicationId, string VerificationNo, CouponType Type, long UnixTime,
    IReadOnlyList<PosCouponItemInput> Items, IReadOnlyList<PosCouponPaymentInput> Payments,
    long TotalCents, IReadOnlyList<PosCouponTaxGroupInput> TaxGroups,
    long TotalTaxCents, long TotalNoTaxCents, long TotalDiscountCents,
    ulong? ReferenceCouponId = null);

public static class PosCouponBuilder
{
    public static PosCoupon Build(PosCouponInput input)
    {
        ArgumentNullException.ThrowIfNull(input);
        if (input.BusinessId == 0 || input.CouponId == 0 || input.BranchId == 0 ||
            input.PosId == 0 || input.ApplicationId == 0 || input.UnixTime <= 0)
            throw new ArgumentException("Business, coupon, branch, POS and application IDs and Unix time must be valid.");
        if (string.IsNullOrWhiteSpace(input.Location) || string.IsNullOrWhiteSpace(input.OperatorId))
            throw new ArgumentException("Location and operator ID are required.");
        if (string.IsNullOrWhiteSpace(input.VerificationNo) || input.VerificationNo.Length > 16)
            throw new ArgumentException("Verification number must contain 1 to 16 characters.");
        if (input.Type == CouponType.UnknownType)
            throw new ArgumentException("Coupon type is required.");
        if (input.Type == CouponType.Sale && input.ReferenceCouponId.HasValue)
            throw new ArgumentException("A sale coupon must not reference another coupon.");
        if (input.Type is CouponType.Cancel or CouponType.Return &&
            (!input.ReferenceCouponId.HasValue || input.ReferenceCouponId.Value == 0))
            throw new ArgumentException("Cancel and return coupons must reference the original coupon.");

        if (input.Items is null || input.Items.Count == 0) throw new ArgumentException("At least one item is required.");
        if (input.Payments is null || input.Payments.Count == 0) throw new ArgumentException("At least one payment is required.");
        if (input.TaxGroups is null || input.TaxGroups.Count == 0) throw new ArgumentException("At least one tax group is required.");
        if (input.TotalCents < 0 || input.TotalTaxCents < 0 || input.TotalNoTaxCents < 0 || input.TotalDiscountCents < 0)
            throw new ArgumentOutOfRangeException(nameof(input), "Coupon monetary totals cannot be negative.");

        var itemTotal = input.Items.Sum(x => x.LineTotalCents);
        var paymentTotal = input.Payments.Sum(x => x.AmountCents);
        var taxBaseTotal = input.TaxGroups.Sum(x => x.TotalForTaxCents);
        var taxAmountTotal = input.TaxGroups.Sum(x => x.TotalTaxCents);

        if (input.Items.Any(x => string.IsNullOrWhiteSpace(x.Name) || string.IsNullOrWhiteSpace(x.Unit) ||
            string.IsNullOrWhiteSpace(x.ItemType) || x.TaxRate.Length != 1 || x.Quantity <= 0 ||
            x.LineTotalCents < 0 || x.UnitPriceEuro < 0))
            throw new ArgumentException("Every item needs a name, ATK unit/category/tax code, positive quantity and non-negative price.");
        if (input.Payments.Any(x => x.Type == PaymentType.UnknownPayment || x.AmountCents < 0))
            throw new ArgumentException("Every payment needs a valid ATK payment type and non-negative amount.");
        if (input.TaxGroups.Any(x => x.TaxRate.Length != 1 || x.TotalForTaxCents < 0 || x.TotalTaxCents < 0))
            throw new ArgumentException("Tax groups need a one-character ATK tax code and non-negative amounts.");

        if (itemTotal - input.TotalDiscountCents != input.TotalCents)
            throw new ArgumentException("Item totals minus discount must equal the coupon total.");
        if (paymentTotal != input.TotalCents)
            throw new ArgumentException("Payment amounts must equal the coupon total.");
        if (input.TotalNoTaxCents + input.TotalTaxCents != input.TotalCents)
            throw new ArgumentException("Net amount plus tax must equal the coupon total.");
        if (taxBaseTotal != input.TotalNoTaxCents || taxAmountTotal != input.TotalTaxCents)
            throw new ArgumentException("Tax-group totals must reconcile with coupon net and tax totals.");

        var coupon = new PosCoupon
        {
            BusinessId = input.BusinessId,
            CouponId = input.CouponId,
            BranchId = input.BranchId,
            Location = input.Location.Trim(),
            OperatorId = input.OperatorId.Trim(),
            PosId = input.PosId,
            ApplicationId = input.ApplicationId,
            VerificationNo = input.VerificationNo,
            Type = input.Type,
            Time = input.UnixTime,
            Total = input.TotalCents,
            TotalTax = input.TotalTaxCents,
            TotalNoTax = input.TotalNoTaxCents,
            TotalDiscount = input.TotalDiscountCents,
            ReferenceNo = input.ReferenceCouponId ?? 0
        };

        foreach (var item in input.Items)
        {
            var quantity = (float)item.Quantity;
            if (!float.IsFinite(quantity)) throw new ArgumentException("Item quantity is outside the supported Protobuf float range.");
            coupon.Items.Add(new CouponItem
            {
                Name = item.Name.Trim(),
                Price = AtkMoney.ToUnitPrice(item.UnitPriceEuro),
                Unit = item.Unit.Trim(),
                Quantity = quantity,
                Total = item.LineTotalCents,
                TaxRate = item.TaxRate,
                Type = item.ItemType
            });
        }

        foreach (var payment in input.Payments)
            coupon.Payments.Add(new Payment { Type = payment.Type, Amount = payment.AmountCents });

        foreach (var group in input.TaxGroups)
            coupon.TaxGroups.Add(new TaxGroup
            {
                TaxRate = group.TaxRate,
                TotalForTax = group.TotalForTaxCents,
                TotalTax = group.TotalTaxCents
            });

        return coupon;
    }
}
