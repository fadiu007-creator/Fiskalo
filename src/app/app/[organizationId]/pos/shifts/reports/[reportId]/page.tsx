import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import PrintReportButton from "../../../../reports/daily/print-button";

type Props = { params: Promise<{ organizationId: string; reportId: string }> };
type Movement = { id: string; type: string; amount: number | string; note: string; created_at: string };
type PaidInvoice = { invoice_id: string; invoice_number: string | null; total: number | string; payment_status: string };

const money = (value: unknown) => new Intl.NumberFormat("sq-XK", { style: "currency", currency: "EUR" }).format(Number(value ?? 0));
const label = (value: string) => value === "cash" ? "Para në dorë" : value === "card" ? "Kartelë" : value === "bank_transfer" ? "Transfer bankar" : value;

export default async function InternalZReportPage({ params }: Props) {
  const { organizationId, reportId } = await params;
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) redirect("/login");
  const { data: membership } = await supabase.from("fiskalo_organization_users")
    .select("role").eq("organization_id", organizationId).eq("user_id", auth.user.id).maybeSingle();
  if (!membership) redirect("/app");
  const { data: report, error } = await supabase.from("fiskalo_cashier_shift_reports")
    .select("id,organization_id,cashier_shift_id,report_type,report_number,snapshot,generated_by,generated_at")
    .eq("id", reportId).eq("organization_id", organizationId).maybeSingle();
  if (error || !report) notFound();
  const snapshot = report.snapshot as Record<string, unknown>;
  if (membership.role === "cashier" && snapshot.cashier_user_id !== auth.user.id) redirect("/app/" + organizationId);
  const payments = (snapshot.payments_by_method && typeof snapshot.payments_by_method === "object"
    ? Object.entries(snapshot.payments_by_method as Record<string, unknown>) : []);
  const movements = (Array.isArray(snapshot.cash_movements) ? snapshot.cash_movements : []) as Movement[];
  const invoices = (Array.isArray(snapshot.paid_invoices) ? snapshot.paid_invoices : []) as PaidInvoice[];

  return <main style={{maxWidth:900,margin:"0 auto",padding:"28px 18px 56px"}}>
    <style>{`@media print {.no-print{display:none!important} body{background:#fff!important} main{max-width:none!important;padding:0!important} article{break-inside:avoid;box-shadow:none!important}}`}</style>
    <div className="no-print" style={{display:"flex",justifyContent:"space-between",gap:12,flexWrap:"wrap",marginBottom:18}}>
      <Link href={"/app/"+organizationId+"/pos/shifts"} style={{color:"var(--brand)",fontWeight:800}}>← Ndërrimet e arkës</Link>
      <PrintReportButton />
    </div>
    <header style={{borderBottom:"2px solid #111",paddingBottom:16,marginBottom:18}}>
      <p style={{fontSize:11,fontWeight:900,letterSpacing:".12em",margin:"0 0 8px"}}>FISKALO · RAPORT I BRENDSHËM</p>
      <h1 style={{fontSize:28,margin:"0 0 5px"}}>Raporti Z i arkës</h1>
      <strong style={{fontSize:17}}>{report.report_number}</strong>
      <p style={{fontSize:12,color:"var(--muted)",margin:"8px 0 0"}}>Gjeneruar: {new Date(report.generated_at).toLocaleString("sq-XK")} · Mbyllur: {new Date(String(snapshot.closed_at)).toLocaleString("sq-XK")}</p>
    </header>
    <section style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(165px,1fr))",gap:10,marginBottom:16}}>
      {[
        ["Gjendja fillestare",snapshot.opening_cash],
        ["Shitje cash",snapshot.cash_sales],
        ["Hyrje në arkë",snapshot.cash_in],
        ["Dalje nga arka",snapshot.cash_out],
        ["Arka e pritur",snapshot.expected_cash],
        ["Arka e numëruar",snapshot.counted_cash],
        ["Diferenca",snapshot.cash_difference],
      ].map(([name,value])=><article key={String(name)} style={{border:"1px solid var(--line)",borderRadius:10,padding:13}}><span style={{fontSize:11,color:"var(--muted)"}}>{String(name)}</span><strong style={{display:"block",fontSize:20,marginTop:6}}>{money(value)}</strong></article>)}
    </section>
    <article style={{border:"1px solid var(--line)",borderRadius:10,padding:16,marginBottom:14}}>
      <h2 style={{fontSize:16,margin:"0 0 10px"}}>Pagesat sipas mënyrës</h2>
      {payments.map(([method,amount])=><div key={method} style={{display:"flex",justifyContent:"space-between",padding:"8px 0",borderBottom:"1px solid var(--line)"}}><span>{label(method)}</span><strong>{money(amount)}</strong></div>)}
    </article>
    <article style={{border:"1px solid var(--line)",borderRadius:10,padding:16,marginBottom:14}}>
      <h2 style={{fontSize:16,margin:"0 0 10px"}}>Lëvizjet e parasë</h2>
      {movements.length ? <div style={{overflowX:"auto"}}><table className="data-table"><thead><tr><th>Koha</th><th>Lloji</th><th>Arsyeja</th><th>Shuma</th></tr></thead><tbody>{movements.map(row=><tr key={row.id}><td>{new Date(row.created_at).toLocaleString("sq-XK")}</td><td>{row.type==="cash_in"?"Hyrje":"Dalje"}</td><td>{row.note}</td><td>{money(row.amount)}</td></tr>)}</tbody></table></div> : <p style={{fontSize:13,color:"var(--muted)"}}>Nuk ka lëvizje shtesë të parasë.</p>}
    </article>
    <article style={{border:"1px solid var(--line)",borderRadius:10,padding:16,marginBottom:14}}>
      <h2 style={{fontSize:16,margin:"0 0 10px"}}>Faturat e paguara gjatë ndërrimit</h2>
      {invoices.length ? <div style={{overflowX:"auto"}}><table className="data-table"><thead><tr><th>Fatura</th><th>Statusi</th><th>Totali</th></tr></thead><tbody>{invoices.map(row=><tr key={row.invoice_id}><td>{row.invoice_number || row.invoice_id}</td><td>{row.payment_status}</td><td>{money(row.total)}</td></tr>)}</tbody></table></div> : <p style={{fontSize:13,color:"var(--muted)"}}>Nuk ka pagesa të lidhura me këtë ndërrim.</p>}
    </article>
    {snapshot.closing_note ? <p><strong>Shënim në mbyllje:</strong> {String(snapshot.closing_note)}</p> : null}
    <footer style={{borderTop:"1px solid #777",paddingTop:12,marginTop:22,fontSize:11,lineHeight:1.6}}>
      <strong>RAPORT I BRENDSHËM I ARKËS — NUK ËSHTË RAPORT TATIMOR I ATK-së.</strong><br/>
      Ky dokument është fotografi e pandryshueshme e gjendjes së ndërrimit në momentin e mbylljes. Nuk dërgohet në ATK dhe nuk zëvendëson raportin zyrtar tatimor Z.
    </footer>
  </main>;
}
