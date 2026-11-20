using System.Security.Cryptography;
using System.Text;
using Fiskalo.PosAgent.Core.Atk;
using Xunit;

namespace Fiskalo.PosAgent.Tests;

public sealed class ServerHeartbeatVerifierTests
{
    [Fact]
    public void VerifiesExactBusinessPosNonceAndServerTimestamp()
    {
        using var signingKey = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var verifier = new ServerHeartbeatVerifier(signingKey.ExportSubjectPublicKeyInfo());
        const string businessId = "22222222-2222-4222-8222-222222222222";
        const string posUuid = "33333333-3333-4333-8333-333333333333";
        const string nonce = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
        const long issuedAt = 1794916800000;
        var canonical = ServerHeartbeatVerifier.CreateCanonicalMessage(businessId, posUuid, nonce, issuedAt);
        Assert.Equal(
            "fiskalo-atk-heartbeat-v1\nATK TEST\n" +
            "22222222-2222-4222-8222-222222222222\n" +
            "33333333-3333-4333-8333-333333333333\n" +
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n1794916800000",
            canonical);
        var signature = Convert.ToBase64String(signingKey.SignData(
            Encoding.UTF8.GetBytes(canonical),
            HashAlgorithmName.SHA256,
            DSASignatureFormat.IeeeP1363FixedFieldConcatenation));

        Assert.True(verifier.Verify(businessId, posUuid, nonce, issuedAt, signature));
        Assert.False(verifier.Verify(businessId, posUuid, nonce, issuedAt + 1, signature));
        Assert.False(verifier.Verify(businessId, "44444444-4444-4444-8444-444444444444", nonce, issuedAt, signature));
        Assert.False(verifier.Verify("55555555-5555-4555-8555-555555555555", posUuid, nonce, issuedAt, signature));
    }

    [Theory]
    [InlineData("", "33333333-3333-4333-8333-333333333333", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", 1794916800000)]
    [InlineData("invalid", "33333333-3333-4333-8333-333333333333", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", 1794916800000)]
    [InlineData("22222222-2222-4222-8222-222222222222", "invalid", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", 1794916800000)]
    [InlineData("22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333", "short", 1794916800000)]
    [InlineData("22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", 0)]
    public void RejectsMalformedCanonicalFields(string businessId, string posUuid, string nonce, long issuedAt)
    {
        Assert.ThrowsAny<ArgumentException>(() =>
            ServerHeartbeatVerifier.CreateCanonicalMessage(businessId, posUuid, nonce, issuedAt));
    }

    [Fact]
    public void RejectsMalformedOrWrongLengthSignature()
    {
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var verifier = new ServerHeartbeatVerifier(key.ExportSubjectPublicKeyInfo());
        Assert.False(verifier.Verify(
            "22222222-2222-4222-8222-222222222222",
            "33333333-3333-4333-8333-333333333333",
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            1794916800000,
            "not-base64"));
        Assert.False(verifier.Verify(
            "22222222-2222-4222-8222-222222222222",
            "33333333-3333-4333-8333-333333333333",
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            1794916800000,
            Convert.ToBase64String(new byte[32])));
    }
}
