using System.Security.Cryptography;
using System.Text;
using Fiskalo.PosAgent.Core.Atk;
using Xunit;

namespace Fiskalo.PosAgent.Tests;

public sealed class ServerHeartbeatVerifierTests
{
    [Fact]
    public void VerifiesOnlyTheExactBusinessPosNonceAndServerTimestamp()
    {
        using var signingKey = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var verifier = new ServerHeartbeatVerifier(signingKey.ExportSubjectPublicKeyInfo());
        const string businessId = "6f54e9ac-7b21-4c8d-a84b-8a9e1d8f0001";
        const string posUuid = "7f54e9ac-7b21-4c8d-a84b-8a9e1d8f0002";
        const string nonce = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
        const long issuedAt = 1794916800000;
        var message = ServerHeartbeatVerifier.CreateCanonicalMessage(businessId, posUuid, nonce, issuedAt);
        var signature = Convert.ToBase64String(signingKey.SignData(
            Encoding.UTF8.GetBytes(message),
            HashAlgorithmName.SHA256,
            DSASignatureFormat.IeeeP1363FixedFieldConcatenation));

        Assert.True(verifier.Verify(businessId, posUuid, nonce, issuedAt, signature));
        Assert.False(verifier.Verify(businessId, posUuid, nonce, issuedAt + 1, signature));
        Assert.False(verifier.Verify(businessId, posUuid, nonce + "A", issuedAt, signature));
        Assert.False(verifier.Verify(businessId, "8f54e9ac-7b21-4c8d-a84b-8a9e1d8f0003", nonce, issuedAt, signature));
        Assert.False(verifier.Verify("9f54e9ac-7b21-4c8d-a84b-8a9e1d8f0004", posUuid, nonce, issuedAt, signature));
    }

    [Theory]
    [InlineData("", "7f54e9ac-7b21-4c8d-a84b-8a9e1d8f0002", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", 1794916800000)]
    [InlineData("invalid", "7f54e9ac-7b21-4c8d-a84b-8a9e1d8f0002", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", 1794916800000)]
    [InlineData("6f54e9ac-7b21-4c8d-a84b-8a9e1d8f0001", "invalid", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", 1794916800000)]
    [InlineData("6f54e9ac-7b21-4c8d-a84b-8a9e1d8f0001", "7f54e9ac-7b21-4c8d-a84b-8a9e1d8f0002", "short", 1794916800000)]
    [InlineData("6f54e9ac-7b21-4c8d-a84b-8a9e1d8f0001", "7f54e9ac-7b21-4c8d-a84b-8a9e1d8f0002", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", 0)]
    public void RejectsMalformedHeartbeatFields(string businessId, string posUuid, string nonce, long issuedAt)
    {
        Assert.Throws<ArgumentException>(() =>
            ServerHeartbeatVerifier.CreateCanonicalMessage(businessId, posUuid, nonce, issuedAt));
    }

    [Fact]
    public void RejectsMalformedOrWrongLengthSignatures()
    {
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var verifier = new ServerHeartbeatVerifier(key.ExportSubjectPublicKeyInfo());
        Assert.False(verifier.Verify(
            "6f54e9ac-7b21-4c8d-a84b-8a9e1d8f0001",
            "7f54e9ac-7b21-4c8d-a84b-8a9e1d8f0002",
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            1794916800000,
            "not-base64"));
        Assert.False(verifier.Verify(
            "6f54e9ac-7b21-4c8d-a84b-8a9e1d8f0001",
            "7f54e9ac-7b21-4c8d-a84b-8a9e1d8f0002",
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            1794916800000,
            Convert.ToBase64String(new byte[32])));
    }
}
