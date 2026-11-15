import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

Deno.test("uint64 transaction id validation rejects zero, overflow and non-numeric values", () => {
  const valid = (v: string) => /^(0|[1-9][0-9]{0,19})$/.test(v) && BigInt(v) > 0n && BigInt(v) <= 18446744073709551615n;
  assertEquals(valid("1"), true);
  assertEquals(valid("18446744073709551615"), true);
  assertEquals(valid("0"), false);
  assertEquals(valid("18446744073709551616"), false);
  assertEquals(valid("1e5"), false);
  assertEquals(valid("abc"), false);
});

Deno.test("browser response fields are not used as an ATK acceptance source", async () => {
  const source = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  assertEquals(source.includes("body.atkResponse"), false);
  assertEquals(source.includes("body.transactionId"), false);
  assertEquals(source.includes('fetch(ATK'), true);
  assertEquals(source.includes('atkBody.transaction_id'), true);
});
