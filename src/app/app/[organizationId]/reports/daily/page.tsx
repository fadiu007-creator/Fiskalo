import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import PrintReportButton from "./print-button";

type Props = { params: Promise<{ organizationId: string }>; searchParams: Promise<{ date?: string }> };
const money = (value: number | string | null | undefined) => new Intl.NumberFormat("sq-XK", { style: "currency", currency: "EUR" }).format(Number(value ?? 0));
const kosovoDate = (date = new Date()) => {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Belgrade", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  return part("year") + "-" + part("month") + "-" + part("day");
};
const dateBoundary = (date: string) => {
  const [year, month, day] = date.split("-").map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  const nextDate = next.getUTCFullYear() + "-" + String(next.getUTCMonth() + 1).padStart(2, "0") + "-" + String(next.getUTCDate()).padStart(2, "0");
  const offset = (value: string) => {
    const probe = new Date(value + "T12:00:00Z");
    const zone = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Belgrade", timeZoneName: "longOffset" }).formatToParts(probe).find((item) => item.type === "timeZoneName")?.value ?? "GMT+01:00";
    return zone.replace("GMT", "");
  };
  return { start: date + "T00:00:00" + offset(date), end: nextDate + "T00:00:00" + offset(nextDate) };
};
const validDate = (value?: string) => value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : kosovoDate();

