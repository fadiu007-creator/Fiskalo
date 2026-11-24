import { authorizeAtkOrganization, getAtkRequestContext, getAtkServiceRoleClient, positiveInteger } from "@/lib/atk/server-auth";
import { certificateSpkiFingerprint, verifySignedBase64Payload } from "@/lib/atk/certificate-crypto";
import { readAtkPosCouponVerificationNo, validateAtkCitizenCouponPayload, validateAtkCouponPayload } from "@/lib/atk/validate-coupon-payload";
import { recordFiscalSubmissionStartBestEffort } from "@/lib/atk/submission-start";
import { parseAtkTransactionId } from "@/lib/atk/transaction-id";
import { classifyAtkHttpFailure } from "@/lib/atk/http-submission-outcome";

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
      if ([1, 2, 3, 6, 7, 9, 10, 13].includes(field)) fields.set(field, parsed.value);
    } else if (wire === 1) cursor += 8;
    else if (wire === 2) { const length = readVarint(bytes, cursor); cursor = length.next; cursor += Number(length.value); }
    else if (wire === 5) cursor += 4;
    else throw new Error("Unsupported ATK Protobuf wire type.");
    if (cursor > bytes.length) throw new Error("Truncated ATK Protobuf payload.");
  }
  return fields;
}

function readableProviderMessage(value: unknown, fallback: string): string {
  if (typeof value === "string" && value.trim()) return value.slice(0, 1200);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["message", "detail", "error", "description", "title"]) {
      if (record[key] !== undefined) {
        const message = readableProviderMessage(record[key], "");
        if (message) return message;
      }
    }
    try { return JSON.stringify(value).slice(0, 1200); } catch { return fallback; }
  }
  return fallback;
}



function isBase64(value: string): boolean {
  if (!value || value.length > 2_000_000 || value.length % 4 !== 0) return false;
  return /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value);
}

