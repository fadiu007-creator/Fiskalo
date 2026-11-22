"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

type Supplier = { id: string; name: string; business_number: string | null; phone: string | null; email: string | null };
type Product = { id: string; name: string; unit: string | null; stock_quantity: number; unit_price: number };
type Purchase = { id: string; reference: string | null; purchase_date: string; status: string; total: number; payment_status: string; paid_total: number; supplier_id: string; received_at: string | null };
type Line = { product_id: string; quantity: string; unit_cost: string; vat_rate: string };

const money = (n: number | string) => new Intl.NumberFormat("sq-XK", { style: "currency", currency: "EUR" }).format(Number(n || 0));
const inputStyle: React.CSSProperties = { width:"100%", minWidth:0, padding:"10px 11px", border:"1px solid var(--line)", borderRadius:9, background:"white", color:"var(--ink)", font:"inherit", fontSize:14 };
const buttonStyle: React.CSSProperties = { border:0, borderRadius:9, padding:"10px 14px", background:"var(--brand)", color:"white", fontWeight:800, cursor:"pointer" };

export default function PurchasesWorkspace({ organizationId }: { organizationId: string }) {
  const router = useRouter();
  const supabase = useMemo(() => createClient(), []);
  const [suppliers,setSuppliers] = useState<Supplier[]>([]);
  const [products,setProducts] = useState<Product[]>([]);
  const [purchases,setPurchases] = useState<Purchase[]>([]);
  const [busy,setBusy] = useState(false);
  const [loading,setLoading] = useState(true);
  const [error,setError] = useState("");
  const [notice,setNotice] = useState("");
  const [supplierName,setSupplierName] = useState("");
  const [supplierNumber,setSupplierNumber] = useState("");
  const [supplierPhone,setSupplierPhone] = useState("");
  const [supplierEmail,setSupplierEmail] = useState("");
  const [supplierId,setSupplierId] = useState("");
  const [reference,setReference] = useState("");
  const [purchaseDate,setPurchaseDate] = useState(new Date().toISOString().slice(0,10));
  const [notes,setNotes] = useState("");
  const [lines,setLines] = useState<Line[]>([{product_id:"",quantity:"1",unit_cost:"0",vat_rate:"18"}]);
  const [paymentPurchase,setPaymentPurchase] = useState("");
  const [paymentAmount,setPaymentAmount] = useState("");
  const [paymentMethod,setPaymentMethod] = useState("bank_transfer");
  const [paymentReference,setPaymentReference] = useState("");

  const load = useCallback(async () => {
    setLoading(true); setError("");
    const [s,p,b] = await Promise.all([
      supabase.from("fiskalo_suppliers").select("id,name,business_number,phone,email").eq("organization_id",organizationId).order("name"),
      supabase.from("fiskalo_products").select("id,name,unit,stock_quantity,unit_price").eq("organization_id",organizationId).eq("is_active",true).eq("track_stock",true).order("name"),
      supabase.from("fiskalo_purchases").select("id,reference,purchase_date,status,total,payment_status,paid_total,supplier_id,received_at").eq("organization_id",organizationId).order("created_at",{ascending:false}).limit(100)
    ]);
    const issue=s.error||p.error||b.error;
    if(issue) setError(issue.message);
    setSuppliers(s.data??[]); setProducts(p.data??[]); setPurchases(b.data??[]);
    setLoading(false);
  },[organizationId,supabase]);

  useEffect(()=>{ void load(); },[load]);

  const supplierNames = useMemo(()=>Object.fromEntries(suppliers.map(s=>[s.id,s.name])) as Record<string,string>,[suppliers]);
  const total = lines.reduce((sum,line)=>{
    const q=Number(line.quantity), c=Number(line.unit_cost), v=Number(line.vat_rate);
    return sum+(Number.isFinite(q*c*(1+v/100))?q*c*(1+v/100):0);
  },0);

  async function addSupplier(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(""); setNotice("");
    const {data,error:insertError}=await supabase.from("fiskalo_suppliers").insert({
      organization_id:organizationId,name:supplierName.trim(),business_number:supplierNumber.trim()||null,
      phone:supplierPhone.trim()||null,email:supplierEmail.trim()||null
    }).select("id,name,business_number,phone,email").single();
    if(insertError){setError(insertError.message);setBusy(false);return;}
    setSuppliers(current=>[...current,data].sort((a,b)=>a.name.localeCompare(b.name)));
    setSupplierId(data.id); setSupplierName("");setSupplierNumber("");setSupplierPhone("");setSupplierEmail("");
    setNotice("Furnitori u ruajt.");setBusy(false);
  }

  async function createPurchase(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true);setError("");setNotice("");
    const clean=lines.map(l=>({product_id:l.product_id,quantity:Number(l.quantity),unit_cost:Number(l.unit_cost),vat_rate:Number(l.vat_rate)}));
    if(!supplierId||clean.some(l=>!l.product_id||!Number.isFinite(l.quantity)||l.quantity<=0||!Number.isFinite(l.unit_cost)||l.unit_cost<0||![0,8,18].includes(l.vat_rate))){
      setError("Kontrollo furnitorin dhe të gjitha rreshtat e blerjes.");setBusy(false);return;
    }
    const {data,error:rpcError}=await supabase.rpc("fiskalo_create_purchase",{payload:{
      organization_id:organizationId,supplier_id:supplierId,reference:reference.trim()||null,
      purchase_date:purchaseDate,notes:notes.trim()||null,items:clean
    }});
    if(rpcError||!data){setError(rpcError?.message||"Blerja nuk u krijua.");setBusy(false);return;}
    setNotice("Blerja u ruajt si draft. Stoku nuk ndryshon derisa ta pranosh.");setReference("");setNotes("");
    setLines([{product_id:"",quantity:"1",unit_cost:"0",vat_rate:"18"}]);
    await load();router.refresh();setBusy(false);
  }

  async function receive(id:string) {
    if(!window.confirm("Prano këtë blerje? Stoku do të rritet menjëherë dhe veprimi do të auditohet.")) return;
    setBusy(true);setError("");setNotice("");
    const {data,error:rpcError}=await supabase.rpc("fiskalo_receive_purchase",{target_purchase:id});
    if(rpcError){setError(rpcError.message);setBusy(false);return;}
    setNotice("Blerja u pranua. Stoku u përditësua. Totali: "+money(data));
    await load();router.refresh();setBusy(false);
  }

  async function recordPayment(event:React.FormEvent<HTMLFormElement>) {
    event.preventDefault();setBusy(true);setError("");setNotice("");
    const {data,error:rpcError}=await supabase.rpc("fiskalo_record_purchase_payment",{
      target_purchase:paymentPurchase,payment_amount:Number(paymentAmount),method:paymentMethod,
      payment_reference:paymentReference.trim()||null
    });
    if(rpcError){setError(rpcError.message);setBusy(false);return;}
    setNotice("Pagesa u regjistrua. Borxhi i mbetur: "+money(data));
    setPaymentPurchase("");setPaymentAmount("");setPaymentReference("");
    await load();router.refresh();setBusy(false);
  }

  const pendingPayment=purchases.find(p=>p.id===paymentPurchase);
  return <main style={{maxWidth:1180,margin:"0 auto",padding:"26px 18px 64px",display:"grid",gap:18}}>
    <header style={{display:"flex",justifyContent:"space-between",alignItems:"end",gap:12,flexWrap:"wrap"}}>
      <div><div style={{fontSize:11,fontWeight:850,letterSpacing:".12em",color:"var(--muted)"}}>FURNITORËT DHE HYRJET E MALLIT</div>
        <h1 style={{fontSize:28,letterSpacing:"-.04em",margin:"6px 0"}}>Blerjet</h1>
        <p style={{margin:0,color:"var(--muted)",fontSize:13}}>Regjistro faturat e furnitorëve, prano mallin dhe përcjell pagesat.</p></div>
      <button type="button" onClick={()=>void load()} style={{...buttonStyle,background:"white",color:"var(--ink)",border:"1px solid var(--line)"}}>Rifresko</button>
    </header>
    {error&&<div role="alert" style={{padding:12,borderRadius:9,background:"#fff1f0",color:"#a33f36",fontSize:13}}>{error}</div>}
    {notice&&<div role="status" style={{padding:12,borderRadius:9,background:"#eef8f1",color:"#226b43",fontSize:13}}>{notice}</div>}
    <section style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(min(100%,320px),1fr))",gap:14}}>
      <form onSubmit={addSupplier} style={{background:"white",border:"1px solid var(--line)",borderRadius:13,padding:16,display:"grid",gap:10,alignContent:"start"}}>
        <h2 style={{fontSize:16,margin:0}}>Regjistro furnitor</h2>
        <label style={{fontSize:12,fontWeight:750}}>Emri i furnitorit<input required value={supplierName} onChange={e=>setSupplierName(e.target.value)} style={inputStyle} placeholder="Emri i biznesit"/></label>
        <label style={{fontSize:12,fontWeight:750}}>NUI / numri i biznesit<input value={supplierNumber} onChange={e=>setSupplierNumber(e.target.value)} style={inputStyle}/></label>
        <label style={{fontSize:12,fontWeight:750}}>Telefoni<input value={supplierPhone} onChange={e=>setSupplierPhone(e.target.value)} style={inputStyle}/></label>
        <label style={{fontSize:12,fontWeight:750}}>Email<input type="email" value={supplierEmail} onChange={e=>setSupplierEmail(e.target.value)} style={inputStyle}/></label>
        <button disabled={busy||!supplierName.trim()} style={buttonStyle}>Ruaj furnitorin</button>
      </form>
      <form onSubmit={createPurchase} style={{background:"white",border:"1px solid var(--line)",borderRadius:13,padding:16,display:"grid",gap:10}}>
        <h2 style={{fontSize:16,margin:0}}>Regjistro blerje</h2>
        <label style={{fontSize:12,fontWeight:750}}>Furnitori<select required value={supplierId} onChange={e=>setSupplierId(e.target.value)} style={inputStyle}><option value="">Zgjidh furnitorin</option>{suppliers.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
          <label style={{fontSize:12,fontWeight:750}}>Nr. faturës<input value={reference} onChange={e=>setReference(e.target.value)} style={inputStyle}/></label>
          <label style={{fontSize:12,fontWeight:750}}>Data<input type="date" required value={purchaseDate} onChange={e=>setPurchaseDate(e.target.value)} style={inputStyle}/></label>
        </div>
        <div style={{display:"grid",gap:8}}>
          {lines.map((line,index)=><div key={index} style={{display:"grid",gridTemplateColumns:"minmax(130px,2fr) repeat(3,minmax(65px,1fr)) auto",gap:6,alignItems:"end"}}>
            <label style={{fontSize:11,fontWeight:700}}>Produkti<select required value={line.product_id} onChange={e=>setLines(curr=>curr.map((x,i)=>i===index?{...x,product_id:e.target.value}:x))} style={inputStyle}><option value="">Artikulli</option>{products.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
            <label style={{fontSize:11,fontWeight:700}}>Sasia<input required type="number" min="0.001" step="0.001" value={line.quantity} onChange={e=>setLines(curr=>curr.map((x,i)=>i===index?{...x,quantity:e.target.value}:x))} style={inputStyle}/></label>
            <label style={{fontSize:11,fontWeight:700}}>Kosto €/nj<input required type="number" min="0" step="0.0001" value={line.unit_cost} onChange={e=>setLines(curr=>curr.map((x,i)=>i===index?{...x,unit_cost:e.target.value}:x))} style={inputStyle}/></label>
            <label style={{fontSize:11,fontWeight:700}}>TVSH<select value={line.vat_rate} onChange={e=>setLines(curr=>curr.map((x,i)=>i===index?{...x,vat_rate:e.target.value}:x))} style={inputStyle}><option value="0">0%</option><option value="8">8%</option><option value="18">18%</option></select></label>
            <button type="button" aria-label="Hiq rreshtin" disabled={lines.length===1} onClick={()=>setLines(curr=>curr.filter((_,i)=>i!==index))} style={{height:39,border:"1px solid var(--line)",borderRadius:8,background:"white",cursor:"pointer"}}>×</button>
          </div>)}
          <button type="button" onClick={()=>setLines(curr=>[...curr,{product_id:"",quantity:"1",unit_cost:"0",vat_rate:"18"}])} style={{justifySelf:"start",border:"1px solid var(--line)",borderRadius:8,padding:"8px 10px",background:"white",fontWeight:700,cursor:"pointer"}}>+ Shto artikull</button>
        </div>
        <label style={{fontSize:12,fontWeight:750}}>Shënime<textarea rows={2} value={notes} onChange={e=>setNotes(e.target.value)} style={inputStyle}/></label>
        <div style={{display:"flex",justifyContent:"space-between",fontWeight:850,fontSize:17}}><span>Totali i parashikuar</span><span>{money(total)}</span></div>
        <p style={{fontSize:11,color:"var(--muted)",margin:0}}>Krijimi ruan draftin. Stoku rritet vetëm pasi të shtypësh “Prano blerjen”.</p>
        <button disabled={busy||!suppliers.length||!products.length} style={buttonStyle}>Ruaj draftin e blerjes</button>
        {!products.length&&<small style={{color:"#a33f36"}}>Nuk ka produkte aktive me përcjellje të stokut.</small>}
      </form>
    </section>
    <section style={{background:"white",border:"1px solid var(--line)",borderRadius:13,padding:16,display:"grid",gap:12}}>
      <h2 style={{fontSize:17,margin:0}}>Regjistro pagesë ndaj furnitorit</h2>
      <form onSubmit={recordPayment} style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(150px,1fr))",gap:9,alignItems:"end"}}>
        <label style={{fontSize:12,fontWeight:750}}>Blerja<select required value={paymentPurchase} onChange={e=>setPaymentPurchase(e.target.value)} style={inputStyle}><option value="">Zgjidh blerjen</option>{purchases.filter(p=>p.status==="received"&&Number(p.paid_total)<Number(p.total)).map(p=><option key={p.id} value={p.id}>{supplierNames[p.supplier_id]||"Furnitor"} · {p.reference||p.id.slice(0,8)} · Borxh {money(Number(p.total)-Number(p.paid_total))}</option>)}</select></label>
        <label style={{fontSize:12,fontWeight:750}}>Shuma (€)<input required type="number" min="0.01" max={pendingPayment?Number(pendingPayment.total)-Number(pendingPayment.paid_total):undefined} step="0.01" value={paymentAmount} onChange={e=>setPaymentAmount(e.target.value)} style={inputStyle}/></label>
        <label style={{fontSize:12,fontWeight:750}}>Metoda<select value={paymentMethod} onChange={e=>setPaymentMethod(e.target.value)} style={inputStyle}><option value="bank_transfer">Transfer bankar</option><option value="cash">Para në dorë</option><option value="card">Kartelë</option></select></label>
        <label style={{fontSize:12,fontWeight:750}}>Referenca<input value={paymentReference} onChange={e=>setPaymentReference(e.target.value)} style={inputStyle}/></label>
        <button disabled={busy||!paymentPurchase||Number(paymentAmount)<=0} style={buttonStyle}>Regjistro pagesën</button>
      </form>
    </section>
    <section style={{background:"white",border:"1px solid var(--line)",borderRadius:13,padding:16}}>
      <h2 style={{fontSize:17,margin:"0 0 12px"}}>Historiku i blerjeve</h2>
      {loading?<p style={{color:"var(--muted)",fontSize:13}}>Duke ngarkuar...</p>:!purchases.length?<p style={{color:"var(--muted)",fontSize:13}}>Nuk ka blerje të regjistruara.</p>:
        <div style={{overflowX:"auto"}}><table className="data-table" style={{minWidth:760,width:"100%"}}><thead><tr><th>Furnitori</th><th>Referenca</th><th>Data</th><th>Totali</th><th>Pranimi</th><th>Pagesa</th><th>Veprimi</th></tr></thead><tbody>
          {purchases.map(p=><tr key={p.id}><td>{supplierNames[p.supplier_id]||"—"}</td><td>{p.reference||"—"}</td><td>{p.purchase_date}</td><td><strong>{money(p.total)}</strong></td><td>{p.status==="received"?"Pranuar":"Draft"}</td><td>{p.payment_status==="paid"?"Paguar":p.payment_status==="partial"?"Pjesërisht":"Pa paguar"}<br/><small>{money(p.paid_total)} / {money(p.total)}</small></td><td>{p.status==="draft"?<button disabled={busy} onClick={()=>void receive(p.id)} style={{...buttonStyle,padding:"7px 10px"}}>Prano blerjen</button>:<span style={{fontSize:12,color:"var(--muted)"}}>{p.received_at?new Date(p.received_at).toLocaleDateString("sq-XK"):"—"}</span>}</td></tr>)}
        </tbody></table></div>}
    </section>
  </main>;
}
