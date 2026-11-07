using Fiskalo.PosAgent.Core.Atk;
using Xunit;

namespace Fiskalo.PosAgent.Tests;

public sealed class FiscalReceiptIdentityTests
{
    [Fact]
    public void CreateNuiKf_UsesFiscalizationNumberBranchAndKosovoLocalTimestamp()
    {
        var issueTimeUtc = new DateTimeOffset(2025, 1, 1, 7, 30, 45, TimeSpan.Zero);

        var nuiKf = FiscalReceiptIdentity.CreateNuiKf(
            "0123456789", 121, issueTimeUtc.ToUnixTimeSeconds());

        Assert.Equal("0123456789012101012025083045", nuiKf);
        Assert.Equal(FiscalReceiptIdentity.NuiKfLength, nuiKf.Length);
        Assert.True(FiscalReceiptIdentity.IsValidNuiKf(nuiKf));
    }

    [Theory]
    [InlineData("EDI-FISCAL-TEST")]
    [InlineData("123456789")]
    [InlineData("12345678901")]
    [InlineData("")]
    public void CreateNuiKf_RejectsInvalidAtkFiscalizationNumber(string fiscalizationNumber)
    {
        Assert.Throws<ArgumentException>(() =>
            FiscalReceiptIdentity.CreateNuiKf(fiscalizationNumber, 121, 1767252645));
    }

    [Fact]
    public void CreateNuiKf_RejectsBranchCodesOutsideFourDigitField()
    {
        Assert.Throws<ArgumentOutOfRangeException>(() =>
            FiscalReceiptIdentity.CreateNuiKf("0123456789", 10000, 1767252645));
    }

    [Theory]
    [InlineData("ABCDEFGHIJKLMNOP")]
    [InlineData("0123456789012101012025083")]
    [InlineData("012345678901210101202508304X")]
    public void IsValidNuiKf_RejectsLegacyOrMalformedIdentifiers(string value)
    {
        Assert.False(FiscalReceiptIdentity.IsValidNuiKf(value));
    }
}
