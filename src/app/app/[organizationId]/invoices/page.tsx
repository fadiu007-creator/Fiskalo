import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ArrowLeft, ArrowUpRight, FileText } from "lucide-react";

type Props = { params: Promise<{ organizationId: string }> };
const money = (value: number) => new Intl.NumberFormat("sq-XK", { style: "currency", currency: "EUR" }).format(value);
const paymentLabels: Record<string,string> = { paid:"E paguar", unpaid:"E papaguar", partial:"Pjesërisht" };
const fiscalLabels: Record<string,string> = { accepted:"Pranuar nga ATK", rejected:"Refuzuar", queued:"Në radhë", submitted:"Dërguar", not_fiscalized:"Jo e fiskalizuar", offline_pending:"Në verifikim" };

export default async function InvoiceListPage({ params }: Props) {
  const { organizationId } = await params;
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) redirect("/login");
  const [{ data: membership }, { data: invoices, error }] = await Promise.all([
    supabase.from("fiskalo_organization_users").select("role").eq("organization_id",organizationId).eq("user_id",auth.user.id).maybeSingle(),
    supabase.from("fiskalo_invoices").select("id,invoice_number,issue_date,status,payment_status,payment_method,total,fiscalization_status")
      .eq("organization_id",organizationId).order("created_at",{ascending:false}).limit(150),
  ]);
  if (!membership) redirect("/app");
  return <main style={{maxWidth:1180,margin:"0 auto",padding:"26px clamp(15px,3vw,30px) 56px"}}>
    <header style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:12,flexWrap:"wrap",marginBottom:22}}>
      <div><Link href={"/app/"+organizationId} style={{display:"inline-flex",alignItems:"center",gap:7,color:"var(--brand)",fontSize:12,fontWeight:750}}><ArrowLeft size={15}/> Paneli</Link><h1 style={{fontSize:29,letterSpacing:"-.04em",margin:"12px 0 5px"}}>Faturat</h1><p style={{margin:0,color:"var(--muted)",fontSize:13}}>Shitjet, pagesat dhe statusi i fiskalizimit.</p></div>
      <Link href={"/app/"+organizationId+"/pos"} style={{display:"inline-flex",alignItems:"center",gap:8,padding:"11px 14px",borderRadius:10,background:"var(--brand)",color:"white",fontSize:12,fontWeight:800}}>Krijo shitje <ArrowUpRight size={15}/></Link>
    </header>
    <section style={{background:"white",border:"1px solid var(--line)",borderRadius:15,padding:17}}>
      {error ? <p role="alert" style={{color:"#a33f36",fontSize:13}}>Faturat nuk u ngarkuan: {error.message}</p> : invoices?.length ? <div style={{overflowX:"auto"}}><table className="data-table" style={{minWidth:760}}><thead><tr><th>Numri</th><th>Data</th><th>Pagesa</th><th>Fiskalizimi</th><th>Totali</th><th></th></tr></thead><tbody>
        {invoices.map((invoice) => <tr key={invoice.id}><td><strong>{invoice.invoice_number || "Draft"}</strong><small>{invoice.status === "issued" ? "E lëshuar" : invoice.status}</small></td><td>{new Date(invoice.issue_date+"T12:00:00").toLocaleDateString("sq-XK")}</td><td>{paymentLabels[invoice.payment_status] ?? invoice.payment_status}<small>{invoice.payment_method || "—"}</small></td><td>{fiscalLabels[invoice.fiscalization_status] ?? invoice.fiscalization_status}</td><td><strong>{money(Number(invoice.total))}</strong></td><td><Link href={"/app/"+organizationId+"/invoices/"+invoice.id} style={{color:"var(--brand)",fontWeight:800,fontSize:12}}>Hap faturën</Link></td></tr>)}
      </tbody></table></div> : <div style={{padding:"38px 12px",textAlign:"center"}}><FileText size={28} color="var(--brand)"/><h2 style={{fontSize:16}}>Ende nuk ka fatura</h2><p style={{fontSize:13,color:"var(--muted)"}}>Faturat e shitjeve do të shfaqen këtu.</p><Link href={"/app/"+organizationId+"/pos"} style={{color:"var(--brand)",fontWeight:800,fontSize:13}}>Hap arkën</Link></div>}
    </section>
  </main>;
}
