import { redirect } from "next/navigation";
type Props = { params: Promise<{ organizationId: string }> };
export default async function LegacyBasicRoute({ params }: Props) { await params; redirect("/basic"); }
