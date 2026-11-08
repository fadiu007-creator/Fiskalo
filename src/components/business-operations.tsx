"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";

type Product={id:string;name:string;price:number;stock:number;vat_rate:number;atk_unit_code:string;atk_item_category_code:string;atk_vat_code:string};
type Movement={id:string;product_id:string;movement_type:string;quantity_delta:number;reason:string;created_at:string};
type Purchase={id:string;supplier_name:string;invoice_number:string|null;purchase_date:string;payment_status:string;subtotal:number};
type Expense={id:string;description:string;category:string;amount:number;expense_date:string;payment_method:string;supplier_name:string|null};

export default function BusinessOperations({businessId,products,onRefresh,mode}:{businessId:string;products:Product[];onRefresh:()=>Promise<void>;mode:"inventory"|"purchases"}){
  const [movements,setMovements]=useState<Movement[]>([]);
  const [purchases,setPurchases]=useState<Purchase[]>([]);
  const [expenses,setExpenses]=useState<Expense[]>([]);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  const [success,setSuccess]=useState("");
  const [productId,setProductId]=useState("");
  const [adjustment,setAdjustment]=useState("1");
  const [adjustmentReason,setAdjustmentReason]=useState("Korrigjim i stokut");
  const [supplier,setSupplier]=useState("");
  const [invoice,setInvoice]=useState("");
  const [purchaseDate,setPurchaseDate]=useState(new Date().toISOString().slice(0,10));
  const [purchasePayment,setPurchasePayment]=useState("unpaid");
  const [purchaseMethod,setPurchaseMethod]=useState("bank_transfer");
  const [purchaseLines,setPurchaseLines]=useState<Array<{product_id:string;quantity:string;unit_cost:string}>>([]);
  const [expenseDescription,setExpenseDescription]=useState("");
  const [expenseCategory,setExpenseCategory]=useState("Qira");
  const [expenseAmount,setExpenseAmount]=useState("");
  const [expenseDate,setExpenseDate]=useState(new Date().toISOString().slice(0,10));
  const [expenseMethod,setExpenseMethod]=useState("cash");
  const [expenseSupplier,setExpenseSupplier]=useState("");
  const supabase=useMemo(()=>createClient(),[]);

  const refresh=useCallback(async()=>{
    const [m,p,e]=await Promise.all([
      supabase.from("fiskalo_basic_stock_movements").select("id,product_id,movement_type,quantity_delta,reason,created_at").eq("business_id",businessId).order("created_at",{ascending:false}).limit(40),
      supabase.from("fiskalo_basic_purchases").select("id,supplier_name,invoice_number,purchase_date,payment_status,subtotal").eq("business_id",businessId).order("purchase_date",{ascending:false}).limit(30),
      supabase.from("fiskalo_basic_expenses").select("id,description,category,amount,expense_date,payment_method,supplier_name").eq("business_id",businessId).order("expense_date",{ascending:false}).limit(30)
    ]);
    if(m.error)throw m.error;if(p.error)throw p.error;if(e.error)throw e.error;
    setMovements((m.data??[]) as Movement[]);setPurchases((p.data??[]) as Purchase[]);setExpenses((e.data??[]) as Expense[]);
  },[supabase,businessId]);
  useEffect(()=>{void refresh().catch(e=>setError(e instanceof Error?e.message:"Nuk u ngarkuan të dhënat."));},[refresh]);

  async function adjustStock(event:React.FormEvent){
    event.preventDefault();setBusy(true);setError("");setSuccess("");
    try{
      const delta=Number(adjustment);
      if(!productId||!Number.isFinite(delta)||delta===0)throw new Error("Zgjidh produktin dhe shkruaj ndryshim të vlefshëm të stokut.");
      const {error:writeError}=await supabase.from("fiskalo_basic_stock_movements").insert({business_id:businessId,product_id:productId,movement_type:"adjustment",quantity_delta:delta,reason:adjustmentReason.trim(),created_by:(await supabase.auth.getUser()).data.user?.id});
      if(writeError)throw writeError;
      await Promise.all([refresh(),onRefresh()]);setAdjustment("1");setSuccess("Lëvizja u regjistrua dhe stoku u përditësua.");
    }catch(e){setError(e instanceof Error?e.message:"Ndryshimi i stokut dështoi.");}
    finally{setBusy(false);}
  }

  async function createPurchase(event:React.FormEvent){
    event.preventDefault();setBusy(true);setError("");setSuccess("");
    try{
      const valid=purchaseLines.filter(x=>x.product_id&&Number(x.quantity)>0&&Number(x.unit_cost)>=0);
      if(!supplier.trim()||!valid.length)throw new Error("Plotëso furnizuesin dhe së paku një artikull të blerë.");
      const {error:rpcError}=await supabase.rpc("fiskalo_basic_create_purchase",{
        p_business_id:businessId,p_supplier_name:supplier.trim(),p_invoice_number:invoice.trim()||null,
        p_purchase_date:purchaseDate,p_payment_status:purchasePayment,p_payment_method:purchasePayment==="unpaid"?null:purchaseMethod,
        p_notes:null,p_items:valid.map(x=>({product_id:x.product_id,quantity:Number(x.quantity),unit_cost:Number(x.unit_cost)}))
      });
      if(rpcError)throw rpcError;
      setSupplier("");setInvoice("");setPurchaseLines([]);setPurchasePayment("unpaid");
      await Promise.all([refresh(),onRefresh()]);setSuccess("Blerja u ruajt. Stoku u rrit automatikisht dhe lëvizjet u regjistruan.");
    }catch(e){setError(e instanceof Error?e.message:"Blerja nuk u ruajt.");}
    finally{setBusy(false);}
  }

  async function createExpense(event:React.FormEvent){
    event.preventDefault();setBusy(true);setError("");setSuccess("");
    try{
      const amount=Number(expenseAmount);
      if(!expenseDescription.trim()||!Number.isFinite(amount)||amount<=0)throw new Error("Plotëso përshkrimin dhe shumën e shpenzimit.");
      const user=(await supabase.auth.getUser()).data.user;
      const {error:writeError}=await supabase.from("fiskalo_basic_expenses").insert({
        business_id:businessId,description:expenseDescription.trim(),category:expenseCategory,amount,
        expense_date:expenseDate,payment_method:expenseMethod,supplier_name:expenseSupplier.trim()||null,created_by:user?.id
      });
      if(writeError)throw writeError;
      setExpenseDescription("");setExpenseAmount("");setExpenseSupplier("");
      await refresh();setSuccess("Shpenzimi u regjistrua.");
    }catch(e){setError(e instanceof Error?e.message:"Shpenzimi nuk u ruajt.");}
    finally{setBusy(false);}
  }

  const purchaseTotal=purchases.reduce((sum,p)=>sum+Number(p.subtotal),0);
  const expenseTotal=expenses.reduce((sum,e)=>sum+Number(e.amount),0);
  const productName=(id:string)=>products.find(p=>p.id===id)?.name??"Produkt i arkivuar";
  const addPurchaseLine=()=>setPurchaseLines(lines=>[...lines,{product_id:products[0]?.id??"",quantity:"1",unit_cost:"0.00"}]);
  return <section className="panel" style={{marginTop:16}}>
    {error&&<p className="notice" role="alert">{error}</p>}{success&&<p className="notice" role="status">{success}</p>}
    {mode==="inventory"&&<>
      <h2>Inventari</h2><p className="sub">Stoku ndryshon përmes blerjeve dhe lëvizjeve të regjistruara. Historiku është auditues dhe nuk mund të fshihet nga paneli.</p>
      <div className="grid" style={{gridTemplateColumns:"repeat(auto-fit,minmax(180px,1fr))",margin:"14px 0"}}>
        <div className="stat-card"><span className="eyebrow">Produkte aktive</span><strong className="stat">{products.length}</strong></div>
        <div className="stat-card"><span className="eyebrow">Njësi në stok</span><strong className="stat">{products.reduce((n,p)=>n+Number(p.stock),0).toLocaleString("sq-XK")}</strong></div>
        <div className="stat-card"><span className="eyebrow">Lëvizje të regjistruara</span><strong className="stat">{movements.length}</strong></div>
      </div>
      <h3>Korrigjo stokun</h3><form onSubmit={adjustStock} className="grid" style={{gridTemplateColumns:"repeat(auto-fit,minmax(180px,1fr))",alignItems:"end"}}>
        <div className="field"><label>Produkti</label><select required value={productId} onChange={e=>setProductId(e.target.value)}><option value="">Zgjidh produktin</option>{products.map(p=><option key={p.id} value={p.id}>{p.name} · stok {p.stock}</option>)}</select></div>
        <div className="field"><label>Ndryshimi (+/-)</label><input required type="number" step="0.001" value={adjustment} onChange={e=>setAdjustment(e.target.value)} placeholder="p.sh. 5 ose -2"/></div>
        <div className="field"><label>Arsyeja</label><input required minLength={2} maxLength={240} value={adjustmentReason} onChange={e=>setAdjustmentReason(e.target.value)}/></div>
        <button className="btn" disabled={busy||!products.length}>Regjistro lëvizjen</button>
      </form>
      <h3 style={{marginTop:24}}>Gjendja e stokut</h3><div style={{overflowX:"auto"}}><table style={{width:"100%",borderCollapse:"collapse",fontSize:13}}><thead><tr><th style={{textAlign:"left",padding:9}}>Produkti</th><th style={{textAlign:"right",padding:9}}>Stoku</th><th style={{textAlign:"right",padding:9}}>Çmimi</th></tr></thead><tbody>{products.map(p=><tr key={p.id} style={{borderTop:"1px solid var(--line)"}}><td style={{padding:9}}>{p.name}</td><td style={{padding:9,textAlign:"right"}}>{Number(p.stock).toLocaleString("sq-XK")}</td><td style={{padding:9,textAlign:"right"}}>€{Number(p.price).toFixed(2)}</td></tr>)}</tbody></table></div>
      <h3 style={{marginTop:24}}>Historiku i lëvizjeve</h3>{movements.length===0?<p className="sub">Nuk ka ende lëvizje të inventarit. Blerjet dhe korrigjimet do të shfaqen këtu.</p>:movements.map(m=><div key={m.id} className="row" style={{justifyContent:"space-between",padding:"10px 0",borderTop:"1px solid var(--line)",gap:12}}><div><strong>{productName(m.product_id)}</strong><div className="sub" style={{fontSize:12}}>{m.reason} · {new Date(m.created_at).toLocaleString("sq-XK")}</div></div><strong style={{color:Number(m.quantity_delta)>0?"#16834a":"#b33b32"}}>{Number(m.quantity_delta)>0?"+":""}{Number(m.quantity_delta).toLocaleString("sq-XK")}</strong></div>)}
    </>}
    {mode==="purchases"&&<>
      <h2>Blerjet &amp; shpenzimet</h2><p className="sub">Regjistro faturat e furnizuesve, hyrjen e artikujve në stok dhe shpenzimet operative. Blerjet përditësojnë inventarin automatikisht.</p>
      <div className="grid" style={{gridTemplateColumns:"repeat(auto-fit,minmax(170px,1fr))",margin:"14px 0"}}>
        <div className="stat-card"><span className="eyebrow">Blerjet e listuara</span><strong className="stat">€{purchaseTotal.toFixed(2)}</strong></div>
        <div className="stat-card"><span className="eyebrow">Shpenzimet e listuara</span><strong className="stat">€{expenseTotal.toFixed(2)}</strong></div>
      </div>
      <div className="grid" style={{gridTemplateColumns:"repeat(auto-fit,minmax(280px,1fr))",alignItems:"start"}}>
        <section><h3>Regjistro blerje</h3><form onSubmit={createPurchase}>
          <div className="field"><label>Furnizuesi</label><input required minLength={2} value={supplier} onChange={e=>setSupplier(e.target.value)} placeholder="Emri i furnizuesit"/></div>
          <div className="field"><label>Numri i faturës</label><input value={invoice} onChange={e=>setInvoice(e.target.value)} placeholder="Opsional"/></div>
          <div className="field"><label>Data e blerjes</label><input type="date" required value={purchaseDate} onChange={e=>setPurchaseDate(e.target.value)}/></div>
          <div className="field"><label>Statusi i pagesës</label><select value={purchasePayment} onChange={e=>setPurchasePayment(e.target.value)}><option value="unpaid">Pa paguar</option><option value="partial">Pjesërisht e paguar</option><option value="paid">Paguar</option></select></div>
          {purchasePayment!=="unpaid"&&<div className="field"><label>Mënyra e pagesës</label><select value={purchaseMethod} onChange={e=>setPurchaseMethod(e.target.value)}><option value="cash">Kesh</option><option value="card">Kartelë</option><option value="bank_transfer">Transfer bankar</option></select></div>}
          <h4>Artikujt e blerë</h4>{purchaseLines.map((line,index)=><div key={index} className="grid" style={{gridTemplateColumns:"minmax(120px,1.5fr) minmax(70px,.7fr) minmax(85px,.8fr)",gap:7}}>
            <div className="field"><label>Produkt</label><select required value={line.product_id} onChange={e=>setPurchaseLines(rows=>rows.map((r,i)=>i===index?{...r,product_id:e.target.value}:r))}><option value="">Zgjidh</option>{products.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></div>
            <div className="field"><label>Sasia</label><input required type="number" min="0.001" step="0.001" value={line.quantity} onChange={e=>setPurchaseLines(rows=>rows.map((r,i)=>i===index?{...r,quantity:e.target.value}:r))}/></div>
            <div className="field"><label>Kosto/njësi €</label><input required type="number" min="0" step="0.0001" value={line.unit_cost} onChange={e=>setPurchaseLines(rows=>rows.map((r,i)=>i===index?{...r,unit_cost:e.target.value}:r))}/></div>
          </div>)}
          <div className="row" style={{justifyContent:"space-between",margin:"10px 0"}}><button className="btn secondary" type="button" disabled={!products.length} onClick={addPurchaseLine}>+ Shto artikull</button><strong>Totali: €{purchaseLines.reduce((sum,l)=>sum+Number(l.quantity||0)*Number(l.unit_cost||0),0).toFixed(2)}</strong></div>
          <button className="btn" disabled={busy||!purchaseLines.length}>Ruaj blerjen dhe shto stokun</button>
        </form></section>
        <section><h3>Regjistro shpenzim</h3><form onSubmit={createExpense}>
          <div className="field"><label>Përshkrimi</label><input required minLength={2} value={expenseDescription} onChange={e=>setExpenseDescription(e.target.value)} placeholder="p.sh. Qira e lokalit"/></div>
          <div className="field"><label>Kategoria</label><select value={expenseCategory} onChange={e=>setExpenseCategory(e.target.value)}>{["Qira","Rrymë","Ujë","Internet","Transport","Mirëmbajtje","Paga","Marketing","Tjetër"].map(c=><option key={c}>{c}</option>)}</select></div>
          <div className="field"><label>Shuma (€)</label><input required type="number" min="0.01" step="0.01" value={expenseAmount} onChange={e=>setExpenseAmount(e.target.value)}/></div>
          <div className="field"><label>Data</label><input type="date" required value={expenseDate} onChange={e=>setExpenseDate(e.target.value)}/></div>
          <div className="field"><label>Mënyra e pagesës</label><select value={expenseMethod} onChange={e=>setExpenseMethod(e.target.value)}><option value="cash">Kesh</option><option value="card">Kartelë</option><option value="bank_transfer">Transfer bankar</option></select></div>
          <div className="field"><label>Furnizuesi / përfituesi</label><input value={expenseSupplier} onChange={e=>setExpenseSupplier(e.target.value)}/></div>
          <button className="btn" disabled={busy}>Ruaj shpenzimin</button>
        </form></section>
      </div>
      <h3 style={{marginTop:24}}>Blerjet e fundit</h3>{purchases.length===0?<p className="sub">Nuk ka blerje të regjistruara.</p>:purchases.map(p=><div key={p.id} className="row" style={{justifyContent:"space-between",padding:"10px 0",borderTop:"1px solid var(--line)"}}><div><strong>{p.supplier_name}</strong><div className="sub" style={{fontSize:12}}>{p.invoice_number||"Pa numër fature"} · {p.purchase_date} · {p.payment_status==="paid"?"Paguar":p.payment_status==="partial"?"Pjesërisht":"Pa paguar"}</div></div><strong>€{Number(p.subtotal).toFixed(2)}</strong></div>)}
      <h3 style={{marginTop:24}}>Shpenzimet e fundit</h3>{expenses.length===0?<p className="sub">Nuk ka shpenzime të regjistruara.</p>:expenses.map(e=><div key={e.id} className="row" style={{justifyContent:"space-between",padding:"10px 0",borderTop:"1px solid var(--line)"}}><div><strong>{e.description}</strong><div className="sub" style={{fontSize:12}}>{e.category} · {e.expense_date} · {e.payment_method==="cash"?"Kesh":e.payment_method==="card"?"Kartelë":"Transfer bankar"}</div></div><strong>€{Number(e.amount).toFixed(2)}</strong></div>)}
    </>}
  </section>;
}
