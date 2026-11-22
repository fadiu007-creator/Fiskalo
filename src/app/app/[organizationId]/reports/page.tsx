import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ArrowLeft, Download, FileBarChart2 } from "lucide-react";

type Props = { params: Promise<{ organizationId: string }> };
const money = (value: number | string | null | undefined) => new Intl.NumberFormat("sq-XK", { style: "currency", currency: "EUR" }).format(Number(value ?? 0));
const day = (value: string) => new Date(value + "T12:00:00").toLocaleDateString("sq-XK");

export default async function ReportsPage({ params }: Props) {
  const { organizationId } = await params;
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) redirect("/login");

  const { data: membership } = await supabase.from("fiskalo_organization_users")
    .select("role").eq("organization_id", organizationId).eq("user_id", auth.user.id).maybeSingle();
  if (!membership) redirect("/app");

  const from = new Date();
  from.setDate(from.getDate() - 29);
  const fromDate = from.toISOString().slice(0, 10);
  const toDate = new Date().toISOString().slice(0, 10);

  const [invoiceResult, expenseResult, shiftResult, fiscalResult] = await Promise.all([
    supabase.from("fiskalo_invoices")
      .select("id,invoice_number,issue_date,status,payment_status,subtotal,vat_total,total,fiscalization_status")
      .eq("organization_id", organizationId).eq("status", "issued")
      .gte("issue_date", fromDate).lte("issue_date", toDate)
      .order("issue_date", { ascending: false }).limit(1000),
    supabase.from("fiskalo_expenses").select("amount,vat_rate,expense_date,category")
      .eq("organization_id", organizationId).gte("expense_date", fromDate).lte("expense_date", toDate),
    supabase.from("fiskalo_cashier_shifts")
      .select("id,status,opening_cash,expected_cash,counted_cash,cash_difference,opened_at,closed_at")
      .eq("organization_id", organizationId).gte("opened_at", from.toISOString())
      .order("opened_at", { ascending: false }).limit(300),
    supabase.from("fiskalo_atk_fiscal_documents")
      .select("id,status,document_type,total,coupon_id,atk_transaction_id,occurred_at,last_error")
      .eq("organization_id", organizationId).gte("occurred_at", from.toISOString())
      .order("occurred_at", { ascending: false }).limit(500),
  ]);

  const invoices = invoiceResult.data ?? [];
  const expenses = expenseResult.data ?? [];
  const shifts = shiftResult.data ?? [];
  const fiscalDocs = fiscalResult.data ?? [];
  const invoiceIds = invoices.map((invoice) => invoice.id);
  const { data: items } = invoiceIds.length
    ? await supabase.from("fiskalo_invoice_items").select("invoice_id,vat_rate,line_subtotal,line_vat")
        .in("invoice_id", invoiceIds)
    : { data: [] as { invoice_id: string; vat_rate: number; line_subtotal: number; line_vat: number }[] };
  const { data: payments } = invoiceIds.length
    ? await supabase.from("fiskalo_invoice_payments").select("invoice_id,amount,payment_method,created_at")
        .in("invoice_id", invoiceIds)
    : { data: [] as { invoice_id: string; amount: number; payment_method: string; created_at: string }[] };

  const sum = (values: Array<number | string | null | undefined>) => values.reduce<number>((total, value) => total + Number(value ?? 0), 0);
  const turnover = sum(invoices.map((invoice) => invoice.total));
  const netSales = sum(invoices.map((invoice) => invoice.subtotal));
  const vatTotal = sum(invoices.map((invoice) => invoice.vat_total));
  const expenseTotal = sum(expenses.map((expense) => expense.amount));
  const paid = invoices.filter((invoice) => invoice.payment_status === "paid").length;
  const unpaid = invoices.filter((invoice) => invoice.payment_status !== "paid").length;
  const paymentTotals = ["cash", "card", "bank_transfer"].map((method) => ({
    method,
    amount: sum((payments ?? []).filter((payment) => payment.payment_method === method).map((payment) => payment.amount)),
  }));
  const vatTotals = [0, 8, 18].map((rate) => {
    const lines = (items ?? []).filter((item) => Number(item.vat_rate) === rate);
    return { rate, net: sum(lines.map((line) => line.line_subtotal)), vat: sum(lines.map((line) => line.line_vat)) };
  });
  const fiscalCounts = ["accepted", "rejected", "queued", "submitted", "offline_pending"].map((status) => ({
    status, count: fiscalDocs.filter((doc) => doc.status === status).length,
    amount: sum(fiscalDocs.filter((doc) => doc.status === status).map((doc) => doc.total)),
  }));
  const closedShifts = shifts.filter((shift) => shift.status === "closed");
  const cashDifference = sum(closedShifts.map((shift) => shift.cash_difference));
  const exportRows = [
    ["Lloji", "Numri", "Data", "Neto", "TVSH", "Totali", "Statusi i pagesës", "Statusi fiskal"],
    ...invoices.map((invoice) => [ "Faturë", invoice.invoice_number ?? "", invoice.issue_date, String(invoice.subtotal), String(invoice.vat_total), String(invoice.total), invoice.payment_status, invoice.fiscalization_status ]),
  ];
  const csv = exportRows.map((row) => row.map((cell) => '"' + String(cell).replace(/"/g, '""') + '"').join(";")).join("\r\n");
  const csvHref = "data:text/csv;charset=utf-8," + encodeURIComponent("\uFEFF" + csv);

  return <main style={{maxWidth:1180,margin:"0 auto",padding:"26px clamp(15px,3vw,30px) 56px"}}>
    <header style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:12,flexWrap:"wrap",marginBottom:22}}>
      <div><Link href={"/app/"+organizationId} style={{display:"inline-flex",alignItems:"center",gap:7,color:"var(--brand)",fontSize:12,fontWeight:750}}><ArrowLeft size={15}/> Paneli</Link><h1 style={{fontSize:29,letterSpacing:"-.04em",margin:"12px 0 5px"}}>Raportet</h1><p style={{margin:0,color:"var(--muted)",fontSize:13}}>Përmbledhje operative dhe financiare · {day(fromDate)} – {day(toDate)}</p></div>
      <Link href={"/app/"+organizationId+"/reports/daily"} style={{display:"inline-flex",alignItems:"center",gap:8,padding:"11px 14px",borderRadius:10,border:"1px solid var(--line)",color:"var(--ink)",fontSize:12,fontWeight:800,textDecoration:"none"}}>Raporti ditor</Link>
      {["owner", "administrator"].includes(membership.role) ? <Link href={"/app/"+organizationId+"/reports/audit"} style={{display:"inline-flex",alignItems:"center",gap:8,padding:"11px 14px",borderRadius:10,border:"1px solid var(--line)",color:"var(--ink)",fontSize:12,fontWeight:800,textDecoration:"none"}}>Log-et e auditimit</Link> : null}
      <a href={csvHref} download={"fiskalo-raporti-"+fromDate+"-"+toDate+".csv"} style={{display:"inline-flex",alignItems:"center",gap:8,padding:"11px 14px",borderRadius:10,background:"var(--brand)",color:"white",fontSize:12,fontWeight:800,textDecoration:"none"}}><Download size={15}/> Eksporto faturat CSV</a>
    </header>

    {invoiceResult.error || expenseResult.error || shiftResult.error || fiscalResult.error ? <p role="alert" style={{color:"#a33f36"}}>Disa të dhëna të raportit nuk u ngarkuan. Rifresko faqen ose kontakto administratorin.</p> : null}
    <section style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(175px,1fr))",gap:12,marginBottom:18}}>
      {[
        ["Shitjet bruto",money(turnover)],["Shitjet pa TVSH",money(netSales)],["TVSH e llogaritur",money(vatTotal)],
        ["Shpenzimet e regjistruara",money(expenseTotal)],["Fatura të paguara",String(paid)],["Fatura me saldo",String(unpaid)],
      ].map(([label,value])=><article key={label} style={{background:"white",border:"1px solid var(--line)",borderRadius:14,padding:16}}><span style={{fontSize:12,color:"var(--muted)"}}>{label}</span><strong style={{display:"block",fontSize:23,letterSpacing:"-.04em",marginTop:7}}>{value}</strong></article>)}
    </section>

    <section style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(300px,1fr))",gap:16,marginBottom:18}}>
      <article style={{background:"white",border:"1px solid var(--line)",borderRadius:14,padding:17}}>
        <h2 style={{fontSize:16,margin:"0 0 12px"}}>TVSH sipas normës</h2>
        <table className="data-table"><thead><tr><th>Norma</th><th>Neto</th><th>TVSH</th></tr></thead><tbody>{vatTotals.map((row)=><tr key={row.rate}><td>{row.rate}%</td><td>{money(row.net)}</td><td>{money(row.vat)}</td></tr>)}</tbody></table>
        <p style={{fontSize:11,color:"var(--muted)",marginBottom:0}}>Bazuar në rreshtat e faturave të lëshuara gjatë periudhës.</p>
      </article>
      <article style={{background:"white",border:"1px solid var(--line)",borderRadius:14,padding:17}}>
        <h2 style={{fontSize:16,margin:"0 0 12px"}}>Pagesat sipas mënyrës</h2>
        {paymentTotals.map((row)=><div key={row.method} style={{display:"flex",justifyContent:"space-between",padding:"10px 0",borderBottom:"1px solid var(--line)",fontSize:13}}><span>{row.method === "cash" ? "Para në dorë" : row.method === "card" ? "Kartelë" : "Transfer bankar"}</span><strong>{money(row.amount)}</strong></div>)}
      </article>
    </section>

    <section style={{background:"white",border:"1px solid var(--line)",borderRadius:14,padding:17,marginBottom:18}}>
      <h2 style={{fontSize:16,margin:"0 0 12px"}}>Dërgesat fiskale në ATK</h2>
      <p style={{fontSize:12,color:"var(--muted)",marginTop:0}}>Ky është raport i statusit të dokumenteve të ruajtura në Fiskalo; nuk është deklaratë tatimore dhe nuk dërgon raport periodik në ATK.</p>
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(135px,1fr))",gap:10}}>
        {fiscalCounts.map((row)=><div key={row.status} style={{background:"#f7f8fa",borderRadius:10,padding:12}}><span style={{fontSize:11,color:"var(--muted)"}}>{({accepted:"Pranuar",rejected:"Refuzuar",queued:"Në radhë",submitted:"Dërguar",offline_pending:"Në pritje offline"} as Record<string,string>)[row.status]}</span><strong style={{display:"block",fontSize:20,marginTop:4}}>{row.count}</strong><small>{money(row.amount)}</small></div>)}
      </div>
      {fiscalDocs.some((doc) => doc.status === "rejected") ? <p style={{fontSize:12,color:"#a33f36",marginBottom:0}}>Ka dokumente të refuzuara. Kontrollo gabimin dhe mos i shëno si të pranuara pa përgjigje të vlefshme nga ATK.</p> : null}
    </section>

    <section style={{background:"white",border:"1px solid var(--line)",borderRadius:14,padding:17,marginBottom:18}}>
      <h2 style={{fontSize:16,margin:"0 0 12px"}}>Ndërrimet e arkës</h2>
      <div style={{display:"flex",gap:20,flexWrap:"wrap",fontSize:13,marginBottom:12}}><span>Ndërrime të mbyllura: <strong>{closedShifts.length}</strong></span><span>Diferenca neto: <strong>{money(cashDifference)}</strong></span><span>Ndërrime të hapura: <strong>{shifts.filter((shift)=>shift.status==="open").length}</strong></span></div>
      {closedShifts.length ? <div style={{overflowX:"auto"}}><table className="data-table" style={{minWidth:620}}><thead><tr><th>Hapur më</th><th>Arka e pritur</th><th>Arka e numëruar</th><th>Diferenca</th></tr></thead><tbody>{closedShifts.slice(0,12).map((shift)=><tr key={shift.id}><td>{new Date(shift.opened_at).toLocaleString("sq-XK")}</td><td>{money(Number(shift.expected_cash))}</td><td>{money(Number(shift.counted_cash))}</td><td>{money(Number(shift.cash_difference))}</td></tr>)}</tbody></table></div> : <p style={{fontSize:13,color:"var(--muted)"}}>Nuk ka ndërrime të mbyllura në këtë periudhë.</p>}
    </section>

    <section style={{background:"white",border:"1px solid var(--line)",borderRadius:14,padding:17}}>
      <h2 style={{fontSize:16,margin:"0 0 12px"}}>Faturat e periudhës</h2>
      {invoices.length ? <div style={{overflowX:"auto"}}><table className="data-table" style={{minWidth:720}}><thead><tr><th>Numri</th><th>Data</th><th>Neto</th><th>TVSH</th><th>Totali</th><th>Pagesa</th><th>Fiskalizimi</th></tr></thead><tbody>{invoices.slice(0,100).map((invoice)=><tr key={invoice.id}><td><Link href={"/app/"+organizationId+"/invoices/"+invoice.id} style={{color:"var(--brand)",fontWeight:800}}>{invoice.invoice_number || "—"}</Link></td><td>{day(invoice.issue_date)}</td><td>{money(Number(invoice.subtotal))}</td><td>{money(Number(invoice.vat_total))}</td><td><strong>{money(Number(invoice.total))}</strong></td><td>{invoice.payment_status}</td><td>{invoice.fiscalization_status}</td></tr>)}</tbody></table></div> : <p style={{fontSize:13,color:"var(--muted)"}}>Nuk ka fatura të lëshuara në këtë periudhë.</p>}
      <p style={{fontSize:11,color:"var(--muted)",marginBottom:0}}><FileBarChart2 size={13} style={{display:"inline",verticalAlign:"-2px"}}/> Raporti përfshin deri në 1,000 fatura, 500 dokumente fiskale dhe 300 ndërrime për 30 ditët e fundit.</p>
    </section>
  </main>;
}
