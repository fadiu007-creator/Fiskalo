import { authorizeAtkOrganization, getAtkRequestContext, positiveInteger } from "@/lib/atk/server-auth";
import { validateAtkCouponPayload } from "@/lib/atk/validate-coupon-payload";

export const runtime = "nodejs";

function readVarint(bytes: Uint8Array, start: number): { value: bigint; next: number } {
  let value = BigInt(0); let shift = BigInt(0); let cursor = start;
  while (cursor < bytes.length && shift < BigInt(70)) {
    const byte = bytes[cursor++]; value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value, next: cursor };
    shift += BigInt(7);
  }
  throw new Error("Malformed ATK Protobuf varint.");
}

function readCouponHeader(details: string): Map<number, bigint> {
  const binary = atob(details);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const fields = new Map<number, bigint>();
  let cursor = 0;
  while (cursor < bytes.length) {
    const tag = readVarint(bytes, cursor); cursor = tag.next;
    const field = Number(tag.value >> BigInt(3)); const wire = Number(tag.value & BigInt(7));
    if (field <= 0) throw new Error("Invalid ATK Protobuf field.");
    if (wire === 0) {
      const parsed = readVarint(bytes, cursor); cursor = parsed.next;
      if ([1, 2, 3, 6, 7, 9, 13, 17, 18].includes(field)) fields.set(field, parsed.value);
    } else if (wire === 1) cursor += 8;
    else if (wire === 2) { const length = readVarint(bytes, cursor); cursor = length.next; cursor += Number(length.value); }
    else if (wire === 5) cursor += 4;
    else throw new Error("Unsupported ATK Protobuf wire type.");
    if (cursor > bytes.length) throw new Error("Truncated ATK Protobuf payload.");
  }
  return fields;
}

function isBase64(value: string): boolean {
  return Boolean(value) && value.length <= 2_000_000 && value.length % 4 === 0 &&
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value);
}

function transactionId(raw: string): string | null {
  const match = raw.match(/"transaction_id"\s*:\s*(?:"([0-9]+)"|([0-9]+))/);
  const value = match?.[1] ?? match?.[2];
  if (!value) return null;
  try {
    const parsed = BigInt(value);
    return parsed > BigInt(0) && parsed <= BigInt("18446744073709551615") ? parsed.toString() : null;
  } catch { return null; }
}

function providerMessage(value: unknown, fallback: string): string {
  if (typeof value === "string" && value.trim()) return value.slice(0, 1200);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["message", "detail", "error", "description"]) {
      if (typeof record[key] === "string" && String(record[key]).trim()) return String(record[key]).slice(0, 1200);
    }
  }
  return fallback;
}

