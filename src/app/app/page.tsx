import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ArrowUpRight, Building2, Store } from "lucide-react";

export default async function BusinessHome() {
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) redirect("/login");
  await supabase.rpc("fiskalo_accept_pending_team_invitations");

  const [{ data: memberships, error }, { data: providerAccess }] = await Promise.all([
    supabase.from("fiskalo_organization_users")
      .select("organization_id,role,fiskalo_organizations(legal_name,trade_name,municipality)")
      .eq("user_id", auth.user.id),
    supabase.from("fiskalo_provider_users").select("role").eq("user_id", auth.user.id).maybeSingle(),
  ]);
  if (error) throw new Error("Nuk u ngarkuan bizneset. Provo përsëri.");
  const isProvider = Boolean(providerAccess);
  if (!memberships?.length && !isProvider) redirect("/onboarding");

  return <main className="workspace-picker">
    <header><Link href="/" className="workspace-picker-brand"><span>F</span><strong>fiskalo</strong></Link><span>{auth.user.email}</span></header>
    <section className="workspace-picker-intro"><span>HAPËSIRAT E PUNËS</span><h1>Ku dëshiron të vazhdosh?</h1><p>Hap panelin e ofruesit ose zgjidh një biznes për të menaxhuar shitjet dhe faturat.</p></section>
    <section className="workspace-picker-grid">
      {isProvider && <Link href="/provider" className="workspace-picker-card provider"><span className="workspace-picker-icon"><Building2 size={23}/></span><strong>Paneli i ofruesit</strong><p>Menaxho softuerin Fiskalo, konfigurimin ATK dhe bizneset kliente.</p><span>Hap hapësirën <ArrowUpRight size={16}/></span></Link>}
      {(memberships ?? []).map((membership) => {
        const org = membership.fiskalo_organizations as {legal_name?:string;trade_name?:string;municipality?:string}|null;
        return <article key={membership.organization_id} className="workspace-picker-card"><span className="workspace-picker-icon"><Store size={23}/></span><strong>{org?.trade_name || org?.legal_name || "Biznes"}</strong><p>{org?.municipality ?? ""} · Roli: {membership.role}</p><div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 12 }}><Link href={`/app/${membership.organization_id}`} style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "9px 11px", borderRadius: 8, background: "var(--brand)", color: "white", fontWeight: 700, fontSize: 12, textDecoration: "none" }}>Hap Fiskalo Full <ArrowUpRight size={15}/></Link><Link href={`/basic`} style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "9px 11px", borderRadius: 8, border: "1px solid var(--line)", color: "var(--ink)", fontWeight: 700, fontSize: 12, textDecoration: "none" }}>Hap Fiskalo Basic <ArrowUpRight size={15}/></Link></div></article>;
      })}
    </section>
    <Link href="/onboarding" className="workspace-picker-add">+ Shto biznes tjetër</Link>
  </main>;
}
