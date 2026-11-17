namespace Fiskalo.PosAgent.Core.Atk;

public static class AtkMoney
{
    public static long ToUnitPrice(decimal euroAmount) => ConvertExact(euroAmount, 10000m, 4, nameof(euroAmount));
    public static long ToCents(decimal euroAmount) => ConvertExact(euroAmount, 100m, 2, nameof(euroAmount));

    private static long ConvertExact(decimal amount, decimal multiplier, int decimals, string name)
    {
        if (amount < 0) throw new ArgumentOutOfRangeException(name, "Amount cannot be negative.");
        if (decimal.Round(amount, decimals, MidpointRounding.AwayFromZero) != amount)
            throw new ArgumentException("Amount has too many decimal places.", name);
        var scaled = amount * multiplier;
        if (scaled > long.MaxValue) throw new OverflowException("ATK monetary value exceeds Int64.");
        return decimal.ToInt64(scaled);
    }
}
