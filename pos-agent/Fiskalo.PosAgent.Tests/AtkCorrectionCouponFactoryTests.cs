using System.Security.Cryptography;
using System.Text;
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
        ApplicationId = 17,
        VerificationNo = "SALE-VERIFY",
        Type = CouponType.Sale,
        Time = 1_790_000_000,
        TransactionNo = 987654,
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
            original, 43, "CANCELVERIFY1234", issuedAt);

        Assert.Equal(CouponType.Cancel, correction.Type);
        Assert.Equal((ulong)42, correction.ReferenceNo);
        Assert.Equal((ulong)43, correction.CouponId);
        Assert.Equal("CANCELVERIFY1234", correction.VerificationNo);
        Assert.Equal(issuedAt.ToUnixTimeSeconds(), correction.Time);
        Assert.Equal(original.Total, correction.Total);
        Assert.Equal(original.TotalTax, correction.TotalTax);
        Assert.Equal(original.TotalNoTax, correction.TotalNoTax);
        Assert.Equal((ulong)0, correction.TransactionNo);
        Assert.Equal((ulong)987654, original.TransactionNo);
        Assert.Equal(CouponType.Sale, original.Type);
        Assert.Equal((ulong)0, original.ReferenceNo);
    }

    [Fact]
    public void FullReturn_ReferencesOriginalSale()
    {
        var original = OriginalSale();

        var correction = AtkCorrectionCouponFactory.CreateFullReturn(
            original, 44, "RETURNVERIFY1234", DateTimeOffset.FromUnixTimeSeconds(1_800_000_001));

        Assert.Equal(CouponType.Return, correction.Type);
        Assert.Equal((ulong)42, correction.ReferenceNo);
        Assert.Equal((ulong)44, correction.CouponId);
        Assert.Equal("RETURNVERIFY1234", correction.VerificationNo);
        Assert.Equal((ulong)0, correction.TransactionNo);
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
            source, 43, "CANCELVERIFY1234", DateTimeOffset.UtcNow));
    }

    [Theory]
    [InlineData(42)]
    [InlineData(0)]
    public void RejectsInvalidCorrectionCouponId(ulong correctionId)
    {
        Assert.Throws<ArgumentOutOfRangeException>(() => AtkCorrectionCouponFactory.CreateFullCancellation(
            OriginalSale(), correctionId, "CANCELVERIFY1234", DateTimeOffset.UtcNow));
    }

    [Theory]
    [InlineData("")]
    [InlineData("123456789012345")]
    [InlineData("12345678901234567")]
    [InlineData("abcdefghijklmnop")]
    [InlineData("1234-67890123456")]
    public void RejectsMalformedNuiKf(string verificationNo)
    {
        Assert.Throws<ArgumentException>(() => AtkCorrectionCouponFactory.CreateFullReturn(
            OriginalSale(), 44, verificationNo, DateTimeOffset.UtcNow));
    }

    [Fact]
    public void RejectsOriginalSaleWithoutCompletePosIdentity()
    {
        var original = OriginalSale();
        original.ApplicationId = 0;

        Assert.Throws<ArgumentException>(() => AtkCorrectionCouponFactory.CreateFullReturn(
            original, 44, "RETURNVERIFY1234", DateTimeOffset.UtcNow));
    }

    [Fact]
    public void RejectsNonUtcIssueTime()
    {
        Assert.Throws<ArgumentException>(() => AtkCorrectionCouponFactory.CreateFullCancellation(
            OriginalSale(), 43, "CANCELVERIFY1234", new DateTimeOffset(2026, 11, 8, 12, 0, 0, TimeSpan.FromHours(1))));
    }

    [Fact]
    public void CreateFromSignedOriginal_VerifiesSignatureAndCreatesLinkedCorrection()
    {
        using var key = AtkPki.GenerateP256Key();
        var original = OriginalSale();
        original.VerificationNo = "1234567890ABCDEF";
        var signed = AtkCouponSigner.SignPosCoupon(original, key);
        using var publicKey = ECDsa.Create(key.ExportParameters(false));

        var correction = AtkCorrectionCouponFactory.CreateFromSignedOriginal(
            signed.DetailsBase64,signed.SignatureBase64,publicKey,
            original.BusinessId,original.BranchId,original.PosId,original.ApplicationId,
            original.CouponId,43,"123456","CANCELVERIFY1234",
            DateTimeOffset.FromUnixTimeSeconds(1_800_000_000),CouponType.Cancel);

        Assert.Equal(CouponType.Cancel,correction.Type);
        Assert.Equal(original.CouponId,correction.ReferenceNo);
        Assert.Equal((ulong)43,correction.CouponId);
        Assert.Equal("CANCELVERIFY1234",correction.VerificationNo);
    }

    [Fact]
    public void CreateFromSignedOriginal_RejectsTamperedSignature()
    {
        using var key = AtkPki.GenerateP256Key();
        var original = OriginalSale();
        original.VerificationNo = "1234567890ABCDEF";
        var signed = AtkCouponSigner.SignPosCoupon(original,key);
        using var publicKey = ECDsa.Create(key.ExportParameters(false));
        var tampered = Convert.ToBase64String(Encoding.UTF8.GetBytes("tampered"));

        Assert.Throws<CryptographicException>(() => AtkCorrectionCouponFactory.CreateFromSignedOriginal(
            signed.DetailsBase64,tampered,publicKey,
            original.BusinessId,original.BranchId,original.PosId,original.ApplicationId,
            original.CouponId,43,"123456","CANCELVERIFY1234",
            DateTimeOffset.FromUnixTimeSeconds(1_800_000_000),CouponType.Cancel));
    }

    [Fact]
    public void CreateFromSignedOriginal_RejectsDifferentVerifiedPosIdentity()
    {
        using var key = AtkPki.GenerateP256Key();
        var original = OriginalSale();
        original.VerificationNo = "1234567890ABCDEF";
        var signed = AtkCouponSigner.SignPosCoupon(original,key);
        using var publicKey = ECDsa.Create(key.ExportParameters(false));

        Assert.Throws<ArgumentException>(() => AtkCorrectionCouponFactory.CreateFromSignedOriginal(
            signed.DetailsBase64,signed.SignatureBase64,publicKey,
            original.BusinessId,original.BranchId,99,original.ApplicationId,
            original.CouponId,43,"123456","CANCELVERIFY1234",
            DateTimeOffset.FromUnixTimeSeconds(1_800_000_000),CouponType.Cancel));
    }

    [Theory]
    [InlineData("")]
    [InlineData("0")]
    [InlineData("not-a-transaction")]
    public void CreateFromSignedOriginal_RequiresPositiveOriginalTransactionId(string transactionId)
    {
        using var key = AtkPki.GenerateP256Key();
        var original = OriginalSale();
        original.VerificationNo = "1234567890ABCDEF";
        var signed = AtkCouponSigner.SignPosCoupon(original,key);
        using var publicKey = ECDsa.Create(key.ExportParameters(false));

        Assert.Throws<ArgumentException>(() => AtkCorrectionCouponFactory.CreateFromSignedOriginal(
            signed.DetailsBase64,signed.SignatureBase64,publicKey,
            original.BusinessId,original.BranchId,original.PosId,original.ApplicationId,
            original.CouponId,43,transactionId,"CANCELVERIFY1234",
            DateTimeOffset.FromUnixTimeSeconds(1_800_000_000),CouponType.Cancel));
    }

}
