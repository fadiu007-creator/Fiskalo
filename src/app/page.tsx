"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { User } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";
import { pairLocalAgent, getLocalAgentStatus, verifyLocalTestPos, issueLocalTestCertificate, submitLocalTestCoupon, getLocalAgentQueue, type AgentStatus, type AtkVerification } from "@/lib/pos/local-agent";

type Business={id:string;name:string;nui:string;vat_number:string|null};
type Product={id:string;name:string;price:number;stock:number;vat_rate:number;atk_unit_code:string;atk_item_category_code:string;atk_vat_code:string};
type Pos={id:string;label:string;location:string;branch_id:number;pos_id:number;unit_number:string|null;fiscalization_number:string;application_id:string|null;verification_no:string|null;verified_business_name:string|null;certificate_status:string};
type CartLine={product:Product;quantity:number};
type SaleRecord={id:string;coupon_id:number;status:string;subtotal:number;vat_total:number;total:number;payment_method:string;created_at:string;pos_id:string;operator_id:string;daily_number:number|null;items:Array<{description:string;quantity:number;unit_price:number;line_total:number;line_net?:number;line_vat?:number;vat_rate?:number;atk_unit_code?:string;atk_vat_code?:string}>;transaction_id:string|null;nui_kf?:string|null;legacy_nui_kf?:string|null;submission_state?:string|null;offline_issued_at?:string|null;recovery_deadline_at?:string|null;qr_svg_base64?:string|null;pos_identifier?:string|null;business_address?:string|null;unit_name?:string|null;unit_code?:number|null;pos_number?:number|null;unit_number?:string|null;operator_name?:string|null;operator_identifier?:string|null;document_type?:string;is_offline?:boolean;recovery_deadline_exceeded?:boolean;queue_last_error?:string|null;is_copy?:boolean};
type Tab="pos"|"products"|"atk"|"sales";
type MemberRole="owner"|"cashier";

function FiscalLogo(){
  return <div role="img" aria-label="Stema zyrtare e Republikës së Kosovës dhe MFPT" style={{display:"flex",alignItems:"center",justifyContent:"center",gap:7,margin:"0 auto",height:"12mm"}}>
    <img
      src="/rks-coat-of-arms.svg"
      alt="Stema e Republikës së Kosovës"
      width="34"
      height="38"
      style={{width:"9mm",height:"10mm",objectFit:"contain"}}
    />
    <div style={{textAlign:"left",lineHeight:1.05,color:"#111"}}>
      <div style={{fontSize:13,fontWeight:900,letterSpacing:1}}>RKS</div>
      <div style={{fontSize:8,fontWeight:800,letterSpacing:.5}}>MFPT</div>
    </div>
  </div>;
}

