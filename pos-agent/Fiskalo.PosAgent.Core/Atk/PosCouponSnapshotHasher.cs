using System.Globalization;
using System.Security.Cryptography;
using System.Text;

namespace Fiskalo.PosAgent.Core.Atk;

public static class PosCouponSnapshotHasher
{
    public static string ComputeSha256(PosCouponInput input, string verificationNo)
    {
        ArgumentNullException.ThrowIfNull(input);
        if (string.IsNullOrWhiteSpace(verificationNo)) throw new ArgumentException("Verification number is required.", nameof(verificationNo));

        var fields = new List<string>
        {
            "FISKALO-ATK-SNAPSHOT-V1",
            input.BusinessId.ToString(CultureInfo.InvariantCulture),
            input.CouponId.ToString(CultureInfo.InvariantCulture),
            input.BranchId.ToString(CultureInfo.InvariantCulture),
            input.PosId.ToString(CultureInfo.InvariantCulture),
            input.ApplicationId.ToString(CultureInfo.InvariantCulture),
            input.UnixTime.ToString(CultureInfo.InvariantCulture),
            input.DailyNumber.ToString(CultureInfo.InvariantCulture),
            verificationNo.Trim(),
            ((int)input.Type).ToString(CultureInfo.InvariantCulture),
            input.Location.Trim(),
            input.OperatorId.Trim(),
            input.TotalCents.ToString(CultureInfo.InvariantCulture),
            input.TotalTaxCents.ToString(CultureInfo.InvariantCulture),
            input.TotalNoTaxCents.ToString(CultureInfo.InvariantCulture),
            input.TotalDiscountCents.ToString(CultureInfo.InvariantCulture),
            (input.ReferenceCouponId ?? 0).ToString(CultureInfo.InvariantCulture),
            input.Items.Count.ToString(CultureInfo.InvariantCulture)
        };

        var items = input.Items.Select(item => new[]
        {
            item.Name.Trim(),
            item.UnitPriceEuro.ToString("0.0000", CultureInfo.InvariantCulture),
            item.Unit.Trim(),
            item.Quantity.ToString("0.000", CultureInfo.InvariantCulture),
            item.LineTotalCents.ToString(CultureInfo.InvariantCulture),
            item.TaxRate,
            item.ItemType.Trim()
        }).Select(values => string.Join("\u001f", values))
          .OrderBy(value => value, StringComparer.Ordinal)
          .ToArray();
        fields.AddRange(items);

        fields.Add(input.Payments.Count.ToString(CultureInfo.InvariantCulture));
        fields.AddRange(input.Payments
            .OrderBy(payment => (int)payment.Type)
            .ThenBy(payment => payment.AmountCents)
            .Select(payment => string.Join("\u001f",
                ((int)payment.Type).ToString(CultureInfo.InvariantCulture),
                payment.AmountCents.ToString(CultureInfo.InvariantCulture))));

        fields.Add(input.TaxGroups.Count.ToString(CultureInfo.InvariantCulture));
        fields.AddRange(input.TaxGroups
            .OrderBy(group => group.TaxRate, StringComparer.Ordinal)
            .ThenBy(group => group.TotalForTaxCents)
            .Select(group => string.Join("\u001f",
                group.TaxRate,
                group.TotalForTaxCents.ToString(CultureInfo.InvariantCulture),
                group.TotalTaxCents.ToString(CultureInfo.InvariantCulture))));

        var canonical = string.Join("|", fields.Select(value =>
            Encoding.UTF8.GetByteCount(value).ToString(CultureInfo.InvariantCulture) + ":" + value));
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(canonical))).ToLowerInvariant();
    }
}
