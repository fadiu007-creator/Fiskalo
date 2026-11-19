import { NextResponse } from "next/server";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { createClient as createCookieClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

async function getAdminContext() {
  const authClient = await createCookieClient();
  const { data: { user }, error } = await authClient.auth.getUser();
  if (error || !user?.email) return { error: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  const allowed = (process.env.FISKALO_PLATFORM_ADMIN_EMAILS || "").split(",").map(v => v.trim().toLowerCase()).filter(Boolean);
  if (!allowed.includes(user.email.toLowerCase())) return { error: NextResponse.json({ error: "forbidden", detail: "Nuk ke autorizim për panelin e platformës." }, { status: 403 }) };
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) return { error: NextResponse.json({ error: "admin_backend_not_configured", detail: "Mungon SUPABASE_SERVICE_ROLE_KEY në konfigurimin server-side të Cloudflare." }, { status: 503 }) };
  const admin = createSupabaseClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
  return { user, admin };
}

export async function GET() {
  const context = await getAdminContext();
  if ("error" in context) return context.error;
  const { admin } = context;
  const [{ data: organizations, error: orgError }, { data: memberships, error: memberError }, { data: positions, error: posError }] = await Promise.all([
    admin.from("fiskalo_organizations").select("id,legal_name,trade_name,nui,municipality,email,phone,created_at").order("created_at", { ascending: false }).limit(500),
    admin.from("fiskalo_organization_users").select("organization_id,user_id,role"),
    admin.from("fiskalo_atk_pos_installations").select("id,organization_id,atk_branch_id,pos_id,label,location,environment,status,created_at").order("created_at", { ascending: false }),
  ]);
  if (orgError || memberError || posError) return NextResponse.json({ error: "admin_data_load_failed", detail: orgError?.message || memberError?.message || posError?.message }, { status: 500 });
  const { data: userData, error: usersError } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (usersError) return NextResponse.json({ error: "owner_lookup_failed", detail: usersError.message }, { status: 500 });
  const emailById = new Map((userData.users || []).map(u => [u.id, u.email || ""]));
  const rows = (organizations || []).map(org => ({
    ...org,
    owners: (memberships || []).filter(m => m.organization_id === org.id && m.role === "owner").map(m => ({ userId: m.user_id, email: emailById.get(m.user_id) || "" })),
    pos: (positions || []).filter(p => p.organization_id === org.id),
  }));
  return NextResponse.json({ organizations: rows }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  const context = await getAdminContext();
  if ("error" in context) return context.error;
  const { admin, user } = context;
  let body: Record<string, unknown>;
  try { body = await request.json() as Record<string, unknown>; }
  catch { return NextResponse.json({ error: "invalid_json" }, { status: 400 }); }

  const organizationId = typeof body.organizationId === "string" ? body.organizationId : "";
  if (!organizationId) return NextResponse.json({ error: "organization_required" }, { status: 400 });

  if (body.action === "assign_owner") {
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return NextResponse.json({ error: "invalid_email", detail: "Shëno email valid të pronarit." }, { status: 400 });
    const { data: users, error: userError } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
    if (userError) return NextResponse.json({ error: "owner_lookup_failed", detail: userError.message }, { status: 500 });
    const owner = users.users.find(u => u.email?.toLowerCase() === email);
    if (!owner) return NextResponse.json({ error: "owner_account_not_found", detail: "Ky email nuk ka llogari Fiskalo. Pronari duhet të regjistrohet së pari." }, { status: 404 });
    const { error: membershipError } = await admin.from("fiskalo_organization_users").upsert(
      { organization_id: organizationId, user_id: owner.id, role: "owner" },
      { onConflict: "organization_id,user_id" }
    );
    if (membershipError) return NextResponse.json({ error: "owner_assignment_failed", detail: membershipError.message }, { status: 500 });
    return NextResponse.json({ success: true, message: "Pronari u caktua.", ownerEmail: email });
  }

  if (body.action === "create_pos") {
    const branchId = Number(body.branchId), posId = Number(body.posId);
    const label = typeof body.label === "string" ? body.label.trim() : "";
    const location = typeof body.location === "string" ? body.location.trim() : "";
    if (!Number.isSafeInteger(branchId) || branchId <= 0 || !Number.isSafeInteger(posId) || posId <= 0 || !label) {
      return NextResponse.json({ error: "invalid_pos", detail: "Dega ATK, POS ID dhe emri i pajisjes janë të detyrueshme." }, { status: 400 });
    }
    const { data: pos, error: insertError } = await admin.from("fiskalo_atk_pos_installations").insert({
      organization_id: organizationId, atk_branch_id: branchId, pos_id: posId, label, location: location || null,
      environment: "test", status: "unregistered", created_by: user.id,
    }).select("id,organization_id,atk_branch_id,pos_id,label,location,environment,status").single();
    if (insertError) return NextResponse.json({ error: "pos_create_failed", detail: insertError.message }, { status: 409 });
    return NextResponse.json({ success: true, pos });
  }

  if (body.action === "update_pos") {
    const posId = typeof body.posInstallationId === "string" ? body.posInstallationId : "";
    const branchId = Number(body.branchId), terminalId = Number(body.posId);
    const label = typeof body.label === "string" ? body.label.trim() : "";
    const location = typeof body.location === "string" ? body.location.trim() : "";
    if (!posId || !Number.isSafeInteger(branchId) || branchId <= 0 || !Number.isSafeInteger(terminalId) || terminalId <= 0 || !label) {
      return NextResponse.json({ error: "invalid_pos", detail: "POS, dega ATK, POS ID dhe emri janë të detyrueshme." }, { status: 400 });
    }
    const { data: existing, error: lookupError } = await admin.from("fiskalo_atk_pos_installations")
      .select("id,organization_id,atk_branch_id,pos_id,status").eq("id", posId).eq("organization_id", organizationId).maybeSingle();
    if (lookupError || !existing) return NextResponse.json({ error: "pos_not_found", detail: lookupError?.message || "POS nuk u gjet." }, { status: 404 });
    const identityChanged = Number(existing.atk_branch_id) !== branchId || Number(existing.pos_id) !== terminalId;
    const update: Record<string, unknown> = { atk_branch_id: branchId, pos_id: terminalId, label, location: location || null };
    // A changed ATK identity invalidates the previous verification. Require a fresh provider registration.
    if (identityChanged) update.status = "unregistered";
    const { data: pos, error: updateError } = await admin.from("fiskalo_atk_pos_installations")
      .update(update).eq("id", posId).eq("organization_id", organizationId)
      .select("id,organization_id,atk_branch_id,pos_id,label,location,environment,status").single();
    if (updateError) return NextResponse.json({ error: "pos_update_failed", detail: updateError.message }, { status: 409 });
    if (identityChanged) {
      await admin.from("fiskalo_atk_pos_verifications").delete().eq("organization_id", organizationId).eq("pos_installation_id", posId);
    }
    return NextResponse.json({ success: true, pos, requires_reregistration: identityChanged });
  }

  if (body.action === "delete_pos") {
    const posId = typeof body.posInstallationId === "string" ? body.posInstallationId : "";
    if (!posId) return NextResponse.json({ error: "pos_required" }, { status: 400 });
    const { data: existing, error: lookupError } = await admin.from("fiskalo_atk_pos_installations")
      .select("id,organization_id,status").eq("id", posId).eq("organization_id", organizationId).maybeSingle();
    if (lookupError || !existing) return NextResponse.json({ error: "pos_not_found", detail: lookupError?.message || "POS nuk u gjet." }, { status: 404 });
    if (existing.status === "active") {
      return NextResponse.json({ error: "active_pos_protected", detail: "POS aktiv nuk mund të fshihet drejtpërdrejt. Çaktivizoje/revokoje fillimisht në ATK dhe pastaj provo përsëri." }, { status: 409 });
    }
    const { error: deleteError } = await admin.from("fiskalo_atk_pos_installations")
      .delete().eq("id", posId).eq("organization_id", organizationId);
    if (deleteError) return NextResponse.json({ error: "pos_delete_failed", detail: "POS nuk u fshi. Mund të ketë kuponë ose regjistrime të lidhura; ruaje historikun dhe çaktivizoje në vend të fshirjes. " + deleteError.message }, { status: 409 });
    return NextResponse.json({ success: true, deleted: true });
  }

  return NextResponse.json({ error: "unsupported_action" }, { status: 400 });
}