export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try { body = await request.json() as Record<string, unknown>; }
  catch { return Response.json({ error: "invalid_json" }, { status: 400 }); }

  const { supabase, user, authError } = await getAtkRequestContext(request);
  if (authError || !user) return Response.json({ error: "unauthorized" }, { status: 401 });

  const organizationId = typeof body.organizationId === "string" ? body.organizationId : "";
  const nui = typeof body.nui === "string" ? body.nui : "";
  const invoiceId = typeof body.invoiceId === "string" ? body.invoiceId : "";
  const posInstallationId = typeof body.posInstallationId === "string" ? body.posInstallationId : "";
  const details = typeof body.details === "string" ? body.details : "";
  const signature = typeof body.signature === "string" ? body.signature : "";
  const citizenDetails = typeof body.citizenDetails === "string" ? body.citizenDetails : "";
  const citizenSignature = typeof body.citizenSignature === "string" ? body.citizenSignature : "";
  const couponId = positiveInteger(body.couponId);
  const totalCents = positiveInteger(body.totalCents);
  const applicationId = positiveInteger(body.applicationId);
  if (!organizationId || !invoiceId || !posInstallationId || !/^\d{9}$/.test(nui) ||
      !couponId || totalCents === null || !applicationId || !isBase64(details) || !isBase64(signature) || !isBase64(citizenDetails) || !isBase64(citizenSignature)) {
    return Response.json({ error: "invalid_coupon_request", detail: "Organization, invoice, TEST POS, NUI, coupon ID, total and signed Protobuf details are required." }, { status: 400 });
  }

  const authorization = await authorizeAtkOrganization(supabase, user.id, organizationId, nui, ["owner", "administrator", "manager", "cashier"]);
  if (!authorization.ok) return Response.json({ error: "organization_not_authorized", detail: authorization.detail }, { status: authorization.status });

  let service: ReturnType<typeof getAtkServiceRoleClient>;
  try { service = getAtkServiceRoleClient(); }
  catch { return Response.json({ error: "trusted_atk_backend_unavailable" }, { status: 503 }); }

  const [{ data: invoice, error: invoiceError }, { data: pos, error: posError }] = await Promise.all([
    supabase.from("fiskalo_invoices").select("id,organization_id,status,total,subtotal,vat_total,discount_total,invoice_number,payment_status,payment_method").eq("id", invoiceId).eq("organization_id", organizationId).single(),
    supabase.from("fiskalo_atk_pos_installations").select("id,organization_id,atk_branch_id,pos_id,environment,status,location").eq("id", posInstallationId).eq("organization_id", organizationId).single(),
  ]);
  if (invoiceError || !invoice || invoice.status !== "issued" || invoice.payment_status !== "paid") {
    return Response.json({ error: "invoice_not_eligible", detail: "Only a fully paid and issued Fiskalo invoice can be submitted as an ATK TEST sale." }, { status: 409 });
  }
  if (posError || !pos || pos.environment !== "test" || pos.status !== "active") {
    return Response.json({ error: "test_pos_not_ready", detail: "The selected POS installation is not configured for the ATK TEST environment." }, { status: 409 });
  }
  const { data: verification, error: verificationError } = await supabase.from("fiskalo_atk_pos_verifications")
    .select("nui,atk_branch_id,pos_id,application_id,verified_at")
    .eq("organization_id", organizationId).eq("pos_installation_id", posInstallationId).maybeSingle();
  if (verificationError || !verification ||
      verification.nui !== nui ||
      Number(verification.atk_branch_id) !== Number(pos.atk_branch_id) ||
      Number(verification.pos_id) !== Number(pos.pos_id) ||
      Number(verification.application_id) !== applicationId) {
    return Response.json({ error: "pos_verification_missing", detail: "This POS has no matching ATK TEST verification saved to the business account. Verify this exact POS once in Regjistro / certifiko POS, then retry." }, { status: 409 });
  }

  const { data: registeredCertificate, error: certificateError } = await service.from("fiskalo_atk_pos_certificates")
    .select("certificate_pem,spki_sha256,application_id").eq("organization_id", organizationId)
    .eq("pos_installation_id", posInstallationId).eq("status", "active").is("revoked_at", null)
    .order("issued_at", { ascending: false }).limit(1).maybeSingle();
  if (certificateError || !registeredCertificate?.certificate_pem || !registeredCertificate.spki_sha256) {
    return Response.json({ error: "pos_certificate_not_registered", detail: "No active server-registered ATK certificate exists for this exact POS." }, { status: 409 });
  }
  if (Number(registeredCertificate.application_id) !== applicationId) {
    return Response.json({ error: "certificate_application_id_mismatch", detail: "The active ATK certificate belongs to a different Application ID. Re-verify and issue a matching certificate before creating new coupons." }, { status: 409 });
  }
  try {
    const fingerprint = await certificateSpkiFingerprint(registeredCertificate.certificate_pem);
    if (fingerprint !== registeredCertificate.spki_sha256 ||
        !(await verifySignedBase64Payload(registeredCertificate.certificate_pem, details, signature)) ||
        !(await verifySignedBase64Payload(registeredCertificate.certificate_pem, citizenDetails, citizenSignature))) {
      return Response.json({ error: "pos_signature_invalid", detail: "The signed POS coupon or CitizenCoupon does not verify against the certificate registered to this POS." }, { status: 403 });
    }
  } catch {
    return Response.json({ error: "pos_signature_invalid", detail: "The coupon signature or registered POS certificate is invalid." }, { status: 403 });
  }
  let header: Map<number, bigint>;
  try { header = readCouponHeader(details); }
  catch { return Response.json({ error: "invalid_protobuf", detail: "The signed details are not a valid ATK Protobuf coupon." }, { status: 400 }); }
  const expectedHeader = new Map<number, bigint>([[1, BigInt(nui)], [2, BigInt(couponId)], [3, BigInt(pos.atk_branch_id)], [6, BigInt(pos.pos_id)], [7, BigInt(applicationId)], [9, BigInt(1)], [13, BigInt(totalCents)]]);
  for (const [field, expected] of expectedHeader) {
    if (header.get(field) !== expected) return Response.json({ error: "coupon_header_mismatch", detail: "The signed coupon identifiers or totals do not match the selected Fiskalo business, TEST POS and invoice." }, { status: 409 });
  }
  if (Math.round(Number(invoice.total) * 100) !== totalCents) {
    return Response.json({ error: "invoice_total_mismatch", detail: "The signed coupon total does not match the issued Fiskalo invoice." }, { status: 409 });
  }

  const [{ data: invoiceLines, error: invoiceLinesError }, { data: payments, error: paymentsError }] = await Promise.all([
    supabase.from("fiskalo_invoice_items")
      .select("product_id,description,quantity,unit_price,line_subtotal,line_vat,vat_rate,atk_unit_code,atk_tax_code,atk_item_category_code")
      .eq("invoice_id", invoiceId),
    supabase.from("fiskalo_invoice_payments")
      .select("amount,payment_method")
      .eq("invoice_id", invoiceId)
      .order("created_at"),
  ]);
  if (invoiceLinesError || !invoiceLines?.length || paymentsError || !payments?.length) {
    return Response.json({ error: "invoice_ledger_unavailable", detail: "Fiskalo could not read the complete invoice lines and payment ledger. No coupon was sent." }, { status: 500 });
  }
  // Validate against the immutable ATK classification captured on each invoice line.
  // Never join the current product master for an already-issued sale.
  const products = invoiceLines
    .filter((line) => typeof line.product_id === "string")
    .map((line) => ({
      id: line.product_id as string,
      atk_unit_code: line.atk_unit_code,
      atk_tax_code: line.atk_tax_code,
      atk_item_category_code: line.atk_item_category_code,
    }));

  const payloadValidation = validateAtkCouponPayload(details, {
    nui,
    couponId,
    branchId: Number(pos.atk_branch_id),
    posId: Number(pos.pos_id),
    applicationId,
    operatorId: user.id,
    location: pos.location || authorization.organization.municipality || "",
    total: Number(invoice.total),
    discountTotal: Number(invoice.discount_total ?? 0),
    subtotal: Number(invoice.subtotal),
    vatTotal: Number(invoice.vat_total),
    lines: invoiceLines,
    products,
    payments,
  });
  if (!payloadValidation.ok) {
    return Response.json({ error: "coupon_invoice_mismatch", detail: payloadValidation.detail }, { status: 409 });
  }

  const expectedTaxGroups = new Map<string, { totalForTaxCents: number; totalTaxCents: number }>();
  for (const line of invoiceLines) {
    const taxRate = String(line.atk_tax_code || "");
    const current = expectedTaxGroups.get(taxRate) ?? { totalForTaxCents: 0, totalTaxCents: 0 };
    current.totalForTaxCents += Math.round(Number(line.line_subtotal) * 100);
    current.totalTaxCents += Math.round(Number(line.line_vat) * 100);
    expectedTaxGroups.set(taxRate, current);
  }
  const citizenValidation = validateAtkCitizenCouponPayload(citizenDetails, {
    nui,
    couponId,
    branchId: Number(pos.atk_branch_id),
    posId: Number(pos.pos_id),
    verificationNo: readAtkPosCouponVerificationNo(details),
    type: Number(header.get(9)) as 1 | 2 | 3,
    unixTime: Number(header.get(10)),
    totalCents,
    totalTaxCents: Math.round(Number(invoice.vat_total) * 100),
    totalNoTaxCents: Math.round(Number(invoice.subtotal) * 100),
    taxGroups: Array.from(expectedTaxGroups.entries()).map(([taxRate, values]) => ({ taxRate, ...values })),
  });
  if (!citizenValidation.ok) {
    return Response.json({ error: "citizen_coupon_invoice_mismatch", detail: citizenValidation.detail }, { status: 409 });
  }

  const { data: existing, error: existingLookupError } = await supabase.from("fiskalo_atk_fiscal_documents")
    .select("id,status,atk_transaction_id").eq("organization_id", organizationId).eq("source_invoice_id", invoiceId).maybeSingle();
  if (existingLookupError) {
    return Response.json({ error: "fiscal_document_lookup_failed", detail: "Could not check whether this invoice already has an ATK document. No new coupon was sent." }, { status: 500 });
  }
  if (existing) {
    return Response.json({ error: "invoice_already_submitted", fiscalDocumentId: existing.id, status: existing.status, transactionId: existing.atk_transaction_id }, { status: 409 });
  }

  const qrPayload = citizenDetails + "|" + citizenSignature;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(details));
  const payloadHash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const { data: fiscalDocument, error: insertError } = await service.from("fiskalo_atk_fiscal_documents").insert({
    organization_id: organizationId,
    pos_installation_id: posInstallationId,
    source_invoice_id: invoiceId,
    coupon_id: couponId,
    document_type: "sale",
    status: "queued",
    occurred_at: new Date().toISOString(),
    total: Number(invoice.total),
    pos_coupon_base64: details,
    signature_base64: signature,
    citizen_coupon_base64: citizenDetails,
    citizen_signature_base64: citizenSignature,
    qr_payload: qrPayload,
    payload_sha256: payloadHash,
    created_by: user.id,
  }).select("id").single();

  if (insertError || !fiscalDocument) {
    // A concurrent checkout/retry may have won the unique invoice constraint.
    // Return its ledger state instead of exposing a generic failure or submitting twice.
    if (insertError?.code === "23505") {
      const { data: racedDocument } = await supabase.from("fiskalo_atk_fiscal_documents")
        .select("id,status,atk_transaction_id").eq("organization_id", organizationId)
        .eq("source_invoice_id", invoiceId).maybeSingle();
      if (racedDocument) {
        return Response.json({
          error: "invoice_already_submitted", fiscalDocumentId: racedDocument.id,
          status: racedDocument.status, transactionId: racedDocument.atk_transaction_id,
        }, { status: 409 });
      }
    }
    return Response.json({ error: "fiscal_document_save_failed", detail: insertError?.message ?? "Could not save the ATK TEST document." }, { status: 500 });
  }

  // The signed coupon is durably stored and uniquely linked to this invoice.
  // Audit/status bookkeeping must not strand a queued document before the ATK
  // request: if either write fails, continue with the single submission attempt
  // and preserve the resulting provider response for later reconciliation.
  await recordFiscalSubmissionStartBestEffort([
    {
      label: "Fiskalo ATK sale submission audit event failed",
      run: () => service.from("fiskalo_atk_fiscal_events").insert({
        organization_id: organizationId, fiscal_document_id: fiscalDocument.id,
        event_type: "submission_started", details: { environment: "TEST", invoiceNumber: invoice.invoice_number },
      }),
    },
    {
      label: "Fiskalo ATK sale submission status update failed",
      run: () => service.from("fiskalo_atk_fiscal_documents").update({
        status: "submitted", submission_attempts: 1, last_submitted_at: new Date().toISOString(),
      }).eq("id", fiscalDocument.id).eq("organization_id", organizationId),
    },
  ]);

  try {
    const response = await fetch("https://fiskalizimi-test.atk-ks.org/pos/coupon", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ details, signature }),
      signal: AbortSignal.timeout(30000),
      cache: "no-store",
    });
    const raw = await response.text();
    let result: Record<string, unknown> = {};
    try { result = JSON.parse(raw) as Record<string, unknown>; } catch { /* checked below */ }
    if (!response.ok) {
      const detail = readableProviderMessage(result, readableProviderMessage(raw, "ATK rejected the TEST coupon."));
      // Match the Windows POS Agent's conservative allowlist. Only known ATK
      // validation/auth responses are definitive; unknown 4xx, redirects, timeouts,
      // conflicts, throttling and 5xx responses remain ambiguous to prevent duplicates.
      const definitiveRejection = classifyAtkHttpFailure(response.status) === "rejected";
      const fiscalStatus = definitiveRejection ? "rejected" : "offline_pending";
      const eventType = definitiveRejection ? "rejected" : "response_unconfirmed";
      await service.from("fiskalo_atk_fiscal_documents").update({
        status: fiscalStatus, last_error: detail, atk_response: result,
      }).eq("id", fiscalDocument.id);
      await service.from("fiskalo_atk_fiscal_events").insert({
        organization_id: organizationId, fiscal_document_id: fiscalDocument.id, event_type: eventType,
        details: { httpStatus: response.status, detail, requiresReconciliation: !definitiveRejection },
      });
      return Response.json({
        error: definitiveRejection ? "atk_coupon_rejected" : "atk_response_unconfirmed",
        detail, atkStatus: response.status, fiscalDocumentId: fiscalDocument.id,
      }, { status: 502 });
    }
    const transactionId = parseAtkTransactionId(raw);
    if (!transactionId) {
      const detail = "ATK returned HTTP success but its response did not contain a valid uint64 transaction_id. Check ATK before retrying.";
      await service.from("fiskalo_atk_fiscal_documents").update({ status: "offline_pending", last_error: detail, atk_response: result }).eq("id", fiscalDocument.id);
      await service.from("fiskalo_atk_fiscal_events").insert({ organization_id: organizationId, fiscal_document_id: fiscalDocument.id, event_type: "response_unconfirmed", details: { detail, httpStatus: response.status } });
      return Response.json({ error: "atk_response_unconfirmed", detail, fiscalDocumentId: fiscalDocument.id }, { status: 502 });
    }
    // Persist the exact decimal digits as a string so neither JS nor JSON serialization rounds the uint64.
    result.transaction_id = transactionId;
    const { error: acceptedUpdateError } = await service.from("fiskalo_atk_fiscal_documents").update({
      status: "accepted", atk_transaction_id: transactionId, atk_response: result,
      accepted_at: new Date().toISOString(), last_error: null,
    }).eq("id", fiscalDocument.id).eq("organization_id", organizationId);
    if (acceptedUpdateError) {
      return Response.json({ error: "accepted_status_save_failed", detail: "ATK accepted the coupon, but Fiskalo could not save the acceptance status. Do not resubmit this invoice.", fiscalDocumentId: fiscalDocument.id, transactionId }, { status: 500 });
    }
    await service.from("fiskalo_atk_fiscal_events").insert({
      organization_id: organizationId, fiscal_document_id: fiscalDocument.id,
      event_type: "accepted", details: { transactionId, environment: "TEST" },
    });
    return Response.json({ accepted: true, environment: "TEST", transactionId, fiscalDocumentId: fiscalDocument.id, qrPayload, message: result.message ?? "ATK accepted the TEST coupon." }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const detail = error instanceof Error && error.name === "TimeoutError" ? "ATK TEST request timed out; check ATK before retrying to avoid a duplicate." : "Could not reach ATK TEST. Check the fiscal document before retrying.";
    await service.from("fiskalo_atk_fiscal_documents").update({ status: "offline_pending", last_error: detail }).eq("id", fiscalDocument.id);
    await service.from("fiskalo_atk_fiscal_events").insert({ organization_id: organizationId, fiscal_document_id: fiscalDocument.id, event_type: "offline_saved", details: { detail } });
    return Response.json({ error: "atk_unreachable", detail, fiscalDocumentId: fiscalDocument.id }, { status: 502 });
  }
}
