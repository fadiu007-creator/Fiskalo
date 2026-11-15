"use client";

import { encodeAtkBase64, encodeAtkPosCoupon } from "@/lib/atk/protobuf";
import { hasBrowserPosCertificate, signAtkBase64Payload } from "@/lib/atk/browser-key-vault";
import type { createClient } from "@/lib/supabase/client";

type SupabaseBrowserClient = ReturnType<typeof createClient>;
type RefundMethod = "cash" | "card" | "bank_transfer";

function readOriginalApplicationId(details: string): number {
  const binary = atob(details);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  let cursor = 0;
  const readVarint = (): bigint => {
    let value = BigInt(0); let shift = BigInt(0);
    while (cursor < bytes.length && shift < BigInt(70)) {
      const byte = bytes[cursor++];
      value |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return value;
      shift += BigInt(7);
    }
    throw new Error("Kuponi origjinal ka Protobuf të pavlefshëm.");
  };
  while (cursor < bytes.length) {
    const tag = readVarint();
    const field = Number(tag >> BigInt(3));
    const wire = Number(tag & BigInt(7));
    if (field <= 0) throw new Error("Kuponi origjinal ka fushë të pavlefshme.");
    if (wire === 0) {
      const value = readVarint();
      if (field === 7) {
        const applicationId = Number(value);
        if (!Number.isSafeInteger(applicationId) || applicationId <= 0) throw new Error("Application ID i kuponit origjinal është i pavlefshëm.");
        return applicationId;
      }
    } else if (wire === 1) cursor += 8;
    else if (wire === 2) {
      const length = Number(readVarint());
      if (!Number.isSafeInteger(length) || length < 0) throw new Error("Gjatësia e kuponit origjinal është e pavlefshme.");
      cursor += length;
    } else if (wire === 5) cursor += 4;
    else throw new Error("Kuponi origjinal ka Protobuf wire type të pambështetur.");
    if (cursor > bytes.length) throw new Error("Kuponi origjinal është i cunguar.");
  }
  throw new Error("Kuponi origjinal nuk përmban Application ID.");
}

function verificationNo(): string {
  const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}

function errorText(value: unknown, fallback: string): string {
  if (value && typeof value === "object") {
    const row = value as Record<string, unknown>;
    for (const key of ["detail", "message", "error"]) if (typeof row[key] === "string") return String(row[key]);
  }
  return fallback;
}

