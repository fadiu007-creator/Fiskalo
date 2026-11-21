import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import BusinessWorkspaceNav from "@/components/business-workspace-nav";

type Props = { children: React.ReactNode; params: Promise<{ organizationId: string }> };

export default async function BusinessWorkspaceLayout({ children, params }: Props) {
  const { organizationId } = await params;
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) redirect("/login");
  const [{ data: membership }, { data: organization }, { data: providerAccess }] = await Promise.all([
    supabase.from("fiskalo_organization_users").select("role").eq("organization_id", organizationId).eq("user_id", auth.user.id).maybeSingle(),
    supabase.from("fiskalo_organizations").select("legal_name,trade_name").eq("id", organizationId).maybeSingle(),
    supabase.from("fiskalo_provider_users").select("role").eq("user_id", auth.user.id).maybeSingle(),
  ]);
  if (!membership || !organization) redirect("/app");
  return <BusinessWorkspaceNav organizationId={organizationId} businessName={organization.trade_name || organization.legal_name} role={membership.role} isProvider={Boolean(providerAccess)}>{children}</BusinessWorkspaceNav>;
}
