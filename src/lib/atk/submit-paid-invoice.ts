"use client";

import { encodeAtkBase64, encodeAtkPosCoupon } from "@/lib/atk/protobuf";
import { ensureATKTestPosReady } from "@/lib/atk/ensure-test-pos-ready";
import { hasBrowserPosCertificate, signAtkBase64Payload } from "@/lib/atk/browser-key-vault";
import type { createClient } from "@/lib/supabase/client";

type SupabaseBrowserClient = ReturnType<typeof createClient>;

function createCouponVerificationNo(): string {
  const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const random = new Uint8Array(16);
  crypto.getRandomValues(random);
  return Array.from(random, (byte) => alphabet[byte % alphabet.length]).join("");
}

function errorText(value: unknown, fallback: string): string {
  if (value && typeof value === "object") {
    const row = value as Record<string, unknown>;
    for (const key of ["detail", "message", "error"]) if (typeof row[key] === "string") return String(row[key]);
  }
  return fallback;
}

/**
 * Sends one paid cash invoice to ATK TEST using the certificate installed on this POS browser.
 * The server enforces one fiscal document per invoice; this client helper never retries an existing document.
 */
export async function submitPaidInvoiceToATK(
  supabase: SupabaseBrowserClient,
  organizationId: string,
  invoiceId: string,
): Promise<{ status: string; transactionId?: string; qrPayload?: string; message: string }> {
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) throw new Error("Sesioni ka skaduar. Hyr përsëri.");

  const { data: invoice, error: invoiceError } = await supabase
    .from("fiskalo_invoices")
    .select("id,organization_id,status,total,invoice_number,payment_status,payment_method,subtotal,vat_total,discount_total")
    .eq("id", invoiceId).eq("organization_id", organizationId).single();
  if (invoiceError || !invoice) throw new Error("Fatura nuk u gjet për fiskalizim.");
  if (invoice.status !== "issued" || invoice.payment_status !== "paid") {
    return { status: "not_due", message: "Fatura nuk është ende plotësisht e paguar." };
  }
  
  const { data: existing, error: existingError } = await supabase.from("fiskalo_atk_fiscal_documents")
    .select("id,status,atk_transaction_id,qr_payload").eq("organization_id", organizationId)
    .eq("source_invoice_id", invoiceId).maybeSingle();
  if (existingError) throw new Error("Nuk u kontrollua statusi ekzistues i ATK-së: " + existingError.message);
  if (existing) {
    return { status: existing.status, transactionId: existing.atk_transaction_id ? String(existing.atk_transaction_id) : undefined,
      qrPayload: typeof existing.qr_payload === "string" ? existing.qr_payload : undefined,
      message: existing.status === "accepted" ? "Fatura është pranuar tashmë nga ATK." : "Kjo faturë tashmë ka një dërgesë ATK (" + existing.status + "). Nuk u krijua kupon i dytë." };
  }

  const posReady = await ensureATKTestPosReady(supabase, organizationId);
  if (!posReady.ready) throw new Error(posReady.message);

  const [{ data: org, error: orgError }, { data: positions, error: posError }, { data: lines, error: linesError }, { data: paymentRows, error: paymentsError }] = await Promise.all([
    supabase.from("fiskalo_organizations").select("nui,municipality").eq("id", organizationId).single(),
    supabase.from("fiskalo_atk_pos_installations").select("id,atk_branch_id,pos_id,label,location,environment,status")
      .eq("organization_id", organizationId).eq("environment", "test").eq("status", "active")
      .order("created_at", { ascending: false }),
    supabase.from("fiskalo_invoice_items").select("id,product_id,description,quantity,unit_price,line_subtotal,line_vat,vat_rate,discount_percent")
      .eq("invoice_id", invoiceId),
    supabase.from("fiskalo_invoice_payments").select("amount,payment_method").eq("invoice_id", invoiceId).order("created_at"),
  ]);
  if (orgError || !org || !new RegExp("^[0-9]{9}$").test(String(org.nui))) throw new Error("NUI i biznesit mungon ose nuk është valid.");
  if (posError || !positions?.length) throw new Error("Nuk ka POS TEST aktiv. Përfundo konfigurimin dhe certifikimin një herë.");
  if (linesError || !lines?.length) throw new Error("Fatura nuk ka artikuj të lexueshëm.");
  if (paymentsError || !paymentRows?.length) throw new Error("Nuk u lexua evidenca e pagesave të faturës.");
  const paymentType: Record<string, number> = { cash: 1, card: 2, bank_transfer: 6 };
  const paymentTotals = new Map<number, number>();
  for (const payment of paymentRows) {
    const type = paymentType[payment.payment_method];
    if (!type) throw new Error("Mënyra e pagesës " + payment.payment_method + " nuk ka kod të konfiguruar për ATK.");
    paymentTotals.set(type, (paymentTotals.get(type) ?? 0) + Math.round(Number(payment.amount) * 100));
  }
  const paymentCents = Array.from(paymentTotals.values()).reduce((sum, amount) => sum + amount, 0);
  if (paymentCents !== Math.round(Number(invoice.total) * 100)) throw new Error("Totali i pagesave nuk përputhet me totalin e faturës.");

  let pos: (typeof positions)[number] | null = null;
  let verification: { nui: string; atk_branch_id: number; pos_id: number; application_id: number } | null = null;
  let keyId = "";
  for (const candidate of positions) {
    const saved = await supabase.from("fiskalo_atk_pos_verifications")
      .select("nui,atk_branch_id,pos_id,application_id")
      .eq("organization_id", organizationId).eq("pos_installation_id", candidate.id).maybeSingle();
    if (saved.error || !saved.data || saved.data.nui !== org.nui ||
        Number(saved.data.atk_branch_id) !== Number(candidate.atk_branch_id) ||
        Number(saved.data.pos_id) !== Number(candidate.pos_id) ||
        !Number.isSafeInteger(Number(saved.data.application_id)) || Number(saved.data.application_id) <= 0) continue;
    const candidateKey = organizationId + ":" + candidate.id + ":" + Number(saved.data.application_id);
    if (!await hasBrowserPosCertificate(candidateKey)) continue;
    pos = candidate;
    verification = saved.data;
    keyId = candidateKey;
    break;
  }
  if (!pos || !verification) {
    throw new Error("Nuk u gjet POS TEST me verifikim të ruajtur dhe certifikatë në këtë pajisje. Hyr në pajisjen ku u instalua certifikata ose përfundo konfigurimin fillestar një herë.");
  }

  const productIds = Array.from(new Set(lines.map((line) => line.product_id).filter((id): id is string => Boolean(id))));
  const { data: products, error: productsError } = productIds.length
    ? await supabase.from("fiskalo_products").select("id,atk_unit_code,atk_tax_code,atk_item_category_code")
      .eq("organization_id", organizationId).in("id", productIds)
    : { data: [], error: null };
  if (productsError) throw new Error("Kodet ATK të produkteve nuk u lexuan: " + productsError.message);
  const productMap = new Map<string, { id: string; atk_unit_code: string | null; atk_tax_code: string | null; atk_item_category_code: string | null }>((products ?? []).map((product) => [product.id, product] as const));
  const itemRows = lines.map((line) => {
    const product = line.product_id ? productMap.get(line.product_id) : null;
    const unit = product?.atk_unit_code?.trim() ?? "";
    const tax = product?.atk_tax_code?.trim() ?? "";
    const itemType = product?.atk_item_category_code?.trim() ?? "";
    const vatRate = Number(line.vat_rate);
    const taxMatchesVat = vatRate === 8 ? tax === "D"
      : vatRate === 18 ? tax === "E"
      : vatRate === 0 ? tax === "A" || tax === "C"
      : false;
    if (!unit || !/^[A-Z]$/.test(tax) || !taxMatchesVat || !itemType) {
      throw new Error("Kodet ATK të produktit " + line.description +
        " mungojnë ose nuk përputhen me TVSH-në. Përdor A/C për 0%, D për 8% dhe E për 18%, sipas trajtimit tatimor.");
    }
    return { line, unit, tax, itemType };
  });

  const { data: couponId, error: couponError } = await supabase.rpc("fiskalo_next_atk_coupon_id", { target_organization: organizationId });
  if (couponError || !couponId) throw new Error("Nuk u caktua numri unik i kuponit ATK.");
  const totalCents = Math.round(Number(invoice.total) * 100);
  const items = itemRows.map(({ line, unit, tax, itemType }) => {
    const grossBase = Math.round(Number(line.quantity) * Number(line.unit_price) * 100) / 100;
    const grossVat = Math.round(Number(line.quantity) * Number(line.unit_price) * Number(line.vat_rate)) / 100;
    return {
      name: line.description, unitPriceEuro: Number(line.unit_price), unit, quantity: Number(line.quantity),
      // ATK receives undiscounted item values plus one explicit coupon-level discount.
      lineTotalCents: Math.round((grossBase + grossVat) * 100),
      taxRate: tax, itemType,
    };
  });
  const grouped = new Map<string, { totalForTaxCents: number; totalTaxCents: number }>();
  itemRows.forEach(({ line, tax }) => {
    const current = grouped.get(tax) || { totalForTaxCents: 0, totalTaxCents: 0 };
    current.totalForTaxCents += Math.round(Number(line.line_subtotal) * 100);
    current.totalTaxCents += Math.round(Number(line.line_vat) * 100);
    grouped.set(tax, current);
  });
  const payload = encodeAtkPosCoupon({
    businessId: String(org.nui), couponId, branchId: pos.atk_branch_id,
    location: pos.location || org.municipality || "",
    operatorId: auth.user.id, posId: pos.pos_id, applicationId: Number(verification.application_id),
    verificationNo: createCouponVerificationNo(), type: 1, unixTime: Math.floor(Date.now() / 1000),
    items, payments: Array.from(paymentTotals.entries()).map(([type, amountCents]) => ({ type, amountCents })), totalCents,
    taxGroups: Array.from(grouped.entries()).map(([taxRate, values]) => ({ taxRate, ...values })),
    totalTaxCents: Math.round(Number(invoice.vat_total) * 100),
    totalNoTaxCents: Math.round(Number(invoice.subtotal) * 100),
    totalDiscountCents: Math.round(Number(invoice.discount_total ?? 0) * 100),
  });
  const details = encodeAtkBase64(payload);
  const signature = await signAtkBase64Payload(keyId, details);
  const response = await fetch("/api/atk/test/coupon", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ organizationId, nui: String(org.nui), invoiceId, posInstallationId: pos.id,
      couponId: String(couponId), applicationId: Number(verification.application_id), totalCents, details, signature }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(errorText(result, "Dërgimi i faturës në ATK dështoi. Kontrollo statusin para çdo veprimi tjetër."));
  return { status: "accepted", transactionId: String(result.transactionId), qrPayload: typeof result.qrPayload === "string" ? result.qrPayload : undefined, message: "Fatura u dërgua dhe u pranua nga ATK TEST." };
}
