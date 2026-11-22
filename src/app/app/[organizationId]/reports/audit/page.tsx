import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import PrintReportButton from "../daily/print-button";

type Props = { params: Promise<{ organizationId: string }> };
type AuditRow = {
  id: number;
  actor_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  details: Record<string, unknown>;
  created_at: string;
};

function csvCell(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return '"' + text.replace(/"/g, '""') + '"';
}

export default async function AuditLogExportPage({ params }: Props) {
  const { organizationId } = await params;
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) redirect("/login");

  const { data: membership } = await supabase.from("fiskalo_organization_users")
    .select("role").eq("organization_id", organizationId).eq("user_id", auth.user.id).maybeSingle();
  if (!membership || !["owner", "administrator"].includes(membership.role)) redirect("/app/" + organizationId + "/reports");

  const rows: AuditRow[] = [];
  const pageSize = 1000;
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await supabase.from("fiskalo_audit_logs")
      .select("id,actor_id,action,entity_type,entity_id,details,created_at")
      .eq("organization_id", organizationId)
      .order("id", { ascending: true })
      .range(offset, offset + pageSize - 1);
    if (error) throw new Error("Audit logs could not be loaded for export: " + error.message);
    rows.push(...((data ?? []) as AuditRow[]));
    if (!data || data.length < pageSize) break;
  }

  const csvRows = [
    ["ID", "Koha UTC", "ID i përdoruesit", "Veprimi", "Lloji i objektit", "ID e objektit", "Detajet"],
    ...rows.map((row) => [
      String(row.id), row.created_at, row.actor_id ?? "", row.action,
      row.entity_type, row.entity_id ?? "", JSON.stringify(row.details ?? {}),
    ]),
  ];
  const csv = csvRows.map((row) => row.map(csvCell).join(";")).join("\r\n");
  const csvHref = "data:text/csv;charset=utf-8," + encodeURIComponent("\uFEFF" + csv);

  return <main style={{ maxWidth: 1180, margin: "0 auto", padding: "26px clamp(15px,3vw,30px) 56px" }}>
    <style>{`@media print {.no-print{display:none!important} body{background:#fff!important} main{max-width:none!important;padding:0!important} table{font-size:9px!important} tr{break-inside:avoid}} `}</style>
    <div className="no-print" style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", marginBottom: 18 }}>
      <Link href={"/app/" + organizationId + "/reports"} style={{ color: "var(--brand)", fontWeight: 750, textDecoration: "none" }}>← Raportet</Link>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <a href={csvHref} download="fiskalo-audit-logs.csv" style={{ border: "1px solid var(--line)", borderRadius: 9, padding: "9px 12px", color: "var(--ink)", textDecoration: "none", fontWeight: 700 }}>Shkarko CSV</a>
        <PrintReportButton />
      </div>
    </div>
    <header style={{ borderBottom: "2px solid #111", paddingBottom: 14, marginBottom: 18 }}>
      <p style={{ fontSize: 11, fontWeight: 900, letterSpacing: ".12em", margin: "0 0 8px" }}>FISKALO · AUDITIM</p>
      <h1 style={{ fontSize: 26, margin: "0 0 5px" }}>Regjistri i auditimit</h1>
      <p style={{ color: "var(--muted)", fontSize: 12, margin: 0 }}>Regjistrat ruhen në rend kronologjik. Për PDF përdor Printo dhe zgjidh Save as PDF.</p>
      <p style={{ fontSize: 12, margin: "8px 0 0" }}>Gjithsej: <strong>{rows.length}</strong> ngjarje · Eksportuar: {new Date().toISOString()}</p>
    </header>
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
        <thead><tr>{["ID", "Koha (UTC)", "Përdoruesi", "Veprimi", "Objekti", "ID e objektit", "Detajet"].map(label =>
          <th key={label} style={{ textAlign: "left", borderBottom: "2px solid #111", padding: "8px 6px", whiteSpace: "nowrap" }}>{label}</th>)}</tr></thead>
        <tbody>{rows.map((row) => <tr key={row.id}>
          <td style={{ borderBottom: "1px solid #ddd", padding: "7px 6px" }}>{row.id}</td>
          <td style={{ borderBottom: "1px solid #ddd", padding: "7px 6px", whiteSpace: "nowrap" }}>{row.created_at}</td>
          <td style={{ borderBottom: "1px solid #ddd", padding: "7px 6px" }}>{row.actor_id ?? "Sistem"}</td>
          <td style={{ borderBottom: "1px solid #ddd", padding: "7px 6px" }}>{row.action}</td>
          <td style={{ borderBottom: "1px solid #ddd", padding: "7px 6px" }}>{row.entity_type}</td>
          <td style={{ borderBottom: "1px solid #ddd", padding: "7px 6px" }}>{row.entity_id ?? "—"}</td>
          <td style={{ borderBottom: "1px solid #ddd", padding: "7px 6px", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{JSON.stringify(row.details ?? {})}</td>
        </tr>)}</tbody>
      </table>
      {!rows.length && <p style={{ color: "var(--muted)" }}>Nuk ka ende ngjarje auditimi.</p>}
    </div>
  </main>;
}
