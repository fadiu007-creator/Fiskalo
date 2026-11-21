import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import ProviderDashboard, { type ProviderBusiness, type ProviderPos, type ProviderSettings, type ProviderAtkLookup } from "./provider-dashboard";

export const dynamic = "force-dynamic";

export default async function ProviderPage() {
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) redirect("/login");

  const { data: providerAccess } = await supabase
    .from("fiskalo_provider_users")
    .select("role")
    .eq("user_id", auth.user.id)
    .maybeSingle();

  if (!providerAccess) redirect("/app");

  const [{ data: businesses, error: businessesError }, { data: posDevices, error: posError }, { data: settings }, { data: atkLookups, error: atkLookupError }] = await Promise.all([
    supabase.from("fiskalo_organizations")
      .select("id,trade_name,legal_name,municipality,fiscalization_status,plan_package,product_limit,created_at")
      .order("created_at", { ascending: false }),
    supabase.from("fiskalo_atk_pos_installations")
      .select("id,organization_id,label,status,environment,last_seen_at")
      .order("created_at", { ascending: false }),
    supabase.from("fiskalo_atk_provider_settings")
      .select("provider_nui,sef_code,application_id,solution_name,solution_version,certification_status,production_enabled")
      .eq("singleton", true)
      .maybeSingle(),
    supabase.from("fiskalo_provider_atk_lookups")
      .select("id,organization_id,lookup_type,lookup_value,taxpayer_name,registration_status,municipality,vat_status,checked_at")
      .order("checked_at", { ascending: false }).limit(30),
  ]);

  return (
    <ProviderDashboard
      role={providerAccess.role}
      userEmail={auth.user.email ?? ""}
      businesses={(businesses ?? []) as ProviderBusiness[]}
      posDevices={(posDevices ?? []) as ProviderPos[]}
      settings={(settings ?? null) as ProviderSettings | null}
      atkLookups={(atkLookups ?? []) as ProviderAtkLookup[]}
      loadError={businessesError?.message ?? posError?.message ?? atkLookupError?.message ?? ""}
    />
  );
}
