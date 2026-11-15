import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { createClient as createCookieClient } from "@/lib/supabase/server";

export async function getAtkRequestContext(request: Request) {
  const authorization = request.headers.get("authorization") ?? "";
  const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
  let supabase;
  if (bearer) {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !key) throw new Error("Supabase public configuration is missing.");
    supabase = createSupabaseClient(url, key, {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
      global: { headers: { Authorization: "Bearer " + bearer } },
    });
  } else {
    supabase = await createCookieClient();
  }
  const { data, error } = await supabase.auth.getUser(bearer);
  return { supabase, user: data.user, authError: error };
}

export async function authorizeAtkOrganization(
  supabase: Awaited<ReturnType<typeof createCookieClient>>,
  userId: string,
  organizationId: string,
  taxpayerNui: string,
  allowedRoles: string[] = ["owner", "administrator"],
) {
  const { data: membership, error: membershipError } = await supabase
    .from("fiskalo_organization_users")
    .select("role")
    .eq("organization_id", organizationId)
    .eq("user_id", userId)
    .maybeSingle();
  if (membershipError || !membership || !allowedRoles.includes(membership.role)) {
    return { ok: false as const, status: 403, detail: "This account does not have permission for this ATK operation." };
  }

  const { data: organization, error: organizationError } = await supabase
    .from("fiskalo_organizations")
    .select("nui,legal_name,municipality")
    .eq("id", organizationId)
    .single();
  if (organizationError || !organization || String(organization.nui) !== taxpayerNui) {
    return { ok: false as const, status: 400, detail: "The supplied taxpayer NUI does not match this Fiskalo business." };
  }
  return { ok: true as const, organization };
}

export function positiveInteger(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}
