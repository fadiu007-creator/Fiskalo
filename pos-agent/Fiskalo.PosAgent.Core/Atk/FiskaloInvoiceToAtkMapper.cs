using Atk;

namespace Fiskalo.PosAgent.Core.Atk;

/// <summary>
/// An issued Fiskalo invoice line plus ATK catalogue codes explicitly selected
/// from the current ATK catalogue. Codes are never inferred from VAT percentages.
/// Monetary line values are the persisted Fiskalo values, not recalculated here.
/// </summary>
public sealed record FiskaloFiscalLine(
    string Description,
    decimal Quantity,
    decimal UnitPriceEuro,
    decimal NetAmountEuro,
    decimal VatAmountEuro,
    string AtkUnitCode,
    string AtkTaxCode,
    string AtkItemTypeCode);

public sealed record FiskaloFiscalInvoice(
    string Status,
    ulong BusinessNui,
    ulong CouponId,
    ulong BranchId,
    string Location,
    string OperatorId,
    ulong PosId,
    ulong ApplicationId,
    string VerificationNumber,
    DateTimeOffset IssuedAt,
    decimal SubtotalEuro,
    decimal VatTotalEuro,
    decimal TotalEuro,
    IReadOnlyList<FiskaloFiscalLine> Lines,
    IReadOnlyList<PosCouponPaymentInput> Payments);

/// <summary>
/// Maps an already-issued Fiskalo invoice into the ATK coupon contract.
/// The caller must supply current ATK unit, tax and item-type catalogue codes
/// and explicit payment allocations. No tax rule or payment type is guessed.
/// </summary>
public static class FiskaloInvoiceToAtkMapper
{
    public static PosCouponInput Map(
        FiskaloFiscalInvoice invoice,
        CouponType couponType = CouponType.Sale,
        ulong? originalCouponId = null)
    {
        ArgumentNullException.ThrowIfNull(invoice);
        if (!string.Equals(invoice.Status, "issued", StringComparison.OrdinalIgnoreCase))
            throw new ArgumentException("Only an issued Fiskalo invoice can be mapped to an ATK coupon.");
        if (invoice.BusinessNui == 0 || invoice.CouponId == 0 || invoice.BranchId == 0 ||
            invoice.PosId == 0 || invoice.ApplicationId == 0)
            throw new ArgumentException("Business NUI, coupon, branch, POS and application identifiers are required.");
        if (couponType == CouponType.UnknownType)
            throw new ArgumentException("An ATK coupon type is required.", nameof(couponType));
        if (couponType == CouponType.Sale && originalCouponId.HasValue)
            throw new ArgumentException("A Sale coupon cannot reference an original coupon.", nameof(originalCouponId));
        if (couponType is CouponType.Cancel or CouponType.Return &&
            (!originalCouponId.HasValue || originalCouponId.Value == 0))
            throw new ArgumentException("Cancel and Return coupons must reference the original ATK coupon.", nameof(originalCouponId));
        if (invoice.Lines is null || invoice.Lines.Count == 0)
            throw new ArgumentException("The invoice must contain at least one line.");
        if (invoice.Payments is null || invoice.Payments.Count == 0)
            throw new ArgumentException("Explicit ATK payment allocations are required.");
        if (invoice.SubtotalEuro < 0 || invoice.VatTotalEuro < 0 || invoice.TotalEuro < 0)
            throw new ArgumentException("Invoice totals cannot be negative.");

        var net = invoice.Lines.Sum(line => line.NetAmountEuro);
        var vat = invoice.Lines.Sum(line => line.VatAmountEuro);
        var gross = net + vat;
        if (ToCents(net) != ToCents(invoice.SubtotalEuro) ||
            ToCents(vat) != ToCents(invoice.VatTotalEuro) ||
            ToCents(gross) != ToCents(invoice.TotalEuro))
            throw new ArgumentException("Persisted invoice line totals do not reconcile with the invoice header.");

        var items = invoice.Lines.Select(line =>
        {
            if (string.IsNullOrWhiteSpace(line.Description) ||
                string.IsNullOrWhiteSpace(line.AtkUnitCode) ||
                string.IsNullOrWhiteSpace(line.AtkTaxCode) ||
                string.IsNullOrWhiteSpace(line.AtkItemTypeCode))
                throw new ArgumentException("Each invoice line requires explicit ATK unit, tax and item-type catalogue codes.");
            if (line.Quantity <= 0 || line.UnitPriceEuro < 0 || line.NetAmountEuro < 0 || line.VatAmountEuro < 0)
                throw new ArgumentException("Invoice line quantities and monetary values are invalid.");
            return new PosCouponItemInput(
                line.Description,
                line.UnitPriceEuro,
                line.AtkUnitCode,
                line.Quantity,
                ToCents(line.NetAmountEuro + line.VatAmountEuro),
                line.AtkTaxCode,
                line.AtkItemTypeCode);
        }).ToArray();

        var taxGroups = invoice.Lines
            .GroupBy(line => line.AtkTaxCode, StringComparer.Ordinal)
            .Select(group => new PosCouponTaxGroupInput(
                group.Key,
                group.Sum(line => ToCents(line.NetAmountEuro)),
                group.Sum(line => ToCents(line.VatAmountEuro))))
            .ToArray();

        var totalCents = ToCents(invoice.TotalEuro);
        if (invoice.Payments.Sum(payment => payment.AmountCents) != totalCents)
            throw new ArgumentException("Explicit ATK payment allocations must equal the issued invoice total.");

        return new PosCouponInput(
            invoice.BusinessNui,
            invoice.CouponId,
            invoice.BranchId,
            invoice.Location,
            invoice.OperatorId,
            invoice.PosId,
            invoice.ApplicationId,
            invoice.VerificationNumber,
            couponType,
            invoice.IssuedAt.ToUnixTimeSeconds(),
            items,
            invoice.Payments,
            totalCents,
            taxGroups,
            ToCents(invoice.VatTotalEuro),
            ToCents(invoice.SubtotalEuro),
            0,
            originalCouponId);
    }

    private static long ToCents(decimal euro) =>
        decimal.ToInt64(decimal.Round(euro * 100m, 0, MidpointRounding.AwayFromZero));
}
