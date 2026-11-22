import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import AdjustmentRequestForm from "./adjustment-request-form";

type Props = { params: Promise<{ organizationId: string; invoiceId: string }>; searchParams: Promise<{ type?: string }> };

export default async function NewInvoiceAdjustmentPage({params,searchParams}:Props) {
  const {organizationId,invoiceId}=await params;
  const query=await searchParams;
  const kind=query.type==="return"?"return":query.type==="cancel"?"cancel":null;
  if(!kind) notFound();
  const supabase=await createClient();
  const {data:auth}=await supabase.auth.getUser();
  if(!auth.user) redirect("/login");
  const {data:membership}=await supabase.from("fiskalo_organization_users")
    .select("role").eq("organization_id",organizationId).eq("user_id",auth.user.id).maybeSingle();
  if(!membership) redirect("/app");
  if(!["owner","administrator","manager","accountant"].includes(membership.role)) redirect("/app/"+organizationId);
  const [{data:invoice},{data:fiscalDoc},{data:prior},{data:invoiceItems,error:itemError}] = await Promise.all([
    supabase.from("fiskalo_invoices").select("id,invoice_number,total,status,payment_status")
      .eq("id",invoiceId).eq("organization_id",organizationId).maybeSingle(),
    supabase.from("fiskalo_atk_fiscal_documents").select("id,coupon_id,atk_transaction_id,status,document_type")
      .eq("organization_id",organizationId).eq("source_invoice_id",invoiceId).eq("document_type","sale").eq("status","accepted").maybeSingle(),
    supabase.from("fiskalo_invoice_adjustments").select("id,adjustment_type,amount,status,reason,failure_reason,created_at")
      .eq("organization_id",organizationId).eq("original_invoice_id",invoiceId).order("created_at",{ascending:false}),
    supabase.from("fiskalo_invoice_items").select("id,description,quantity,line_subtotal,line_vat")
      .eq("invoice_id",invoiceId).order("id"),
  ]);
  if(!invoice) notFound();
  const priorRows=(prior??[]);
  // Only live ATK workflows reserve quantities or block a full cancellation.
  // Rejected attempts remain visible as history but must not block a new correction.
  const activePrior=priorRows.filter(row=>["awaiting_atk","submitted","accepted"].includes(row.status));
  const priorAmount=activePrior.reduce((sum,row)=>sum+Number(row.amount),0);
  const activePriorIds=activePrior.map(row=>row.id);
  const [{data:priorItems,error:priorItemsError},{data:priorFiscalDocs,error:priorFiscalDocsError}]=await Promise.all([
    activePriorIds.length
      ? supabase.from("fiskalo_invoice_adjustment_items")
          .select("original_invoice_item_id,quantity,net_amount,vat_amount")
          .eq("organization_id",organizationId).in("adjustment_id",activePriorIds)
      : Promise.resolve({data:[],error:null}),
    activePriorIds.length
      ? supabase.from("fiskalo_atk_fiscal_documents")
          .select("source_adjustment_id,status,atk_transaction_id,last_error")
          .eq("organization_id",organizationId).in("source_adjustment_id",activePriorIds)
      : Promise.resolve({data:[],error:null}),
  ]);
  const fiscalStatusByAdjustment=new Map((priorFiscalDocs??[]).map(doc=>[doc.source_adjustment_id,doc] as const));
  const pendingAdjustmentId=activePrior.find(row=>row.adjustment_type===kind&&row.status==="awaiting_atk"&&!fiscalStatusByAdjustment.has(row.id))?.id;
  const ledger=new Map<string,{quantity:number;net:number;vat:number}>();
  for(const row of priorItems??[]){
    const value=ledger.get(row.original_invoice_item_id)??{quantity:0,net:0,vat:0};
    value.quantity+=Number(row.quantity); value.net+=Number(row.net_amount); value.vat+=Number(row.vat_amount);
    ledger.set(row.original_invoice_item_id,value);
  }
  const eligible=invoice.status==="issued"&&invoice.payment_status==="paid"&&!!fiscalDoc&&!!fiscalDoc.atk_transaction_id;
  const cancellationBlocked=kind==="cancel"&&activePrior.length>0;
  return <main style={{maxWidth:760,margin:"0 auto",padding:"28px 18px 60px"}}>
    <Link href={"/app/"+organizationId+"/invoices/"+invoiceId} style={{color:"var(--brand)",fontWeight:750,fontSize:13}}>← Kthehu te fatura</Link>
    <h1 style={{fontSize:27,letterSpacing:"-.04em",margin:"14px 0 5px"}}>{kind==="cancel"?"Anulim i faturës":"Kthim i artikujve"}</h1>
    <p style={{fontSize:13,color:"var(--muted)",marginTop:0}}>Zgjidh artikujt dhe sasitë origjinale. Vlera dhe TVSH-ja llogariten nga linjat e faturës dhe kthimet paraprake.</p>
    {!eligible ? <section style={{padding:16,border:"1px solid var(--line)",borderRadius:12,background:"white"}}>
      <strong>Nuk mund të krijohet kërkesa.</strong>
      <p style={{fontSize:13,color:"var(--muted)"}}>Kërkohet faturë e lëshuar dhe plotësisht e paguar, me kupon origjinal të pranuar nga ATK.</p>
    </section> : itemError || priorItemsError || priorFiscalDocsError || !invoiceItems?.length ? <section style={{padding:16,border:"1px solid var(--line)",borderRadius:12,background:"white"}}>
      <strong>Linjat e faturës ose kthimet paraprake nuk u lexuan.</strong><p style={{fontSize:13,color:"var(--muted)"}}>Nuk mund të krijohet korrigjim pa të dhënat e plota të artikujve.</p>
    </section> : cancellationBlocked ? <section style={{padding:16,border:"1px solid var(--line)",borderRadius:12,background:"white"}}>
      <strong>Anulimi i plotë nuk është më i disponueshëm.</strong>
      <p style={{fontSize:13,color:"var(--muted)"}}>Ekziston së paku një kërkesë kthimi/anulimi. Vazhdo vetëm me kthimin e sasive të mbetura të artikujve.</p>
    </section> : <section style={{padding:18,border:"1px solid var(--line)",borderRadius:12,background:"white"}}>
      {priorRows.length ? <div style={{padding:12,background:"#f5f7fa",borderRadius:9,marginBottom:14,fontSize:12}}>
        <strong>Historia e korrigjimeve</strong><br/>{priorRows.map(row=>{const fiscal=fiscalStatusByAdjustment.get(row.id);const statusLabel=row.status==="rejected"?"Dështoi — nuk u dërgua / u refuzua":row.status==="accepted"?"Pranuar nga ATK":row.status==="submitted"?"Dërguar — në pritje të konfirmimit":row.status==="awaiting_atk"?"Në pritje të dërgimit":"Anuluar";return <div key={row.id} style={{paddingTop:6}}>{row.adjustment_type==="cancel"?"Anulim":"Kthim"} · {Number(row.amount).toFixed(2)} € · {statusLabel} · ATK: {fiscal?.status??"nuk është dërguar"}{fiscal?.atk_transaction_id? " · TX "+String(fiscal.atk_transaction_id):""}{row.status==="rejected"&&row.failure_reason? <div style={{color:"#a33f36",paddingTop:3}}>{row.failure_reason}</div>:null}</div>})}<br/>
        Shuma aktive e korrigjuar: {priorAmount.toFixed(2)} € / {Number(invoice.total).toFixed(2)} €
      </div>:null}
      <AdjustmentRequestForm invoiceId={invoiceId} organizationId={organizationId} pendingAdjustmentId={pendingAdjustmentId} total={Number(invoice.total)}
        kind={kind} invoiceNumber={invoice.invoice_number||invoice.id} couponId={String(fiscalDoc.coupon_id)}
        transactionId={String(fiscalDoc.atk_transaction_id)}
        items={(invoiceItems??[]).map(item=>{
          const returned=ledger.get(item.id)??{quantity:0,net:0,vat:0};
          return {id:item.id,description:item.description,quantity:Number(item.quantity),
            line_subtotal:Number(item.line_subtotal),line_vat:Number(item.line_vat),
            remainingQuantity:Math.max(0,Number(item.quantity)-returned.quantity),
            remainingNet:Math.max(0,Number(item.line_subtotal)-returned.net),
            remainingVat:Math.max(0,Number(item.line_vat)-returned.vat)};
        })}/>
    </section>}
  </main>;
}
