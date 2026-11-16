// deno-lint-ignore no-import-prefix -- Supabase Edge Functions pin and resolve npm modules at runtime.
import { createClient } from "npm:@supabase/supabase-js@2.114.0";
import { createAtkReceiptHandler, type AtkReceiptDependencies } from "./handler.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL");
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

if (!supabaseUrl || !serviceRoleKey) {
  Deno.serve(() => new Response(
    JSON.stringify({ error: "Supabase Edge Function secrets are not configured." }),
    { status: 503, headers: { "Content-Type": "application/json; charset=utf-8" } },
  ));
} else {
  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const dependencies: AtkReceiptDependencies = {
    async authenticate(token) {
      const { data, error } = await admin.auth.getUser(token);
      if (error || !data.user) return null;
      return { id: data.user.id };
    },
    async isMember(businessId, userId) {
      const { data, error } = await admin.from("fiskalo_basic_members")
        .select("user_id").eq("business_id", businessId).eq("user_id", userId).maybeSingle();
      if (error) throw error;
      return Boolean(data);
    },
    async isOwner(businessId, userId) {
      const { data, error } = await admin.from("fiskalo_basic_members")
        .select("user_id").eq("business_id", businessId).eq("user_id", userId).eq("role", "owner").maybeSingle();
      if (error) throw error;
      return Boolean(data);
    },
    async registerCertificate(args) {
      const { data, error } = await admin.rpc("fiskalo_basic_server_register_pos_certificate_v1", args);
      if (error) throw error;
      if (typeof data !== "string" || !data) throw new Error("ATK certificate registration RPC returned no certificate ID.");
      return data;
    },
    async getBusiness(businessId) {
      const { data, error } = await admin.from("fiskalo_basic_businesses")
        .select("nui,name").eq("id", businessId).maybeSingle();
      if (error) throw error;
      return data ? { nui: data.nui as string | number, name: data.name as string } : null;
    },
    async getPos(businessId, posUuid) {
      const { data, error } = await admin.from("fiskalo_basic_pos")
        .select("id,business_id,branch_id,pos_id,application_id,certificate_status,location,verified_business_name")
        .eq("id", posUuid).eq("business_id", businessId).maybeSingle();
      if (error) throw error;
      return data ? {
        id: data.id,
        businessId: data.business_id,
        branchId: Number(data.branch_id),
        posNumber: Number(data.pos_id),
        applicationId: data.application_id as string | number,
        certificateStatus: data.certificate_status,
        location: data.location,
        verifiedBusinessName: data.verified_business_name,
      } : null;
    },
    async getCertificate(businessId, posUuid) {
      const { data, error } = await admin.from("fiskalo_basic_pos_certificates")
        .select("application_id,certificate_pem,spki_sha256,status,revoked_at")
        .eq("business_id", businessId).eq("pos_id", posUuid)
        .order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (error) throw error;
      return data ? {
        applicationId: Number(data.application_id),
        certificatePem: data.certificate_pem,
        spkiSha256: data.spki_sha256,
        status: data.status,
        revokedAt: data.revoked_at,
      } : null;
    },
    async getSale(businessId, saleId) {
      const { data, error } = await admin.from("fiskalo_basic_sales")
        .select("id,business_id,pos_id,coupon_id,status,daily_number,created_at,checkout_idempotency_key,operator_name,payment_method,payment_allocations,subtotal,vat_total,total")
        .eq("id", saleId).eq("business_id", businessId).maybeSingle();
      if (error) throw error;
      return data ? {
        id: data.id,
        businessId: data.business_id,
        posId: data.pos_id,
        couponId: data.coupon_id,
        status: data.status,
        dailyNumber: data.daily_number,
        createdAt: data.created_at,
        checkoutIdempotencyKey: data.checkout_idempotency_key,
        operatorName: data.operator_name,
        paymentMethod: data.payment_method,
        paymentAllocations: data.payment_allocations,
        subtotal: data.subtotal,
        vatTotal: data.vat_total,
        total: data.total,
      } : null;
    },
    async getSaleItems(saleId) {
      const { data, error } = await admin.from("fiskalo_basic_sale_items")
        .select("description,unit_price,quantity,line_total,line_net,line_vat,atk_unit_code,atk_item_category_code,atk_vat_code")
        .eq("sale_id", saleId);
      if (error) throw error;
      return (data ?? []).map(item => ({
        description: item.description,
        unitPrice: item.unit_price,
        quantity: item.quantity,
        lineTotal: item.line_total,
        lineNet: item.line_net,
        lineVat: item.line_vat,
        unitCode: item.atk_unit_code,
        categoryCode: item.atk_item_category_code,
        vatCode: item.atk_vat_code,
      }));
    },
    async queueReceipt(args) {
      const { data, error } = await admin.rpc("fiskalo_basic_store_offline_receipt_v2", args);
      if (error) throw error;
      if (typeof data !== "string" || !data) throw new Error("Offline fiscal document RPC returned no document ID.");
      return data;
    },
    async recordReceipt(args) {
      const { data, error } = await admin.rpc("fiskalo_basic_server_record_atk_receipt_v2", args);
      if (error) throw error;
      if (typeof data !== "string" || !data) throw new Error("ATK acceptance RPC returned no document ID.");
      return data;
    },
  };

  Deno.serve(createAtkReceiptHandler(dependencies));
}
