"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { User } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";
import { pairLocalAgent, getLocalAgentStatus, verifyLocalTestPos, issueLocalTestCertificate, type AgentStatus } from "@/lib/pos/local-agent";
import { pairLocalAgent, getLocalAgentStatus, verifyLocalTestPos, issueLocalTestCertificate, submitLocalTestCoupon, type AgentStatus, type AtkVerification } from "@/lib/pos/local-agent";

type Business={id:string;name:string;nui:string};
type Product={id:string;name:string;price:number;stock:number;vat_rate:number;atk_unit_code:string;atk_item_category_code:string;atk_vat_code:string};
type Pos={id:string;label:string;location:string;branch_id:number;pos_id:number;fiscalization_number:string;application_id:string|null;verification_no:string|null;verified_business_name:string|null;certificate_status:string};
type CartLine={product:Product;quantity:number};
type Tab="pos"|"products"|"atk";

export default function Home(){
  const [user,setUser]=useState<User|null>(null);
  const [configured,setConfigured]=useState(true);
  const [loading,setLoading]=useState(true);
  const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState("");
  const [business,setBusiness]=useState<Business|null>(null);
  const [products,setProducts]=useState<Product[]>([]);
  const [positions,setPositions]=useState<Pos[]>([]);
  const [tab,setTab]=useState<Tab>("pos");
  const [businessName,setBusinessName]=useState("");
  const [nui,setNui]=useState("");
  const [productName,setProductName]=useState("");
  const [productPrice,setProductPrice]=useState("1.00");
  const [productStock,setProductStock]=useState("0");
  const [vatRate,setVatRate]=useState("18");
  const [vatCode,setVatCode]=useState("E");
  const [unitCode,setUnitCode]=useState("");
  const [categoryCode,setCategoryCode]=useState("");
  const [posLabel,setPosLabel]=useState("Arka 1");
  const [posLocation,setPosLocation]=useState("");

  const [branchId,setBranchId]=useState("1");
  const [posId,setPosId]=useState("1");
  const [fiscalizationNumber,setFiscalizationNumber]=useState("");
  const [applicationId,setApplicationId]=useState("");
  const [agentPairingCode,setAgentPairingCode]=useState("");
  const [agentToken,setAgentToken]=useState("");
  const [agentStatus,setAgentStatus]=useState<AgentStatus|null>(null);
  const [verificationCode,setVerificationCode]=useState("");
  const [verifiedBusinessName,setVerifiedBusinessName]=useState("");
  const [selectedPos,setSelectedPos]=useState("");
  const [agentToken,setAgentToken]=useState("");
  const [pairCode,setPairCode]=useState("");
  const [agentStatus,setAgentStatus]=useState<AgentStatus|null>(null);
  const [verification,setVerification]=useState<AtkVerification|null>(null);
  const [cart,setCart]=useState<Record<string,CartLine>>({});
  const [payment,setPayment]=useState("cash");

  const supabase=useMemo(()=>{try{return createClient()}catch{return null}},[]);
  const loadWorkspace=useCallback(async(uid:string)=>{
    if(!supabase)return;
    const {data:member,error:memberError}=await supabase.from("fiskalo_basic_members").select("business_id,role").eq("user_id",uid).limit(1).maybeSingle();
    if(memberError)throw memberError;
    if(!member){setBusiness(null);setProducts([]);setPositions([]);return;}
    const {data:biz,error:bizError}=await supabase.from("fiskalo_basic_businesses").select("id,name,nui").eq("id",member.business_id).single();
    if(bizError)throw bizError;
    setBusiness(biz);
    const [{data:prods,error:productError},{data:poses,error:posError}]=await Promise.all([
      supabase.from("fiskalo_basic_products").select("*").eq("business_id",biz.id).eq("active",true).order("name"),
      supabase.from("fiskalo_basic_pos").select("*").eq("business_id",biz.id).order("created_at")
    ]);
    if(productError)throw productError;if(posError)throw posError;
    setProducts(prods??[]);setPositions(poses??[]);
    if(!selectedPos&&poses?.length)setSelectedPos(poses[0].id);
  },[supabase,selectedPos]);

  useEffect(()=>{
    if(!supabase){setConfigured(false);setLoading(false);return;}
    supabase.auth.getUser().then(async({data,error})=>{
      if(error){setMessage(error.message);setLoading(false);return;}
      setUser(data.user);
      if(data.user){try{await loadWorkspace(data.user.id)}catch(e){setMessage(e instanceof Error?e.message:"Nuk u ngarkua hapësira.")}}
      setLoading(false);
    });
    const {data:{subscription}}=supabase.auth.onAuthStateChange((_event,session)=>{setUser(session?.user??null);if(session?.user){void loadWorkspace(session.user.id).catch(e=>setMessage(e instanceof Error?e.message:"Nuk u ngarkua hapësira."));}else{setBusiness(null);setProducts([]);setPositions([]);}});
    return()=>subscription.unsubscribe();
  },[supabase,loadWorkspace]);

  async function signIn(e:React.FormEvent){e.preventDefault();setBusy(true);setMessage("");try{const {error}=await supabase!.auth.signInWithPassword({email:(document.getElementById("email") as HTMLInputElement).value,password:(document.getElementById("password") as HTMLInputElement).value});if(error)throw error;}catch(e){setMessage(e instanceof Error?e.message:"Hyrja dështoi.");}finally{setBusy(false);}}
  async function createBusiness(e:React.FormEvent){e.preventDefault();setBusy(true);setMessage("");try{const {data,error}=await supabase!.rpc("fiskalo_basic_create_business",{p_name:businessName,p_nui:nui});if(error)throw error;await loadWorkspace(user!.id);setMessage("Biznesi u krijua.");}catch(e){setMessage(e instanceof Error?e.message:"Biznesi nuk u krijua. Kontrollo nëse migrimet janë aplikuar.");}finally{setBusy(false);}}
  async function addProduct(e:React.FormEvent){e.preventDefault();if(!business)return;setBusy(true);setMessage("");try{const {error}=await supabase!.from("fiskalo_basic_products").insert({business_id:business.id,name:productName,price:Number(productPrice),stock:Number(productStock),vat_rate:Number(vatRate),atk_vat_code:vatCode,atk_unit_code:unitCode,atk_item_category_code:categoryCode});if(error)throw error;setProductName("");await loadWorkspace(user!.id);setMessage("Artikulli u ruajt.");}catch(e){setMessage(e instanceof Error?e.message:"Artikulli nuk u ruajt.");}finally{setBusy(false);}}
  async function pairAgent(){setBusy(true);setMessage("");try{const result=await pairLocalAgent(pairCode.trim());sessionStorage.setItem("fiskalo.posAgentToken",result.sessionToken);setAgentToken(result.sessionToken);setPairCode("");setAgentStatus(await getLocalAgentStatus(result.sessionToken));setMessage("POS Agent u lidh me këtë shfletues.");}catch(e){setMessage(e instanceof Error?e.message:"Lidhja me POS Agent dështoi.");}finally{setBusy(false);}}
  async function verifyAtkPos(){const pos=positions.find(p=>p.id===selectedPos);if(!pos||!business||!agentToken){setMessage("Lidh POS Agent dhe zgjidh pajisjen.");return;}if(!pos.application_id){setMessage("Vendos Application ID TEST për këtë POS.");return;}setBusy(true);setMessage("");try{const result=await verifyLocalTestPos(agentToken,{nui:Number(business.nui),fiscalizationNumber:pos.fiscalization_number,posId:pos.pos_id,branchId:pos.branch_id,applicationId:Number(pos.application_id)});setVerification(result);const {error}=await supabase!.from("fiskalo_basic_pos").update({verification_no:result.verificationCode,verified_business_name:result.businessName,certificate_status:"verified"}).eq("id",pos.id);if(error)throw error;await loadWorkspace(user!.id);setMessage("ATK TEST verifikoi POS-in. Tani mund të kërkosh certifikatën.");}catch(e){setMessage(e instanceof Error?e.message:"Verifikimi ATK dështoi.");}finally{setBusy(false);}}
  async function requestAtkCertificate(){const pos=positions.find(p=>p.id===selectedPos);if(!pos||!business||!agentToken||!pos.application_id||!pos.verification_no){setMessage("Kryej fillimisht verifikimin ATK për këtë POS.");return;}setBusy(true);setMessage("");try{const result=await issueLocalTestCertificate(agentToken,{businessName:pos.verified_business_name||verification?.businessName||business.name,businessNui:Number(business.nui),branchId:pos.branch_id,verificationCode:pos.verification_no,posId:pos.pos_id,applicationId:Number(pos.application_id)});if(!result.certificateStatus.includes("RECEIVED_AND_KEY_MATCHED"))throw new Error("ATK certificate was not confirmed as matching the local POS key.");const {error}=await supabase!.from("fiskalo_basic_pos").update({certificate_status:"certificate_issued"}).eq("id",pos.id);if(error)throw error;setAgentStatus(await getLocalAgentStatus(agentToken));await loadWorkspace(user!.id);setMessage("Certifikata ATK TEST u ruajt në POS dhe çelësi publik u përputh.");}catch(e){setMessage(e instanceof Error?e.message:"Lëshimi i certifikatës dështoi.");}finally{setBusy(false);}}
  async function pairAgent(){setBusy(true);setMessage("");try{const result=await pairLocalAgent(agentPairingCode.trim());setAgentToken(result.sessionToken);setAgentPairingCode("");const status=await getLocalAgentStatus(result.sessionToken);setAgentStatus(status);setMessage("POS Agent u lidh me sukses.");}catch(e){setMessage(e instanceof Error?e.message:"Lidhja me POS Agent dështoi.");}finally{setBusy(false);}}
  async function refreshAgent(){if(!agentToken)return;setBusy(true);try{setAgentStatus(await getLocalAgentStatus(agentToken));setMessage("Statusi i POS Agent u rifreskua.");}catch(e){setMessage(e instanceof Error?e.message:"POS Agent nuk përgjigjet.");}finally{setBusy(false);}}
  async function verifySelectedPos(){const pos=positions.find(p=>p.id===selectedPos);if(!pos||!agentToken)return;setBusy(true);setMessage("");try{const result=await verifyLocalTestPos(agentToken,{nui:Number(business!.nui),fiscalizationNumber:pos.fiscalization_number,posId:pos.pos_id,branchId:pos.branch_id,applicationId:pos.application_id??""});setVerificationCode(result.verificationCode);setVerifiedBusinessName(result.businessName);setMessage("ATK TEST e verifikoi POS-in. Hapi tjetër: nënshkrimi i CSR-së në këtë pajisje.");}catch(e){setMessage(e instanceof Error?e.message:"Verifikimi ATK dështoi.");}finally{setBusy(false);}}
  async function issueSelectedCertificate(){const pos=positions.find(p=>p.id===selectedPos);if(!pos||!agentToken||!verificationCode)return;setBusy(true);setMessage("");try{const result=await issueLocalTestCertificate(agentToken,{businessName:verifiedBusinessName||business!.name,businessNui:Number(business!.nui),branchId:pos.branch_id,verificationCode,posId:pos.pos_id,applicationId:pos.application_id??""});const {error}=await supabase!.from("fiskalo_basic_pos").update({certificate_status:"certificate_issued",verified_business_name:verifiedBusinessName||business!.name}).eq("id",pos.id).eq("business_id",business!.id);if(error)throw error;await loadWorkspace(user!.id);setMessage("Certifikata TEST u ruajt në POS Agent. Verifiko statusin para kuponit të parë.");}catch(e){setMessage(e instanceof Error?e.message:"Lëshimi i certifikatës dështoi.");}finally{setBusy(false);}}
  async function addPos(e:React.FormEvent){e.preventDefault();if(!business)return;setBusy(true);setMessage("");try{const {error}=await supabase!.from("fiskalo_basic_pos").insert({business_id:business.id,label:posLabel,location:posLocation,branch_id:Number(branchId),pos_id:Number(posId),fiscalization_number:fiscalizationNumber,application_id:applicationId||null});if(error)throw error;await loadWorkspace(user!.id);setMessage("POS-i u regjistrua në Fiskalo. Kjo nuk e verifikon automatikisht te ATK.");}catch(e){setMessage(e instanceof Error?e.message:"POS-i nuk u ruajt.");}finally{setBusy(false);}}
  function changeCart(product:Product,delta:number){setCart(current=>{const next={...current};const qty=(next[product.id]?.quantity??0)+delta;if(qty<=0)delete next[product.id];else next[product.id]={product,quantity:qty};return next;});}
  const cartLines=Object.values(cart);
  const total=cartLines.reduce((sum,line)=>sum+line.product.price*line.quantity*(1+line.product.vat_rate/100),0);
  async function completeSale(){
    if(!business||!selectedPos||!cartLines.length)return;
    const pos=positions.find(p=>p.id===selectedPos);
    if(!pos)return;
    setBusy(true);setMessage("");
    try{
      const {data:saleId,error}=await supabase!.rpc("fiskalo_basic_create_sale",{p_business_id:business.id,p_pos_id:selectedPos,p_payment_method:payment,p_lines:cartLines.map(x=>({product_id:x.product.id,quantity:x.quantity}))});
      if(error)throw error;
      setCart({});
      const [{data:sale,error:saleError},{data:lines,error:linesError}]=await Promise.all([
        supabase!.from("fiskalo_basic_sales").select("*").eq("id",saleId).single(),
        supabase!.from("fiskalo_basic_sale_items").select("*").eq("sale_id",saleId).order("id")
      ]);
      if(saleError)throw saleError;if(linesError)throw linesError;
      if(!agentToken||pos.certificate_status!=="certificate_issued"||!pos.verification_no||!pos.application_id){
        await loadWorkspace(user!.id);
        setMessage("Shitja u ruajt si e paguar, por ky POS nuk ka certifikatë TEST aktive ose POS Agent të lidhur. Shitja nuk është fiskalizuar.");
        return;
      }
      try{
        const cents=(value:number)=>Math.round(Number(value)*100);
        const grouped=new Map<string,{taxRate:string;base:number;tax:number}>();
        for(const line of lines??[]){
          const key=line.atk_vat_code;
          const group=grouped.get(key)??{taxRate:key,base:0,tax:0};
          group.base+=cents(line.line_net);group.tax+=cents(line.line_vat);grouped.set(key,group);
        }
        const paymentType=payment==="cash"?1:payment==="card"?2:6;
        const coupon={
          businessId:Number(business.nui),couponId:Number(sale.coupon_id),branchId:pos.branch_id,
          location:pos.location,operatorId:user!.id,posId:pos.pos_id,applicationId:Number(pos.application_id),
          verificationNo:pos.verification_no,type:1,unixTime:Math.floor(new Date(sale.created_at).getTime()/1000),
          items:(lines??[]).map(line=>({name:line.description,unitPriceEuro:Number(line.unit_price),unit:line.atk_unit_code,quantity:Number(line.quantity),lineTotalCents:cents(line.line_total),taxRate:line.atk_vat_code,itemType:line.atk_item_category_code})),
          payments:[{type:paymentType,amountCents:cents(sale.total)}],
          totalCents:cents(sale.total),taxGroups:Array.from(grouped.values()).map(g=>({taxRate:g.taxRate,totalForTaxCents:g.base,totalTaxCents:g.tax})),
          totalTaxCents:cents(sale.vat_total),totalNoTaxCents:cents(sale.subtotal),totalDiscountCents:0
        };
        const idempotencyKey=business.nui+":"+pos.branch_id+":"+pos.pos_id+":"+sale.coupon_id;
        const accepted=await submitLocalTestCoupon(agentToken,idempotencyKey,coupon);
        if(accepted.status!=="accepted"||!(/^[1-9][0-9]{0,19}$/.test(accepted.transactionId)))throw new Error("ATK did not return a valid transaction_id.");
        const {error:recordError}=await supabase!.rpc("fiskalo_basic_record_atk_sale",{
          p_business_id:business.id,p_sale_id:saleId,p_coupon_id:sale.coupon_id,p_idempotency_key:idempotencyKey,
          p_signed_payload:accepted.detailsBase64,p_signature:accepted.signatureBase64,
          p_atk_transaction_id:accepted.transactionId,p_atk_response:accepted
        });
        if(recordError)throw new Error("ATK returned transaction_id "+accepted.transactionId+", but Fiskalo could not persist the accepted record: "+recordError.message+". Do not resubmit; reconcile this coupon.");
        await loadWorkspace(user!.id);
        setMessage("ATK TEST e pranoi kuponin. Transaction ID: "+accepted.transactionId);
      }catch(submitError){
        await loadWorkspace(user!.id);
        setMessage(submitError instanceof Error?"Shitja u ruajt, por fiskalizimi nuk u konfirmua. Kontrollo radhën e POS Agent dhe statusin në ATK para çdo riprovimi. "+submitError.message:"Shitja u ruajt, por rezultati i ATK është i paqartë. Mos e ridërgo pa reconciliim.");
      }
    }catch(e){setMessage(e instanceof Error?e.message:"Shitja dështoi.");}
    finally{setBusy(false);}
  }

  if(!configured)return <main className="shell"><header className="topbar"><div className="brand">fiskalo<span>.</span></div><span className="eyebrow">Basic ATK MVP</span></header><section className="panel"><h1>Konfigurimi kërkohet</h1><p className="sub">Vendos NEXT_PUBLIC_SUPABASE_URL dhe NEXT_PUBLIC_SUPABASE_ANON_KEY në mjedisin e aplikacionit.</p></section></main>;
  if(loading)return <main className="shell"><div className="brand">fiskalo<span>.</span></div><p className="sub">Duke ngarkuar…</p></main>;
  if(!user)return <main className="shell"><header className="topbar"><div className="brand">fiskalo<span>.</span></div><span className="eyebrow">Fiscal POS · Kosovo</span></header><section className="panel" style={{maxWidth:460,margin:"8vh auto"}}><div className="eyebrow">Hyr në llogari</div><h1>Mirë se u ktheve.</h1><p className="sub">Hyr si pronar ose arkëtar.</p><form onSubmit={signIn}><div className="field"><label>Email</label><input id="email" type="email" required autoComplete="username"/></div><div className="field"><label>Fjalëkalimi</label><input id="password" type="password" required autoComplete="current-password"/></div>{message&&<p className="notice">{message}</p>}<button className="btn" disabled={busy} style={{width:"100%"}}>{busy?"Duke hyrë…":"Hyr"}</button></form></section></main>;
  if(!business)return <main className="shell"><header className="topbar"><div className="brand">fiskalo<span>.</span></div><button className="btn secondary" onClick={()=>supabase!.auth.signOut()}>Dil</button></header><section className="panel" style={{maxWidth:560,margin:"5vh auto"}}><div className="eyebrow">Konfigurimi fillestar</div><h1>Regjistro biznesin</h1><p className="sub">Krijo hapësirën e biznesit. NUI duhet të jetë numri real i biznesit.</p><form onSubmit={createBusiness}><div className="field"><label>Emri i biznesit</label><input required value={businessName} onChange={e=>setBusinessName(e.target.value)}/></div><div className="field"><label>NUI (9 shifra)</label><input required inputMode="numeric" pattern="[0-9]{9}" value={nui} onChange={e=>setNui(e.target.value)}/></div>{message&&<p className="notice">{message}</p>}<button className="btn" disabled={busy}>{busy?"Duke ruajtur…":"Krijo biznesin"}</button></form></section></main>;

  return <main className="shell">
    <header className="topbar"><div><div className="brand">fiskalo<span>.</span></div><span className="eyebrow">{business.name} · NUI {business.nui}</span></div><div className="row"><span className="sub">{user.email}</span><button className="btn secondary" onClick={()=>supabase!.auth.signOut()}>Dil</button></div></header>
    <div className="eyebrow">Paneli i biznesit</div><h1>Arka dhe fiskalizimi.</h1><p className="sub">Version i thjeshtuar: produkte, POS dhe shitje. Dërgimi fiskal aktivizohet pasi të përfundojë integrimi dhe testimi ATK.</p>
    <div className="row" style={{margin:"22px 0"}}><button className={tab==="pos"?"btn":"btn secondary"} onClick={()=>setTab("pos")}>Arka / POS</button><button className={tab==="products"?"btn":"btn secondary"} onClick={()=>setTab("products")}>Artikujt</button><button className={tab==="atk"?"btn":"btn secondary"} onClick={()=>setTab("atk")}>ATK / POS</button></div>
    {message&&<p className="notice" role="status">{message}</p>}
    {tab==="products"&&<div className="grid" style={{gridTemplateColumns:"minmax(260px,1fr) minmax(280px,1.4fr)"}}><section className="panel"><h2>Artikull i ri</h2><form onSubmit={addProduct}><div className="field"><label>Emri</label><input required value={productName} onChange={e=>setProductName(e.target.value)}/></div><div className="field"><label>Çmimi pa TVSH (€)</label><input type="number" min="0" step="0.0001" required value={productPrice} onChange={e=>setProductPrice(e.target.value)}/></div><div className="field"><label>Stoku</label><input type="number" min="0" step="0.001" value={productStock} onChange={e=>setProductStock(e.target.value)}/></div><div className="field"><label>Norma TVSH</label><select value={vatRate} onChange={e=>{setVatRate(e.target.value);setVatCode(e.target.value==="18"?"E":e.target.value==="8"?"D":"A")}}><option value="18">18%</option><option value="8">8%</option><option value="0">0%</option></select></div><div className="field"><label>Kodi ATK – njësia</label><input required value={unitCode} onChange={e=>setUnitCode(e.target.value)} placeholder="Kodi zyrtar ATK"/></div><div className="field"><label>Kodi ATK – kategoria</label><input required value={categoryCode} onChange={e=>setCategoryCode(e.target.value)} placeholder="Kodi zyrtar ATK"/></div><div className="field"><label>Kodi ATK – TVSH</label><input required maxLength={1} value={vatCode} onChange={e=>setVatCode(e.target.value.toUpperCase())}/></div><button className="btn" disabled={busy}>Ruaj artikullin</button></form></section><section className="panel"><h2>Katalogu</h2>{products.length===0?<p className="sub">Nuk ka artikuj ende.</p>:products.map(p=><div key={p.id} className="row" style={{justifyContent:"space-between",padding:"12px 0",borderBottom:"1px solid var(--line)"}}><div><strong>{p.name}</strong><div className="sub" style={{fontSize:12}}>Stoku {p.stock} · TVSH {p.vat_rate}%</div></div><strong>€{Number(p.price).toFixed(2)}</strong></div>)}</section></div>}
    {tab==="atk"&&<div className="grid" style={{gridTemplateColumns:"minmax(260px,1fr) minmax(280px,1.4fr)"}}><section className="panel"><h2>Regjistro POS</h2><form onSubmit={addPos}><div className="field"><label>Emërtimi</label><input required value={posLabel} onChange={e=>setPosLabel(e.target.value)}/></div><div className="field"><label>Lokacioni i biznesit</label><input required value={posLocation} onChange={e=>setPosLocation(e.target.value)} placeholder="Adresa e njësisë së regjistruar"/></div><div className="field"><label>Adresa / lokacioni i POS-it</label><input required value={posLocation} onChange={e=>setPosLocation(e.target.value)} placeholder="Rruga, qyteti"/></div><div className="field"><label>Numri i njësisë / Branch ID</label><input type="number" min="1" required value={branchId} onChange={e=>setBranchId(e.target.value)}/></div><div className="field"><label>Numri POS</label><input type="number" min="1" required value={posId} onChange={e=>setPosId(e.target.value)}/></div><div className="field"><label>Numri i fiskalizimit TEST</label><input required value={fiscalizationNumber} onChange={e=>setFiscalizationNumber(e.target.value)}/></div><div className="field"><label>Application ID TEST</label><input required value={applicationId} onChange={e=>setApplicationId(e.target.value)}/></div><button className="btn" disabled={busy}>Ruaj POS-in</button></form></section><section className="panel"><h2>POS Agent lokal</h2><p className="sub">Nise Fiskalo POS Agent në pajisjen e arkës dhe kopjo kodin njëpërdorimësh që shfaqet në dritaren e tij.</p><div className="field"><label>Kodi i lidhjes</label><input value={agentPairingCode} onChange={e=>setAgentPairingCode(e.target.value)} autoComplete="off" placeholder="Kodi nga POS Agent"/></div><div className="row"><button className="btn" disabled={busy||!agentPairingCode.trim()} onClick={pairAgent}>Lidhe pajisjen</button><button className="btn secondary" disabled={busy||!agentToken} onClick={refreshAgent}>Rifresko statusin</button></div>{agentStatus&&<p className="notice">Agent {agentStatus.version} · {agentStatus.paired?"I lidhur":"Pa lidhje"} · {agentStatus.windowsKeyStoreAvailable?"Windows keystore gati":"Windows keystore jo i disponueshëm"}</p>}<div className="field" style={{marginTop:14}}><label>POS për verifikim</label><select value={selectedPos} onChange={e=>setSelectedPos(e.target.value)}><option value="">Zgjidh POS</option>{positions.map(p=><option key={p.id} value={p.id}>{p.label} · POS {p.pos_id}</option>)}</select></div><button className="btn secondary" disabled={busy||!agentToken||!selectedPos} onClick={verifySelectedPos}>Verifiko POS-in në ATK TEST</button>{verificationCode&&<><p className="notice">Kodi i verifikimit ATK: <strong>{verificationCode}</strong></p><button className="btn" disabled={busy} onClick={issueSelectedCertificate}>Gjenero CSR dhe merr certifikatën TEST</button></>}</section><section className="panel"><h2>Pajisjet</h2>{positions.length===0?<p className="sub">Nuk është regjistruar asnjë POS.</p>:positions.map(p=><div key={p.id} style={{padding:"12px 0",borderBottom:"1px solid var(--line)"}}><div className="row" style={{justifyContent:"space-between"}}><strong>{p.label}</strong><span className="status">{p.certificate_status}</span></div><p className="sub" style={{fontSize:12,margin:"5px 0"}}>Njësia {p.branch_id} · POS {p.pos_id} · TEST {p.fiscalization_number}</p></div>)}</section>
      <section className="panel"><h2>Lidhja me POS Agent (Windows)</h2><p className="sub">Nise Fiskalo POS Agent në kompjuterin e arkës. Përdor kodin njëpërdorimësh që shfaqet në dritaren e tij.</p><div className="row"><input style={{flex:1,minWidth:160}} placeholder="Kodi i çiftimit" value={pairCode} onChange={e=>setPairCode(e.target.value)}/><button className="btn" disabled={busy||!pairCode.trim()} onClick={pairAgent}>Lidh pajisjen</button></div>{agentStatus&&<p className="sub" style={{marginTop:12}}>Agent {agentStatus.version} · Windows keystore: {agentStatus.windowsKeyStoreAvailable?"Gati":"Nuk u zbulua"} · Certifikata TEST: {agentStatus.testCertificateInstalled?"Po":"Jo"}</p>}<div className="field"><label>POS për verifikim</label><select value={selectedPos} onChange={e=>setSelectedPos(e.target.value)}><option value="">Zgjidh POS</option>{positions.map(p=><option key={p.id} value={p.id}>{p.label} · POS {p.pos_id}</option>)}</select></div><div className="row"><button className="btn secondary" disabled={busy||!agentToken||!selectedPos} onClick={verifyAtkPos}>Verifiko me ATK TEST</button><button className="btn" disabled={busy||!agentToken||!positions.find(p=>p.id===selectedPos)?.verification_no} onClick={requestAtkCertificate}>Merr certifikatën TEST</button></div>{verification&&<p className="notice" style={{marginTop:12}}>Biznesi i verifikuar: {verification.businessName}. Kodi i verifikimit u ruajt në konfigurimin e POS-it.</p>}<p className="footer">Çelësi privat dhe certifikata ruhen në kompjuterin Windows. Fiskalo nuk i ngarkon çelësat privatë në cloud.</p></section></div>}
    {tab==="pos"&&<div className="grid" style={{gridTemplateColumns:"minmax(280px,1.5fr) minmax(260px,1fr)"}}><section className="panel"><div className="row" style={{justifyContent:"space-between"}}><h2>Artikujt</h2><span className="eyebrow">{products.length} artikuj</span></div>{products.length===0?<p className="sub">Shto artikujt fillimisht te skeda Artikujt.</p>:<div className="grid" style={{gridTemplateColumns:"repeat(auto-fit,minmax(150px,1fr))"}}>{products.map(p=><button key={p.id} className="tile" style={{minHeight:110}} onClick={()=>changeCart(p,1)}><span className="icon">+</span><strong>{p.name}</strong><p>€{(Number(p.price)*(1+Number(p.vat_rate)/100)).toFixed(2)} · stok {p.stock}</p></button>)}</div>}</section><section className="panel"><h2>Shporta</h2>{cartLines.map(line=><div key={line.product.id} className="row" style={{justifyContent:"space-between",padding:"9px 0",borderBottom:"1px solid var(--line)"}}><div><strong>{line.product.name}</strong><div className="sub" style={{fontSize:12}}>Sasia: {line.quantity}</div></div><div className="row"><button className="btn secondary" onClick={()=>changeCart(line.product,-1)}>-</button><button className="btn secondary" onClick={()=>changeCart(line.product,1)}>+</button></div></div>)}<div className="field"><label>POS</label><select value={selectedPos} onChange={e=>setSelectedPos(e.target.value)}><option value="">Zgjidh POS</option>{positions.map(p=><option key={p.id} value={p.id}>{p.label}</option>)}</select></div><div className="field"><label>Pagesa</label><select value={payment} onChange={e=>setPayment(e.target.value)}><option value="cash">Cash</option><option value="card">Kartelë</option><option value="bank_transfer">Transfer bankar</option></select></div><div className="row" style={{justifyContent:"space-between",margin:"18px 0"}}><strong>Totali</strong><strong className="stat">€{total.toFixed(2)}</strong></div><button className="btn" style={{width:"100%"}} disabled={busy||!cartLines.length||!selectedPos} onClick={completeSale}>{busy?"Duke ruajtur…":"Regjistro pagesën"}</button><p className="footer">Regjistrimi i pagesës nuk është kupon fiskal. Dërgimi në ATK nuk është aktivizuar ende.</p></section></div>}
    <section className="panel" style={{marginTop:18}}><div className="row" style={{justifyContent:"space-between"}}><div><div className="eyebrow">Gjendja e ATK</div><h3 style={{margin:"7px 0"}}>Integrimi në zhvillim</h3></div><span className="status">TEST · jo i certifikuar</span></div><p className="sub" style={{margin:0}}>Fiskalo nuk shënon kupon si fiskalizuar pa përgjigje të pranuar nga ATK dhe transaction_id të ruajtur.</p></section>
    <p className="footer">Fiskalo Basic ATK MVP · Provider authorization and formal ATK certification are external release gates.</p>
  </main>;
}
