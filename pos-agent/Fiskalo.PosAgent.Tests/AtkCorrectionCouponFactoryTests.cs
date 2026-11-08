using Atk;
using Fiskalo.PosAgent.Core.Atk;
using Xunit;

namespace Fiskalo.PosAgent.Tests;

public sealed class AtkCorrectionCouponFactoryTests
{
    private static PosCoupon OriginalSale() => new()
    {
        BusinessId = 123456789,
        CouponId = 42,
        BranchId = 2,
        PosId = 3,
        VerificationNo = "SALE-VERIFY",
        Type = CouponType.Sale,
        Time = 1_790_000_000,
        Total = 1180,
        TotalTax = 180,
        TotalNoTax = 1000
    };

    [Fact]
    public void FullCancellation_ReferencesOriginalAndPreservesFiscalAmounts()
    {
        var original = OriginalSale();
        var issuedAt = DateTimeOffset.FromUnixTimeSeconds(1_800_000_000);

        var correction = AtkCorrectionCouponFactory.CreateFullCancellation(
            original, 43, "CANCEL-VERIFY", issuedAt);

        Assert.Equal(CouponType.Cancel, correction.Type);
        Assert.Equal((ulong)42, correction.ReferenceNo);
        Assert.Equal((ulong)43, correction.CouponId);
        Assert.Equal("CANCEL-VERIFY", correction.VerificationNo);
        Assert.Equal(issuedAt.ToUnixTimeSeconds(), correction.Time);
        Assert.Equal(original.Total, correction.Total);
        Assert.Equal(original.TotalTax, correction.TotalTax);
        Assert.Equal(original.TotalNoTax, correction.TotalNoTax);
        Assert.Equal(CouponType.Sale, original.Type);
        Assert.Equal((ulong)0, original.ReferenceNo);
    }

    [Fact]
    public void FullReturn_ReferencesOriginalSale()
    {
        var original = OriginalSale();

        var correction = AtkCorrectionCouponFactory.CreateFullReturn(
            original, 44, "RETURN-VERIFY", DateTimeOffset.FromUnixTimeSeconds(1_800_000_001));

        Assert.Equal(CouponType.Return, correction.Type);
        Assert.Equal((ulong)42, correction.ReferenceNo);
        Assert.Equal((ulong)44, correction.CouponId);
        Assert.Equal(original.Items, correction.Items);
        Assert.Equal(original.Payments, correction.Payments);
        Assert.Equal(original.TaxGroups, correction.TaxGroups);
    }

    [Fact]
    public void RejectsNonSaleSource()
    {
        var source = OriginalSale();
        source.Type = CouponType.Cancel;

        Assert.Throws<ArgumentException>(() => AtkCorrectionCouponFactory.CreateFullCancellation(
            source, 43, "CANCEL-VERIFY", DateTimeOffset.UtcNow));
    }

    [Theory]
    [InlineData(42)]
    [InlineData(0)]
    public void RejectsInvalidCorrectionCouponId(ulong correctionId)
    {
        Assert.Throws<ArgumentOutOfRangeException>(() => AtkCorrectionCouponFactory.CreateFullCancellation(
            OriginalSale(), correctionId, "CANCEL-VERIFY", DateTimeOffset.UtcNow));
    }

    [Fact]
    public void RejectsVerificationNumberLongerThanSixteenCharacters()
    {
        Assert.Throws<ArgumentOutOfRangeException>(() => AtkCorrectionCouponFactory.CreateFullReturn(
            OriginalSale(), 44, "12345678901234567", DateTimeOffset.UtcNow));
    }

    [Fact]
    public void RejectsNonUtcIssueTime()
    {
        Assert.Throws<ArgumentException>(() => AtkCorrectionCouponFactory.CreateFullCancellation(
            OriginalSale(), 43, "CANCEL-VERIFY", DateTimeOffset.Now));
    }
}
