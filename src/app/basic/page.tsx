"use client";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { User } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";
import BusinessOperations from "@/components/business-operations";
import { createOrLoadPosCsr, installPosCertificate, hasMatchingPosCertificate, getPosCertificatePem, signAtkBase64Payload, generateNuiKf } from "@/lib/atk/browser-runtime";
import { encodeAtkPosCoupon, encodeAtkCitizenCoupon, encodeAtkBase64 } from "@/lib/atk/protobuf";
import { verifyCloudTestPos, issueCloudTestCertificate, submitCloudTestCoupon, queueCloudTestCoupon, reserveCloudCorrection, submitCloudCorrection, queueCloudCorrection, CloudAtkError } from "@/lib/pos/cloud-atk";
import { createCitizenQrSvg } from "@/lib/atk/citizen-qr";
import { saveFiscalOutboxItem, listFiscalOutboxItems, updateFiscalOutboxItem, getOrStartPosConnectivityOutage, clearPosConnectivityOutage, outageRecoveryDeadline } from "@/lib/pos/browser-outbox";
import { ATK_VAT_CLASSIFICATIONS, getAtkVatRate, isAtkVatCode, isValidAtkVatClassification, type AtkVatCode } from "@/lib/atk/product-tax";
import { ATK_MEASUREMENT_UNITS, isAtkUnitCode, normalizeAtkUnitCode } from "@/lib/atk/product-units";
import { ATK_ITEM_CATEGORIES, getAtkItemCategoryLabel, isAtkItemCategoryCode } from "@/lib/atk/product-categories";
import { buildPaymentAllocations, formatPaymentAllocations, paymentMethodLabel, toAtkPaymentType, type AdditionalPaymentMethod } from "@/lib/atk/payment-allocation";