/** Signs and submits one item-ledger adjustment using the same TEST POS that accepted the original sale. */
export async function submitInvoiceAdjustmentToATK(
  supabase: SupabaseBrowserClient,
  organizationId: string,
  adjustmentId: string,
  refundPaymentMethod: RefundMethod,
): Promise<{ transactionId: string; message: string }> {
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) throw new Error("Sesioni ka skaduar. Hyr përsëri.");

  const [{ data: adjustment, error: adjustmentError }, { data: organization, error: organizationError }] = await Promise.all([
    supabase.from("fiskalo_invoice_adjustments")
      .select("id,organization_id,original_invoice_id,original_fiscal_document_id,adjustment_type,amount,status")
      .eq("id", adjustmentId).eq("organization_id", organizationId).single(),
    supabase.from("fiskalo_organizations").select("nui,municipality").eq("id", organizationId).single(),
  ]);
  if (adjustmentError || !adjustment) throw new Error("Kërkesa për korrigjim nuk u gjet.");
  if (adjustment.status !== "awaiting_atk") throw new Error("Kërkesa nuk është në pritje të dërgimit në ATK.");
  if (organizationError || !organization || !/^\d{9}$/.test(String(organization.nui))) throw new Error("NUI i biznesit mungon ose nuk është valid.");

  const [{ data: original, error: originalError }, { data: adjustmentItems, error: adjustmentItemsError }, { data: invoiceItems, error: invoiceItemsError }] = await Promise.all([
    supabase.from("fiskalo_atk_fiscal_documents")
      .select("id,coupon_id,atk_transaction_id,pos_installation_id,status,document_type,pos_coupon_base64")
      .eq("id", adjustment.original_fiscal_document_id).eq("organization_id", organizationId).single(),
    supabase.from("fiskalo_invoice_adjustment_items")
      .select("original_invoice_item_id,product_id,description,quantity,unit_price,net_amount,vat_amount,total_amount")
      .eq("adjustment_id", adjustmentId).eq("organization_id", organizationId),
    supabase.from("fiskalo_invoice_items")
      .select("id,product_id,description,quantity,unit_price,line_subtotal,line_vat,vat_rate")
      .eq("invoice_id", adjustment.original_invoice_id),
  ]);
  if (originalError || !original || original.document_type !== "sale" || original.status !== "accepted" || !original.atk_transaction_id) {
    throw new Error("Kuponi origjinal i shitjes nuk është i pranuar nga ATK.");
  }
  if (adjustmentItemsError || !adjustmentItems?.length || invoiceItemsError || !invoiceItems?.length) {
    throw new Error("Linjat e korrigjimit nuk u lexuan.");
  }

  const { data: pos, error: posError } = await supabase.from("fiskalo_atk_pos_installations")
    .select("id,atk_branch_id,pos_id,location,environment,status")
    .eq("id", original.pos_installation_id).eq("organization_id", organizationId).single();
  if (posError || !pos || pos.environment !== "test" || pos.status !== "active") {
    throw new Error("POS TEST origjinal nuk është aktiv. Korrigjimi duhet të dërgohet nga i njëjti POS.");
  }
  const { data: verification, error: verificationError } = await supabase.from("fiskalo_atk_pos_verifications")
    .select("nui,atk_branch_id,pos_id,application_id")
    .eq("organization_id", organizationId).eq("pos_installation_id", pos.id).maybeSingle();
  if (verificationError || !verification || verification.nui !== String(organization.nui) ||
      Number(verification.atk_branch_id) !== Number(pos.atk_branch_id) ||
      Number(verification.pos_id) !== Number(pos.pos_id) ||
      !Number.isSafeInteger(Number(verification.application_id)) || Number(verification.application_id) <= 0) {
    throw new Error("Verifikimi i POS origjinal nuk përputhet me biznesin ose Application ID mungon.");
  }
  // The accepted sale's coupon is the authoritative source of Application ID.
  // The current POS verification may have since been replaced with another ID.
  let originalApplicationId: number;
  try { originalApplicationId = readOriginalApplicationId(String(original.pos_coupon_base64 || "")); }
  catch {
    throw new Error("Nuk mund të lexohet Application ID nga kuponi origjinal i pranuar. Korrigjimi nuk u dërgua.");
  }
  const legacyKeyId = organizationId + ":" + pos.id;
  const scopedKeyId = organizationId + ":" + pos.id + ":" + originalApplicationId;
  const keyId = await hasBrowserPosCertificate(scopedKeyId)
    ? scopedKeyId
    : await hasBrowserPosCertificate(legacyKeyId) ? legacyKeyId : "";
  if (!keyId) {
    throw new Error("Certifikata ATK TEST e POS-it origjinal nuk gjendet në këtë shfletues. Hape POS-in origjinal në këtë pajisje dhe përfundo regjistrimin e certifikatës TEST.");
  }

  const originalItemMap = new Map(invoiceItems.map((line) => [line.id, line]));
  const lines = adjustmentItems.map((item) => {
    const originalLine = originalItemMap.get(item.original_invoice_item_id);
    if (!originalLine) throw new Error("Një artikull korrigjimi nuk përputhet me faturën origjinale.");
    return {
      product_id: item.product_id,
      description: item.description,
      quantity: Number(item.quantity),
      unit_price: Number(item.unit_price),
      line_subtotal: Number(item.net_amount),
      line_vat: Number(item.vat_amount),
      vat_rate: Number(originalLine.vat_rate),
    };
  });
  const productIds = Array.from(new Set(lines.map((line) => line.product_id).filter((id): id is string => Boolean(id))));
  const { data: products, error: productsError } = productIds.length
    ? await supabase.from("fiskalo_products").select("id,atk_unit_code,atk_tax_code,atk_item_category_code")
      .eq("organization_id", organizationId).in("id", productIds)
    : { data: [], error: null };
  if (productsError) throw new Error("Kodet ATK të produkteve nuk u lexuan.");

  const productMap = new Map((products ?? []).map((product) => [product.id, product]));
  const itemRows = lines.map((line) => {
    if (!line.product_id) throw new Error("Një artikull nuk ka produkt të lidhur.");
    const product = productMap.get(line.product_id);
    const unit = product?.atk_unit_code?.trim() ?? "";
    const tax = product?.atk_tax_code?.trim() ?? "";
    const itemType = product?.atk_item_category_code?.trim() ?? "";
    const rate = Number(line.vat_rate);
    const taxMatches = rate === 8 ? tax === "D" : rate === 18 ? tax === "E" : rate === 0 ? tax === "A" || tax === "C" : false;
    if (!unit || !taxMatches || !itemType) throw new Error("Një produkt ka kode ATK që mungojnë ose nuk përputhen me TVSH-në.");
    return { line, unit, tax, itemType };
  });

  const { data: couponId, error: couponError } = await supabase.rpc("fiskalo_next_atk_coupon_id", { target_organization: organizationId });
  if (couponError || !couponId) throw new Error("Nuk u caktua numri unik i kuponit korrigjues ATK.");
  const totalCents = Math.round(Number(adjustment.amount) * 100);
  const subtotalCents = Math.round(lines.reduce((sum, line) => sum + line.line_subtotal, 0) * 100);
  const vatCents = Math.round(lines.reduce((sum, line) => sum + line.line_vat, 0) * 100);
  if (subtotalCents + vatCents !== totalCents) throw new Error("Vlera neto dhe TVSH e korrigjimit nuk përputhen me totalin.");

  const items = itemRows.map(({ line, unit, tax, itemType }) => ({
    name: line.description,
    unitPriceEuro: line.unit_price,
    unit,
    quantity: line.quantity,
    // Keep the original unit price in the ATK item row. The returned net/VAT
    // amounts below represent the discounted amount; TotalDiscount reconciles
    // the difference for the returned quantities.
    lineTotalCents:
      Math.round(Number(line.quantity) * Number(line.unit_price) * 100) +
      Math.round(Number(line.quantity) * Number(line.unit_price) * Number(line.vat_rate)),
    taxRate: tax,
    itemType,
  }));
  const totalDiscountCents = itemRows.reduce((sum, { line }) => {
    const grossCents =
      Math.round(Number(line.quantity) * Number(line.unit_price) * 100) +
      Math.round(Number(line.quantity) * Number(line.unit_price) * Number(line.vat_rate));
    const discountedCents = Math.round((Number(line.line_subtotal) + Number(line.line_vat)) * 100);
    return sum + grossCents - discountedCents;
  }, 0);
  if (totalDiscountCents < 0) throw new Error("Vlera e zbritjes së kthimit nuk mund të jetë negative.");
  const taxGroups = new Map<string, { totalForTaxCents: number; totalTaxCents: number }>();
  itemRows.forEach(({ line, tax }) => {
    const current = taxGroups.get(tax) ?? { totalForTaxCents: 0, totalTaxCents: 0 };
    current.totalForTaxCents += Math.round(line.line_subtotal * 100);
    current.totalTaxCents += Math.round(line.line_vat * 100);
    taxGroups.set(tax, current);
  });
  const paymentType: Record<RefundMethod, number> = { cash: 1, card: 2, bank_transfer: 6 };
  const coupon = encodeAtkPosCoupon({
    businessId: String(organization.nui),
    couponId: String(couponId),
    branchId: pos.atk_branch_id,
    location: pos.location || organization.municipality || "",
    operatorId: auth.user.id,
    posId: pos.pos_id,
    applicationId: originalApplicationId,
    verificationNo: verificationNo(),
    type: adjustment.adjustment_type === "cancel" ? 2 : 3,
    unixTime: Math.floor(Date.now() / 1000),
    items,
    payments: [{ type: paymentType[refundPaymentMethod], amountCents: totalCents }],
    totalCents,
    taxGroups: Array.from(taxGroups.entries()).map(([taxRate, values]) => ({ taxRate, ...values })),
    totalTaxCents: vatCents,
    totalNoTaxCents: subtotalCents,
    totalDiscountCents,
    referenceNo: String(original.coupon_id),
  });
  const details = encodeAtkBase64(coupon);
  const signature = await signAtkBase64Payload(keyId, details);
  const response = await fetch("/api/atk/test/adjustment", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      organizationId,
      adjustmentId,
      posInstallationId: pos.id,
      nui: String(organization.nui),
      couponId: String(couponId),
      applicationId: originalApplicationId,
      totalCents,
      refundPaymentMethod,
      details,
      signature,
    }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(errorText(result, "Dërgimi i korrigjimit në ATK dështoi. Kontrollo statusin para çdo veprimi tjetër."));
  return { transactionId: String(result.transactionId), message: "Kuponi korrigjues u pranua nga ATK TEST." };
}