export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try { body = await request.json() as Record<string, unknown>; }
  catch { return Response.json({ error: "invalid_json" }, { status: 400 }); }

  const { supabase, user, authError } = await getAtkRequestContext(request);
  if (authError || !user) return Response.json({ error: "unauthorized" }, { status: 401 });

  const organizationId = typeof body.organizationId === "string" ? body.organizationId : "";
  const adjustmentId = typeof body.adjustmentId === "string" ? body.adjustmentId : "";
  const posInstallationId = typeof body.posInstallationId === "string" ? body.posInstallationId : "";
  const nui = typeof body.nui === "string" ? body.nui : "";
  const details = typeof body.details === "string" ? body.details : "";
  const signature = typeof body.signature === "string" ? body.signature : "";
  const couponIdRaw = typeof body.couponId === "string" ? body.couponId : String(body.couponId ?? "");
  const couponId = /^\d+$/.test(couponIdRaw) ? BigInt(couponIdRaw) : BigInt(0);
  const applicationId = positiveInteger(body.applicationId);
  const totalCents = positiveInteger(body.totalCents);
  const refundPaymentMethod = typeof body.refundPaymentMethod === "string" ? body.refundPaymentMethod : "";
  const paymentType: Record<string, number> = { cash: 1, card: 2, bank_transfer: 6 };
  if (!organizationId || !adjustmentId || !/^\d{9}$/.test(nui)) {
    return Response.json({ error: "invalid_adjustment_request", detail: "A valid organization, adjustment and nine-digit NUI are required." }, { status: 400 });
  }

  const authorization = await authorizeAtkOrganization(supabase, user.id, organizationId, nui, ["owner", "administrator", "manager", "accountant"]);
  if (!authorization.ok) return Response.json({ error: "organization_not_authorized", detail: authorization.detail }, { status: authorization.status });

  const { data: adjustment, error: adjustmentError } = await supabase.from("fiskalo_invoice_adjustments")
    .select("id,organization_id,original_invoice_id,original_fiscal_document_id,adjustment_type,amount,reason,status")
    .eq("id", adjustmentId).eq("organization_id", organizationId).maybeSingle();
  if (adjustmentError || !adjustment) return Response.json({ error: "adjustment_not_found" }, { status: 404 });
  async function rejectBeforeSubmission(error: string, detail: string, status = 409) {
    const { error: rejectError } = await supabase.rpc("fiskalo_reject_invoice_adjustment_preflight", { target_adjustment: adjustmentId, target_detail: detail });
    if (rejectError) console.error("Fiskalo could not close failed preflight adjustment", rejectError.message);
    return Response.json({ error, detail, preflightRejected: !rejectError }, { status });
  }

  if (adjustment.status !== "awaiting_atk") {
    const { data: existing } = await supabase.from("fiskalo_atk_fiscal_documents")
      .select("id,status,atk_transaction_id").eq("source_adjustment_id", adjustmentId).maybeSingle();
    return Response.json({ error: "adjustment_already_processed", fiscalDocumentId: existing?.id, status: existing?.status ?? adjustment.status, transactionId: existing?.atk_transaction_id }, { status: 409 });
  }

  if (!posInstallationId || couponId <= BigInt(0) || couponId > BigInt("18446744073709551615") ||
      !applicationId || totalCents === null || !isBase64(details) || !isBase64(signature) ||
      !paymentType[refundPaymentMethod]) {
    return rejectBeforeSubmission("invalid_adjustment_request", "Të dhënat e POS-it, kuponit ose nënshkrimit janë të pavlefshme. Korrigjimi nuk u dërgua në ATK.", 400);
  }

  const [{ data: invoice, error: invoiceError }, { data: original, error: originalError }, { data: pos, error: posError }] = await Promise.all([
    supabase.from("fiskalo_invoices").select("id,organization_id,status,payment_status").eq("id", adjustment.original_invoice_id).eq("organization_id", organizationId).single(),
    supabase.from("fiskalo_atk_fiscal_documents").select("id,coupon_id,atk_transaction_id,pos_installation_id,status,document_type,pos_coupon_base64")
      .eq("id", adjustment.original_fiscal_document_id).eq("organization_id", organizationId).single(),
    supabase.from("fiskalo_atk_pos_installations").select("id,organization_id,atk_branch_id,pos_id,environment,status,location")
      .eq("id", posInstallationId).eq("organization_id", organizationId).single(),
  ]);
  if (invoiceError || !invoice || invoice.status !== "issued" || invoice.payment_status !== "paid") {
    return rejectBeforeSubmission("original_invoice_not_eligible", "Fatura origjinale nuk është e lëshuar dhe e paguar. Korrigjimi nuk u dërgua në ATK.");
  }
  if (originalError || !original || original.document_type !== "sale" || original.status !== "accepted" || !original.atk_transaction_id) {
    return rejectBeforeSubmission("original_atk_sale_not_accepted", "Kuponi origjinal nuk ka pranim të konfirmuar nga ATK. Korrigjimi nuk u dërgua.");
  }
  // A correction must use the same certified application identity as the
  // accepted original sale. This also proves which legacy browser key is valid.
  try {
    const originalHeader = readCouponHeader(String(original.pos_coupon_base64 || ""));
    if (originalHeader.get(7) !== BigInt(applicationId)) {
      return rejectBeforeSubmission("original_application_id_mismatch",
        "Application ID i verifikimit nuk përputhet me kuponin origjinal të pranuar nga ATK. Përdor Application ID me të cilin u lëshua shitja origjinale.");
    }
  } catch {
    return rejectBeforeSubmission("original_coupon_identity_unavailable",
      "Nuk mund të verifikohet Application ID i kuponit origjinal. Korrigjimi nuk u dërgua në ATK.");
  }
  if (posError || !pos || pos.environment !== "test" || pos.status !== "active" || pos.id !== original.pos_installation_id) {
    return rejectBeforeSubmission("original_test_pos_required", "Përdor të njëjtin POS TEST aktiv që e ka dërguar shitjen origjinale. Korrigjimi nuk u dërgua në ATK.");
  }
  const { data: verification, error: verificationError } = await supabase.from("fiskalo_atk_pos_verifications")
    .select("nui,atk_branch_id,pos_id,application_id")
    .eq("organization_id", organizationId).eq("pos_installation_id", posInstallationId).maybeSingle();
  if (verificationError || !verification || verification.nui !== nui ||
      Number(verification.atk_branch_id) !== Number(pos.atk_branch_id) ||
      Number(verification.pos_id) !== Number(pos.pos_id)) {
    return rejectBeforeSubmission("pos_verification_missing", "POS-i origjinal nuk ka verifikim ATK TEST të sinkronizuar në Fiskalo. Korrigjimi nuk u dërgua në ATK.");
  }

  const [{ data: adjustmentItems, error: adjustmentItemsError }, { data: invoiceItems, error: invoiceItemsError }, { data: organization, error: organizationError }] = await Promise.all([
    supabase.from("fiskalo_invoice_adjustment_items")
      .select("original_invoice_item_id,product_id,description,quantity,unit_price,net_amount,vat_amount,total_amount")
      .eq("adjustment_id", adjustmentId).eq("organization_id", organizationId),
    supabase.from("fiskalo_invoice_items")
      .select("id,product_id,description,quantity,unit_price,line_subtotal,line_vat,vat_rate")
      .eq("invoice_id", invoice.id),
    supabase.from("fiskalo_organizations").select("nui,municipality").eq("id", organizationId).single(),
  ]);
  if (adjustmentItemsError || !adjustmentItems?.length || invoiceItemsError || !invoiceItems?.length || organizationError || !organization) {
    return rejectBeforeSubmission("adjustment_ledger_unavailable", "Të dhënat e faturës ose të artikujve nuk mund të lexohen. Korrigjimi nuk u dërgua në ATK.", 500);
  }
  if (String(organization.nui) !== nui) return rejectBeforeSubmission("nui_mismatch", "NUI nuk përputhet me biznesin. Korrigjimi nuk u dërgua në ATK.");
  const invoiceItemMap = new Map(invoiceItems.map((line) => [line.id, line]));
  const adjustedLines = adjustmentItems.map((item) => {
    const originalLine = invoiceItemMap.get(item.original_invoice_item_id);
    if (!originalLine) return null;
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
  if (adjustedLines.some((line) => !line)) return rejectBeforeSubmission("adjustment_item_mismatch", "Artikujt e korrigjimit nuk përputhen me faturën origjinale. Korrigjimi nuk u dërgua.");
  const lines = adjustedLines as NonNullable<(typeof adjustedLines)[number]>[];
  const total = Number(adjustment.amount);
  const subtotal = lines.reduce((sum, line) => sum + line.line_subtotal, 0);
  const vatTotal = lines.reduce((sum, line) => sum + line.line_vat, 0);
  // For returned quantities, compare the original unit-price gross value with
  // the discounted refund ledger amount. This preserves the original sale's
  // discount in ATK TotalDiscount instead of silently dropping it.
  const discountTotalCents = lines.reduce((sum, line) => {
    const grossCents =
      Math.round(Number(line.quantity) * Number(line.unit_price) * 100) +
      Math.round(Number(line.quantity) * Number(line.unit_price) * Number(line.vat_rate));
    const discountedCents = Math.round((Number(line.line_subtotal) + Number(line.line_vat)) * 100);
    return sum + grossCents - discountedCents;
  }, 0);
  if (discountTotalCents < 0) {
    return rejectBeforeSubmission("adjustment_discount_invalid", "Zbritja e llogaritur për korrigjimin është negative. Korrigjimi nuk u dërgua.");
  }
  if (Math.round(total * 100) !== totalCents || Math.round((subtotal + vatTotal) * 100) !== totalCents) {
    return rejectBeforeSubmission("adjustment_total_mismatch", "Totali i korrigjimit nuk përputhet me shumën e nënshkruar. Korrigjimi nuk u dërgua.");
  }
  const productIds = Array.from(new Set(lines.map((line) => line.product_id).filter((id): id is string => Boolean(id))));
  const { data: products, error: productsError } = productIds.length
    ? await supabase.from("fiskalo_products").select("id,atk_unit_code,atk_tax_code,atk_item_category_code")
      .eq("organization_id", organizationId).in("id", productIds)
    : { data: [], error: null };
  if (productsError) return rejectBeforeSubmission("product_mapping_unavailable", "Kodet fiskale të artikujve nuk mund të lexohen. Korrigjimi nuk u dërgua në ATK.", 500);

  const couponType = adjustment.adjustment_type === "cancel" ? 2 : 3;
  let header: Map<number, bigint>;
  try { header = readCouponHeader(details); }
  catch { return rejectBeforeSubmission("invalid_protobuf", "Kuponi i nënshkruar ka format të pavlefshëm. Korrigjimi nuk u dërgua në ATK.", 400); }
  const expectedHeader = new Map<number, bigint>([
    [1, BigInt(nui)], [2, couponId], [3, BigInt(pos.atk_branch_id)],
    [6, BigInt(pos.pos_id)], [7, BigInt(applicationId)], [9, BigInt(couponType)],
    [13, BigInt(totalCents)], [17, BigInt(original.coupon_id)],
  ]);
  for (const [field, expected] of expectedHeader) {
    if (header.get(field) !== expected) return rejectBeforeSubmission("coupon_header_mismatch", "Të dhënat e kuponit të nënshkruar nuk përputhen me faturën dhe POS-in. Korrigjimi nuk u dërgua.");
  }
  if (header.get(18) && header.get(18) !== BigInt(0)) {
    return rejectBeforeSubmission("unsupported_transaction_reference", "Referenca opsionale e transaksionit nuk mbështetet ende. Korrigjimi nuk u dërgua.");
  }
  const payloadValidation = validateAtkCouponPayload(details, {
    nui, couponId: couponId.toString(), couponType, referenceCouponId: String(original.coupon_id),
    branchId: Number(pos.atk_branch_id), posId: Number(pos.pos_id), applicationId,
    operatorId: user.id, location: pos.location || organization.municipality || "",
    total, discountTotal: discountTotalCents / 100, subtotal, vatTotal, lines, products: products ?? [],
    payments: [{ amount: total, payment_method: refundPaymentMethod }],
  });
  if (!payloadValidation.ok) return rejectBeforeSubmission("correction_payload_mismatch", payloadValidation.detail + " Korrigjimi nuk u dërgua në ATK.");

  const { data: existing, error: existingError } = await supabase.from("fiskalo_atk_fiscal_documents")
    .select("id,status,atk_transaction_id").eq("source_adjustment_id", adjustmentId).maybeSingle();
  if (existingError) return rejectBeforeSubmission("correction_lookup_failed", "Nuk u verifikua nëse ekziston një dërgim i mëparshëm. Korrigjimi nuk u dërgua në ATK.", 500);
  if (existing) return Response.json({ error: "adjustment_already_submitted", fiscalDocumentId: existing.id, status: existing.status, transactionId: existing.atk_transaction_id }, { status: 409 });

  const qrPayload = details + "|" + signature;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(details));
  const payloadHash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const { data: fiscalDocument, error: insertError } = await supabase.from("fiskalo_atk_fiscal_documents").insert({
    organization_id: organizationId, pos_installation_id: posInstallationId,
    source_invoice_id: invoice.id, source_adjustment_id: adjustmentId,
    coupon_id: couponIdRaw, reference_coupon_id: original.coupon_id,
    document_type: adjustment.adjustment_type, status: "queued",
    occurred_at: new Date().toISOString(), total, pos_coupon_base64: details,
    signature_base64: signature, qr_payload: qrPayload, payload_sha256: payloadHash,
    created_by: user.id,
  }).select("id").single();
  if (insertError || !fiscalDocument) {
    if (insertError?.code === "23505") {
      const { data: raced } = await supabase.from("fiskalo_atk_fiscal_documents")
        .select("id,status,atk_transaction_id").eq("source_adjustment_id", adjustmentId).maybeSingle();
      if (raced) return Response.json({ error: "adjustment_already_submitted", fiscalDocumentId: raced.id, status: raced.status, transactionId: raced.atk_transaction_id }, { status: 409 });
    }
    return rejectBeforeSubmission("fiscal_document_save_failed", "Kuponi nuk u ruajt në Fiskalo dhe nuk u dërgua në ATK. " + (insertError?.message ?? ""), 500);
  }

  // The signed coupon is now durably stored and uniquely linked to this adjustment.
  // Audit/status writes must not prevent the actual ATK request: otherwise a saved
  // coupon can become permanently stuck without ever reaching ATK.
  const { error: eventError } = await supabase.from("fiskalo_atk_fiscal_events").insert({
    organization_id: organizationId, fiscal_document_id: fiscalDocument.id,
    event_type: "submission_started",
    details: { environment: "TEST", adjustmentId, adjustmentType: adjustment.adjustment_type, originalCouponId: original.coupon_id },
  });
  if (eventError) console.error("Fiskalo ATK adjustment audit event failed", eventError.message);
  const { error: submittingError } = await supabase.from("fiskalo_atk_fiscal_documents").update({
    status: "submitted", submission_attempts: 1, last_submitted_at: new Date().toISOString(),
  }).eq("id", fiscalDocument.id).eq("organization_id", organizationId);
  if (submittingError) console.error("Fiskalo ATK adjustment submission status update failed", submittingError.message);
  const { error: adjustmentSubmitError } = await supabase.rpc("fiskalo_set_invoice_adjustment_atk_status", {
    target_adjustment: adjustmentId, target_status: "submitted",
  });
  if (adjustmentSubmitError) console.error("Fiskalo ATK adjustment ledger submission status update failed", adjustmentSubmitError.message);

  try {
    const response = await fetch("https://fiskalizimi-test.atk-ks.org/pos/coupon", {
      method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ details, signature }), signal: AbortSignal.timeout(30000), cache: "no-store",
    });
    const raw = await response.text();
    let result: Record<string, unknown> = {};
    try { result = JSON.parse(raw) as Record<string, unknown>; } catch { /* handled below */ }
    if (!response.ok) {
      const detail = providerMessage(result, raw || "ATK returned an error.");
      const definitive = response.status >= 400 && response.status < 500;
      await supabase.from("fiskalo_atk_fiscal_documents").update({
        status: definitive ? "rejected" : "offline_pending", last_error: detail, atk_response: result,
      }).eq("id", fiscalDocument.id);
      await supabase.from("fiskalo_atk_fiscal_events").insert({
        organization_id: organizationId, fiscal_document_id: fiscalDocument.id,
        event_type: definitive ? "rejected" : "response_unconfirmed",
        details: { httpStatus: response.status, detail, requiresReconciliation: !definitive },
      });
      if (definitive) {
        await supabase.rpc("fiskalo_set_invoice_adjustment_atk_status", {
          target_adjustment: adjustmentId, target_status: "rejected",
        });
      }
      return Response.json({ error: definitive ? "atk_correction_rejected" : "atk_response_unconfirmed", detail, fiscalDocumentId: fiscalDocument.id }, { status: 502 });
    }
    const id = transactionId(raw);
    if (!id) {
      const detail = "ATK returned HTTP success without a valid uint64 transaction_id. Check ATK before retrying.";
      await supabase.from("fiskalo_atk_fiscal_documents").update({ status: "offline_pending", last_error: detail, atk_response: result }).eq("id", fiscalDocument.id);
      await supabase.from("fiskalo_atk_fiscal_events").insert({ organization_id: organizationId, fiscal_document_id: fiscalDocument.id, event_type: "response_unconfirmed", details: { detail } });
      return Response.json({ error: "atk_response_unconfirmed", detail, fiscalDocumentId: fiscalDocument.id }, { status: 502 });
    }
    result.transaction_id = id;
    const { error: acceptedError } = await supabase.from("fiskalo_atk_fiscal_documents").update({
      status: "accepted", atk_transaction_id: id, atk_response: result, accepted_at: new Date().toISOString(), last_error: null,
    }).eq("id", fiscalDocument.id).eq("organization_id", organizationId);
    if (acceptedError) return Response.json({ error: "accepted_status_save_failed", detail: "ATK accepted the correction, but Fiskalo could not persist its status. Do not resubmit.", fiscalDocumentId: fiscalDocument.id, transactionId: id }, { status: 500 });
    const { error: adjustmentAcceptedError } = await supabase.rpc("fiskalo_set_invoice_adjustment_atk_status", {
      target_adjustment: adjustmentId, target_status: "accepted",
    });
    if (adjustmentAcceptedError) {
      return Response.json({ error: "adjustment_acceptance_save_failed", detail: "ATK accepted the correction and the fiscal document is saved, but the adjustment ledger status needs reconciliation. Do not resubmit.", fiscalDocumentId: fiscalDocument.id, transactionId: id }, { status: 500 });
    }
    await supabase.from("fiskalo_atk_fiscal_events").insert({
      organization_id: organizationId, fiscal_document_id: fiscalDocument.id,
      event_type: "accepted", details: { transactionId: id, environment: "TEST", adjustmentId },
    });
    return Response.json({ accepted: true, environment: "TEST", transactionId: id, fiscalDocumentId: fiscalDocument.id, qrPayload }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    const detail = "Could not confirm the ATK TEST response. The correction is saved for reconciliation; do not submit it again.";
    await supabase.from("fiskalo_atk_fiscal_documents").update({ status: "offline_pending", last_error: detail }).eq("id", fiscalDocument.id);
    await supabase.from("fiskalo_atk_fiscal_events").insert({
      organization_id: organizationId, fiscal_document_id: fiscalDocument.id, event_type: "response_unconfirmed", details: { detail },
    });
    return Response.json({ error: "atk_response_unconfirmed", detail, fiscalDocumentId: fiscalDocument.id }, { status: 502 });
  }
}