type Business={id:string;name:string;nui:string;vat_number:string|null};
type AtkVerification={businessName:string;verificationCode:string;environment:"ATK TEST";productionEnabled:false};
type Product={id:string;name:string;price:number;stock:number;vat_rate:number;atk_unit_code:string;atk_item_category_code:string;atk_vat_code:string};
type Pos={id:string;label:string;location:string;branch_id:number;pos_id:number;unit_number:string|null;fiscalization_number:string;application_id:string|null;verification_no:string|null;verified_business_name:string|null;certificate_status:string};
type CartLine={product:Product;quantity:number};
type SaleRecord={id:string;coupon_id:number;status:string;subtotal:number;vat_total:number;total:number;payment_method:string;payment_allocations?:Array<{method:string;amount_cents:number}>|null;created_at:string;pos_id:string;operator_id:string;daily_number:number|null;idempotency_key?:string|null;items:Array<{description:string;quantity:number;unit_price:number;line_total:number;line_net?:number;line_vat?:number;vat_rate?:number;atk_unit_code?:string;atk_vat_code?:string;atk_item_category_code?:string}>;transaction_id:string|null;nui_kf?:string|null;verification_no?:string|null;legacy_nui_kf?:string|null;submission_state?:string|null;offline_issued_at?:string|null;recovery_deadline_at?:string|null;qr_svg_base64?:string|null;pos_identifier?:string|null;business_address?:string|null;unit_name?:string|null;unit_code?:number|null;pos_number?:number|null;unit_number?:string|null;operator_name?:string|null;operator_identifier?:string|null;document_type?:string;is_offline?:boolean;recovery_deadline_exceeded?:boolean;queue_last_error?:string|null;correction_type?:string|null;correction_state?:string|null;correction_transaction_id?:string|null;reference_coupon_id?:number|null;reference_transaction_id?:string|null;correction_coupon_id?:number|null;correction_nui_kf?:string|null;correction_daily_number?:number|null;correction_qr_svg_base64?:string|null;correction_offline_issued_at?:string|null;correction_recovery_deadline_at?:string|null;correction_reference_coupon_id?:number|null;correction_document_type?:number|null;is_copy?:boolean};
type Tab="pos"|"products"|"purchases"|"atk"|"sales";
type MemberRole="owner"|"cashier";
type WorkerMember={userId:string;email:string|null;role:MemberRole;operatorName:string|null;createdAt:string};

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
  const [workers,setWorkers]=useState<WorkerMember[]>([]);
  const [workerEmail,setWorkerEmail]=useState("");
  const [workersError,setWorkersError]=useState("");
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
  const [vatCode,setVatCode]=useState<AtkVatCode>("E");
  const [unitCode,setUnitCode]=useState("CP");
  const [categoryCode,setCategoryCode]=useState("");
  const [editingProductId,setEditingProductId]=useState<string|null>(null);
  const [posLabel,setPosLabel]=useState("Arka 1");
  const [posLocation,setPosLocation]=useState("");
  const [unitNumber,setUnitNumber]=useState("");
  const [unitNumberEdits,setUnitNumberEdits]=useState<Record<string,string>>({});

  const [branchId,setBranchId]=useState("1");
  const [posId,setPosId]=useState("1");
  const [fiscalizationNumber,setFiscalizationNumber]=useState("");
  const [applicationId,setApplicationId]=useState("");
  const [selectedPos,setSelectedPos]=useState("");
  const [verification,setVerification]=useState<AtkVerification|null>(null);
  const [cart,setCart]=useState<Record<string,CartLine>>({});
  const [checkoutKey,setCheckoutKey]=useState("");
  const [checkoutAttempted,setCheckoutAttempted]=useState(false);
  const [checkoutDraftLoaded,setCheckoutDraftLoaded]=useState(false);
  const [additionalPayments,setAdditionalPayments]=useState<Array<{id:string;method:AdditionalPaymentMethod;amount:string}>>([]);
  const [productSearch,setProductSearch]=useState("");
  const [selectedCategory,setSelectedCategory]=useState("all");
  const [isPosFullscreen,setIsPosFullscreen]=useState(false);

  const supabase=useMemo(()=>{try{return createClient()}catch{return null}},[]);
  const loadWorkspace=useCallback(async(uid:string)=>{
    if(!supabase)return;
    const {data:member,error:memberError}=await supabase.from("fiskalo_basic_members").select("business_id,role,operator_name,operator_identifier").eq("user_id",uid).limit(1).maybeSingle();
    if(memberError)throw memberError;
    if(!member){setBusiness(null);setMemberRole(null);setWorkers([]);setWorkersError("");setOperatorName("");setOperatorIdentifier("");setProducts([]);setPositions([]);setSelectedPos("");return;}
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
  },[supabase]);

  const loadWorkers=useCallback(async()=>{
    if(!supabase||!business||memberRole!=="owner"){setWorkers([]);setWorkersError("");return;}
    const {data,error}=await supabase.functions.invoke("fiskalo-basic-workers",{body:{action:"list",businessId:business.id}});
    if(error)throw error;
    setWorkers((data?.members??[]) as WorkerMember[]);
    setWorkersError("");
  },[supabase,business,memberRole]);

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
        supabase.from("fiskalo_basic_sale_items").select("sale_id,description,quantity,unit_price,line_total,line_net,line_vat,vat_rate,atk_unit_code,atk_vat_code,atk_item_category_code").in("sale_id",ids),
        supabase.from("fiskalo_basic_fiscal_documents").select("sale_id,atk_transaction_id,coupon_id,nui_kf,legacy_nui_kf,daily_number,submission_state,offline_issued_at,recovery_deadline_at,document_type,qr_svg_base64,reference_coupon_id,parent_document_id,created_at").in("sale_id",ids),
        supabase.from("fiskalo_basic_members").select("user_id,operator_name").eq("business_id",business.id)
      ]);
      if(itemError)throw itemError;if(documentError)throw documentError;
      const itemsBySale=new Map<string,SaleRecord["items"]>();
      for(const item of itemRows??[]){const list=itemsBySale.get(item.sale_id)??[];list.push(item);itemsBySale.set(item.sale_id,list);}
      const docsBySale=new Map<string,typeof documents>();
      for(const doc of documents??[]){const list=docsBySale.get(doc.sale_id)??[];list.push(doc);docsBySale.set(doc.sale_id,list);}
      const operatorNames=new Map((members??[]).map(member=>[member.user_id,member.operator_name]));
      const localOutbox=await listFiscalOutboxItems(business.id).catch(()=>[]);
      const saleOutboxBySale=new Map(localOutbox.filter(item=>item.documentType===1).map(item=>[item.saleId,item]));
      const correctionOutboxBySale=new Map(localOutbox.filter(item=>item.documentType!==1).map(item=>[item.saleId,item]));
      setQueueOverdueCount(localOutbox.filter(item=>item.state!=="accepted"&&Date.parse(item.recoveryDeadlineUtc)<Date.now()).length);
      setSales(rows.map(s=>{
        const pos=positions.find(p=>p.id===s.pos_id);
        const idempotencyKey=pos?business.nui+":"+pos.branch_id+":"+pos.pos_id+":"+s.coupon_id:"";
        const saleOutbox=saleOutboxBySale.get(s.id);
        const correctionOutbox=correctionOutboxBySale.get(s.id);
        const saleDocs=docsBySale.get(s.id)??[];
        const doc=saleDocs.find(item=>item.document_type===1);
        const correctionDoc=saleDocs.filter(item=>item.document_type===2||item.document_type===3).sort((a,b)=>Date.parse(b.created_at)-Date.parse(a.created_at))[0];
        return {
          ...s,
          idempotency_key:idempotencyKey,
          items:itemsBySale.get(s.id)??[],
          transaction_id:String(doc?.atk_transaction_id??saleOutbox?.transactionId??"")||null,
          nui_kf:doc?.nui_kf??saleOutbox?.nuiKf??null,
          legacy_nui_kf:doc?.legacy_nui_kf??null,
          daily_number:doc?.daily_number??s.daily_number??saleOutbox?.dailyNumber??null,
          submission_state:doc?.submission_state??(saleOutbox?.state==="prepared"?"needs_reconciliation":saleOutbox?.state==="cloud_queued"?"queued":saleOutbox?.state??null),
          offline_issued_at:doc?.offline_issued_at??saleOutbox?.offlineIssuedAtUtc??null,
          recovery_deadline_at:doc?.recovery_deadline_at??saleOutbox?.recoveryDeadlineUtc??null,
          qr_svg_base64:doc?.qr_svg_base64??saleOutbox?.qrSvg??null,
          pos_identifier:pos?.unit_number?pos.unit_number+"-"+business.nui+"-"+String(pos.pos_id):null,
          unit_number:pos?.unit_number??null,
          business_address:pos?.location??null,
          unit_name:pos?.label??null,
          operator_name:s.operator_name??operatorNames.get(s.operator_id)??(user?.id===s.operator_id?(operatorName||"Nuk është konfiguruar"):"Nuk është konfiguruar"),
          operator_identifier:s.operator_identifier??null,
          document_type:doc?.document_type===2?"ANULIM":doc?.document_type===3?"KTHIM":"SHITJE",
          is_offline:!!(doc?.offline_issued_at??saleOutbox?.offlineIssuedAtUtc),
          recovery_deadline_exceeded:!!saleOutbox&&Date.parse(saleOutbox.recoveryDeadlineUtc)<Date.now()&&saleOutbox.state!=="accepted",
          queue_last_error:saleOutbox?.lastError??null,
          correction_type:correctionDoc?.document_type===2?"ANULIM":correctionDoc?.document_type===3?"KTHIM I PLOTË":correctionOutbox?.documentType===2?"ANULIM":correctionOutbox?.documentType===3?"KTHIM I PLOTË":null,
          correction_state:correctionDoc?.submission_state??correctionOutbox?.state??null,
          correction_transaction_id:String(correctionDoc?.atk_transaction_id??correctionOutbox?.transactionId??"")||null,
          correction_coupon_id:correctionDoc?.coupon_id??correctionOutbox?.couponId??null,
          correction_nui_kf:correctionDoc?.nui_kf??correctionOutbox?.nuiKf??null,
          correction_daily_number:correctionDoc?.daily_number??correctionOutbox?.dailyNumber??null,
          correction_qr_svg_base64:correctionDoc?.qr_svg_base64??correctionOutbox?.qrSvg??null,
          correction_offline_issued_at:correctionDoc?.offline_issued_at??correctionOutbox?.offlineIssuedAtUtc??null,
          correction_recovery_deadline_at:correctionDoc?.recovery_deadline_at??correctionOutbox?.recoveryDeadlineUtc??null,
          correction_reference_coupon_id:correctionDoc?.reference_coupon_id??correctionOutbox?.originalCouponId??null,
          correction_document_type:correctionDoc?.document_type??correctionOutbox?.documentType??null
        };
      }));
    }catch(e){setMessage(e instanceof Error?e.message:"Nuk u ngarkua historia e shitjeve.");}
    finally{setBusy(false);}
  },[supabase,business,positions,user,operatorName]);


  useEffect(()=>{
    if(!business||!selectedPos)return;
    const recordOutage=()=>{
      void getOrStartPosConnectivityOutage(business.id,selectedPos).catch(error=>
        setMessage(error instanceof Error?error.message:"Nuk u ruajt koha e ndërprerjes së lidhjes.")
      );
    };
    window.addEventListener("offline",recordOutage);
    if(!navigator.onLine)recordOutage();
    return()=>window.removeEventListener("offline",recordOutage);
  },[business,selectedPos]);

  useEffect(()=>{
    if(!business||!supabase||!user)return;
    let running=false;
    let active=true;
    const syncKnownUnsentQueue=async()=>{
      if(running||!navigator.onLine)return;
      running=true;
      try{
        const queued=(await listFiscalOutboxItems(business.id)).filter(item=>item.state==="queued");
        const touchedPosIds=new Set<string>();
        for(const item of queued){
          touchedPosIds.add(item.posRecordId);
          if(!active||!navigator.onLine)break;
          const recoveryOverdue=Date.parse(item.recoveryDeadlineUtc)<=Date.now();
          // The 48-hour point is an escalation/notification deadline, not permission
          // to discard or stop synchronizing a signed fiscal document. The local
          // Agent continues safe delivery; cloud sync must preserve the evidence.
          try{
            if(item.documentType===1){
              await queueCloudTestCoupon(supabase,{
                businessId:item.businessId,posRecordId:item.posRecordId,saleId:item.saleId,
                couponId:item.couponId,idempotencyKey:item.idempotencyKey,
                details:item.detailsBase64,signature:item.signatureBase64,certificatePem:item.certificatePem,nuiKf:item.nuiKf,
                citizenPayload:item.citizenPayloadBase64,citizenSignature:item.citizenSignatureBase64,
                dailyNumber:item.dailyNumber,verificationNo:item.nuiKf,
                offlineIssuedAt:item.offlineIssuedAtUtc??item.issuedAtUtc
              });
            }else{
              if(!item.originalCouponId||!item.originalTransactionId)throw new Error("Correction reference is missing from the local outbox.");
              await queueCloudCorrection(supabase,{
                businessId:item.businessId,posRecordId:item.posRecordId,saleId:item.saleId,
                correctionCouponId:item.couponId,originalCouponId:item.originalCouponId,
                originalTransactionId:item.originalTransactionId,documentType:item.documentType as 2|3,
                idempotencyKey:item.idempotencyKey,details:item.detailsBase64,signature:item.signatureBase64,
                certificatePem:item.certificatePem,nuiKf:item.nuiKf,dailyNumber:item.dailyNumber,
                unixTime:Math.floor(Date.parse(item.issuedAtUtc)/1000),
                citizenPayload:item.citizenPayloadBase64,citizenSignature:item.citizenSignatureBase64,
                offlineIssuedAt:item.offlineIssuedAtUtc??item.issuedAtUtc
              });
            }
            await updateFiscalOutboxItem(item.idempotencyKey,{
              state:"cloud_queued",transactionId:null,
              lastError:recoveryOverdue
                ?"Afati 48-orësh ka kaluar. Dokumenti u ruajt në radhën cloud; ndiq procedurën përkatëse të nenit 44 dhe mos e ridërgo manualisht."
                :null
            });
          }catch(error){
            const conflict=error instanceof CloudAtkError&&[400,401,403,409,422].includes(error.httpStatus);
            await updateFiscalOutboxItem(item.idempotencyKey,{
              state:conflict?"needs_reconciliation":"queued",
              lastError:error instanceof Error?error.message:"Ngarkimi i radhës dështoi; do të provohet përsëri kur lidhja të rikthehet."
            });
          }
        }
        if(active){
          const remaining=(await listFiscalOutboxItems(business.id)).filter(item=>
            item.state==="queued"||item.state==="needs_reconciliation"
          );
          for(const posRecordId of touchedPosIds){
            if(!remaining.some(item=>item.posRecordId===posRecordId)){
              await clearPosConnectivityOutage(business.id,posRecordId).catch(()=>undefined);
            }
          }
        }
        if(active&&tab==="sales")void loadSales();
      }catch(error){
        if(active)setMessage(error instanceof Error?error.message:"Radha lokale e fiskalizimit nuk u sinkronizua.");
      }finally{running=false;}
    };
    window.addEventListener("online",syncKnownUnsentQueue);
    void syncKnownUnsentQueue();
    return()=>{active=false;window.removeEventListener("online",syncKnownUnsentQueue);};
  },[business,supabase,user,tab,loadSales]);

  useEffect(()=>{
    if(!supabase){setConfigured(false);setLoading(false);return;}
    supabase.auth.getUser().then(async({data,error})=>{
      if(error){setMessage(error.message);setLoading(false);return;}
      setUser(data.user);
      if(data.user){try{await loadWorkspace(data.user.id)}catch(e){setMessage(e instanceof Error?e.message:"Nuk u ngarkua hapësira.")}}
      setLoading(false);
    });
    const {data:{subscription}}=supabase.auth.onAuthStateChange((_event,session)=>{setUser(session?.user??null);if(session?.user){void loadWorkspace(session.user.id).catch(e=>setMessage(e instanceof Error?e.message:"Nuk u ngarkua hapësira."));}else{setBusiness(null);setMemberRole(null);setWorkers([]);setWorkersError("");setProducts([]);setPositions([]);setSelectedPos("");}});
    return()=>subscription.unsubscribe();
  },[supabase,loadWorkspace]);

  useEffect(()=>{
    if(!business||memberRole!=="owner"){setWorkers([]);setWorkersError("");return;}
    void loadWorkers().catch(e=>setWorkersError(e instanceof Error?e.message:"Lista e punonjësve nuk u ngarkua."));
  },[business,memberRole,loadWorkers]);

  useEffect(()=>{
    if(!business)return;
    const storageKey="fiskalo.pendingCheckout."+business.id;
    const raw=sessionStorage.getItem(storageKey);
    if(!raw){setCheckoutDraftLoaded(true);return;}
    if(!products.length)return;
    try{
      const draft=JSON.parse(raw) as {key?:string;attempted?:boolean;lines?:Array<{productId?:string;quantity?:number}>;payment?:string;additionalPayments?:Array<{id?:string;method?:string;amount?:string}>;selectedPos?:string};
      if(!draft.key||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(draft.key)||!Array.isArray(draft.lines)){
        sessionStorage.removeItem(storageKey);setCheckoutDraftLoaded(true);return;
      }
      const restored:Record<string,CartLine>={};
      for(const line of draft.lines){
        const product=products.find(p=>p.id===line.productId);
        const quantity=Number(line.quantity);
        if(product&&Number.isFinite(quantity)&&quantity>0)restored[product.id]={product,quantity};
      }
      if(Object.keys(restored).length){
        setCart(restored);setCheckoutKey(draft.key);setCheckoutAttempted(!!draft.attempted);
        const restoredTotalCents=Object.values(restored).reduce((sum,line)=>{const net=Math.round(line.product.price*line.quantity*100);const vat=Math.round(net*line.product.vat_rate/100);return sum+net+vat;},0);
        if(Array.isArray(draft.additionalPayments)){
          const restoredPayments:Array<{id:string;method:AdditionalPaymentMethod;amount:string}>=[];
          draft.additionalPayments.forEach((item,index)=>{if(item&&typeof item.method==="string"&&["card","bank_transfer","voucher","cheque","crypto"].includes(item.method)&&typeof item.amount==="string"){restoredPayments.push({id:typeof item.id==="string"?item.id:"restored-"+index,method:item.method as AdditionalPaymentMethod,amount:item.amount});}});
          setAdditionalPayments(restoredPayments);
        }else if(draft.payment==="card"||draft.payment==="bank_transfer"){
          setAdditionalPayments([{id:"legacy-"+draft.payment,method:draft.payment,amount:(restoredTotalCents/100).toFixed(2)}]);
        }
        if(positions.some(p=>p.id===draft.selectedPos))setSelectedPos(draft.selectedPos!);
      }else{
        sessionStorage.removeItem(storageKey);
      }
    }catch{
      sessionStorage.removeItem(storageKey);
    }finally{
      setCheckoutDraftLoaded(true);
    }
  },[business,products,positions]);

  useEffect(()=>{
    if(!business||!checkoutDraftLoaded)return;
    const storageKey="fiskalo.pendingCheckout."+business.id;
    const lines=Object.values(cart).map(line=>({productId:line.product.id,quantity:line.quantity}));
    if(!checkoutKey||!lines.length){sessionStorage.removeItem(storageKey);return;}
    try{sessionStorage.setItem(storageKey,JSON.stringify({key:checkoutKey,attempted:checkoutAttempted,lines,additionalPayments,selectedPos}));}catch{}
  },[business,cart,checkoutKey,checkoutAttempted,additionalPayments,selectedPos,checkoutDraftLoaded]);

  async function signIn(e:React.FormEvent){e.preventDefault();setBusy(true);setMessage("");try{const {error}=await supabase!.auth.signInWithPassword({email:(document.getElementById("email") as HTMLInputElement).value,password:(document.getElementById("password") as HTMLInputElement).value});if(error)throw error;}catch(e){setMessage(e instanceof Error?e.message:"Hyrja dështoi.");}finally{setBusy(false);}}
  async function createBusiness(e:React.FormEvent){e.preventDefault();setBusy(true);setMessage("");try{const {data,error}=await supabase!.rpc("fiskalo_basic_create_business",{p_name:businessName,p_nui:nui});if(error)throw error;await loadWorkspace(user!.id);setMessage("Biznesi u krijua.");}catch(e){setMessage(e instanceof Error?e.message:"Biznesi nuk u krijua. Kontrollo nëse migrimet janë aplikuar.");}finally{setBusy(false);}}
  async function saveOperatorIdentity(e:React.FormEvent){e.preventDefault();if(!business)return;setBusy(true);setMessage("");try{const {error}=await supabase!.rpc("fiskalo_basic_set_operator_identity",{p_business_id:business.id,p_operator_name:operatorName.trim(),p_operator_identifier:operatorIdentifier.trim()});if(error)throw error;setMessage("Emri dhe identifikuesi i operatorit u ruajtën për kuponët e ardhshëm.");}catch(e){setMessage(e instanceof Error?e.message:"Identiteti i operatorit nuk u ruajt.");}finally{setBusy(false);}}
  async function saveTaxProfile(e:React.FormEvent){e.preventDefault();if(!business)return;setBusy(true);setMessage("");try{const {error}=await supabase!.rpc("fiskalo_basic_update_business_tax_profile",{p_business_id:business.id,p_vat_number:vatNumber.trim()||null});if(error)throw error;setBusiness({...business,vat_number:vatNumber.trim()||null});setMessage("Numri i TVSH-së u ruajt për kuponët e ardhshëm.");}catch(e){setMessage(e instanceof Error?e.message:"Të dhënat tatimore nuk u ruajtën.");}finally{setBusy(false);}}
  async function inviteWorker(e:React.FormEvent){
    e.preventDefault();
    if(!business||memberRole!=="owner"||!supabase)return;
    const email=workerEmail.trim().toLowerCase();
    const parts=email.split("@");
    if(email.length>254||parts.length!==2||!parts[0]||!parts[1]?.includes(".")||parts[1].startsWith(".")||parts[1].endsWith(".")){
      setWorkersError("Shkruaj një adresë email të vlefshme.");
      return;
    }
    setBusy(true);setMessage("");setWorkersError("");
    try{
      const {data,error}=await supabase.functions.invoke("fiskalo-basic-workers",{body:{action:"invite",businessId:business.id,email}});
      if(error)throw error;
      setWorkerEmail("");
      await loadWorkers();
      if(data?.alreadyMember)setMessage("Ky përdorues është tashmë anëtar i biznesit.");
      else if(data?.invited)setMessage("Ftesa u dërgua në "+email+". Punonjësi duhet ta pranojë lidhjen e email-it para hyrjes.");
      else if(data?.delivery==="not_confirmed")setMessage("Llogaria u lidh me biznesin, por dërgimi i email-it nuk u konfirmua. Kontrollo konfigurimin e email-it në Supabase.");
      else setMessage("Llogaria ekzistuese u shtua si arkëtare. Punonjësi mund të hyjë me llogarinë e vet.");
    }catch(e){setWorkersError(e instanceof Error?e.message:"Ftesa e punonjësit dështoi.");}
    finally{setBusy(false);}
  }

  function resetProductForm(){
    setEditingProductId(null);setProductName("");setProductPrice("1.00");setProductStock("0");
    setVatCode("E");setUnitCode("CP");setCategoryCode("");
  }
  function startEditProduct(product:Product){
    if(!isAtkVatCode(product.atk_vat_code)||!isValidAtkVatClassification(product.atk_vat_code,Number(product.vat_rate))){
      setMessage("Produkti ka klasifikim TVSH-je të pavlefshëm. Korrigjoje para se ta ndryshosh.");
      return;
    }
    setEditingProductId(product.id);setProductName(product.name);setProductPrice(String(product.price));
    setProductStock(String(product.stock));setVatCode(product.atk_vat_code);
    setUnitCode(product.atk_unit_code);setCategoryCode(product.atk_item_category_code);
  }
  async function addProduct(e:React.FormEvent){
    e.preventDefault();if(!business)return;
    const payload={name:productName.trim(),price:Number(productPrice),vat_rate:getAtkVatRate(vatCode),
      atk_vat_code:vatCode,atk_unit_code:normalizeAtkUnitCode(unitCode)??"",atk_item_category_code:categoryCode.trim()};
    if(!payload.name||!Number.isFinite(payload.price)||payload.price<0||!Number.isFinite(Number(productStock))||Number(productStock)<0||
       !isAtkUnitCode(payload.atk_unit_code)||!isAtkItemCategoryCode(payload.atk_item_category_code)||
       !isValidAtkVatClassification(payload.atk_vat_code,payload.vat_rate)){setMessage("Plotëso emrin, çmimin, stokun dhe kodet fiskale me një klasifikim të vlefshëm ATK.");return;}
    setBusy(true);setMessage("");
    try{
      if(editingProductId){
        const {data,error}=await supabase!.from("fiskalo_basic_products").update(payload)
          .eq("id",editingProductId).eq("business_id",business.id).select("id").maybeSingle();
        if(error)throw error;if(!data)throw new Error("Artikulli nuk u gjet ose nuk ke leje ta ndryshosh.");
      }else{
        const {data:created,error}=await supabase!.from("fiskalo_basic_products").insert({business_id:business.id,...payload,stock:0}).select("id").single();
        if(error)throw error;
        if(Number(productStock)>0){const {error:stockError}=await supabase!.from("fiskalo_basic_stock_movements").insert({business_id:business.id,product_id:created.id,movement_type:"adjustment",quantity_delta:Number(productStock),reason:"Stoku fillestar",created_by:user!.id});if(stockError)throw stockError;}
      }
      resetProductForm();await loadWorkspace(user!.id);
      setMessage(editingProductId?"Artikulli u përditësua.":"Artikulli u ruajt.");
    }catch(e){setMessage(e instanceof Error?e.message:"Artikulli nuk u ruajt.");}
    finally{setBusy(false);}
  }
  async function archiveProduct(product:Product){
    if(!business||!window.confirm("Hiqe "+product.name+" nga katalogu? Historiku i shitjeve dhe kuponët e vjetër do të ruhen."))return;
    setBusy(true);setMessage("");
    try{
      const {data,error}=await supabase!.from("fiskalo_basic_products").update({active:false})
        .eq("id",product.id).eq("business_id",business.id).select("id").maybeSingle();
      if(error)throw error;if(!data)throw new Error("Artikulli nuk u gjet ose nuk ke leje ta heqësh.");
      if(editingProductId===product.id)resetProductForm();
      await loadWorkspace(user!.id);setMessage("Artikulli u hoq nga katalogu; historiku i shitjeve mbetet i pandryshuar.");
    }catch(e){setMessage(e instanceof Error?e.message:"Artikulli nuk u hoq nga katalogu.");}
    finally{setBusy(false);}
  }
  function exportSalesCsv(){
    if(!sales.length)return;
    const quote=(value:unknown)=>'"'+String(value??"").replace(/"/g,'""')+'"';
    const headers=["Kuponi","Data","Statusi i pageses","Statusi ATK","Ndarja e pagesës","Neto EUR","TVSH EUR","Totali EUR","Transaction ID","NUIKF","Numri ditor","Artikujt"];
    const rows=sales.map(s=>[
      s.coupon_id,s.created_at,s.status,s.submission_state??"not_confirmed",formatPaymentAllocations(s.payment_allocations??[{method:s.payment_method,amount_cents:Math.round(Number(s.total)*100)}]),
      Number(s.subtotal).toFixed(2),Number(s.vat_total).toFixed(2),Number(s.total).toFixed(2),
      s.transaction_id??"",s.nui_kf??"",s.daily_number??"",
      s.items.map(item=>item.description+" x "+item.quantity+" @ "+Number(item.unit_price).toFixed(4)).join("; ")
    ]);
    const csv="\uFEFF"+[headers,...rows].map(row=>row.map(quote).join(",")).join("\r\n");
    const url=URL.createObjectURL(new Blob([csv],{type:"text/csv;charset=utf-8"}));
    const link=document.createElement("a");link.href=url;link.download="fiskalo-shitjet-50-te-fundit-"+new Date().toISOString().slice(0,10)+".csv";
    document.body.appendChild(link);link.click();link.remove();window.setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  async function issueCorrection(sale:SaleRecord,documentType:2|3){
    if(!business||!supabase||!user)return;
    if(sale.status!=="fiscalized"||!sale.transaction_id){
      setMessage("Vetëm një shitje e pranuar nga ATK mund të anulohet ose kthehet.");
      return;
    }
    const label=documentType===2?"ANULIM":"KTHIM I PLOTË";
    if(!window.confirm("Konfirmo "+label.toLowerCase()+" të plotë për kuponin #"+sale.coupon_id+"? Ky veprim do të dërgohet në ATK TEST."))return;
    const pos=positions.find(p=>p.id===sale.pos_id);
    if(!pos||pos.certificate_status!=="certificate_issued"||!pos.application_id){
      setMessage("POS-i origjinal nuk ka certifikatë ATK TEST aktive.");
      return;
    }
    setBusy(true);setMessage("");
    const correctionKeyStorage="fiskalo.pendingCorrection."+sale.id+"."+documentType;
    let idempotencyKey=localStorage.getItem(correctionKeyStorage)||crypto.randomUUID();
    localStorage.setItem(correctionKeyStorage,idempotencyKey);
    try{
      const identity={businessNui:business.nui,branchId:pos.branch_id,posId:pos.pos_id,businessName:pos.verified_business_name||business.name};
      if(!await hasMatchingPosCertificate(identity))throw new Error("Çelësi privat dhe certifikata ATK nuk përputhen në këtë shfletues.");
      const certificatePem=await getPosCertificatePem(identity);
      idempotencyKey=crypto.randomUUID();
      const reservation=await reserveCloudCorrection(supabase,{
        businessId:business.id,saleId:sale.id,documentType,idempotencyKey
      });
      const correctionCouponId=Number(reservation.correctionCouponId);
      const dailyNumber=Number(reservation.dailyNumber);
      const originalCouponId=Number(reservation.originalCouponId);
      const originalTransactionId=String(reservation.originalTransactionId);
      if(!Number.isSafeInteger(correctionCouponId)||correctionCouponId<=0||!Number.isSafeInteger(dailyNumber)||dailyNumber<=0)throw new Error("ATK nuk rezervoi numër unik për kuponin korrigjues.");
      const nuiKf=generateNuiKf();
      const unixTime=Math.floor(Date.now()/1000);
      const cents=(value:number)=>Math.round(Number(value)*100);
      const grouped=new Map<string,{taxRate:string;base:number;tax:number}>();
      for(const line of sale.items){
        const taxRate=line.atk_vat_code??"E";
        const group=grouped.get(taxRate)??{taxRate,base:0,tax:0};
        group.base+=cents(line.line_net??(line.line_total/(1+(Number(line.vat_rate??0)/100))));
        group.tax+=cents(line.line_vat??(line.line_total-(line.line_net??(line.line_total/(1+(Number(line.vat_rate??0)/100))))));
        grouped.set(taxRate,group);
      }
      const taxGroups=Array.from(grouped.values()).map(group=>({taxRate:group.taxRate,totalForTaxCents:group.base,totalTaxCents:group.tax}));
      if(!taxGroups.length)throw new Error("Shitja origjinale nuk ka grupe të vlefshme TVSH-je.");
      const paymentAllocations=sale.payment_allocations?.length?sale.payment_allocations:[{method:sale.payment_method,amount_cents:cents(sale.total)}];
      const coupon={
        businessId:BigInt(business.nui),couponId:correctionCouponId,branchId:pos.branch_id,
        location:pos.location,operatorId:sale.operator_name??operatorName.trim(),
        posId:pos.pos_id,applicationId:Number(pos.application_id),verificationNo:nuiKf,
        type:documentType,unixTime,
        items:sale.items.map(line=>({
          name:line.description,unitPriceEuro:Number(line.unit_price),unit:line.atk_unit_code??"CP",
          quantity:Number(line.quantity),lineTotalCents:cents(line.line_total),
          taxRate:line.atk_vat_code??"E",itemType:line.atk_item_category_code??"TT"
        })),
        payments:paymentAllocations.map(item=>({type:toAtkPaymentType(item.method as "cash"|"card"|"bank_transfer"|"voucher"|"cheque"|"crypto"),amountCents:Number(item.amount_cents)})),
        totalCents:cents(sale.total),taxGroups,totalTaxCents:cents(sale.vat_total),
        totalNoTaxCents:cents(sale.subtotal),totalDiscountCents:0,
        referenceNo:originalCouponId
      };
      const detailsBase64=encodeAtkBase64(encodeAtkPosCoupon(coupon));
      const signatureBase64=await signAtkBase64Payload(identity,detailsBase64);
      const citizenPayloadBase64=encodeAtkBase64(encodeAtkCitizenCoupon({
        businessId:BigInt(business.nui),couponId:correctionCouponId,branchId:pos.branch_id,posId:pos.pos_id,
        verificationNo:nuiKf,type:documentType,unixTime,totalCents:cents(sale.total),
        taxGroups,totalTaxCents:cents(sale.vat_total),totalNoTaxCents:cents(sale.subtotal)
      }));
      const citizenSignatureBase64=await signAtkBase64Payload(identity,citizenPayloadBase64);
      const qrSvgBase64=encodeAtkBase64(new TextEncoder().encode(await createCitizenQrSvg(citizenPayloadBase64+"|"+citizenSignatureBase64)));
      const issuedAtUtc=new Date(unixTime*1000).toISOString();
      const recoveryDeadlineUtc=new Date(Date.parse(issuedAtUtc)+48*60*60*1000).toISOString();
      await saveFiscalOutboxItem({
        businessId:business.id,posRecordId:pos.id,saleId:sale.id,couponId:correctionCouponId,
        originalCouponId,originalTransactionId,idempotencyKey,detailsBase64,signatureBase64,
        certificatePem,nuiKf,verificationNo:nuiKf,citizenPayloadBase64,citizenSignatureBase64,citizenQrPayload:citizenPayloadBase64+"|"+citizenSignatureBase64,
        dailyNumber,issuedAtUtc,offlineIssuedAtUtc:null,recoveryDeadlineUtc,
        documentType,state:"prepared",transactionId:null,lastError:null,qrSvg:qrSvgBase64
      });
      const correctionInput={
        businessId:business.id,posRecordId:pos.id,saleId:sale.id,correctionCouponId,
        originalCouponId,originalTransactionId,documentType,idempotencyKey,
        details:detailsBase64,signature:signatureBase64,certificatePem,nuiKf,dailyNumber,unixTime,
        citizenPayload:citizenPayloadBase64,citizenSignature:citizenSignatureBase64,offlineIssuedAt:null
      };
      let queuedOffline=false;
      let transactionId:string|null=null;
      let qrToPrint=qrSvgBase64;
      if(!navigator.onLine){
        queuedOffline=true;
        const outage=await getOrStartPosConnectivityOutage(business.id,pos.id);
        const outageDeadline=outageRecoveryDeadline(outage.startedAt);
        await updateFiscalOutboxItem(idempotencyKey,{
          state:"queued",offlineIssuedAtUtc:outage.startedAt,recoveryDeadlineUtc:outageDeadline,
          lastError:"Shfletuesi ishte offline; korrigjimi pret ngarkimin cloud."
        });
      }else{
        try{
          const result=await submitCloudCorrection(supabase,correctionInput);
          transactionId=result.transactionId;
          qrToPrint=result.qrSvgBase64;
          await updateFiscalOutboxItem(idempotencyKey,{state:"accepted",transactionId,qrSvg:qrToPrint,lastError:null});
        }catch(error){
          if(!(error instanceof CloudAtkError)||!error.notDelivered)throw error;
          const outage=await getOrStartPosConnectivityOutage(business.id,pos.id);
          const offlineIssuedAt=outage.startedAt;
          const outageDeadline=outageRecoveryDeadline(offlineIssuedAt);
          try{
            await queueCloudCorrection(supabase,{...correctionInput,offlineIssuedAt});
            queuedOffline=true;
            await updateFiscalOutboxItem(idempotencyKey,{state:"cloud_queued",offlineIssuedAtUtc:offlineIssuedAt,recoveryDeadlineUtc:outageDeadline,lastError:error.message});
          }catch(queueError){
            queuedOffline=true;
            await updateFiscalOutboxItem(idempotencyKey,{state:"queued",offlineIssuedAtUtc:offlineIssuedAt,recoveryDeadlineUtc:outageDeadline,lastError:queueError instanceof Error?queueError.message:error.message});
          }
        }
      }
      const receipt:SaleRecord={
        ...sale,coupon_id:correctionCouponId,created_at:issuedAtUtc,daily_number:dailyNumber,
        transaction_id:transactionId,nui_kf:nuiKf,verification_no:nuiKf,
        submission_state:queuedOffline?"queued":"accepted",offline_issued_at:queuedOffline?new Date().toISOString():null,
        recovery_deadline_at:queuedOffline?recoveryDeadlineUtc:null,qr_svg_base64:qrToPrint,
        document_type:label,correction_type:label,reference_coupon_id:originalCouponId,reference_transaction_id:originalTransactionId,
        correction_state:queuedOffline?"queued":"accepted",correction_transaction_id:transactionId,
        is_offline:queuedOffline,is_copy:false
      };
      localStorage.removeItem(correctionKeyStorage);
      setReceipt(receipt);
      setMessage(queuedOffline?label+" u ruajt për dërgim automatik në ATK TEST brenda 48 orëve.":"ATK TEST pranoi "+label.toLowerCase()+". Transaction ID: "+transactionId);
      await loadSales();
    }catch(error){
      if(idempotencyKey)await updateFiscalOutboxItem(idempotencyKey,{
        state:error instanceof CloudAtkError&&error.rejected?"rejected":"needs_reconciliation",
        lastError:error instanceof Error?error.message:"Korrigjimi nuk u konfirmua nga ATK."
      }).catch(()=>undefined);
      if(error instanceof CloudAtkError&&error.rejected)localStorage.removeItem(correctionKeyStorage);
      setMessage(error instanceof Error?error.message:"Korrigjimi ATK dështoi.");
    }finally{setBusy(false);}
  }

  async function verifyAtkPos(){
    const pos=positions.find(p=>p.id===selectedPos);
    if(!pos||!business||!supabase){setMessage("Zgjidh biznesin dhe POS-in.");return;}
    if(!pos.application_id){setMessage("Vendos Application ID TEST për këtë POS.");return;}
    setBusy(true);setMessage("");
    try{
      const result=await verifyCloudTestPos(supabase,{businessId:business.id,posRecordId:pos.id,fiscalizationNumber:pos.fiscalization_number,applicationId:Number(pos.application_id)});
      setVerification(result);
      const {error}=await supabase.from("fiskalo_basic_pos").update({verification_no:result.verificationCode,verified_business_name:result.businessName,certificate_status:"verified"}).eq("id",pos.id);
      if(error)throw error;
      await loadWorkspace(user!.id);
      setMessage("ATK TEST verifikoi POS-in. Tani mund të krijosh CSR dhe të kërkosh certifikatën në këtë shfletues.");
    }catch(e){setMessage(e instanceof Error?e.message:"Verifikimi ATK dështoi.");}
    finally{setBusy(false);}
  }
  async function requestAtkCertificate(){
    const pos=positions.find(p=>p.id===selectedPos);
    if(!pos||!business||!supabase||!pos.application_id||!pos.verification_no){setMessage("Kryej fillimisht verifikimin ATK për këtë POS.");return;}
    setBusy(true);setMessage("");
    try{
      const identity={businessNui:business.nui,branchId:pos.branch_id,posId:pos.pos_id,businessName:pos.verified_business_name||verification?.businessName||business.name};
      const {csrPem,existingKey}=await createOrLoadPosCsr(identity);
      const result=await issueCloudTestCertificate(supabase,{businessId:business.id,posRecordId:pos.id,verificationCode:pos.verification_no,applicationId:Number(pos.application_id),csrPem});
      await installPosCertificate(identity,result.signedCertificate);
      if(!await hasMatchingPosCertificate(identity))throw new Error("Certifikata ATK nuk përputhet me çelësin privat të ruajtur në këtë shfletues.");
      await loadWorkspace(user!.id);
      setMessage(existingKey?"Certifikata TEST u instalua dhe çelësi ekzistues i POS-it u verifikua.":"Certifikata TEST u instalua. Çelësi privat nuk u dërgua në cloud.");
    }catch(e){setMessage(e instanceof Error?e.message:"Lëshimi i certifikatës dështoi.");}
    finally{setBusy(false);}
  }
  async function addPos(e:React.FormEvent){e.preventDefault();if(!business)return;if(!/^[0-9]{7}$/.test(unitNumber.trim())){setMessage("Numri i njësisë ARBK duhet të ketë 7 shifra.");return;}setBusy(true);setMessage("");try{const {error}=await supabase!.from("fiskalo_basic_pos").insert({business_id:business.id,label:posLabel,location:posLocation,unit_number:unitNumber.trim(),branch_id:Number(branchId),pos_id:Number(posId),fiscalization_number:fiscalizationNumber,application_id:applicationId||null});if(error)throw error;setUnitNumber("");await loadWorkspace(user!.id);setMessage("POS-i u regjistrua në Fiskalo. Kjo nuk e verifikon automatikisht te ATK.");}catch(e){setMessage(e instanceof Error?e.message:"POS-i nuk u ruajt.");}finally{setBusy(false);}}
  async function savePosUnitNumber(posUuid:string){const value=(unitNumberEdits[posUuid]??positions.find(p=>p.id===posUuid)?.unit_number??"").trim();if(!/^[0-9]{7}$/.test(value)){setMessage("Numri i njësisë ARBK duhet të ketë 7 shifra.");return;}setBusy(true);setMessage("");try{const {error}=await supabase!.from("fiskalo_basic_pos").update({unit_number:value}).eq("id",posUuid);if(error)throw error;await loadWorkspace(user!.id);setUnitNumberEdits(current=>({...current,[posUuid]:value}));setMessage("Numri i njësisë ARBK u ruajt.");}catch(e){setMessage(e instanceof Error?e.message:"Numri i njësisë nuk u ruajt.");}finally{setBusy(false);}}
  function changeCart(product:Product,delta:number){if(checkoutAttempted){setMessage("Kjo shitje ka nisur. Mos e ndrysho shportën derisa të përfundojë fiskalizimi ose reconciliimi.");return;}setCheckoutKey(crypto.randomUUID());setCart(current=>{const next={...current};const qty=(next[product.id]?.quantity??0)+delta;if(qty<=0)delete next[product.id];else next[product.id]={product,quantity:qty};return next;});}
  const cartLines=Object.values(cart);
  const total=cartLines.reduce((sum,line)=>{const net=Math.round(line.product.price*line.quantity*100)/100;const vat=Math.round(net*line.product.vat_rate)/100;return sum+net+vat;},0);
  const totalCents=Math.round(total*100);
  const paymentResult=buildPaymentAllocations(totalCents,additionalPayments);
  const categoryOptions=useMemo(()=>Array.from(new Set(products.map(product=>product.atk_item_category_code).filter(Boolean))).sort((a,b)=>a.localeCompare(b)),[products]);
  const filteredProducts=useMemo(()=>{
    const query=productSearch.trim().toLocaleLowerCase("sq");
    return products.filter(product=>
      (selectedCategory==="all"||product.atk_item_category_code===selectedCategory)&&
      (!query||product.name.toLocaleLowerCase("sq").includes(query)||product.atk_item_category_code.toLocaleLowerCase("sq").includes(query))
    );
  },[products,productSearch,selectedCategory]);
  const cartQuantity=cartLines.reduce((sum,line)=>sum+line.quantity,0);
  const vatTotal=cartLines.reduce((sum,line)=>sum+line.product.price*line.quantity*line.product.vat_rate/100,0);

  useEffect(()=>{
    const syncFullscreen=()=>setIsPosFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange",syncFullscreen);
    return()=>document.removeEventListener("fullscreenchange",syncFullscreen);
  },[]);
  async function togglePosFullscreen(){
    if(isPosFullscreen&&!document.fullscreenElement){
      setIsPosFullscreen(false);
      return;
    }
    try{
      if(document.fullscreenElement){
        await document.exitFullscreen();
      }else if(document.documentElement.requestFullscreen){
        await document.documentElement.requestFullscreen();
      }else{
        setIsPosFullscreen(true);
      }
    }catch{
      setIsPosFullscreen(true);
    }
  }
  async function completeSale(){
    if(!business||!selectedPos||!cartLines.length||!supabase)return;
    if(!navigator.onLine){
      setMessage("Nuk ka lidhje interneti. Fiskalo ende nuk mund të krijojë shitje të reja plotësisht offline për këtë POS. Mos e finalizo pagesën në aplikacion derisa lidhja të rikthehet; përdor vetëm procedurën e autorizuar të ATK-së për ndërprerje.");
      return;
    }
    if(operatorName.trim().length<2||operatorIdentifier.trim().length<1){setMessage("Vendos emrin dhe numrin identifikues të operatorit para lëshimit të kuponit fiskal.");return;}
    const pos=positions.find(p=>p.id===selectedPos);
    if(!pos)return;
    if(!/^[0-9]{7}$/.test(pos.unit_number??"")){setMessage("Plotëso numrin 7-shifror të njësisë ARBK për këtë POS para lëshimit të kuponit.");return;}
    if(!pos.application_id||!pos.verification_no||pos.certificate_status!=="certificate_issued"){
      setMessage("Ky POS nuk ka përfunduar onboarding-un ATK TEST.");return;
    }
    const identity={businessNui:business.nui,branchId:pos.branch_id,posId:pos.pos_id,businessName:pos.verified_business_name||business.name};
    if(!await hasMatchingPosCertificate(identity)){
      setMessage("Ky shfletues nuk ka çelësin privat dhe certifikatën që përputhen për këtë POS. Kryej onboarding-un në këtë pajisje.");
      return;
    }
    let certificatePem:string;
    try{certificatePem=await getPosCertificatePem(identity)}catch(error){setMessage(error instanceof Error?error.message:"Certifikata e POS-it nuk u lexua.");return;}
    if(!paymentResult.valid){setMessage(paymentResult.error??"Kontrollo ndarjen e pagesës.");return;}
    const checkoutIdempotencyKey=checkoutKey||crypto.randomUUID();
    setCheckoutKey(checkoutIdempotencyKey);setCheckoutAttempted(true);
    try{
      sessionStorage.setItem("fiskalo.pendingCheckout."+business.id,JSON.stringify({
        key:checkoutIdempotencyKey,attempted:true,
        lines:cartLines.map(line=>({productId:line.product.id,quantity:line.quantity})),
        additionalPayments,selectedPos
      }));
    }catch{}
    setBusy(true);setMessage("");
    let outboxKey="";
    try{
      const {error:operatorError}=await supabase.rpc("fiskalo_basic_set_operator_identity",{p_business_id:business.id,p_operator_name:operatorName.trim(),p_operator_identifier:operatorIdentifier.trim()});
      if(operatorError)throw operatorError;
      const {data:saleId,error}=await supabase.rpc("fiskalo_basic_create_sale_with_payments",{
        p_business_id:business.id,p_pos_id:selectedPos,p_payments:paymentResult.allocations.map(item=>({method:item.method,amount_cents:item.amountCents})),
        p_lines:cartLines.map(x=>({product_id:x.product.id,quantity:x.quantity})),
        p_idempotency_key:checkoutIdempotencyKey
      });
      if(error)throw error;
      const [{data:sale,error:saleError},{data:lines,error:linesError}]=await Promise.all([
        supabase.from("fiskalo_basic_sales").select("*").eq("id",saleId).single(),
        supabase.from("fiskalo_basic_sale_items").select("*").eq("sale_id",saleId).order("id")
      ]);
      if(saleError)throw saleError;if(linesError)throw linesError;
      const cents=(value:number)=>Math.round(Number(value)*100);
      const grouped=new Map<string,{taxRate:string;base:number;tax:number}>();
      for(const line of lines??[]){
        const group=grouped.get(line.atk_vat_code)??{taxRate:line.atk_vat_code,base:0,tax:0};
        group.base+=cents(line.line_net);group.tax+=cents(line.line_vat);grouped.set(line.atk_vat_code,group);
      }
      if(!sale.daily_number||Number(sale.daily_number)<=0)throw new Error("Numri ditor i kuponit nuk u caktua nga baza e të dhënave.");
      const taxGroups=Array.from(grouped.values()).map(g=>({taxRate:g.taxRate,totalForTaxCents:g.base,totalTaxCents:g.tax}));
      // ATK's POS verification code is used for certificate issuance. The per-coupon
      // VerificationNo is the unique NUIKF and must be embedded in both signed coupons.
      const nuiKf=generateNuiKf();
      const coupon={
        businessId:business.nui,couponId:sale.coupon_id,dailyNumber:Number(sale.daily_number),
        branchId:pos.branch_id,location:pos.location,operatorId:operatorName.trim(),posId:pos.pos_id,
        applicationId:Number(pos.application_id),verificationNo:nuiKf,type:1 as const,
        unixTime:Math.floor(new Date(sale.created_at).getTime()/1000),
        items:(lines??[]).map(line=>({name:line.description,unitPriceEuro:Number(line.unit_price),unit:line.atk_unit_code,quantity:Number(line.quantity),lineTotalCents:cents(line.line_total),taxRate:line.atk_vat_code,itemType:line.atk_item_category_code})),
        payments:paymentResult.allocations.map(item=>({type:toAtkPaymentType(item.method),amountCents:item.amountCents})),
        totalCents:cents(sale.total),taxGroups,totalTaxCents:cents(sale.vat_total),
        totalNoTaxCents:cents(sale.subtotal),totalDiscountCents:0
      };
      const idempotencyKey=business.nui+":"+pos.branch_id+":"+pos.pos_id+":"+sale.coupon_id;
      outboxKey=idempotencyKey;
      const previous=(await listFiscalOutboxItems(business.id)).find(item=>item.idempotencyKey===idempotencyKey);
      if(previous&&previous.state!=="accepted"){
        throw new Error("Ky kupon ekziston në outbox me status "+previous.state+". Mos e ridërgo; kontrollo regjistrin ATK dhe kryej reconciliimin.");
      }
      const detailsBase64=encodeAtkBase64(encodeAtkPosCoupon(coupon));
      const signatureBase64=await signAtkBase64Payload(identity,detailsBase64);
      const citizenPayload=encodeAtkBase64(encodeAtkCitizenCoupon({
        businessId:business.nui,couponId:sale.coupon_id,branchId:pos.branch_id,posId:pos.pos_id,
        verificationNo:nuiKf,type:1,unixTime:coupon.unixTime,
        totalCents:coupon.totalCents,taxGroups,totalTaxCents:coupon.totalTaxCents,totalNoTaxCents:coupon.totalNoTaxCents
      }));
      const citizenSignature=await signAtkBase64Payload(identity,citizenPayload);
      const citizenQrPayload=citizenPayload+"|"+citizenSignature;
      const qrSvg=await createCitizenQrSvg(citizenQrPayload);
      const qrSvgBase64=encodeAtkBase64(new TextEncoder().encode(qrSvg));
      const issuedAtUtc=new Date().toISOString();
      const recoveryDeadlineUtc=new Date(Date.parse(issuedAtUtc)+48*60*60*1000).toISOString();
      await saveFiscalOutboxItem({
        idempotencyKey,businessId:business.id,saleId,posRecordId:pos.id,couponId:Number(sale.coupon_id),documentType:1,
        detailsBase64,signatureBase64,certificatePem,citizenPayloadBase64:citizenPayload,citizenSignatureBase64:citizenSignature,
        citizenQrPayload,nuiKf,verificationNo:nuiKf,dailyNumber:Number(sale.daily_number),qrSvg:qrSvgBase64,
        issuedAtUtc,offlineIssuedAtUtc:null,recoveryDeadlineUtc,
        state:"prepared",transactionId:null,lastError:null
      });
      if(!navigator.onLine){
        const outage=await getOrStartPosConnectivityOutage(business.id,pos.id);
        const offlineIssuedAtUtc=outage.startedAt;
        const offlineDeadline=outageRecoveryDeadline(offlineIssuedAtUtc);
        await updateFiscalOutboxItem(idempotencyKey,{
          state:"queued",offlineIssuedAtUtc,recoveryDeadlineUtc:offlineDeadline,
          lastError:"Shfletuesi ishte pa lidhje përpara dërgimit në ATK."
        });
        const offlineReceipt:SaleRecord={
          ...sale,payment_allocations:paymentResult.allocations.map(item=>({method:item.method,amount_cents:item.amountCents})),
          items:(lines??[]).map(line=>({description:line.description,quantity:line.quantity,unit_price:line.unit_price,line_total:line.line_total,line_net:line.line_net,line_vat:line.line_vat,vat_rate:line.vat_rate,atk_unit_code:line.atk_unit_code,atk_vat_code:line.atk_vat_code})),
          transaction_id:null,nui_kf:nuiKf,verification_no:nuiKf,daily_number:Number(sale.daily_number),
          submission_state:"queued",offline_issued_at:offlineIssuedAtUtc,recovery_deadline_at:offlineDeadline,
          qr_svg_base64:qrSvgBase64,pos_identifier:pos.unit_number+"-"+business.nui+"-"+String(pos.pos_id).padStart(2,"0"),
          unit_number:pos.unit_number,unit_code:pos.branch_id,pos_number:pos.pos_id,unit_name:pos.label,
          business_address:pos.location,operator_name:sale.operator_name??operatorName.trim(),
          operator_identifier:sale.operator_identifier??null,document_type:"SHITJE",is_offline:true
        };
        setReceipt(offlineReceipt);
        setMessage("Shitja u ruajt. Pajisja ishte pa lidhje; kuponi i nënshkruar mbetet në outbox dhe do të ngarkohet në radhën cloud kur interneti të rikthehet, brenda 48 orëve.");
        setCart({});setCheckoutKey("");setCheckoutAttempted(false);setAdditionalPayments([]);
        sessionStorage.removeItem("fiskalo.pendingCheckout."+business.id);
        return;
      }
      let fiscal;
      try {
        fiscal=await submitCloudTestCoupon(supabase,{
          businessId:business.id,posRecordId:pos.id,saleId,couponId:Number(sale.coupon_id),idempotencyKey,
          details:detailsBase64,signature:signatureBase64,certificatePem,nuiKf,citizenPayload,citizenSignature,
          dailyNumber:Number(sale.daily_number),offlineIssuedAt:null
        });
      } catch (submitError) {
        if (submitError instanceof CloudAtkError && submitError.notDelivered) {
          const outage=await getOrStartPosConnectivityOutage(business.id,pos.id);
          const offlineIssuedAtUtc=outage.startedAt;
          const offlineDeadline=outageRecoveryDeadline(offlineIssuedAtUtc);
          let cloudQueued=false;
          let queueErrorMessage=submitError.message;
          try {
            await queueCloudTestCoupon(supabase,{
              businessId:business.id,posRecordId:pos.id,saleId,couponId:Number(sale.coupon_id),idempotencyKey,
              details:detailsBase64,signature:signatureBase64,certificatePem,nuiKf,verificationNo:nuiKf,
              citizenPayload,citizenSignature,dailyNumber:Number(sale.daily_number),offlineIssuedAt:offlineIssuedAtUtc
            });
            cloudQueued=true;
          } catch (queueError) {
            queueErrorMessage=queueError instanceof Error?queueError.message:queueErrorMessage;
          }
          await updateFiscalOutboxItem(idempotencyKey,{
            state:cloudQueued?"cloud_queued":"queued",offlineIssuedAtUtc,recoveryDeadlineUtc:offlineDeadline,
            lastError:cloudQueued?null:queueErrorMessage
          });
          const offlineReceipt:SaleRecord={
            ...sale,
            items:(lines??[]).map(line=>({description:line.description,quantity:line.quantity,unit_price:line.unit_price,line_total:line.line_total,line_net:line.line_net,line_vat:line.line_vat,vat_rate:line.vat_rate,atk_unit_code:line.atk_unit_code,atk_vat_code:line.atk_vat_code})),
            transaction_id:null,nui_kf:nuiKf,verification_no:nuiKf,daily_number:Number(sale.daily_number),
            submission_state:"queued",offline_issued_at:offlineIssuedAtUtc,recovery_deadline_at:offlineDeadline,
            qr_svg_base64:qrSvgBase64,pos_identifier:pos.unit_number+"-"+business.nui+"-"+String(pos.pos_id).padStart(2,"0"),
            unit_number:pos.unit_number,unit_code:pos.branch_id,pos_number:pos.pos_id,unit_name:pos.label,
            business_address:pos.location,operator_name:sale.operator_name??operatorName.trim(),
            operator_identifier:sale.operator_identifier??null,document_type:"SHITJE",is_offline:true
          };
          setReceipt(offlineReceipt);
          setMessage("ATK TEST nuk u arrit dhe kërkesa nuk u dërgua. Kuponi i nënshkruar u ruajt në outbox dhe do të ngarkohet në radhën cloud; Cloudflare do ta provojë sërish brenda afatit 48-orësh.");
          setCart({});setCheckoutKey("");setCheckoutAttempted(false);setAdditionalPayments([]);
          sessionStorage.removeItem("fiskalo.pendingCheckout."+business.id);
          void loadWorkspace(user!.id).catch(()=>undefined);
          return;
        }
        if(submitError instanceof CloudAtkError && submitError.rejected){
          await updateFiscalOutboxItem(idempotencyKey,{state:"rejected",lastError:submitError.message});
          setMessage("ATK TEST e refuzoi kuponin. Shitja mbetet e paguar, por nuk është fiskalizuar; kontrollo arsyen dhe mos e ridërgo automatikisht.");
          setCart({});setCheckoutKey("");setCheckoutAttempted(false);
          sessionStorage.removeItem("fiskalo.pendingCheckout."+business.id);
          if(tab==="sales")void loadSales();
          return;
        }
        throw submitError;
      }
      await updateFiscalOutboxItem(idempotencyKey,{state:"accepted",transactionId:fiscal.transactionId,lastError:null,qrSvg:fiscal.qrSvgBase64});
      const receiptRecord:SaleRecord={
        ...sale,payment_allocations:paymentResult.allocations.map(item=>({method:item.method,amount_cents:item.amountCents})),
        items:(lines??[]).map(line=>({description:line.description,quantity:line.quantity,unit_price:line.unit_price,line_total:line.line_total,line_net:line.line_net,line_vat:line.line_vat,vat_rate:line.vat_rate,atk_unit_code:line.atk_unit_code,atk_vat_code:line.atk_vat_code})),
        transaction_id:fiscal.transactionId,nui_kf:nuiKf,verification_no:nuiKf,daily_number:Number(sale.daily_number),
        submission_state:"accepted",offline_issued_at:null,recovery_deadline_at:null,
        qr_svg_base64:fiscal.qrSvgBase64,pos_identifier:pos.unit_number+"-"+business.nui+"-"+String(pos.pos_id).padStart(2,"0"),
        unit_number:pos.unit_number,unit_code:pos.branch_id,pos_number:pos.pos_id,unit_name:pos.label,
        business_address:pos.location,operator_name:sale.operator_name??operatorName.trim(),
        operator_identifier:sale.operator_identifier??null,document_type:"SHITJE",is_offline:false
      };
      setReceipt(receiptRecord);
      setMessage("ATK TEST e pranoi kuponin dhe regjistri fiskal u ruajt. Transaction ID: "+fiscal.transactionId);
      setCart({});setCheckoutKey("");setCheckoutAttempted(false);setAdditionalPayments([]);
      sessionStorage.removeItem("fiskalo.pendingCheckout."+business.id);
      await loadWorkspace(user!.id);
      if(tab==="sales")await loadSales();
    }catch(e){
      if(outboxKey){
        const transactionId=e instanceof CloudAtkError?e.transactionId:null;
        await updateFiscalOutboxItem(outboxKey,{
          state:"needs_reconciliation",
          transactionId,
          lastError:e instanceof Error?e.message:"ATK submission result is unknown."
        }).catch(()=>{});
      }
      const {data:existingSale,error:lookupError}=await supabase.from("fiskalo_basic_sales")
        .select("id").eq("business_id",business.id).eq("checkout_idempotency_key",checkoutIdempotencyKey).maybeSingle();
      if(!lookupError&&!existingSale){
        setCheckoutKey("");setCheckoutAttempted(false);
        sessionStorage.removeItem("fiskalo.pendingCheckout."+business.id);
      }
      try{await loadWorkspace(user!.id)}catch{}
      setMessage(e instanceof Error?e.message:"Shitja/fiskalizimi dështoi. Dokumenti mbetet në outbox dhe nuk do të ridërgohet automatikisht pa reconciliim.");
    }finally{setBusy(false);}
  }
  if(!configured)return <main className="shell"><header className="topbar"><div className="brand">fiskalo<span>.</span></div><span className="eyebrow">Basic ATK MVP</span></header><section className="panel"><h1>Konfigurimi kërkohet</h1><p className="sub">Vendos NEXT_PUBLIC_SUPABASE_URL dhe NEXT_PUBLIC_SUPABASE_ANON_KEY në mjedisin e aplikacionit.</p></section></main>;
  if(loading)return <main className="shell"><div className="brand">fiskalo<span>.</span></div><p className="sub">Duke ngarkuar…</p></main>;
  if(!user)return <main className="shell"><header className="topbar"><div className="brand">fiskalo<span>.</span></div><span className="eyebrow">Fiscal POS · Kosovo</span></header><section className="panel" style={{maxWidth:460,margin:"8vh auto"}}><div className="eyebrow">Hyr në llogari</div><h1>Mirë se u ktheve.</h1><p className="sub">Hyr si pronar ose arkëtar.</p><form onSubmit={signIn}><div className="field"><label>Email</label><input id="email" type="email" required autoComplete="username"/></div><div className="field"><label>Fjalëkalimi</label><input id="password" type="password" required autoComplete="current-password"/></div>{message&&<p className="notice">{message}</p>}<button className="btn" disabled={busy} style={{width:"100%"}}>{busy?"Duke hyrë…":"Hyr"}</button></form></section></main>;
  if(!business)return <main className="shell"><header className="topbar"><div className="brand">fiskalo<span>.</span></div><button className="btn secondary" onClick={()=>supabase!.auth.signOut()}>Dil</button></header><section className="panel" style={{maxWidth:560,margin:"5vh auto"}}><div className="eyebrow">Konfigurimi fillestar</div><h1>Regjistro biznesin</h1><p className="sub">Krijo hapësirën e biznesit. NUI duhet të jetë numri real i biznesit.</p><form onSubmit={createBusiness}><div className="field"><label>Emri i biznesit</label><input required value={businessName} onChange={e=>setBusinessName(e.target.value)}/></div><div className="field"><label>NUI (9 shifra)</label><input required inputMode="numeric" pattern="[0-9]{9}" value={nui} onChange={e=>setNui(e.target.value)}/></div>{message&&<p className="notice">{message}</p>}<button className="btn" disabled={busy}>{busy?"Duke ruajtur…":"Krijo biznesin"}</button></form></section></main>;

  return <main className="shell">
    <header className="topbar"><div><div className="brand">fiskalo<span>.</span></div><span className="eyebrow">{business.name} · NUI {business.nui} · {memberRole==="owner"?"Pronari":"Arkëtari"}</span></div><div className="row">{memberRole==="owner"&&<Link href="/basic/reports" className="btn secondary">Raportet</Link>}<Link href="/app" className="btn secondary">Fiskalo Full</Link><span className="sub">{user.email}</span><button className="btn secondary" onClick={()=>supabase!.auth.signOut()}>Dil</button></div></header>
    <div className="eyebrow">Paneli i biznesit</div><h1>Arka dhe fiskalizimi.</h1><p className="sub">Version i thjeshtuar: produkte, POS dhe shitje. Shitjet e paguara nënshkruhen në këtë shfletues dhe dërgohen në ATK TEST përmes Cloudflare. Çelësi privat qëndron në pajisje. Production mbetet i çaktivizuar.</p>
    <section className="panel" style={{marginTop:16,maxWidth:520}}><h3>Operatori i arkës</h3><p className="sub">Emri dhe identifikuesi i operatorit ruhen në çdo shitje dhe shtypen në kupon. Përdor kodin identifikues të punonjësit, jo ID-në e llogarisë së brendshme.</p><form onSubmit={saveOperatorIdentity}><div className="field"><label>Emri dhe mbiemri i operatorit</label><input required minLength={2} maxLength={100} value={operatorName} onChange={e=>setOperatorName(e.target.value)} placeholder="Emri i operatorit"/></div><div className="field"><label>Numri identifikues i operatorit</label><input required minLength={1} maxLength={32} value={operatorIdentifier} onChange={e=>setOperatorIdentifier(e.target.value)} placeholder="ID e punonjësit"/></div><button className="btn secondary" disabled={busy}>Ruaj identitetin e operatorit</button></form></section>
    {memberRole==="owner"&&<section className="panel" style={{marginTop:16,maxWidth:520}}><h3>Të dhënat në kupon</h3><p className="sub">Numri i TVSH-së shtypet vetëm nëse biznesi është i regjistruar për TVSH. Adresa e kuponit merret nga lokacioni i POS-it.</p><form onSubmit={saveTaxProfile}><div className="field"><label>Numri i TVSH-së (9 shifra, opsional)</label><input inputMode="numeric" pattern="[0-9]{9}" maxLength={9} value={vatNumber} onChange={e=>setVatNumber(e.target.value)} placeholder="Lëre bosh nëse nuk je i regjistruar"/></div><button className="btn secondary" disabled={busy}>Ruaj të dhënat tatimore</button></form></section>}
    {memberRole==="owner"&&<section className="panel" style={{marginTop:16,maxWidth:520}}>
      <h3>Menaxhimi i punonjësve</h3>
      <p className="sub">Fto punonjësit me email dhe jepu rolin Arkëtar. Nuk kërkohet verifikim ATK/POS për krijimin e llogarisë; punonjësi duhet ta pranojë ftesën e email-it për të hyrë.</p>
      <form onSubmit={inviteWorker}>
        <div className="field"><label>Email i punonjësit</label><input type="email" required maxLength={254} autoComplete="email" value={workerEmail} onChange={e=>setWorkerEmail(e.target.value)} placeholder="punonjes@example.com"/></div>
        <button className="btn" disabled={busy||!workerEmail.trim()}>{busy?"Duke dërguar…":"Fto punonjësin"}</button>
      </form>
      {workersError&&<p className="notice" role="alert" style={{marginTop:10}}>{workersError}</p>}
      <div style={{marginTop:14}}>
        {workers.length===0?<p className="sub">Nuk u gjetën anëtarë ose lista nuk është ngarkuar ende.</p>:workers.map(worker=><div key={worker.userId} className="row" style={{justifyContent:"space-between",gap:12,padding:"10px 0",borderBottom:"1px solid var(--line)",flexWrap:"wrap"}}>
          <div><strong>{worker.email||"Llogari pa email"}</strong><div className="sub" style={{fontSize:12}}>{worker.role==="owner"?"Pronari":"Arkëtar"} · {worker.operatorName||"Identiteti i operatorit nuk është vendosur"} · {new Date(worker.createdAt).toLocaleDateString("sq-XK")}</div></div>
          <span className="status">{worker.role==="owner"?"PRONAR":"PUNONJËS"}</span>
        </div>)}
      </div>
    </section>}
    {queueOverdueCount>0&&<p className="notice" role="alert">KUJDES: {queueOverdueCount} dokument(e) në outbox kanë kaluar afatin 48-orësh. Mos i ridërgo automatikisht; kërkohet reconciliim me regjistrin e ATK-së.</p>}
    <div className="row" style={{margin:"22px 0"}}><button className={tab==="pos"?"btn":"btn secondary"} onClick={()=>setTab("pos")}>Arka / POS</button>{memberRole==="owner"&&<><button className={tab==="products"?"btn":"btn secondary"} onClick={()=>setTab("products")}>Produktet dhe stoku</button><button className={tab==="purchases"?"btn":"btn secondary"} onClick={()=>setTab("purchases")}>Blerjet &amp; shpenzimet</button><button className={tab==="atk"?"btn":"btn secondary"} onClick={()=>setTab("atk")}>ATK / POS</button><button className={tab==="sales"?"btn":"btn secondary"} onClick={()=>{setTab("sales");void loadSales();}}>Shitjet</button></>}</div>
    {message&&<p className="notice" role="status">{message}</p>}
    {tab==="products"&&memberRole==="owner"&&<><section className="panel" style={{marginBottom:16}}><div className="eyebrow">MENAXHIMI I BIZNESIT</div><h2>PRODUKTET DHE STOKU</h2><p className="sub">Një hapësirë e vetme për katalogun e produkteve, çmimet, barkodet, kodet ATK, sasitë dhe lëvizjet e inventarit.</p></section><div className="grid" style={{gridTemplateColumns:"minmax(260px,1fr) minmax(280px,1.4fr)"}}><section className="panel"><h2>{editingProductId?"Ndrysho produktin":"Produkt i ri"}</h2><form onSubmit={addProduct}><div className="field"><label>Emri</label><input required value={productName} onChange={e=>setProductName(e.target.value)}/></div><div className="field"><label>Çmimi pa TVSH (€)</label><input type="number" min="0" step="0.0001" required value={productPrice} onChange={e=>setProductPrice(e.target.value)}/></div><div className="field"><label>Stoku fillestar / korrigjimi</label><input type="number" min="0" step="0.001" value={productStock} onChange={e=>setProductStock(e.target.value)} disabled={!!editingProductId}/>{editingProductId&&<small className="sub">Përdor panelin e inventarit për të ndryshuar stokun dhe për të ruajtur historikun.</small> }</div><div className="field"><label>Klasifikimi i TVSH-së (ATK)</label><select required value={vatCode} onChange={e=>setVatCode(e.target.value as AtkVatCode)}>{Object.entries(ATK_VAT_CLASSIFICATIONS).map(([code,classification])=><option key={code} value={code}>{code} · {classification.label} ({classification.rate}%)</option>)}</select><small className="sub">A (i liruar) dhe C (normë zero) kanë të dyja 0% TVSH, por janë klasifikime të ndryshme ATK.</small></div><div className="field"><label>Kodi ATK – njësia matëse</label><select required value={isAtkUnitCode(unitCode)?unitCode:""} onChange={e=>setUnitCode(e.target.value)}><option value="">Zgjidh njësinë ATK</option>{ATK_MEASUREMENT_UNITS.map(unit=><option key={unit.code} value={unit.code}>{unit.code} · {unit.label}</option>)}</select>{unitCode&&!isAtkUnitCode(unitCode)&&<small className="sub">Kodi ekzistues “{unitCode}” nuk gjendet në katalogun zyrtar. Zgjidh një kod të vlefshëm para ruajtjes.</small>}</div><div className="field"><label>Kodi ATK – kategoria e mallit/shërbimit</label><select required value={isAtkItemCategoryCode(categoryCode)?categoryCode:""} onChange={e=>setCategoryCode(e.target.value)}><option value="">Zgjidh kategorinë ATK</option>{ATK_ITEM_CATEGORIES.map(category=><option key={category.code} value={category.code}>{category.code} · {category.label}</option>)}</select>{categoryCode&&!isAtkItemCategoryCode(categoryCode)&&<small className="sub">Kodi ekzistues “{categoryCode}” nuk gjendet në katalogun zyrtar. Zgjidh një kod të vlefshëm para ruajtjes.</small>}</div><p className="sub">Njësitë matëse dhe kategoritë përdorin kode të verifikuara nga dokumentet zyrtare të ATK-së (29.09.2026 dhe specifika teknike, maj 2026). Klasifikimi A/C/D/E i TVSH-së mbetet i veçantë nga kategoria e artikullit.</p><a href="https://apps.atk-ks.org/sefaplikimi/uploads/documents/1d551126-ea39-49eb-8b89-6e0deb6e117f.docx" target="_blank" rel="noreferrer">Hap katalogun zyrtar ATK (DOCX)</a><div className="row"><button className="btn" disabled={busy}>{editingProductId?"Ruaj ndryshimet":"Ruaj artikullin"}</button>{editingProductId&&<button type="button" className="btn secondary" disabled={busy} onClick={resetProductForm}>Anulo</button>}</div></form></section><section className="panel"><h2>Katalogu i produkteve</h2>{products.length===0?<p className="sub">Nuk ka artikuj ende.</p>:products.map(p=><div key={p.id} className="row" style={{justifyContent:"space-between",padding:"12px 0",borderBottom:"1px solid var(--line)",flexWrap:"wrap"}}><div><strong>{p.name}</strong><div className="sub" style={{fontSize:12}}>Stoku {p.stock} · TVSH {p.vat_rate}% · {p.atk_unit_code} / {p.atk_item_category_code} / {p.atk_vat_code}</div></div><div className="row"><strong>€{Number(p.price).toFixed(2)}</strong><button className="btn secondary" disabled={busy} onClick={()=>startEditProduct(p)}>Ndrysho</button><button className="btn secondary" disabled={busy} onClick={()=>void archiveProduct(p)}>Hiq nga katalogu</button></div></div>)}</section></div>
    {tab==="products"&&memberRole==="owner"&&<BusinessOperations businessId={business.id} products={products} onRefresh={()=>loadWorkspace(user!.id)} mode="inventory"/>}</>}
    {tab==="purchases"&&memberRole==="owner"&&<BusinessOperations businessId={business.id} products={products} onRefresh={()=>loadWorkspace(user!.id)} mode="purchases"/>}
    {tab==="sales"&&memberRole==="owner"&&<section className="panel"><div className="row" style={{justifyContent:"space-between"}}><div><h2>Historia e shitjeve</h2><p className="sub">50 shitjet e fundit të këtij biznesi. Statusi ATK shfaqet veçmas nga pagesa.</p></div><div className="row"><button className="btn secondary" disabled={busy} onClick={()=>void loadSales()}>Rifresko</button><button className="btn secondary" disabled={busy||!sales.length} onClick={exportSalesCsv}>Eksporto CSV</button></div></div>{sales.length===0?<p className="sub">Nuk ka shitje të regjistruara në këtë listë.</p>:<><div className="grid" style={{gridTemplateColumns:"repeat(auto-fit,minmax(150px,1fr))",margin:"16px 0"}}><div className="stat-card"><span className="eyebrow">Shitje të listuara</span><strong className="stat">{sales.length}</strong></div><div className="stat-card"><span className="eyebrow">Vlera e listuar</span><strong className="stat">€{sales.reduce((sum,s)=>sum+Number(s.total),0).toFixed(2)}</strong></div><div className="stat-card"><span className="eyebrow">Të fiskalizuara</span><strong className="stat">{sales.filter(s=>s.status==="fiscalized").length}</strong></div></div>{sales.map(s=><div key={s.id} className="row" style={{justifyContent:"space-between",gap:12,padding:"13px 0",borderBottom:"1px solid var(--line)",flexWrap:"wrap"}}><div><strong>Kupon #{s.coupon_id}</strong><div className="sub" style={{fontSize:12}}>{new Date(s.created_at).toLocaleString("sq-XK")} · {s.payment_method}</div><div className="sub" style={{fontSize:12}}>ATK: {s.submission_state?.toLowerCase()==="accepted"||s.status==="fiscalized"?"Pranuar · "+(s.transaction_id??"Transaction ID i ruajtur"):s.submission_state?.toLowerCase()==="queued"?"Në radhë · dërgim automatik":s.submission_state?.toLowerCase()==="needsreconciliation"?"Kërkohet reconciliim":s.submission_state?.toLowerCase()==="rejected"?"Refuzuar nga ATK":"Jo i konfirmuar"}</div>{s.queue_last_error&&<div className="sub" style={{fontSize:12,color:"#b91c1c"}}>{s.queue_last_error}</div>}{s.submission_state?.toLowerCase().replace(/_/g,"")==="needsreconciliation"&&<div className="sub" style={{fontSize:12}}>Mos e ridërgo para se të konfirmohet statusi në portalin ATK.</div>}</div><div className="row"><strong>€{Number(s.total).toFixed(2)}</strong><button className="btn secondary" onClick={()=>setReceipt({...s,is_copy:true})}>Kuponi</button>{s.correction_type&&<button className="btn secondary" onClick={()=>setReceipt({...s,coupon_id:s.correction_coupon_id??s.coupon_id,transaction_id:s.correction_transaction_id??null,nui_kf:s.correction_nui_kf??null,daily_number:s.correction_daily_number??null,qr_svg_base64:s.correction_qr_svg_base64??null,document_type:s.correction_type??"KORRIGJIM",reference_coupon_id:s.correction_reference_coupon_id??s.coupon_id,reference_transaction_id:s.transaction_id,is_offline:!!s.correction_offline_issued_at,is_copy:true})}>Kuponi korrigjues</button>}{s.status==="fiscalized"&&s.transaction_id&&!["accepted","queued","cloud_queued","submitting","needs_reconciliation"].includes(String(s.correction_state??""))&&<><button className="btn secondary" disabled={busy} onClick={()=>void issueCorrection(s,2)}>Anulo</button><button className="btn secondary" disabled={busy} onClick={()=>void issueCorrection(s,3)}>Kthim i plotë</button></>}</div>{s.correction_type&&<div className="sub" style={{fontSize:12}}>Korrigjimi: {s.correction_type} · {s.correction_state??"Në pritje"}{s.correction_transaction_id?" · ATK "+s.correction_transaction_id:""}</div>}</div>)}</>}</section>}
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
          {receipt.reference_coupon_id&&<div>Kuponi origjinal: {receipt.reference_coupon_id} · Transaction ID: {receipt.reference_transaction_id}</div>}
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
          <div style={{display:"flex",justifyContent:"space-between",marginTop:5}}><span>PAGUAR</span><strong>€{Number(receipt.total).toFixed(2)}</strong></div>{(receipt.payment_allocations?.length?receipt.payment_allocations:[{method:receipt.payment_method,amount_cents:Math.round(Number(receipt.total)*100)}]).map((allocation,index)=><div key={allocation.method+"-"+index} style={{display:"flex",justifyContent:"space-between"}}><span>{paymentMethodLabel(allocation.method)}</span><strong>€{(Number(allocation.amount_cents)/100).toFixed(2)}</strong></div>)}
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
      <section className="panel"><h2>Onboarding ATK TEST në këtë shfletues</h2><p className="sub">Çdo POS krijon çelësin e vet ECDSA P-256 në këtë pajisje. Çelësi privat është jo-i-eksportueshëm dhe nuk dërgohet në Cloudflare ose Supabase.</p><div className="field"><label>POS për verifikim</label><select value={selectedPos} onChange={e=>setSelectedPos(e.target.value)}><option value="">Zgjidh POS</option>{positions.map(p=><option key={p.id} value={p.id}>{p.label} · POS {p.pos_id}</option>)}</select></div><div className="row"><button className="btn secondary" disabled={busy||!selectedPos||!positions.find(p=>p.id===selectedPos)?.application_id} onClick={verifyAtkPos}>Verifiko me ATK TEST</button><button className="btn" disabled={busy||!selectedPos||!positions.find(p=>p.id===selectedPos)?.verification_no} onClick={requestAtkCertificate}>Krijo çelësin dhe merr certifikatën</button></div>{verification&&<p className="notice" style={{marginTop:12}}>Biznesi i verifikuar: {verification.businessName}. Kodi i verifikimit u ruajt në konfigurimin e POS-it.</p>}{positions.find(p=>p.id===selectedPos)?.certificate_status==="certificate_issued"&&<p className="sub">Statusi në databazë: certifikata TEST është lëshuar. Përputhja me çelësin lokal kontrollohet para çdo shitjeje.</p>}<p className="footer">Ky konfigurim lidhet me këtë profil të shfletuesit dhe pajisje. Nëse fshihen të dhënat e shfletuesit ose ndryshon pajisja, duhet të kryhet onboarding i ri për POS-in.</p></section></div>}
    {tab==="pos"&&<div className={`pos-workspace pos-reference-layout${isPosFullscreen?" pos-workspace--fullscreen":""}`}>
      <section className="pos-catalog pos-reference-catalog">
        <div className="pos-reference-topbar">
          <div className="pos-reference-brand"><span className="pos-brand-mark">f</span><strong>fiskalo</strong></div>
          <button type="button" className="pos-fullscreen-btn" onClick={()=>void togglePosFullscreen()} aria-label={isPosFullscreen?"Dil nga ekrani i plotë":"Hap porositë në ekran të plotë"}>{isPosFullscreen?"↙":"⛶"} {isPosFullscreen?"Dil nga fullscreen":"Fullscreen"}</button>
        </div>
        <div className="pos-reference-greeting"><h2><strong>Tung,</strong><br/>çfarë dëshiron klienti?</h2><div className="pos-reference-search"><span aria-hidden="true">⌕</span><input aria-label="Kërko produkt" value={productSearch} onChange={e=>setProductSearch(e.target.value)} placeholder="Kërko produkt…" disabled={checkoutAttempted}/>{productSearch&&<button type="button" onClick={()=>setProductSearch("")} aria-label="Pastro kërkimin">×</button>}</div></div>
        <div className="pos-reference-categories-title">Kategoritë</div>
        <div className="pos-reference-category-grid">
          <button type="button" className={selectedCategory==="all"?"pos-reference-category selected":"pos-reference-category"} onClick={()=>setSelectedCategory("all")}><span className="pos-reference-category-art">✦</span><strong>Të gjitha</strong><small>{products.length} artikuj</small></button>
          {categoryOptions.map((code,index)=>{
            const categoryProducts=products.filter(product=>product.atk_item_category_code===code);
            const glyphs=["🍔","🥤","🍟","🥪","🍰","🥗","🍗","☕"];
            return <button type="button" key={code} className={selectedCategory===code?"pos-reference-category selected":"pos-reference-category"} onClick={()=>setSelectedCategory(code)}><span className="pos-reference-category-art">{glyphs[index%glyphs.length]}</span><strong>{getAtkItemCategoryLabel(code)||code}</strong><small>{categoryProducts.length} artikuj</small></button>;
          })}
        </div>
        <div className="pos-reference-products-heading"><h2>{productSearch?"Rezultatet":"Produktet"}</h2><span>{filteredProducts.length} artikuj</span></div>
        {products.length===0?<div className="pos-empty"><div className="pos-empty-icon">＋</div><strong>Katalogu është bosh</strong><p>Shto produktet, sasitë në stok dhe kodet fiskale te faqja Produktet & inventari për të filluar porositë.</p></div>:filteredProducts.length===0?<div className="pos-empty"><strong>Nuk u gjet asnjë artikull</strong><p>Ndrysho kërkimin ose zgjidh një kategori tjetër.</p></div>:<div className="pos-reference-product-grid">{filteredProducts.map((product,index)=>{
          const inCart=cart[product.id]?.quantity??0;
          const available=Number(product.stock)>0;
          const name=product.name.toLocaleLowerCase("sq");
          const glyph=name.includes("burger")||name.includes("hamb")? "🍔":name.includes("buk")||name.includes("sand")?"🥪":name.includes("uj")||name.includes("pije")||name.includes("drink")||name.includes("cola")?"🥤":name.includes("patat")||name.includes("fries")?"🍟":name.includes("pul")||name.includes("chicken")?"🍗":name.includes("kafe")||name.includes("coffee")?"☕":name.includes("pizza")?"🍕":name.includes("akull")||name.includes("embëls")?"🍦":["🥐","🍽️","🥗","🧁","🥙","🍞"][index%6];
          return <button type="button" key={product.id} className={`pos-reference-product${inCart?" in-cart":""}`} disabled={checkoutAttempted||!available} onClick={()=>changeCart(product,1)}>
            <span className="pos-reference-product-art" aria-hidden="true">{glyph}</span>
            <strong>{product.name}</strong>
            <b>€{(Number(product.price)*(1+Number(product.vat_rate)/100)).toFixed(2)}</b>
            {inCart>0&&<small>{inCart} në porosi</small>}
            {!available&&<em>Pa stok</em>}
          </button>;
        })}</div>}
      </section>
      <aside className="pos-order-panel pos-reference-order">
        <div className="pos-reference-order-head"><div className="pos-reference-order-title"><h2>Porosia ime</h2><span>Për ta marrë me vete</span></div><span className="pos-reference-bag">▤</span></div>
        {cartLines.length===0?<div className="pos-reference-empty"><span>＋</span><strong>Porosia është bosh</strong><small>Zgjidh produktet për t’i shtuar këtu.</small></div>:<div className="pos-reference-cart">{cartLines.map(line=>{
          const name=line.product.name.toLocaleLowerCase("sq");
          const glyph=name.includes("burger")||name.includes("hamb")?"🍔":name.includes("patat")||name.includes("fries")?"🍟":name.includes("uj")||name.includes("pije")||name.includes("drink")?"🥤":name.includes("pul")||name.includes("chicken")?"🍗":"🍽️";
          return <div key={line.product.id} className="pos-reference-cart-item"><span className="pos-reference-cart-art">{glyph}</span><div className="pos-reference-cart-info"><strong>{line.product.name}</strong><span>€{(Number(line.product.price)*(1+Number(line.product.vat_rate)/100)).toFixed(2)}</span><div className="pos-reference-quantity"><button type="button" aria-label={`Hiq një ${line.product.name}`} disabled={checkoutAttempted} onClick={()=>changeCart(line.product,-1)}>−</button><b>{line.quantity}</b><button type="button" aria-label={`Shto një ${line.product.name}`} disabled={checkoutAttempted||line.quantity>=Number(line.product.stock)} onClick={()=>changeCart(line.product,1)}>＋</button></div></div><strong className="pos-reference-line-total">€{(Number(line.product.price)*line.quantity*(1+Number(line.product.vat_rate)/100)).toFixed(2)}</strong></div>;
        })}</div>}
        <div className="pos-reference-order-bottom">
          <div className="pos-reference-checkout-settings"><label>POS<select value={selectedPos} disabled={checkoutAttempted} onChange={e=>{setSelectedPos(e.target.value);if(cartLines.length)setCheckoutKey(crypto.randomUUID());}}><option value="">Zgjidh POS</option>{positions.map(position=><option key={position.id} value={position.id}>{position.label}</option>)}</select></label></div>
          <div className="pos-reference-payment-settings" style={{display:"grid",gap:8,marginTop:12}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}><span>Cash (mbetja)</span><strong>€{(paymentResult.cashRemainderCents/100).toFixed(2)}</strong></div>
            {additionalPayments.map(item=><div key={item.id} style={{display:"grid",gridTemplateColumns:"minmax(0,1fr) minmax(0,1fr) auto",gap:8,alignItems:"end"}}>
              <label style={{display:"flex",flexDirection:"column",gap:4}}>Mënyra<select value={item.method} disabled={checkoutAttempted} onChange={e=>{setAdditionalPayments(current=>current.map(payment=>payment.id===item.id?{...payment,method:e.target.value as AdditionalPaymentMethod}:payment));if(cartLines.length)setCheckoutKey(crypto.randomUUID());}}>{(["card","bank_transfer","voucher","cheque","crypto"] as AdditionalPaymentMethod[]).map(method=><option key={method} value={method} disabled={additionalPayments.some(other=>other.id!==item.id&&other.method===method)}>{paymentMethodLabel(method)}</option>)}</select></label>
              <label style={{display:"flex",flexDirection:"column",gap:4}}>Shuma (€)<input aria-label={"Shuma "+paymentMethodLabel(item.method)} type="number" min="0" step="0.01" value={item.amount} disabled={checkoutAttempted} onChange={e=>{setAdditionalPayments(current=>current.map(payment=>payment.id===item.id?{...payment,amount:e.target.value}:payment));if(cartLines.length)setCheckoutKey(crypto.randomUUID());}}/></label>
              <button type="button" className="btn secondary" aria-label="Hiq mënyrën e pagesës" disabled={checkoutAttempted} onClick={()=>{setAdditionalPayments(current=>current.filter(payment=>payment.id!==item.id));if(cartLines.length)setCheckoutKey(crypto.randomUUID());}}>×</button>
            </div>)}
            <button type="button" className="btn secondary" disabled={checkoutAttempted||additionalPayments.length>=5} onClick={()=>{const methods:AdditionalPaymentMethod[]=["card","bank_transfer","voucher","cheque","crypto"];const nextMethod=methods.find(method=>!additionalPayments.some(item=>item.method===method));if(nextMethod){setAdditionalPayments(current=>[...current,{id:crypto.randomUUID(),method:nextMethod,amount:""}]);if(cartLines.length)setCheckoutKey(crypto.randomUUID());}}}>+ Shto mënyrë pagese</button>
            <small className="sub">Mund të kombinosh cash, kartelë, transfer bankar/tjetër, vauçer, çek dhe kriptovalutë. Cash llogaritet automatikisht si mbetja.</small>
            {paymentResult.error&&<p className="notice" role="alert">{paymentResult.error}</p>}
          </div>
          <div className="pos-reference-total"><span>Totali</span><strong>€{total.toFixed(2)}</strong></div>
          {checkoutAttempted&&<p className="notice" role="alert">Pagesa ka nisur. Mos krijo porosi të re derisa kjo shitje të zgjidhet.</p>}
          <button type="button" className="pos-reference-done" disabled={busy||!cartLines.length||!selectedPos||!paymentResult.valid} onClick={completeSale}>{busy?"Duke ruajtur…":checkoutAttempted?"Riprovo shitjen":"Përfundo porosinë"} <span>→</span></button>
          {cartLines.length>0&&<button type="button" className="pos-reference-clear" disabled={checkoutAttempted} onClick={()=>{setCart({});setCheckoutKey("");setCheckoutAttempted(false);setAdditionalPayments([]);}}>Pastro porosinë</button>}
          <p className="pos-security-note">Kuponi fiskal konfirmohet vetëm pas përgjigjes së pranuar nga ATK.</p>
        </div>
      </aside>
    </div>}
    <section className="panel" style={{marginTop:18}}><div className="row" style={{justifyContent:"space-between"}}><div><div className="eyebrow">Gjendja e ATK</div><h3 style={{margin:"7px 0"}}>Integrimi në zhvillim</h3></div><span className="status">TEST · jo i certifikuar</span></div><p className="sub" style={{margin:0}}>Fiskalo nuk shënon kupon si fiskalizuar pa përgjigje të pranuar nga ATK dhe transaction_id të ruajtur.</p></section>
    <p className="footer">Fiskalo Basic ATK MVP · Provider authorization and formal ATK certification are external release gates.</p>
    <style jsx global>{`@media print{body *{visibility:hidden!important}.receipt,.receipt *{visibility:visible!important}.receipt{position:absolute!important;left:0!important;top:0!important;width:80mm!important;max-width:80mm!important;margin:0!important;padding:4mm!important;box-shadow:none!important;border:0!important}.no-print{display:none!important}@page{size:80mm auto;margin:0}}`}</style>
  </main>;
}