export default function Home(){
  const [user,setUser]=useState<User|null>(null);
  const [configured,setConfigured]=useState(true);
  const [loading,setLoading]=useState(true);
  const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState("");
  const [business,setBusiness]=useState<Business|null>(null);
  const [memberRole,setMemberRole]=useState<MemberRole|null>(null);
  const [products,setProducts]=useState<Product[]>([]);
  const [positions,setPositions]=useState<Pos[]>([]);
  const [tab,setTab]=useState<Tab>("pos");
  const [sales,setSales]=useState<SaleRecord[]>([]);
  const [receipt,setReceipt]=useState<SaleRecord|null>(null);
  const [queueOverdueCount,setQueueOverdueCount]=useState(0);
  const [businessName,setBusinessName]=useState("");
  const [nui,setNui]=useState("");
  const [vatNumber,setVatNumber]=useState("");
  const [operatorName,setOperatorName]=useState("");
  const [operatorIdentifier,setOperatorIdentifier]=useState("");
  const [productName,setProductName]=useState("");
  const [productPrice,setProductPrice]=useState("1.00");
  const [productStock,setProductStock]=useState("0");
  const [vatRate,setVatRate]=useState("18");
  const [vatCode,setVatCode]=useState("E");
  const [unitCode,setUnitCode]=useState("");
  const [categoryCode,setCategoryCode]=useState("");
  const [posLabel,setPosLabel]=useState("Arka 1");
  const [posLocation,setPosLocation]=useState("");
  const [unitNumber,setUnitNumber]=useState("");
  const [unitNumberEdits,setUnitNumberEdits]=useState<Record<string,string>>({});

  const [branchId,setBranchId]=useState("1");
  const [posId,setPosId]=useState("1");
  const [fiscalizationNumber,setFiscalizationNumber]=useState("");
  const [applicationId,setApplicationId]=useState("");
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
    const {data:member,error:memberError}=await supabase.from("fiskalo_basic_members").select("business_id,role,operator_name,operator_identifier").eq("user_id",uid).limit(1).maybeSingle();
    if(memberError)throw memberError;
    if(!member){setBusiness(null);setMemberRole(null);setOperatorName("");setOperatorIdentifier("");setProducts([]);setPositions([]);setSelectedPos("");return;}
    setMemberRole(member.role as MemberRole);
    if(member.role==="cashier")setTab("pos");
    const {data:biz,error:bizError}=await supabase.from("fiskalo_basic_businesses").select("id,name,nui,vat_number").eq("id",member.business_id).single();
    if(bizError)throw bizError;
    setBusiness(biz);setVatNumber(biz.vat_number??"");setOperatorName(member.operator_name??"");setOperatorIdentifier(member.operator_identifier??"");
    const [{data:prods,error:productError},{data:poses,error:posError}]=await Promise.all([
      supabase.from("fiskalo_basic_products").select("*").eq("business_id",biz.id).eq("active",true).order("name"),
      supabase.from("fiskalo_basic_pos").select("*").eq("business_id",biz.id).order("created_at")
    ]);
    if(productError)throw productError;if(posError)throw posError;
    setProducts(prods??[]);setPositions(poses??[]);
    setSelectedPos(current=>poses?.some(p=>p.id===current)?current:(poses?.[0]?.id??""));
  },[supabase,selectedPos]);

  const loadSales=useCallback(async()=>{
    if(!supabase||!business)return;
    setBusy(true);setMessage("");
    try{
      const {data:saleRows,error:saleError}=await supabase.from("fiskalo_basic_sales").select("*").eq("business_id",business.id).order("created_at",{ascending:false}).limit(50);
      if(saleError)throw saleError;
      const rows=(saleRows??[]) as unknown as Array<Omit<SaleRecord,"items"|"transaction_id">>;
      if(!rows.length){setSales([]);return;}
      const ids=rows.map(s=>s.id);
      const [{data:itemRows,error:itemError},{data:documents,error:documentError},{data:members}]=await Promise.all([
        supabase.from("fiskalo_basic_sale_items").select("sale_id,description,quantity,unit_price,line_total,line_net,line_vat,vat_rate,atk_unit_code,atk_vat_code").in("sale_id",ids),
        supabase.from("fiskalo_basic_fiscal_documents").select("sale_id,atk_transaction_id,nui_kf,legacy_nui_kf,daily_number,submission_state,offline_issued_at,recovery_deadline_at,document_type,qr_svg_base64").in("sale_id",ids),
        supabase.from("fiskalo_basic_members").select("user_id,operator_name").eq("business_id",business.id)
      ]);
      if(itemError)throw itemError;if(documentError)throw documentError;
      const itemsBySale=new Map<string,SaleRecord["items"]>();
      for(const item of itemRows??[]){const list=itemsBySale.get(item.sale_id)??[];list.push(item);itemsBySale.set(item.sale_id,list);}
      const docsBySale=new Map((documents??[]).map(doc=>[doc.sale_id,doc]));
      const operatorNames=new Map((members??[]).map(member=>[member.user_id,member.operator_name]));
      const queue=agentToken?await getLocalAgentQueue(agentToken).catch(()=>null):null;
      setQueueOverdueCount(queue?.overdueCount??0);
      const queueByKey=new Map((queue?.items??[]).map(item=>[item.idempotencyKey,item]));
      setSales(rows.map(s=>{
        const pos=positions.find(p=>p.id===s.pos_id);
        const idempotencyKey=pos?business.nui+":"+pos.branch_id+":"+pos.pos_id+":"+s.coupon_id:"";
        const queued=queueByKey.get(idempotencyKey);
        const doc=docsBySale.get(s.id);
        return {
          ...s,
          items:itemsBySale.get(s.id)??[],
          transaction_id:String(doc?.atk_transaction_id??queued?.atkTransactionId??"")||null,
          nui_kf:doc?.nui_kf??(queued?.nuiKf&&/^[A-Z0-9]{16}$/.test(queued.nuiKf)?queued.nuiKf:null),
          legacy_nui_kf:doc?.legacy_nui_kf??queued?.legacyNuiKf??(queued?.nuiKf&&!/^[A-Z0-9]{16}$/.test(queued.nuiKf)?queued.nuiKf:null),
          daily_number:doc?.daily_number??s.daily_number??queued?.dailyNumber??null,
          submission_state:queued?.status?.toLowerCase()==="accepted"?"accepted":doc?.submission_state??queued?.status??null,
          offline_issued_at:doc?.offline_issued_at??queued?.offlineIssuedAtUtc??null,
          recovery_deadline_at:doc?.recovery_deadline_at??queued?.recoveryDeadlineUtc??null,
          qr_svg_base64:doc?.qr_svg_base64??queued?.qrSvgBase64??null,
          pos_identifier:pos?.unit_number?pos.unit_number+"-"+business.nui+"-"+String(pos.pos_id):null,
          unit_number:pos?.unit_number??null,
          business_address:pos?.location??null,
          unit_name:pos?.label??null,
          operator_name:s.operator_name??operatorNames.get(s.operator_id)??(user?.id===s.operator_id?(operatorName||"Nuk është konfiguruar"):"Nuk është konfiguruar"),
          operator_identifier:s.operator_identifier??null,
          document_type:doc?.document_type===2?"ANULIM":doc?.document_type===3?"KTHIM":"SHITJE",
          is_offline:!!(doc?.offline_issued_at??queued?.offlineIssuedAtUtc),
          recovery_deadline_exceeded:!!queued?.recoveryDeadlineExceeded,
          queue_last_error:queued?.lastError??null
        };
      }));
    }catch(e){setMessage(e instanceof Error?e.message:"Nuk u ngarkua historia e shitjeve.");}
    finally{setBusy(false);}
  },[supabase,business,agentToken,positions,user]);

  const syncAcceptedQueue=useCallback(async()=>{
    if(!supabase||!business||!agentToken)return;
    const queue=await getLocalAgentQueue(agentToken);
    setQueueOverdueCount(queue.overdueCount);
    for(const item of queue.items){
      if(item.status.toLowerCase()!=="accepted"||!item.atkTransactionId||
         !item.detailsBase64||!item.signatureBase64||!item.nuiKf||!/^[A-Z0-9]{16}$/.test(item.nuiKf)||
         !item.citizenPayloadBase64||!item.citizenSignatureBase64||!item.dailyNumber)continue;
      const parts=item.idempotencyKey.split(":");
      if(parts.length!==4||parts[0]!==business.nui)continue;
      const couponId=Number(parts[3]);
      if(!Number.isSafeInteger(couponId)||couponId<=0)continue;
      const {data:sale,error:saleError}=await supabase.from("fiskalo_basic_sales")
        .select("id,coupon_id,pos_id,daily_number").eq("business_id",business.id)
        .eq("coupon_id",couponId).maybeSingle();
      if(saleError)throw saleError;
      if(!sale)continue;
      const pos=positions.find(p=>p.id===sale.pos_id);
      if(!pos||String(pos.branch_id)!==parts[1]||String(pos.pos_id)!==parts[2])continue;
      const {error}=await supabase.rpc("fiskalo_basic_record_atk_receipt",{
        p_business_id:business.id,p_sale_id:sale.id,p_coupon_id:sale.coupon_id,
        p_idempotency_key:item.idempotencyKey,p_signed_payload:item.detailsBase64,
        p_signature:item.signatureBase64,p_atk_transaction_id:item.atkTransactionId,
        p_atk_response:{status:"accepted",transactionId:item.atkTransactionId,environment:"ATK TEST"},
        p_nui_kf:item.nuiKf,p_citizen_payload:item.citizenPayloadBase64,
        p_citizen_signature:item.citizenSignatureBase64,p_daily_number:item.dailyNumber??sale.daily_number,
        p_offline_issued_at:item.offlineIssuedAtUtc
      });
      if(error)throw error;
      if(item.qrSvgBase64){
        const {error:qrError}=await supabase.rpc("fiskalo_basic_set_receipt_qr",{
          p_business_id:business.id,p_sale_id:sale.id,p_coupon_id:sale.coupon_id,
          p_idempotency_key:item.idempotencyKey,p_qr_svg_base64:item.qrSvgBase64
        });
        if(qrError)throw qrError;
      }
    }
  },[supabase,business,agentToken,positions]);

  useEffect(()=>{
    if(!user||!business||!agentToken)return;
    let running=false;
    const sync=async()=>{if(running)return;running=true;try{await syncAcceptedQueue();}catch(e){setMessage(e instanceof Error?e.message:"Nuk u sinkronizuan kuponët e pranuar nga ATK.");}finally{running=false;}};
    void sync();
    const timer=window.setInterval(()=>void sync(),15000);
    return()=>window.clearInterval(timer);
  },[user,business,agentToken,syncAcceptedQueue]);

  useEffect(()=>{
    if(!supabase){setConfigured(false);setLoading(false);return;}
    supabase.auth.getUser().then(async({data,error})=>{
      if(error){setMessage(error.message);setLoading(false);return;}
      setUser(data.user);
      if(data.user){try{await loadWorkspace(data.user.id)}catch(e){setMessage(e instanceof Error?e.message:"Nuk u ngarkua hapësira.")}}
      setLoading(false);
    });
    const {data:{subscription}}=supabase.auth.onAuthStateChange((_event,session)=>{setUser(session?.user??null);if(session?.user){void loadWorkspace(session.user.id).catch(e=>setMessage(e instanceof Error?e.message:"Nuk u ngarkua hapësira."));}else{setBusiness(null);setMemberRole(null);setProducts([]);setPositions([]);setSelectedPos("");}});
    return()=>subscription.unsubscribe();
  },[supabase,loadWorkspace]);

  useEffect(()=>{const token=sessionStorage.getItem("fiskalo.posAgentToken");if(!token)return;setAgentToken(token);void getLocalAgentStatus(token).then(setAgentStatus).catch(()=>{sessionStorage.removeItem("fiskalo.posAgentToken");setAgentToken("");setAgentStatus(null);});},[]);

  async function signIn(e:React.FormEvent){e.preventDefault();setBusy(true);setMessage("");try{const {error}=await supabase!.auth.signInWithPassword({email:(document.getElementById("email") as HTMLInputElement).value,password:(document.getElementById("password") as HTMLInputElement).value});if(error)throw error;}catch(e){setMessage(e instanceof Error?e.message:"Hyrja dështoi.");}finally{setBusy(false);}}
  async function createBusiness(e:React.FormEvent){e.preventDefault();setBusy(true);setMessage("");try{const {data,error}=await supabase!.rpc("fiskalo_basic_create_business",{p_name:businessName,p_nui:nui});if(error)throw error;await loadWorkspace(user!.id);setMessage("Biznesi u krijua.");}catch(e){setMessage(e instanceof Error?e.message:"Biznesi nuk u krijua. Kontrollo nëse migrimet janë aplikuar.");}finally{setBusy(false);}}
  async function saveOperatorIdentity(e:React.FormEvent){e.preventDefault();if(!business)return;setBusy(true);setMessage("");try{const {error}=await supabase!.rpc("fiskalo_basic_set_operator_identity",{p_business_id:business.id,p_operator_name:operatorName.trim(),p_operator_identifier:operatorIdentifier.trim()});if(error)throw error;setMessage("Emri dhe identifikuesi i operatorit u ruajtën për kuponët e ardhshëm.");}catch(e){setMessage(e instanceof Error?e.message:"Identiteti i operatorit nuk u ruajt.");}finally{setBusy(false);}}
  async function saveTaxProfile(e:React.FormEvent){e.preventDefault();if(!business)return;setBusy(true);setMessage("");try{const {error}=await supabase!.rpc("fiskalo_basic_update_business_tax_profile",{p_business_id:business.id,p_vat_number:vatNumber.trim()||null});if(error)throw error;setBusiness({...business,vat_number:vatNumber.trim()||null});setMessage("Numri i TVSH-së u ruajt për kuponët e ardhshëm.");}catch(e){setMessage(e instanceof Error?e.message:"Të dhënat tatimore nuk u ruajtën.");}finally{setBusy(false);}}
  async function addProduct(e:React.FormEvent){e.preventDefault();if(!business)return;setBusy(true);setMessage("");try{const {error}=await supabase!.from("fiskalo_basic_products").insert({business_id:business.id,name:productName,price:Number(productPrice),stock:Number(productStock),vat_rate:Number(vatRate),atk_vat_code:vatCode,atk_unit_code:unitCode,atk_item_category_code:categoryCode});if(error)throw error;setProductName("");await loadWorkspace(user!.id);setMessage("Artikulli u ruajt.");}catch(e){setMessage(e instanceof Error?e.message:"Artikulli nuk u ruajt.");}finally{setBusy(false);}}
  async function pairAgent(){setBusy(true);setMessage("");try{const result=await pairLocalAgent(pairCode.trim());sessionStorage.setItem("fiskalo.posAgentToken",result.sessionToken);setAgentToken(result.sessionToken);setPairCode("");setAgentStatus(await getLocalAgentStatus(result.sessionToken));setMessage("POS Agent u lidh me këtë shfletues.");}catch(e){setMessage(e instanceof Error?e.message:"Lidhja me POS Agent dështoi.");}finally{setBusy(false);}}
  async function verifyAtkPos(){const pos=positions.find(p=>p.id===selectedPos);if(!pos||!business||!agentToken){setMessage("Lidh POS Agent dhe zgjidh pajisjen.");return;}if(!pos.application_id){setMessage("Vendos Application ID TEST për këtë POS.");return;}setBusy(true);setMessage("");try{const result=await verifyLocalTestPos(agentToken,{nui:Number(business.nui),fiscalizationNumber:pos.fiscalization_number,posId:pos.pos_id,branchId:pos.branch_id,applicationId:Number(pos.application_id)});setVerification(result);const {error}=await supabase!.from("fiskalo_basic_pos").update({verification_no:result.verificationCode,verified_business_name:result.businessName,certificate_status:"verified"}).eq("id",pos.id);if(error)throw error;await loadWorkspace(user!.id);setMessage("ATK TEST verifikoi POS-in. Tani mund të kërkosh certifikatën.");}catch(e){setMessage(e instanceof Error?e.message:"Verifikimi ATK dështoi.");}finally{setBusy(false);}}
  async function requestAtkCertificate(){const pos=positions.find(p=>p.id===selectedPos);if(!pos||!business||!agentToken||!pos.application_id||!pos.verification_no){setMessage("Kryej fillimisht verifikimin ATK për këtë POS.");return;}setBusy(true);setMessage("");try{const result=await issueLocalTestCertificate(agentToken,{businessName:pos.verified_business_name||verification?.businessName||business.name,businessNui:Number(business.nui),branchId:pos.branch_id,verificationCode:pos.verification_no,posId:pos.pos_id,applicationId:Number(pos.application_id)});if(!result.certificateStatus.includes("RECEIVED_AND_KEY_MATCHED"))throw new Error("ATK certificate was not confirmed as matching the local POS key.");const {error}=await supabase!.from("fiskalo_basic_pos").update({certificate_status:"certificate_issued"}).eq("id",pos.id);if(error)throw error;setAgentStatus(await getLocalAgentStatus(agentToken));await loadWorkspace(user!.id);setMessage("Certifikata ATK TEST u ruajt në POS dhe çelësi publik u përputh.");}catch(e){setMessage(e instanceof Error?e.message:"Lëshimi i certifikatës dështoi.");}finally{setBusy(false);}}
  async function addPos(e:React.FormEvent){e.preventDefault();if(!business)return;if(!/^[0-9]{7}$/.test(unitNumber.trim())){setMessage("Numri i njësisë ARBK duhet të ketë 7 shifra.");return;}setBusy(true);setMessage("");try{const {error}=await supabase!.from("fiskalo_basic_pos").insert({business_id:business.id,label:posLabel,location:posLocation,unit_number:unitNumber.trim(),branch_id:Number(branchId),pos_id:Number(posId),fiscalization_number:fiscalizationNumber,application_id:applicationId||null});if(error)throw error;setUnitNumber("");await loadWorkspace(user!.id);setMessage("POS-i u regjistrua në Fiskalo. Kjo nuk e verifikon automatikisht te ATK.");}catch(e){setMessage(e instanceof Error?e.message:"POS-i nuk u ruajt.");}finally{setBusy(false);}}
  async function savePosUnitNumber(posUuid:string){const value=(unitNumberEdits[posUuid]??positions.find(p=>p.id===posUuid)?.unit_number??"").trim();if(!/^[0-9]{7}$/.test(value)){setMessage("Numri i njësisë ARBK duhet të ketë 7 shifra.");return;}setBusy(true);setMessage("");try{const {error}=await supabase!.from("fiskalo_basic_pos").update({unit_number:value}).eq("id",posUuid);if(error)throw error;await loadWorkspace(user!.id);setUnitNumberEdits(current=>({...current,[posUuid]:value}));setMessage("Numri i njësisë ARBK u ruajt.");}catch(e){setMessage(e instanceof Error?e.message:"Numri i njësisë nuk u ruajt.");}finally{setBusy(false);}}
  function changeCart(product:Product,delta:number){setCart(current=>{const next={...current};const qty=(next[product.id]?.quantity??0)+delta;if(qty<=0)delete next[product.id];else next[product.id]={product,quantity:qty};return next;});}
  const cartLines=Object.values(cart);
  const total=cartLines.reduce((sum,line)=>sum+line.product.price*line.quantity*(1+line.product.vat_rate/100),0);
  async function completeSale(){
    if(!business||!selectedPos||!cartLines.length)return;
    if(operatorName.trim().length<2||operatorIdentifier.trim().length<1){setMessage("Vendos emrin dhe numrin identifikues të operatorit para lëshimit të kuponit fiskal.");return;}
    const pos=positions.find(p=>p.id===selectedPos);
    if(!pos)return;
    if(!/^[0-9]{7}$/.test(pos.unit_number??"")){setMessage("Plotëso numrin 7-shifror të njësisë ARBK për këtë POS para lëshimit të kuponit.");return;}
    setBusy(true);setMessage("");
    try{
      const {error:operatorError}=await supabase!.rpc("fiskalo_basic_set_operator_identity",{p_business_id:business.id,p_operator_name:operatorName.trim(),p_operator_identifier:operatorIdentifier.trim()});if(operatorError)throw operatorError;
      if(!agentToken||pos.certificate_status!=="certificate_issued"||!pos.verification_no||!pos.application_id)throw new Error("Ky POS nuk ka certifikatë TEST aktive ose POS Agent të lidhur. Shitja nuk u regjistrua.");
      const agent=await getLocalAgentStatus(agentToken);
      if(!agent.paired||!agent.testCertificateInstalled||!agent.testInstallationVerified)throw new Error("POS Agent nuk është i çiftuar ose certifikata TEST nuk është verifikuar. Shitja nuk u regjistrua.");
      const {data:saleId,error}=await supabase!.rpc("fiskalo_basic_create_sale",{p_business_id:business.id,p_pos_id:selectedPos,p_payment_method:payment,p_lines:cartLines.map(x=>({product_id:x.product.id,quantity:x.quantity}))});
      if(error)throw error;
      setCart({});
      const [{data:sale,error:saleError},{data:lines,error:linesError}]=await Promise.all([
        supabase!.from("fiskalo_basic_sales").select("*").eq("id",saleId).single(),
        supabase!.from("fiskalo_basic_sale_items").select("*").eq("sale_id",saleId).order("id")
      ]);
      if(saleError)throw saleError;if(linesError)throw linesError;
      const cents=(value:number)=>Math.round(Number(value)*100);
      const grouped=new Map<string,{taxRate:string;base:number;tax:number}>();
      for(const line of lines??[]){
        const key=line.atk_vat_code;
        const group=grouped.get(key)??{taxRate:key,base:0,tax:0};
        group.base+=cents(line.line_net);group.tax+=cents(line.line_vat);grouped.set(key,group);
      }
      const paymentType=payment==="cash"?1:payment==="card"?2:6;
      if(!sale.daily_number||Number(sale.daily_number)<=0)throw new Error("Numri ditor i kuponit nuk u caktua nga baza e të dhënave.");
      const coupon={
        businessId:Number(business.nui),couponId:Number(sale.coupon_id),dailyNumber:Number(sale.daily_number),
        branchId:pos.branch_id,location:pos.location,operatorId:operatorName.trim(),posId:pos.pos_id,
        applicationId:Number(pos.application_id),verificationNo:"",type:1,
        unixTime:Math.floor(new Date(sale.created_at).getTime()/1000),
        items:(lines??[]).map(line=>({name:line.description,unitPriceEuro:Number(line.unit_price),unit:line.atk_unit_code,quantity:Number(line.quantity),lineTotalCents:cents(line.line_total),taxRate:line.atk_vat_code,itemType:line.atk_item_category_code})),
        payments:[{type:paymentType,amountCents:cents(sale.total)}],
        totalCents:cents(sale.total),taxGroups:Array.from(grouped.values()).map(g=>({taxRate:g.taxRate,totalForTaxCents:g.base,totalTaxCents:g.tax})),
        totalTaxCents:cents(sale.vat_total),totalNoTaxCents:cents(sale.subtotal),totalDiscountCents:0
      };
      const idempotencyKey=business.nui+":"+pos.branch_id+":"+pos.pos_id+":"+sale.coupon_id;
      const fiscal=await submitLocalTestCoupon(agentToken,idempotencyKey,coupon);
      if(!/^[A-Z0-9]{16}$/.test(fiscal.nuiKf||"")||!fiscal.qrSvgBase64||!fiscal.citizenQrPayload)throw new Error("POS Agent did not produce a valid 16-character ATK NUIKF and signed CitizenCoupon QR. Do not print this as a fiscal receipt.");
      if(fiscal.status==="accepted"&&(!fiscal.transactionId||!(/^[1-9][0-9]{0,19}$/.test(fiscal.transactionId))))throw new Error("ATK did not return a valid transaction_id.");

      const receiptRecord:SaleRecord={
        ...sale,items:(lines??[]).map(line=>({description:line.description,quantity:line.quantity,unit_price:line.unit_price,line_total:line.line_total,line_net:line.line_net,line_vat:line.line_vat,vat_rate:line.vat_rate,atk_unit_code:line.atk_unit_code,atk_vat_code:line.atk_vat_code})),
        transaction_id:fiscal.transactionId,nui_kf:fiscal.nuiKf,daily_number:fiscal.dailyNumber,
        submission_state:fiscal.status==="accepted"?"accepted":"queued",
        offline_issued_at:fiscal.offlineIssuedAtUtc??null,recovery_deadline_at:fiscal.recoveryDeadlineUtc??null,
        qr_svg_base64:fiscal.qrSvgBase64,pos_identifier:pos.unit_number+"-"+business.nui+"-"+String(pos.pos_id).padStart(2,"0"),unit_number:pos.unit_number,unit_code:pos.branch_id,pos_number:pos.pos_id,
        unit_name:pos.label,
        business_address:pos.location,operator_name:sale.operator_name??operatorName.trim(),
        operator_identifier:sale.operator_identifier??null,document_type:"SHITJE",is_offline:fiscal.offline
      };
      setReceipt(receiptRecord);

      if(fiscal.status==="accepted"){
        const {error:recordError}=await supabase!.rpc("fiskalo_basic_record_atk_receipt",{
          p_business_id:business.id,p_sale_id:saleId,p_coupon_id:sale.coupon_id,p_idempotency_key:idempotencyKey,
          p_signed_payload:fiscal.detailsBase64,p_signature:fiscal.signatureBase64,
          p_atk_transaction_id:fiscal.transactionId,p_atk_response:fiscal,
          p_nui_kf:fiscal.nuiKf,p_citizen_payload:fiscal.citizenQrPayload.split("|")[0],
          p_citizen_signature:fiscal.citizenQrPayload.split("|")[1],p_daily_number:fiscal.dailyNumber,
          p_offline_issued_at:fiscal.offlineIssuedAtUtc??null
        });
        if(recordError)throw new Error("ATK pranoi kuponin me Transaction ID "+fiscal.transactionId+", por ruajtja e statusit dështoi: "+recordError.message+". Mos e ridërgo; sinkronizoje pas verifikimit.");
        const {error:qrError}=await supabase!.rpc("fiskalo_basic_set_receipt_qr",{
          p_business_id:business.id,p_sale_id:saleId,p_coupon_id:sale.coupon_id,
          p_idempotency_key:idempotencyKey,p_qr_svg_base64:fiscal.qrSvgBase64
        });
        if(qrError)throw new Error("Kuponi u pranua nga ATK, por ruajtja e QR për ribotim dështoi: "+qrError.message);
        setMessage("ATK TEST e pranoi kuponin. Transaction ID: "+fiscal.transactionId);
      }else{
        const {error:queueError}=await supabase!.rpc("fiskalo_basic_store_offline_receipt",{
          p_business_id:business.id,p_sale_id:saleId,p_coupon_id:sale.coupon_id,p_idempotency_key:idempotencyKey,
          p_signed_payload:fiscal.detailsBase64,p_signature:fiscal.signatureBase64,
          p_nui_kf:fiscal.nuiKf,p_citizen_payload:fiscal.citizenQrPayload.split("|")[0],
          p_citizen_signature:fiscal.citizenQrPayload.split("|")[1],p_daily_number:fiscal.dailyNumber,
          p_offline_issued_at:fiscal.offlineIssuedAtUtc
        });
        if(queueError)throw new Error("Kuponi i nënshkruar është ruajtur në radhën lokale, por regjistrimi i tij në panel dështoi: "+queueError.message);
        const {error:qrError}=await supabase!.rpc("fiskalo_basic_set_receipt_qr",{
          p_business_id:business.id,p_sale_id:saleId,p_coupon_id:sale.coupon_id,
          p_idempotency_key:idempotencyKey,p_qr_svg_base64:fiscal.qrSvgBase64
        });
        if(qrError)throw new Error("Kuponi offline është ruajtur, por ruajtja e QR për ribotim dështoi: "+qrError.message);
        setMessage("Kuponi u krijua OFFLINE me NUIKF dhe QR të nënshkruar. POS Agent do ta dërgojë automatikisht sapo të rikthehet lidhja. Afati: "+new Date(fiscal.recoveryDeadlineUtc!).toLocaleString());
      }
      await loadWorkspace(user!.id);
    }catch(e){
      await loadWorkspace(user!.id);
      setMessage(e instanceof Error?e.message:"Shitja/fiskalizimi dështoi. Kontrollo radhën lokale para çdo riprovimi.");
    }finally{setBusy(false);}
  }

  if(!configured)return <main className="shell"><header className="topbar"><div className="brand">fiskalo<span>.</span></div><span className="eyebrow">Basic ATK MVP</span></header><section className="panel"><h1>Konfigurimi kërkohet</h1><p className="sub">Vendos NEXT_PUBLIC_SUPABASE_URL dhe NEXT_PUBLIC_SUPABASE_ANON_KEY në mjedisin e aplikacionit.</p></section></main>;
  if(loading)return <main className="shell"><div className="brand">fiskalo<span>.</span></div><p className="sub">Duke ngarkuar…</p></main>;
  if(!user)return <main className="shell"><header className="topbar"><div className="brand">fiskalo<span>.</span></div><span className="eyebrow">Fiscal POS · Kosovo</span></header><section className="panel" style={{maxWidth:460,margin:"8vh auto"}}><div className="eyebrow">Hyr në llogari</div><h1>Mirë se u ktheve.</h1><p className="sub">Hyr si pronar ose arkëtar.</p><form onSubmit={signIn}><div className="field"><label>Email</label><input id="email" type="email" required autoComplete="username"/></div><div className="field"><label>Fjalëkalimi</label><input id="password" type="password" required autoComplete="current-password"/></div>{message&&<p className="notice">{message}</p>}<button className="btn" disabled={busy} style={{width:"100%"}}>{busy?"Duke hyrë…":"Hyr"}</button></form></section></main>;
  if(!business)return <main className="shell"><header className="topbar"><div className="brand">fiskalo<span>.</span></div><button className="btn secondary" onClick={()=>supabase!.auth.signOut()}>Dil</button></header><section className="panel" style={{maxWidth:560,margin:"5vh auto"}}><div className="eyebrow">Konfigurimi fillestar</div><h1>Regjistro biznesin</h1><p className="sub">Krijo hapësirën e biznesit. NUI duhet të jetë numri real i biznesit.</p><form onSubmit={createBusiness}><div className="field"><label>Emri i biznesit</label><input required value={businessName} onChange={e=>setBusinessName(e.target.value)}/></div><div className="field"><label>NUI (9 shifra)</label><input required inputMode="numeric" pattern="[0-9]{9}" value={nui} onChange={e=>setNui(e.target.value)}/></div>{message&&<p className="notice">{message}</p>}<button className="btn" disabled={busy}>{busy?"Duke ruajtur…":"Krijo biznesin"}</button></form></section></main>;

  return <main className="shell">
    <header className="topbar"><div><div className="brand">fiskalo<span>.</span></div><span className="eyebrow">{business.name} · NUI {business.nui} · {memberRole==="owner"?"Pronari":"Arkëtari"}</span></div><div className="row"><span className="sub">{user.email}</span><button className="btn secondary" onClick={()=>supabase!.auth.signOut()}>Dil</button></div></header>
    <div className="eyebrow">Paneli i biznesit</div><h1>Arka dhe fiskalizimi.</h1><p className="sub">Version i thjeshtuar: produkte, POS dhe shitje. Shitjet e paguara dërgohen në ATK TEST kur POS-i është verifikuar, certifikuar dhe POS Agent është i lidhur. Production mbetet i çaktivizuar.</p>
    <section className="panel" style={{marginTop:16,maxWidth:520}}><h3>Operatori i arkës</h3><p className="sub">Emri dhe identifikuesi i operatorit ruhen në çdo shitje dhe shtypen në kupon. Përdor kodin identifikues të punonjësit, jo ID-në e llogarisë së brendshme.</p><form onSubmit={saveOperatorIdentity}><div className="field"><label>Emri dhe mbiemri i operatorit</label><input required minLength={2} maxLength={100} value={operatorName} onChange={e=>setOperatorName(e.target.value)} placeholder="Emri i operatorit"/></div><div className="field"><label>Numri identifikues i operatorit</label><input required minLength={1} maxLength={32} value={operatorIdentifier} onChange={e=>setOperatorIdentifier(e.target.value)} placeholder="ID e punonjësit"/></div><button className="btn secondary" disabled={busy}>Ruaj identitetin e operatorit</button></form></section>
    {memberRole==="owner"&&<section className="panel" style={{marginTop:16,maxWidth:520}}><h3>Të dhënat në kupon</h3><p className="sub">Numri i TVSH-së shtypet vetëm nëse biznesi është i regjistruar për TVSH. Adresa e kuponit merret nga lokacioni i POS-it.</p><form onSubmit={saveTaxProfile}><div className="field"><label>Numri i TVSH-së (9 shifra, opsional)</label><input inputMode="numeric" pattern="[0-9]{9}" maxLength={9} value={vatNumber} onChange={e=>setVatNumber(e.target.value)} placeholder="Lëre bosh nëse nuk je i regjistruar"/></div><button className="btn secondary" disabled={busy}>Ruaj të dhënat tatimore</button></form></section>}
    {queueOverdueCount>0&&<p className="notice" role="alert">KUJDES: {queueOverdueCount} kupon(e) offline kanë kaluar afatin 48-orësh. Radhët nuk fshihen dhe dërgimi vazhdon automatikisht, por kërkohet kontroll i menjëhershëm me ATK.</p>}
    <div className="row" style={{margin:"22px 0"}}><button className={tab==="pos"?"btn":"btn secondary"} onClick={()=>setTab("pos")}>Arka / POS</button>{memberRole==="owner"&&<><button className={tab==="products"?"btn":"btn secondary"} onClick={()=>setTab("products")}>Artikujt</button><button className={tab==="atk"?"btn":"btn secondary"} onClick={()=>setTab("atk")}>ATK / POS</button><button className={tab==="sales"?"btn":"btn secondary"} onClick={()=>{setTab("sales");void loadSales();}}>Shitjet</button></>}</div>
    {message&&<p className="notice" role="status">{message}</p>}
    {tab==="products"&&memberRole==="owner"&&<div className="grid" style={{gridTemplateColumns:"minmax(260px,1fr) minmax(280px,1.4fr)"}}><section className="panel"><h2>Artikull i ri</h2><form onSubmit={addProduct}><div className="field"><label>Emri</label><input required value={productName} onChange={e=>setProductName(e.target.value)}/></div><div className="field"><label>Çmimi pa TVSH (€)</label><input type="number" min="0" step="0.0001" required value={productPrice} onChange={e=>setProductPrice(e.target.value)}/></div><div className="field"><label>Stoku</label><input type="number" min="0" step="0.001" value={productStock} onChange={e=>setProductStock(e.target.value)}/></div><div className="field"><label>Norma TVSH</label><select value={vatRate} onChange={e=>{setVatRate(e.target.value);setVatCode(e.target.value==="18"?"E":e.target.value==="8"?"D":"A")}}><option value="18">18%</option><option value="8">8%</option><option value="0">0%</option></select></div><div className="field"><label>Kodi ATK – njësia</label><input required value={unitCode} onChange={e=>setUnitCode(e.target.value)} placeholder="Kodi zyrtar ATK"/></div><div className="field"><label>Kodi ATK – kategoria</label><input required value={categoryCode} onChange={e=>setCategoryCode(e.target.value)} placeholder="Kodi zyrtar ATK"/></div><div className="field"><label>Kodi ATK – TVSH</label><input required maxLength={1} value={vatCode} onChange={e=>setVatCode(e.target.value.toUpperCase())}/></div><button className="btn" disabled={busy}>Ruaj artikullin</button></form></section><section className="panel"><h2>Katalogu</h2>{products.length===0?<p className="sub">Nuk ka artikuj ende.</p>:products.map(p=><div key={p.id} className="row" style={{justifyContent:"space-between",padding:"12px 0",borderBottom:"1px solid var(--line)"}}><div><strong>{p.name}</strong><div className="sub" style={{fontSize:12}}>Stoku {p.stock} · TVSH {p.vat_rate}%</div></div><strong>€{Number(p.price).toFixed(2)}</strong></div>)}</section></div>}
    {tab==="sales"&&memberRole==="owner"&&<section className="panel"><div className="row" style={{justifyContent:"space-between"}}><div><h2>Historia e shitjeve</h2><p className="sub">50 shitjet e fundit të këtij biznesi. Statusi ATK shfaqet veçmas nga pagesa.</p></div><button className="btn secondary" disabled={busy} onClick={()=>void loadSales()}>Rifresko</button></div>{sales.length===0?<p className="sub">Nuk ka shitje të regjistruara në këtë listë.</p>:<><div className="grid" style={{gridTemplateColumns:"repeat(auto-fit,minmax(150px,1fr))",margin:"16px 0"}}><div className="stat-card"><span className="eyebrow">Shitje të listuara</span><strong className="stat">{sales.length}</strong></div><div className="stat-card"><span className="eyebrow">Vlera e listuar</span><strong className="stat">€{sales.reduce((sum,s)=>sum+Number(s.total),0).toFixed(2)}</strong></div><div className="stat-card"><span className="eyebrow">Të fiskalizuara</span><strong className="stat">{sales.filter(s=>s.status==="fiscalized").length}</strong></div></div>{sales.map(s=><div key={s.id} className="row" style={{justifyContent:"space-between",gap:12,padding:"13px 0",borderBottom:"1px solid var(--line)",flexWrap:"wrap"}}><div><strong>Kupon #{s.coupon_id}</strong><div className="sub" style={{fontSize:12}}>{new Date(s.created_at).toLocaleString("sq-XK")} · {s.payment_method}</div><div className="sub" style={{fontSize:12}}>ATK: {s.submission_state?.toLowerCase()==="accepted"||s.status==="fiscalized"?"Pranuar · "+(s.transaction_id??"Transaction ID i ruajtur"):s.submission_state?.toLowerCase()==="queued"?"Në radhë · dërgim automatik":s.submission_state?.toLowerCase()==="needsreconciliation"?"Kërkohet reconciliim":s.submission_state?.toLowerCase()==="rejected"?"Refuzuar nga ATK":"Jo i konfirmuar"}</div>{s.queue_last_error&&<div className="sub" style={{fontSize:12,color:"#b91c1c"}}>{s.queue_last_error}</div>}</div><div className="row"><strong>€{Number(s.total).toFixed(2)}</strong><button className="btn secondary" onClick={()=>setReceipt({...s,is_copy:true})}>Kuponi</button></div></div>)}</>}</section>}
    {receipt&&<div className="panel receipt" style={{marginTop:18,maxWidth:420,fontFamily:"Arial, sans-serif",color:"#111",background:"#fff"}}>
      <div className="row no-print" style={{justifyContent:"space-between"}}>
        <strong>Paraqitja e kuponit fiskal</strong>
        <div className="row"><button className="btn secondary" disabled={!receipt.qr_svg_base64||!receipt.nui_kf} onClick={()=>window.print()}>Printo</button><button className="btn secondary" onClick={()=>setReceipt(null)}>Mbyll</button></div>
      </div>
      <div style={{fontSize:12,lineHeight:1.35,padding:"10px 2px"}}>
        <div style={{textAlign:"center",paddingBottom:8,borderBottom:"1px dashed #888"}}>
          <strong style={{fontSize:18,letterSpacing:1}}>FISKALO</strong>
          <div style={{fontWeight:700,marginTop:4}}>{business.name}</div>
          <div>Njësia: {receipt.unit_name||"—"}</div>
          <div>Adresa: {receipt.business_address||"Adresa e njësisë nuk është konfiguruar"}</div>
          <div>NF-NUI: {business.nui}</div>
          {business.vat_number&&<div>Numri TVSH: {business.vat_number}</div>}
          <div>Operator: {receipt.operator_name||"Nuk është konfiguruar"}</div>
          <div>ID operatori: {receipt.operator_identifier||"Nuk është konfiguruar"}</div>
        </div>
        <div style={{textAlign:"center",padding:"8px 0",borderBottom:"1px dashed #888"}}>
          <strong style={{fontSize:15}}>KUPON FISKAL</strong>
          {receipt.is_copy&&<div style={{fontWeight:800}}>KOPJE E KUPONIT</div>}
          <div style={{fontWeight:700,marginTop:3}}>ATK TEST · JO PËR QARKULLIM REAL</div>
          {receipt.is_offline&&<div style={{fontWeight:800,marginTop:3}}>OFFLINE</div>}
          <div>{receipt.document_type||"SHITJE"}</div>
          <div>{new Date(receipt.created_at).toLocaleString("sq-XK")}</div>
          <div>Nr. rendor: {receipt.coupon_id}</div>
          <div>ARTIKUJ: {receipt.items.length}</div>
          <div>Nr. identifikues i SEF: {receipt.pos_identifier||"—"}</div>
          <div>Njësia ARBK: {receipt.unit_number??"—"} · Branch ID: {receipt.unit_code??"—"} · POS: {receipt.pos_number??"—"}</div>
        </div>
        <div style={{padding:"7px 0",borderBottom:"1px dashed #888"}}>
          <div style={{display:"grid",gridTemplateColumns:"1fr auto",fontWeight:700,paddingBottom:4}}><span>ARTIKULLI</span><span>SHUMA</span></div>
          {receipt.items.map((item,i)=><div key={i} style={{padding:"4px 0"}}>
            <div>{item.description}</div>
            <div style={{display:"flex",justifyContent:"space-between",gap:8}}>
              <span>{item.quantity} × €{Number(item.unit_price).toFixed(4)} {item.atk_unit_code||""}</span>
              <strong>€{Number(item.line_total).toFixed(2)} {item.atk_vat_code||""}</strong>
            </div>
          </div>)}
        </div>
        <div style={{padding:"7px 0",borderBottom:"1px dashed #888"}}>
          <div style={{display:"flex",justifyContent:"space-between"}}><span>NËNTOTALI</span><strong>€{Number(receipt.subtotal).toFixed(2)}</strong></div>
          {Object.entries(receipt.items.reduce<Record<string,{base:number;tax:number;rate:number}>>((acc,item)=>{const key=item.atk_vat_code||"A";const group=acc[key]??{base:0,tax:0,rate:Number(item.vat_rate??0)};group.base+=Number(item.line_net??0);group.tax+=Number(item.line_vat??0);acc[key]=group;return acc;},{})).sort(([a],[b])=>a.localeCompare(b)).map(([code,g])=><div key={code} style={{display:"flex",justifyContent:"space-between"}}><span>TVSH {code} {g.rate}%</span><span>€{g.tax.toFixed(2)}</span></div>)}
          <div style={{display:"flex",justifyContent:"space-between"}}><span>TOTALI PA TVSH</span><strong>€{Number(receipt.subtotal).toFixed(2)}</strong></div>
          <div style={{display:"flex",justifyContent:"space-between",fontSize:15,fontWeight:800,marginTop:6}}><span>TOTALI PËR PAGESË</span><span>€{Number(receipt.total).toFixed(2)}</span></div>
          <div style={{display:"flex",justifyContent:"space-between",marginTop:5}}><span>PAGUAR</span><strong>€{Number(receipt.total).toFixed(2)}</strong></div><div style={{display:"flex",justifyContent:"space-between"}}><span>MËNYRA E PAGESËS</span><strong>{receipt.payment_method==="cash"?"KESH":receipt.payment_method==="card"?"KARTELË":"TRANSFER BANKAR"}</strong></div>
        </div>
        <div style={{textAlign:"center",padding:"8px 0",borderBottom:"1px dashed #888"}}>
          <div style={{fontWeight:700}}>NUIKF</div>
          {receipt.nui_kf
            ? <div style={{fontSize:14,fontWeight:800,letterSpacing:1}}>{receipt.nui_kf}</div>
            : receipt.legacy_nui_kf
              ? <div style={{fontWeight:800,color:"#b91c1c"}}>NUIKF I VJETËR TESTUES — FORMAT I PAVLEFSHËM: {receipt.legacy_nui_kf}</div>
              : <div style={{fontWeight:800,color:"#b91c1c"}}>NUIKF NUK ËSHTË GJENERUAR</div>}
          <div>Kupon fiskal ditor nr. {String(receipt.daily_number??"—").padStart(4,"0")}</div>
          {receipt.qr_svg_base64?<img alt="Kodi QR i kuponit të nënshkruar" src={"data:image/svg+xml;base64,"+receipt.qr_svg_base64} style={{width:170,height:170,objectFit:"contain",margin:"8px auto",display:"block"}}/>:<div style={{padding:12,border:"1px solid #b91c1c",color:"#b91c1c",fontWeight:700}}>QR mungon — mos e përdor këtë dokument si kupon fiskal.</div>}
          <div>Statusi ATK: {receipt.submission_state?.toLowerCase()==="accepted"||receipt.status==="fiscalized"?"ACCEPTED":receipt.submission_state?.toLowerCase()==="needsreconciliation"?"RECONCILIIM I NEVOJSHËM":receipt.submission_state?.toLowerCase()==="rejected"?"REFUZUAR NGA ATK":receipt.is_offline?"OFFLINE · NË RADHË":"PENDING"}</div>
          {receipt.transaction_id&&<div>Transaction ID: {receipt.transaction_id}</div>}{receipt.queue_last_error&&<div style={{fontSize:10,marginTop:4}}>Shënim: {receipt.queue_last_error}</div>}
          {receipt.is_offline&&receipt.recovery_deadline_at&&<div>Afati i dërgimit: {new Date(receipt.recovery_deadline_at).toLocaleString("sq-XK")}</div>}{receipt.recovery_deadline_exceeded&&<div style={{fontWeight:800,color:"#b91c1c"}}>AFATI 48-ORËSH I KALUAR — kontroll i menjëhershëm me ATK</div>}
        </div>
        <div style={{textAlign:"center",paddingTop:8}}>
          <FiscalLogo/>
          <div style={{fontWeight:700,marginTop:5}}>e-kuponi</div>
          <div style={{fontSize:10,marginTop:7,fontWeight:800}}>ATK TEST — DOKUMENT TESTUES</div>
          <div style={{fontSize:10,marginTop:3}}>Nuk është kupon fiskal i vlefshëm për shitje reale dhe nuk dëshmon certifikim të Fiskalo nga ATK.</div>
        </div>
      </div>
    </div>}
    {tab==="atk"&&memberRole==="owner"&&<div className="grid" style={{gridTemplateColumns:"minmax(260px,1fr) minmax(280px,1.4fr)"}}><section className="panel"><h2>Regjistro POS</h2><form onSubmit={addPos}><div className="field"><label>Emërtimi</label><input required value={posLabel} onChange={e=>setPosLabel(e.target.value)}/></div><div className="field"><label>Lokacioni i biznesit</label><input required value={posLocation} onChange={e=>setPosLocation(e.target.value)} placeholder="Adresa e njësisë së regjistruar"/></div><div className="field"><label>Numri i njësisë ARBK (7 shifra)</label><input required inputMode="numeric" pattern="[0-9]{7}" maxLength={7} value={unitNumber} onChange={e=>setUnitNumber(e.target.value)} placeholder="p.sh. 5130484"/></div><div className="field"><label>Branch ID (ATK)</label><input type="number" min="1" required value={branchId} onChange={e=>setBranchId(e.target.value)}/></div><div className="field"><label>Numri POS</label><input type="number" min="1" required value={posId} onChange={e=>setPosId(e.target.value)}/></div><div className="field"><label>Numri i fiskalizimit TEST</label><input required value={fiscalizationNumber} onChange={e=>setFiscalizationNumber(e.target.value)} placeholder="Numri i fiskalizimit nga EDI"/></div><div className="field"><label>Application ID TEST</label><input required value={applicationId} onChange={e=>setApplicationId(e.target.value)}/></div><button className="btn" disabled={busy}>Ruaj POS-in</button></form></section><section className="panel"><h2>Pajisjet</h2>{positions.length===0?<p className="sub">Nuk është regjistruar asnjë POS.</p>:positions.map(p=><div key={p.id} style={{padding:"12px 0",borderBottom:"1px solid var(--line)"}}><div className="row" style={{justifyContent:"space-between"}}><strong>{p.label}</strong><span className="status">{p.certificate_status}</span></div><p className="sub" style={{fontSize:12,margin:"5px 0"}}>Njësia ARBK {p.unit_number||"Nuk është konfiguruar"} · Branch ID {p.branch_id} · POS {p.pos_id} · TEST {p.fiscalization_number}</p>{memberRole==="owner"&&<div className="row" style={{marginTop:8}}><input style={{flex:1,minWidth:130}} inputMode="numeric" pattern="[0-9]{7}" maxLength={7} value={unitNumberEdits[p.id]??p.unit_number??""} onChange={e=>setUnitNumberEdits(current=>({...current,[p.id]:e.target.value}))} placeholder="Numri i njësisë ARBK"/><button className="btn secondary" disabled={busy} onClick={()=>savePosUnitNumber(p.id)}>Ruaj</button></div>}</div>)}</section>
      <section className="panel"><h2>Lidhja me POS Agent (Windows)</h2><p className="sub">Nise Fiskalo POS Agent në kompjuterin e arkës. Përdor kodin njëpërdorimësh që shfaqet në dritaren e tij.</p><div className="row"><input style={{flex:1,minWidth:160}} placeholder="Kodi i çiftimit" value={pairCode} onChange={e=>setPairCode(e.target.value)}/><button className="btn" disabled={busy||!pairCode.trim()} onClick={pairAgent}>Lidh pajisjen</button></div>{agentStatus&&<p className="sub" style={{marginTop:12}}>Agent {agentStatus.version} · Windows keystore: {agentStatus.windowsKeyStoreAvailable?"Gati":"Nuk u zbulua"} · Certifikata TEST: {agentStatus.testCertificateInstalled?"Po":"Jo"}</p>}<div className="field"><label>POS për verifikim</label><select value={selectedPos} onChange={e=>setSelectedPos(e.target.value)}><option value="">Zgjidh POS</option>{positions.map(p=><option key={p.id} value={p.id}>{p.label} · POS {p.pos_id}</option>)}</select></div><div className="row"><button className="btn secondary" disabled={busy||!agentToken||!selectedPos} onClick={verifyAtkPos}>Verifiko me ATK TEST</button><button className="btn" disabled={busy||!agentToken||!positions.find(p=>p.id===selectedPos)?.verification_no} onClick={requestAtkCertificate}>Merr certifikatën TEST</button></div>{verification&&<p className="notice" style={{marginTop:12}}>Biznesi i verifikuar: {verification.businessName}. Kodi i verifikimit u ruajt në konfigurimin e POS-it.</p>}<p className="footer">Çelësi privat dhe certifikata ruhen në kompjuterin Windows. Fiskalo nuk i ngarkon çelësat privatë në cloud.</p></section></div>}
    {tab==="pos"&&<div className="grid" style={{gridTemplateColumns:"minmax(280px,1.5fr) minmax(260px,1fr)"}}><section className="panel"><div className="row" style={{justifyContent:"space-between"}}><h2>Artikujt</h2><span className="eyebrow">{products.length} artikuj</span></div>{products.length===0?<p className="sub">Shto artikujt fillimisht te skeda Artikujt.</p>:<div className="grid" style={{gridTemplateColumns:"repeat(auto-fit,minmax(150px,1fr))"}}>{products.map(p=><button key={p.id} className="tile" style={{minHeight:110}} onClick={()=>changeCart(p,1)}><span className="icon">+</span><strong>{p.name}</strong><p>€{(Number(p.price)*(1+Number(p.vat_rate)/100)).toFixed(2)} · stok {p.stock}</p></button>)}</div>}</section><section className="panel"><h2>Shporta</h2>{cartLines.map(line=><div key={line.product.id} className="row" style={{justifyContent:"space-between",padding:"9px 0",borderBottom:"1px solid var(--line)"}}><div><strong>{line.product.name}</strong><div className="sub" style={{fontSize:12}}>Sasia: {line.quantity}</div></div><div className="row"><button className="btn secondary" onClick={()=>changeCart(line.product,-1)}>-</button><button className="btn secondary" onClick={()=>changeCart(line.product,1)}>+</button></div></div>)}<div className="field"><label>POS</label><select value={selectedPos} onChange={e=>setSelectedPos(e.target.value)}><option value="">Zgjidh POS</option>{positions.map(p=><option key={p.id} value={p.id}>{p.label}</option>)}</select></div><div className="field"><label>Pagesa</label><select value={payment} onChange={e=>setPayment(e.target.value)}><option value="cash">Cash</option><option value="card">Kartelë</option><option value="bank_transfer">Transfer bankar</option></select></div><div className="row" style={{justifyContent:"space-between",margin:"18px 0"}}><strong>Totali</strong><strong className="stat">€{total.toFixed(2)}</strong></div><button className="btn" style={{width:"100%"}} disabled={busy||!cartLines.length||!selectedPos} onClick={completeSale}>{busy?"Duke ruajtur…":"Regjistro pagesën"}</button><p className="footer">Pa certifikatë TEST aktive dhe POS Agent të lidhur, pagesa ruhet por nuk është kupon fiskal. Production nuk është aktivizuar.</p></section></div>}
    <section className="panel" style={{marginTop:18}}><div className="row" style={{justifyContent:"space-between"}}><div><div className="eyebrow">Gjendja e ATK</div><h3 style={{margin:"7px 0"}}>Integrimi në zhvillim</h3></div><span className="status">TEST · jo i certifikuar</span></div><p className="sub" style={{margin:0}}>Fiskalo nuk shënon kupon si fiskalizuar pa përgjigje të pranuar nga ATK dhe transaction_id të ruajtur.</p></section>
    <p className="footer">Fiskalo Basic ATK MVP · Provider authorization and formal ATK certification are external release gates.</p>
    <style jsx global>{`@media print{body *{visibility:hidden!important}.receipt,.receipt *{visibility:visible!important}.receipt{position:absolute!important;left:0!important;top:0!important;width:80mm!important;max-width:80mm!important;margin:0!important;padding:4mm!important;box-shadow:none!important;border:0!important}.no-print{display:none!important}@page{size:80mm auto;margin:0}}`}</style>
  </main>;
}
