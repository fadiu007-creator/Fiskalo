using Atk;
using System.Security.Cryptography;
using Fiskalo.PosAgent.Core.Atk;
using Xunit;

namespace Fiskalo.PosAgent.Tests;

public sealed class FiscalReceiptIdentityTests
{
    [Fact]
    public void CreateNuiKf_GeneratesUniqueSixteenCharacterAlphanumericVerificationNumbers()
    {
        var values = Enumerable.Range(0, 1000)
            .Select(_ => FiscalReceiptIdentity.CreateNuiKf())
            .ToArray();

        Assert.All(values, value =>
        {
            Assert.Equal(16, value.Length);
            Assert.True(FiscalReceiptIdentity.IsValidNuiKf(value));
        });
        Assert.Equal(values.Length, values.Distinct(StringComparer.Ordinal).Count());
    }

    [Fact]
    public void PosAndCitizenCoupons_UseTheSamePerCouponNuiKf()
    {
        var input = new PosCouponInput(
            BusinessId: 812345678,
            CouponId: 1,
            BranchId: 1,
            Location: "Prishtina",
            OperatorId: "OP-1",
            PosId: 1,
            ApplicationId: 1,
            VerificationNo: "",
            Type: (CouponType)1,
            UnixTime: 1760000000,
            Items: new[] { new PosCouponItemInput("Water", 1m, "PCE", 1m, 118, "E", "A") },
            Payments: new[] { new PosCouponPaymentInput((PaymentType)1, 118) },
            TotalCents: 118,
            TaxGroups: new[] { new PosCouponTaxGroupInput("E", 100, 18) },
            TotalTaxCents: 18,
            TotalNoTaxCents: 100,
            TotalDiscountCents: 0);

        var nuiKf = FiscalReceiptIdentity.CreateNuiKf();
        var posCoupon = PosCouponBuilder.Build(input, nuiKf);
        var citizenCoupon = AtkCouponSigner.CreateCitizenCoupon(posCoupon);

        Assert.Equal(nuiKf, posCoupon.VerificationNo);
        Assert.Equal(nuiKf, citizenCoupon.VerificationNo);
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var posPayload = AtkCouponSigner.SignPosCoupon(posCoupon, key).DetailsBase64;
        var citizenPayload = AtkCouponSigner.SignCitizenCoupon(citizenCoupon, key).DetailsBase64;
        Assert.True(FiscalReceiptIdentity.IsNuiKfEmbeddedInSignedCoupons(posPayload, citizenPayload, nuiKf));
        Assert.False(FiscalReceiptIdentity.IsNuiKfEmbeddedInSignedCoupons(posPayload, citizenPayload, FiscalReceiptIdentity.CreateNuiKf()));
    }

    [Theory]
    [InlineData("ABCDEFGHIJKLMNOP")]
    [InlineData("0123456789012345")]
    [InlineData("0123456789ABCDEF")]
    public void IsValidNuiKf_AcceptsSixteenUppercaseAlphanumericCharacters(string value)
    {
        Assert.True(FiscalReceiptIdentity.IsValidNuiKf(value));
    }

    [Theory]
    [InlineData("ABCDEFGHIJKLMNO")]
    [InlineData("ABCDEFGHIJKLMNOPQ")]
    [InlineData("abcdefghijklmnop")]
    [InlineData("ABCD-EFGH-IJKL")]
    [InlineData("")]
    public void IsValidNuiKf_RejectsMalformedIdentifiers(string value)
    {
        Assert.False(FiscalReceiptIdentity.IsValidNuiKf(value));
    }
}
