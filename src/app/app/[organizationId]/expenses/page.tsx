import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import ExpensesWorkspace from "./expenses-workspace";
type Props = { params: Promise<{ organizationId: string }> };
export default async function ExpensesPage({ params }: Props) {
 const { organizationId }=await params; const supabase=await createClient(); const {data:auth}=await supabase.auth.getUser(); if(!auth.user)redirect("/login");
 const {data:membership}=await supabase.from("fiskalo_organization_users").select("role").eq("organization_id",organizationId).eq("user_id",auth.user.id).maybeSingle(); if(!membership)redirect("/app");
 if(!["owner","administrator","manager","accountant"].includes(membership.role))redirect(`/app/${organizationId}`);
 return <ExpensesWorkspace organizationId={organizationId}/>;
}
