import { createClient } from "https://esm.sh/@supabase/supabase-js@2.114.0";
import {
  createWorkerHandler,
  WorkerRequestError,
  type WorkerMemberRow,
} from "./handler.ts";

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

  async function findUserByEmail(email: string) {
    for (let page = 1; page <= 100; page += 1) {
      const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
      if (error) throw error;
      const users = data.users ?? [];
      const existing = users.find((candidate) => candidate.email?.toLowerCase() === email);
      if (existing) return existing;
      if (users.length < 1000) return null;
    }
    throw new WorkerRequestError(503, "Kërkimi i llogarisë tejkalon kufirin e sigurt. Kontakto administratorin.");
  }

  const handler = createWorkerHandler({
    async authenticate(token) {
      const { data, error } = await admin.auth.getUser(token);
      if (error || !data.user) return null;
      return { id: data.user.id };
    },
    async isOwner(businessId, userId) {
      const { data, error } = await admin.from("fiskalo_basic_members")
        .select("role").eq("business_id", businessId).eq("user_id", userId).maybeSingle();
      if (error) throw error;
      return data?.role === "owner";
    },
    async listMembers(businessId) {
      const { data, error } = await admin.from("fiskalo_basic_members")
        .select("user_id,role,operator_name,created_at")
        .eq("business_id", businessId).order("created_at", { ascending: true }).limit(200);
      if (error) throw error;
      type MemberRecord = {
        user_id: string;
        role: "owner" | "cashier";
        operator_name: string | null;
        created_at: string;
      };
      return ((data ?? []) as MemberRecord[]).map((row): WorkerMemberRow => ({
        userId: row.user_id,
        role: row.role,
        operatorName: row.operator_name,
        createdAt: row.created_at,
      }));
    },
    async getUserEmail(userId) {
      const { data, error } = await admin.auth.admin.getUserById(userId);
      if (error) return null;
      return data.user.email ?? null;
    },
    async resolveUser(email) {
      const { data, error } = await admin.auth.admin.inviteUserByEmail(email);
      if (!error && data.user) return { id: data.user.id, invited: true, delivery: "sent" as const };

      const existing = await findUserByEmail(email);
      if (existing) {
        return {
          id: existing.id,
          invited: false,
          delivery: error ? "not_confirmed" as const : "existing" as const,
        };
      }
      if (error) {
        throw new WorkerRequestError(502, "Supabase Auth nuk arriti të dërgojë ftesën. Kontrollo konfigurimin e email-it dhe provo përsëri.");
      }
      throw new WorkerRequestError(502, "Supabase Auth nuk ktheu një llogari për këtë ftesë.");
    },
    async attachCashier(businessId, userId) {
      const { data: existing, error: lookupError } = await admin.from("fiskalo_basic_members")
        .select("role").eq("business_id", businessId).eq("user_id", userId).maybeSingle();
      if (lookupError) throw lookupError;
      if (existing?.role === "owner") {
        throw new WorkerRequestError(409, "Kjo llogari është pronare dhe nuk mund të kthehet në arkëtare.");
      }
      if (existing?.role === "cashier") return "already_member";

      const { error: insertError } = await admin.from("fiskalo_basic_members")
        .insert({ business_id: businessId, user_id: userId, role: "cashier" });
      if (!insertError) return "added";

      if (insertError.code === "23505") {
        const { data: racedMember, error: racedError } = await admin.from("fiskalo_basic_members")
          .select("role").eq("business_id", businessId).eq("user_id", userId).maybeSingle();
        if (racedError) throw racedError;
        if (racedMember?.role === "cashier") return "already_member";
        if (racedMember?.role === "owner") {
          throw new WorkerRequestError(409, "Kjo llogari është pronare dhe nuk mund të kthehet në arkëtare.");
        }
      }
      throw insertError;
    },
  });
  Deno.serve(handler);
}
