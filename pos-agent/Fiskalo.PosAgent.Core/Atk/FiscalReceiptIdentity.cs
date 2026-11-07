using System.Globalization;
using System.Text;

namespace Fiskalo.PosAgent.Core.Atk;

/// <summary>
/// Creates the ATK SEF NUIKF:
/// 10-digit ATK fiscalization number + 4-digit business-unit code +
/// local issue timestamp DDMMYYYYHHMMSS, without separators.
/// </summary>
public static class FiscalReceiptIdentity
{
    public const int NuiKfLength = 28;

    public static string CreateNuiKf(string fiscalizationNumber, ulong branchId, long unixTime)
    {
        if (fiscalizationNumber is null || fiscalizationNumber.Length != 10 ||
            fiscalizationNumber.Any(c => c is < '0' or > '9'))
            throw new ArgumentException(
                "ATK fiscalization number must contain exactly 10 digits to create a valid NUIKF.",
                nameof(fiscalizationNumber));
        if (branchId > 9999)
            throw new ArgumentOutOfRangeException(nameof(branchId),
                "ATK business-unit code must fit the four-digit NUIKF field.");
        if (unixTime <= 0)
            throw new ArgumentOutOfRangeException(nameof(unixTime));

        var utc = DateTimeOffset.FromUnixTimeSeconds(unixTime);
        var local = TimeZoneInfo.ConvertTime(utc, KosovoTimeZone());
        var timestamp = local.ToString("ddMMyyyyHHmmss", CultureInfo.InvariantCulture);
        var result = fiscalizationNumber +
                     branchId.ToString("D4", CultureInfo.InvariantCulture) +
                     timestamp;

        if (!IsValidNuiKf(result))
            throw new InvalidOperationException("Generated NUIKF does not match the ATK SEF format.");
        return result;
    }

    public static bool IsValidNuiKf(string? value) =>
        value is { Length: NuiKfLength } && value.All(c => c is >= '0' and <= '9');

    public static string BuildCitizenQrPayload(SignedAtkCoupon signedCitizenCoupon)
    {
        ArgumentNullException.ThrowIfNull(signedCitizenCoupon);
        if (string.IsNullOrWhiteSpace(signedCitizenCoupon.DetailsBase64) ||
            string.IsNullOrWhiteSpace(signedCitizenCoupon.SignatureBase64))
            throw new ArgumentException("Citizen coupon data and digital signature are required.", nameof(signedCitizenCoupon));
        return signedCitizenCoupon.DetailsBase64 + "|" + signedCitizenCoupon.SignatureBase64;
    }

    private static TimeZoneInfo KosovoTimeZone()
    {
        try
        {
            return TimeZoneInfo.FindSystemTimeZoneById("Europe/Belgrade");
        }
        catch (TimeZoneNotFoundException)
        {
            return TimeZoneInfo.FindSystemTimeZoneById("Central European Standard Time");
        }
    }
}
