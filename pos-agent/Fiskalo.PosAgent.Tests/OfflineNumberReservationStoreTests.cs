using System.Security.Cryptography;
using Fiskalo.PosAgent.Core.Queue;
using Xunit;

namespace Fiskalo.PosAgent.Tests;

public sealed class OfflineNumberReservationStoreTests
{
    [Fact]
    public async Task ClaimsAreDurableIdempotentAndNeverReused()
    {
        var fixture=new Fixture();
        try
        {
            var today=DateOnly.FromDateTime(DateTime.UtcNow).ToString("yyyy-MM-dd");
            await fixture.Store.ImportAsync("11111111-1111-1111-1111-111111111111",
                "22222222-2222-2222-2222-222222222222",123456789,1,2,3,
                new ulong[]{9001,9002},new[]{new OfflineDailyNumberPool(today,41,42)});
            var first=await fixture.Store.ClaimAsync("checkout-a",
                "11111111-1111-1111-1111-111111111111","22222222-2222-2222-2222-222222222222",
                123456789,1,2,3,today);
            var repeated=await fixture.Store.ClaimAsync("checkout-a",
                "11111111-1111-1111-1111-111111111111","22222222-2222-2222-2222-222222222222",
                123456789,1,2,3,today);
            Assert.Equal(first,repeated);
            Assert.Equal((ulong)9001,first.CouponId);
            Assert.Equal(41,first.DailyNumber);

            var restarted=new OfflineNumberReservationStore(fixture.Path,fixture.Protector);
            var second=await restarted.ClaimAsync("checkout-b",
                "11111111-1111-1111-1111-111111111111","22222222-2222-2222-2222-222222222222",
                123456789,1,2,3,today);
            Assert.Equal((ulong)9002,second.CouponId);
            Assert.Equal(42,second.DailyNumber);
            await Assert.ThrowsAsync<InvalidOperationException>(()=>restarted.ClaimAsync("checkout-c",
                "11111111-1111-1111-1111-111111111111","22222222-2222-2222-2222-222222222222",
                123456789,1,2,3,today));
        }
        finally{fixture.Dispose();}
    }

    [Fact]
    public async Task RejectsReservationForAnotherPosAndOverlappingNumbers()
    {
        var fixture=new Fixture();
        try
        {
            const string business="11111111-1111-1111-1111-111111111111";
            const string pos="22222222-2222-2222-2222-222222222222";
            var date=DateOnly.FromDateTime(DateTime.UtcNow).ToString("yyyy-MM-dd");
            await fixture.Store.ImportAsync(business,pos,123456789,1,2,3,
                new ulong[]{9010},new[]{new OfflineDailyNumberPool(date,10,12)});
            await Assert.ThrowsAsync<InvalidOperationException>(()=>fixture.Store.ImportAsync(business,
                "33333333-3333-3333-3333-333333333333",123456789,1,2,3,
                new ulong[]{9011},new[]{new OfflineDailyNumberPool(date,20,22)}));
            await Assert.ThrowsAsync<InvalidOperationException>(()=>fixture.Store.ImportAsync(business,pos,
                123456789,1,2,3,new ulong[]{9011},new[]{new OfflineDailyNumberPool(date,11,13)}));
        }
        finally{fixture.Dispose();}
    }

    private sealed class Fixture:IDisposable
    {
        public string Path {get;}=System.IO.Path.Combine(System.IO.Path.GetTempPath(),"fiskalo-offline-number-tests-"+Guid.NewGuid().ToString("N"),"numbers.bin");
        public TestProtector Protector {get;}=new();
        public OfflineNumberReservationStore Store {get;}
        public Fixture(){Store=new OfflineNumberReservationStore(Path,Protector);}
        public void Dispose(){var directory=System.IO.Path.GetDirectoryName(Path);if(directory is not null&&Directory.Exists(directory))Directory.Delete(directory,true);}
    }
    private sealed class TestProtector:IFiscalQueueProtector
    {
        private readonly byte[] _key=RandomNumberGenerator.GetBytes(32);
        public byte[] Protect(byte[] plaintext)
        {
            var nonce=RandomNumberGenerator.GetBytes(12);var tag=new byte[16];var ciphertext=new byte[plaintext.Length];
            using var aes=new AesGcm(_key,16);aes.Encrypt(nonce,plaintext,ciphertext,tag);return [..nonce,..tag,..ciphertext];
        }
        public byte[] Unprotect(byte[] data)
        {
            var nonce=data[..12];var tag=data[12..28];var ciphertext=data[28..];var plaintext=new byte[ciphertext.Length];
            using var aes=new AesGcm(_key,16);aes.Decrypt(nonce,ciphertext,tag,plaintext);return plaintext;
        }
    }
}
