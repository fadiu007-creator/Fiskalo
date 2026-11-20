import { NextResponse } from "next/server";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { createClient as createCookieClient } from "@/lib/supabase/server";

function isSameOriginRequest(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try { return new URL(origin).origin === new URL(request.url).origin; } catch { return false; }
}

export const runtime = "nodejs";

export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "invalid_origin" }, { status: 403 });
  const authClient = await createCookieClient();
  const { data: { user }, error: authError } = await authClient.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: Record<string, unknown>;
  try { body = await request.json() as Record<string, unknown>; }
  catch { return NextResponse.json({ error: "invalid_json" }, { status: 400 }); }

  const organizationId = typeof body.organizationId === "string" ? body.organizationId : "";
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const displayName = typeof body.displayName === "string" ? body.displayName.trim() : "";
  const phone = typeof body.phone === "string" ? body.phone.trim() : "";
  const role = typeof body.role === "string" ? body.role : "cashier";
  if (!organizationId || !email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !displayName || displayName.length > 100 || phone.length > 32) {
    return NextResponse.json({ error: "invalid_input", detail: "Plotëso biznesin, emrin dhe email-in valid." }, { status: 400 });
  }
  if (!["cashier", "manager", "accountant", "administrator"].includes(role)) {
    return NextResponse.json({ error: "invalid_role", detail: "Zgjidh një rol të lejuar për punëtorin." }, { status: 400 });
  }

  const { data: membership } = await authClient.from("fiskalo_organization_users")
    .select("role").eq("organization_id", organizationId).eq("user_id", user.id).maybeSingle();
  if (!membership || !["owner", "administrator"].includes(membership.role)) {
    return NextResponse.json({ error: "forbidden", detail: "Vetëm pronari ose administratori mund të shtojë punëtorë." }, { status: 403 });
  }

  if (role === "administrator" && membership.role !== "owner") {
    return NextResponse.json({ error: "role_forbidden", detail: "Vetëm pronari mund të caktojë administratorë." }, { status: 403 });
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    return NextResponse.json({ error: "admin_backend_not_configured", detail: "Mungon konfigurimi server-side i Supabase për krijimin e llogarive të punëtorëve." }, { status: 503 });
  }
  const admin = createSupabaseClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: listed, error: listError } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (listError) return NextResponse.json({ error: "user_lookup_failed", detail: listError.message }, { status: 500 });
  let worker = listed.users.find(candidate => candidate.email?.toLowerCase() === email);
  let created = false;

  if (!worker) {
    const redirectTo = new URL("/auth/callback?next=" + encodeURIComponent("/app/" + organizationId), request.url).toString();
    const { data, error } = await admin.auth.admin.inviteUserByEmail(email, { data: { display_name: displayName, phone }, redirectTo });
    if (error || !data.user) return NextResponse.json({ error: "worker_invitation_failed", detail: error?.message || "Ftesa nuk u dërgua." }, { status: 400 });
    worker = data.user;
    created = true;
  } else {
    if (!worker.email_confirmed_at && !worker.confirmed_at) return NextResponse.json({ error: "worker_email_unverified", detail: "Punëtori duhet ta konfirmojë email-in ose ta përfundojë ftesën ekzistuese para se t’i jepet qasje." }, { status: 409 });
    const { error } = await admin.auth.admin.updateUserById(worker.id, { user_metadata: { ...(worker.user_metadata || {}), display_name: displayName, phone } });
    if (error) return NextResponse.json({ error: "worker_profile_update_failed", detail: error.message }, { status: 500 });
  }

  const { error: memberError } = await admin.from("fiskalo_organization_users").upsert(
    { organization_id: organizationId, user_id: worker.id, role },
    { onConflict: "organization_id,user_id" }
  );
  if (memberError) return NextResponse.json({ error: "worker_membership_failed", detail: memberError.message }, { status: 500 });

  await admin.from("fiskalo_team_invitations").delete().eq("organization_id", organizationId).eq("email", email);
  await admin.from("fiskalo_audit_logs").insert({
    organization_id: organizationId, actor_id: user.id,
    action: created ? "member.account_created_and_added" : "member.added_or_updated",
    entity_type: "organization_user", entity_id: worker.id,
    details: { email, role, email_verification_skipped: created },
  });

  return NextResponse.json({ success: true, created, email, role, message: created
    ? "Ftesa u dërgua. Punëtori duhet të konfirmojë email-in dhe të vendosë fjalëkalimin para hyrjes."
    : "Llogaria ekzistuese e verifikuar u shtua në ekip." });
}
