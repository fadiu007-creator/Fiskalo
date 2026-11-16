using Atk;
using Fiskalo.PosAgent.Core.Atk;
using Xunit;

namespace Fiskalo.PosAgent.Tests;

public sealed class PosCouponSnapshotHasherTests
{
    [Fact]
    public void HashIsStableAcrossItemOrderingAndChangesWhenFiscalContentChanges()
    {
        var first = CreateInput([
            new PosCouponItemInput("Bread", 1.0000m, "C62", 2.000m, 236, "A", "P"),
            new PosCouponItemInput("Milk", 2.0000m, "C62", 1.000m, 236, "A", "P")
        ]);
        var reversed = CreateInput(first.Items.Reverse().ToArray());
        var changed = CreateInput([
            new PosCouponItemInput("Bread", 1.1000m, "C62", 2.000m, 259, "A", "P"),
            new PosCouponItemInput("Milk", 2.0000m, "C62", 1.000m, 236, "A", "P")
        ]);

        var hash = PosCouponSnapshotHasher.ComputeSha256(first, "0123456789ABCDEF");
        Assert.Equal(hash, PosCouponSnapshotHasher.ComputeSha256(reversed, "0123456789ABCDEF"));
        Assert.NotEqual(hash, PosCouponSnapshotHasher.ComputeSha256(changed, "0123456789ABCDEF"));
        Assert.Equal(64, hash.Length);
    }

    private static PosCouponInput CreateInput(IReadOnlyList<PosCouponItemInput> items) => new(
        123456789, 9001, 1, "Ferizaj", "Operator", 2, 3, "", (CouponType)1, 1799999999,
        items, [new PosCouponPaymentInput((PaymentType)1, 472)],
        472, [new PosCouponTaxGroupInput("A", 400, 72)], 72, 400, 0, null, 12);
}