export default async function DailyReportsPage({ params, searchParams }: Props) {
  const { organizationId } = await params;
  const { date: requestedDate } = await searchParams;
  const date = validDate(requestedDate);
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) redirect("/login");
  const { data: membership } = await supabase.from("fiskalo_organization_users").select("role")
    .eq("organization_id", organizationId).eq("user_id", auth.user.id).maybeSingle();
  if (!membership || !["owner","administrator","manager","accountant"].includes(membership.role)) redirect("/app/"+organizationId);

  const bounds = dateBoundary(date);
  const [invoiceResult, shiftResult, fiscalResult] = await Promise.all([
    supabase.from("fiskalo_invoices").select("id,invoice_number,issue_date,subtotal,vat_total,total,payment_status,fiscalization_status")
      .eq("organization_id",organizationId).eq("status","issued").eq("issue_date",date).order("issue_date",{ascending:true}).limit(2000),
    supabase.from("fiskalo_cashier_shifts").select("id,status,opening_cash,expected_cash,counted_cash,cash_difference,opened_at,closed_at")
      .eq("organization_id",organizationId)
      .or("status.eq.open,and(opened_at.gte." + bounds.start + ",opened_at.lt." + bounds.end + "),and(closed_at.gte." + bounds.start + ",closed_at.lt." + bounds.end + ")")
      .order("opened_at",{ascending:true}).limit(500),
    supabase.from("fiskalo_atk_fiscal_documents").select("id,status,document_type,total,atk_transaction_id,last_error,occurred_at")
      .eq("organization_id",organizationId).gte("occurred_at",bounds.start).lt("occurred_at",bounds.end).order("occurred_at",{ascending:true}).limit(2000)
  ]);
  const invoices = invoiceResult.data ?? [];
  const shifts = shiftResult.data ?? [];
  const fiscalDocs = fiscalResult.data ?? [];
  const shiftIds = shifts.map((row) => row.id);
  const { data: cashMovements, error: movementError } = shiftIds.length
    ? await supabase.from("fiskalo_cash_movements").select("cashier_shift_id,movement_type,amount,note,created_at")
        .eq("organization_id", organizationId).in("cashier_shift_id", shiftIds).gte("created_at", bounds.start).lt("created_at", bounds.end)
    : { data: [] as Array<{cashier_shift_id:string;movement_type:string;amount:number;note:string;created_at:string}>, error: null };
  const [{ data: shiftPayments, error: shiftPaymentsError }, { data: allShiftMovements, error: allShiftMovementsError }] = shiftIds.length
    ? await Promise.all([
        supabase.from("fiskalo_invoice_payments").select("cashier_shift_id,amount,payment_method")
          .eq("organization_id", organizationId).in("cashier_shift_id", shiftIds),
        supabase.from("fiskalo_cash_movements").select("cashier_shift_id,movement_type,amount")
          .eq("organization_id", organizationId).in("cashier_shift_id", shiftIds),
      ])
    : [{ data: [] as Array<{cashier_shift_id:string;amount:number;payment_method:string}>, error: null },
       { data: [] as Array<{cashier_shift_id:string;movement_type:string;amount:number}>, error: null }];
  const invoiceIds = invoices.map(row=>row.id);
  const { data: payments } = invoiceIds.length
    ? await supabase.from("fiskalo_invoice_payments").select("invoice_id,amount,payment_method").in("invoice_id",invoiceIds)
    : { data: [] as {invoice_id:string;amount:number;payment_method:string}[] };
  const sum = (rows: Array<number|string|null|undefined>)=>rows.reduce<number>((total,value)=>total+Number(value??0),0);
  const gross = sum(invoices.map(row=>row.total));
  const net = sum(invoices.map(row=>row.subtotal));
  const vat = sum(invoices.map(row=>row.vat_total));
  const paymentRows = ["cash","card","bank_transfer"].map(method=>({method,amount:sum((payments??[]).filter(row=>row.payment_method===method).map(row=>row.amount))}));
  const closed = shifts.filter(row=>row.status==="closed");
  const fiscalAccepted = fiscalDocs.filter(row=>row.status==="accepted").length;
  const fiscalPending = fiscalDocs.filter(row=>["queued","offline_pending","submitted"].includes(row.status)).length;
  const fiscalRejected = fiscalDocs.filter(row=>row.status==="rejected").length;
  const cashIn = sum((cashMovements ?? []).filter(row => row.movement_type === "cash_in").map(row => row.amount));
  const cashOut = sum((cashMovements ?? []).filter(row => row.movement_type === "cash_out").map(row => row.amount));
  const openShiftBalances = shifts.filter(row => row.status === "open").map(row => {
    const shiftCashSales = sum((shiftPayments ?? []).filter(payment =>
      payment.cashier_shift_id === row.id && payment.payment_method === "cash").map(payment => payment.amount));
    const shiftCashIn = sum((allShiftMovements ?? []).filter(movement =>
      movement.cashier_shift_id === row.id && movement.movement_type === "cash_in").map(movement => movement.amount));
    const shiftCashOut = sum((allShiftMovements ?? []).filter(movement =>
      movement.cashier_shift_id === row.id && movement.movement_type === "cash_out").map(movement => movement.amount));
    return { ...row, cashSales: shiftCashSales, cashIn: shiftCashIn, cashOut: shiftCashOut,
      expectedCash: Number(row.opening_cash) + shiftCashSales + shiftCashIn - shiftCashOut };
  });
  const error = invoiceResult.error || shiftResult.error || fiscalResult.error || movementError || shiftPaymentsError || allShiftMovementsError;
  return <main style={{maxWidth:1050,margin:"0 auto",padding:"24px clamp(15px,3vw,28px) 56px"}}>
    <style>{`@media print {.no-print{display:none!important} body{background:#fff!important} main{max-width:none!important;padding:0!important} .report-card{break-inside:avoid;box-shadow:none!important;border:1px solid #bbb!important}}`}</style>
    <header className="no-print" style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:12,flexWrap:"wrap",marginBottom:22}}>
      <div><Link href={"/app/"+organizationId+"/reports"} style={{color:"var(--brand)",fontWeight:750}}>← Raportet</Link><h1 style={{fontSize:28,margin:"10px 0 4px"}}>Raporti ditor</h1><p style={{margin:0,color:"var(--muted)",fontSize:13}}>Përmbledhja e shitjeve, pagesave dhe ndërrimeve për {date}</p></div>
      <div style={{display:"flex",gap:8,flexWrap:"wrap"}}><form><input type="date" name="date" defaultValue={date} style={{padding:"10px 12px",border:"1px solid var(--line)",borderRadius:9}}/><button style={{padding:"10px 13px",border:0,borderRadius:9,background:"var(--brand)",color:"white",fontWeight:750,marginLeft:6}}>Shfaq</button></form><PrintReportButton /></div>
    </header>
    <div style={{display:"flex",justifyContent:"space-between",gap:12,marginBottom:16}}><strong>Fiskalo · Raport operativ ditor</strong><span>{date}</span></div>
    {error && <p role="alert" style={{color:"#a33f36"}}>Disa të dhëna nuk u ngarkuan. {error.message}</p>}
    <section style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(170px,1fr))",gap:12,marginBottom:16}}>
      {[[ "Shitje bruto",money(gross) ],[ "Shitje neto",money(net) ],[ "TVSH",money(vat) ],[ "Fatura të lëshuara",String(invoices.length) ]].map(([label,value])=><article className="report-card" key={label} style={{background:"white",border:"1px solid var(--line)",borderRadius:12,padding:16}}><span style={{fontSize:12,color:"var(--muted)"}}>{label}</span><strong style={{display:"block",fontSize:23,marginTop:7}}>{value}</strong></article>)}
    </section>
    <section className="report-card" style={{background:"white",border:"1px solid var(--line)",borderRadius:12,padding:17,marginBottom:14}}>
      <h2 style={{fontSize:16,margin:"0 0 10px"}}>Pagesat sipas mënyrës</h2>
      {paymentRows.map(row=><div key={row.method} style={{display:"flex",justifyContent:"space-between",padding:"8px 0",borderBottom:"1px solid var(--line)"}}><span>{row.method==="cash"?"Para në dorë":row.method==="card"?"Kartelë":"Transfer bankar"}</span><strong>{money(row.amount)}</strong></div>)}
    </section>
    <section className="report-card" style={{background:"white",border:"1px solid var(--line)",borderRadius:12,padding:17,marginBottom:14}}>
      <h2 style={{fontSize:16,margin:"0 0 8px"}}>Raporti X · Gjendja e arkës</h2>
      <p style={{fontSize:11,color:"var(--muted)",margin:"0 0 10px"}}>Pamje statistikore e brendshme për ndërrimet e kësaj date; nuk është raport tatimor i ATK-së.</p>
      {date === kosovoDate() && openShiftBalances.length ? openShiftBalances.map(row=><div key={row.id} style={{padding:"10px 0",borderBottom:"1px solid var(--line)"}}>
        <div style={{display:"flex",justifyContent:"space-between",gap:8}}><span>Ndërrim aktiv · {new Date(row.opened_at).toLocaleTimeString("sq-XK")}</span><strong>{money(row.expectedCash)} para të pritshme</strong></div>
        <div style={{fontSize:11,color:"var(--muted)",marginTop:5}}>Fillimi {money(row.opening_cash)} + shitje cash {money(row.cashSales)} + hyrje {money(row.cashIn)} − dalje {money(row.cashOut)}</div>
      </div>) : <p style={{fontSize:13,color:"var(--muted)",margin:0}}>{date === kosovoDate() ? "Nuk ka ndërrim aktiv në këtë datë." : "Pozicioni X paraqitet vetëm për datën aktuale; raporti historik mbetet i pandryshueshëm."}</p>}
      <div style={{display:"flex",justifyContent:"space-between",padding:"8px 0"}}><span>Hyrje në arkë gjatë ditës</span><strong>{money(cashIn)}</strong></div>
      <div style={{display:"flex",justifyContent:"space-between",padding:"8px 0"}}><span>Dalje nga arka</span><strong>{money(cashOut)}</strong></div>
      <div style={{display:"flex",justifyContent:"space-between",padding:"8px 0",borderTop:"1px solid var(--line)"}}><span>Lëvizja neto e parasë</span><strong>{money(cashIn-cashOut)}</strong></div>
    </section>
    <section className="report-card" style={{background:"white",border:"1px solid var(--line)",borderRadius:12,padding:17,marginBottom:14}}>
      <h2 style={{fontSize:16,margin:"0 0 10px"}}>Ndërrimet e arkës</h2>
      <p style={{fontSize:13,color:"var(--muted)"}}>Të mbyllura: {closed.length} · Të hapura: {shifts.filter(row=>row.status==="open").length} · Diferenca: {money(sum(closed.map(row=>row.cash_difference)))}</p>
      <div style={{overflowX:"auto"}}><table className="data-table"><thead><tr><th>Hapja</th><th>Mbyllja</th><th>Arka e pritur</th><th>Arka e numëruar</th><th>Diferenca</th></tr></thead><tbody>{shifts.map(row=><tr key={row.id}><td>{new Date(row.opened_at).toLocaleTimeString("sq-XK")}</td><td>{row.closed_at?new Date(row.closed_at).toLocaleTimeString("sq-XK"):"Hapur"}</td><td>{money(row.expected_cash)}</td><td>{money(row.counted_cash)}</td><td>{money(row.cash_difference)}</td></tr>)}</tbody></table></div>
    </section>
    <section className="report-card" style={{background:"white",border:"1px solid var(--line)",borderRadius:12,padding:17,marginBottom:14}}>
      <h2 style={{fontSize:16,margin:"0 0 10px"}}>Statusi i dokumenteve fiskale në Fiskalo</h2>
      <p style={{fontSize:13}}>Pranuar nga ATK: <strong>{fiscalAccepted}</strong> · Në pritje: <strong>{fiscalPending}</strong> · Refuzuar: <strong>{fiscalRejected}</strong></p>
      <p style={{fontSize:11,color:"var(--muted)"}}>Këto janë statuset e dokumenteve të regjistruara. Ky raport operativ nuk është raport tatimor zyrtar i ATK-së dhe nuk kryen dërgesë në ATK.</p>
    </section>
    <section className="report-card" style={{background:"white",border:"1px solid var(--line)",borderRadius:12,padding:17}}>
      <h2 style={{fontSize:16,margin:"0 0 10px"}}>Faturat e ditës</h2>
      <div style={{overflowX:"auto"}}><table className="data-table"><thead><tr><th>Numri</th><th>Neto</th><th>TVSH</th><th>Totali</th><th>Pagesa</th><th>Fiskalizimi</th></tr></thead><tbody>{invoices.map(row=><tr key={row.id}><td>{row.invoice_number||"—"}</td><td>{money(row.subtotal)}</td><td>{money(row.vat_total)}</td><td><strong>{money(row.total)}</strong></td><td>{row.payment_status}</td><td>{row.fiscalization_status}</td></tr>)}</tbody></table></div>
      {!invoices.length && <p style={{color:"var(--muted)",fontSize:13}}>Nuk ka fatura të lëshuara për këtë datë.</p>}
    </section>
    <p style={{fontSize:11,color:"var(--muted)",marginTop:16}}>Raport i brendshëm menaxherial · Nuk zëvendëson raportin zyrtar Z/raportin tatimor të kërkuar nga ATK.</p>
  </main>;
}
