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
