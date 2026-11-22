"use client";

import { useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { submitInvoiceAdjustmentToATK } from "@/lib/atk/submit-invoice-adjustment";

type InvoiceItem = {
  id: string;
  description: string;
  quantity: number;
  line_subtotal: number;
  line_vat: number;
  remainingQuantity: number;
  remainingNet: number;
  remainingVat: number;
};

type Props = {
  invoiceId: string;
  organizationId: string;
  total: number;
  kind: "cancel" | "return";
  invoiceNumber: string;
  couponId: string;
  transactionId: string;
  items: InvoiceItem[];
  pendingAdjustmentId?: string;
};

const money = (value: number) => new Intl.NumberFormat("sq-XK", { style: "currency", currency: "EUR" }).format(value);

export default function AdjustmentRequestForm(props: Props) {
  const [quantities, setQuantities] = useState<Record<string, string>>(() =>
    Object.fromEntries(props.items.map((item) => [item.id, props.kind === "cancel" ? String(item.remainingQuantity) : "0"]))
  );
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(props.pendingAdjustmentId ? "Ekziston një kërkesë e ruajtur që nuk është dërguar ende në ATK. Konfirmo mënyrën reale të kthimit dhe vazhdo." : "");
  const [created, setCreated] = useState(Boolean(props.pendingAdjustmentId));
  const [createdAdjustmentId, setCreatedAdjustmentId] = useState(props.pendingAdjustmentId ?? "");
  const [accepted, setAccepted] = useState(false);
  const [canRetry, setCanRetry] = useState(Boolean(props.pendingAdjustmentId));
  const [refundPaymentMethod, setRefundPaymentMethod] = useState<"cash" | "card" | "voucher" | "cheque" | "crypto" | "bank_transfer">("cash");

  async function sendToATK(adjustmentId: string) {
    setBusy(true);
    setMessage("Duke nënshkruar dhe dërguar kuponin korrigjues në ATK TEST...");
    const supabase = createClient();
    try {
      const result = await submitInvoiceAdjustmentToATK(supabase, props.organizationId, adjustmentId, refundPaymentMethod);
      setAccepted(true);
      setCanRetry(false);
      setMessage(result.message + " Numri i transaksionit: " + result.transactionId);
    } catch (error) {
      const [{ data: adjustment }, { data: fiscalDocument }] = await Promise.all([
        supabase.from("fiskalo_invoice_adjustments").select("status").eq("id", adjustmentId).maybeSingle(),
        supabase.from("fiskalo_atk_fiscal_documents").select("status,last_error").eq("source_adjustment_id", adjustmentId).maybeSingle(),
      ]);
      let status = fiscalDocument?.status || adjustment?.status || "unknown";
      const detail = error instanceof Error ? error.message : "Dërgimi në ATK dështoi.";
      if (status === "awaiting_atk" && !fiscalDocument) {
        const { data: closed, error: closeError } = await supabase.rpc("fiskalo_reject_invoice_adjustment_preflight", { target_adjustment: adjustmentId, target_detail: detail });
        if (!closeError && closed === true) {
          status = "rejected";
          setCanRetry(false);
          setCreated(false);
          setCreatedAdjustmentId("");
          setMessage("Nuk u dërgua në ATK. " + detail + " Korrigjimi u mbyll si i refuzuar para dërgimit; sasia është liruar. Rregullo pengesën dhe provo përsëri.");
        } else {
          setCanRetry(true);
          setMessage("Nuk u dërgua në ATK. " + detail + " Fiskalo nuk arriti ta mbyllë regjistrimin automatikisht; mos krijo një korrigjim tjetër derisa të rifreskosh faturën.");
        }
      } else if (status === "rejected") {
        setCanRetry(false);
        setCreated(false);
        setCreatedAdjustmentId("");
        setMessage("Korrigjimi nuk u pranua nga ATK ose dështoi para dërgimit. " + (fiscalDocument?.last_error || detail) + " Mund të korrigjosh të dhënat dhe të krijosh një kërkesë të re.");
      } else {
        setCanRetry(false);
        setMessage("Statusi fiskal: " + status + ". " + (fiscalDocument?.last_error || detail) + " Mos e dërgo përsëri pa kontrolluar statusin në ATK.");
      }
    } finally { setBusy(false); }
  }

  const selectedItems = useMemo(() => props.items.flatMap((item) => {
    const quantity = Number(quantities[item.id] || 0);
    if (!Number.isFinite(quantity) || quantity <= 0) return [];
    const remainingQuantity = Number(item.remainingQuantity);
    const ratio = quantity / remainingQuantity;
    const net = quantity === remainingQuantity
      ? Number(item.remainingNet)
      : Math.round(Number(item.remainingNet) * ratio * 100) / 100;
    const vat = quantity === remainingQuantity
      ? Number(item.remainingVat)
      : Math.round(Number(item.remainingVat) * ratio * 100) / 100;
    return [{ invoice_item_id: item.id, quantity, net, vat, total: net + vat, remaining: remainingQuantity }];
  }), [props.items, quantities]);
  const amount = Math.round(selectedItems.reduce((sum, item) => sum + item.total, 0) * 100) / 100;
  const quantityInvalid = selectedItems.some((item) => item.quantity > item.remaining) ||
    selectedItems.some((item) => !Number.isFinite(item.quantity) || item.quantity <= 0);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedItems.length || quantityInvalid || amount <= 0) {
      setMessage("Zgjidh sasi valide për artikujt që po kthehen.");
      return;
    }
    if (props.kind === "cancel" && (selectedItems.length !== props.items.length ||
      selectedItems.some((item) => item.quantity !== item.remaining) || Math.abs(amount - props.total) > 0.01)) {
      setMessage("Anulimi duhet të përfshijë të gjithë artikujt dhe vlerën e plotë të faturës.");
      return;
    }
    setBusy(true);
    setMessage("");
    const supabase = createClient();
    const { data, error } = await supabase.rpc("fiskalo_create_invoice_adjustment_v2", {
      target_invoice: props.invoiceId,
      adjustment_kind: props.kind,
      target_items: selectedItems.map(({ invoice_item_id, quantity }) => ({ invoice_item_id, quantity })),
      adjustment_reason: reason.trim(),
    });
    if (error || !data) {
      setMessage(error?.message || "Kërkesa nuk u ruajt.");
      setBusy(false);
      return;
    }
    const adjustmentId = String(data);
    setCreatedAdjustmentId(adjustmentId);
    setCreated(true);
    setBusy(false);
    await sendToATK(adjustmentId);
  }

  return <form onSubmit={submit} style={{display:"grid",gap:14}}>
    <div style={{padding:13,borderRadius:10,background:"#f5f7fa",fontSize:12,lineHeight:1.7}}>
      <strong>Fatura {props.invoiceNumber}</strong><br/>
      Kuponi origjinal ATK: {props.couponId}<br/>
      Transaksioni origjinal ATK: {props.transactionId}<br/>
      Vlera origjinale: {money(props.total)}
    </div>
    <div style={{display:"grid",gap:8}}>
      <strong style={{fontSize:13}}>{props.kind === "cancel" ? "Artikujt për anulim" : "Zgjidh artikujt dhe sasitë për kthim"}</strong>
      {props.items.map((item) => <label key={item.id} style={{display:"grid",gridTemplateColumns:"minmax(0,1fr) 112px",gap:10,alignItems:"center",padding:"10px 0",borderBottom:"1px solid var(--line)",fontSize:12}}>
        <span><strong>{item.description}</strong><br/><span style={{color:"var(--muted)"}}>Sasia e mbetur: {item.remainingQuantity} · Vlera e mbetur: {money(Number(item.remainingNet)+Number(item.remainingVat))}</span></span>
        <span style={{display:"grid",gap:4}}>Sasia
          <input aria-label={"Sasia për " + item.description} required={props.kind === "cancel"} type="number" min={props.kind === "cancel" ? item.quantity : 0} max={item.remainingQuantity} step="0.001"
            value={quantities[item.id]} readOnly={props.kind === "cancel"}
            onChange={(event) => setQuantities((current) => ({...current,[item.id]:event.target.value}))}
            style={{width:"100%",padding:9,border:"1px solid var(--line)",borderRadius:8,fontSize:14}}/>
        </span>
      </label>)}
    </div>
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"12px 0",borderTop:"1px solid var(--line)"}}>
      <span style={{fontSize:13,fontWeight:700}}>{props.kind === "cancel" ? "Vlera e anulimit" : "Vlera e kthimit"}</span>
      <strong style={{fontSize:22}}>{money(amount)}</strong>
    </div>
    {props.kind === "cancel" && <p style={{margin:0,fontSize:12,color:"var(--muted)"}}>Anulimi përfshin të gjitha linjat dhe vlerën e plotë të faturës origjinale.</p>}
    <label style={{display:"grid",gap:6,fontSize:13,fontWeight:700}}>
      Mënyra e kthimit të pagesës
      <select value={refundPaymentMethod} onChange={event=>setRefundPaymentMethod(event.target.value as "cash" | "card" | "voucher" | "cheque" | "crypto" | "bank_transfer")} style={{padding:11,border:"1px solid var(--line)",borderRadius:9,font:"inherit",background:"white"}}>
        <option value="cash">Para të gatshme</option>
        <option value="card">Kartelë</option>
        <option value="voucher">Vauçer</option>
        <option value="cheque">Çek</option>
        <option value="crypto">Kriptovalutë</option>
        <option value="bank_transfer">Transfer bankar / tjetër</option>
      </select>
    </label>
    <label style={{display:"grid",gap:6,fontSize:13,fontWeight:700}}>
      Arsyeja
      <textarea required minLength={3} maxLength={500} value={reason} onChange={event=>setReason(event.target.value)}
        placeholder="Shëno arsyen e anulimit ose kthimit..." rows={3}
        style={{padding:12,border:"1px solid var(--line)",borderRadius:9,font:"inherit",resize:"vertical"}}/>
    </label>
    <div style={{padding:12,border:"1px solid #d7a64a",borderRadius:9,background:"#fff9eb",fontSize:12,lineHeight:1.6}}>
      <strong>TEST:</strong> Korrigjimi nënshkruhet në këtë pajisje me certifikatën e POS origjinal dhe dërgohet vetëm në ATK TEST. Mënyra e pagesës duhet të përputhet me kthimin real të parave.
    </div>
    <button disabled={busy || created || !reason.trim() || !selectedItems.length || amount <= 0 || quantityInvalid} type="submit"
      style={{border:0,borderRadius:9,padding:"12px 16px",background:"var(--brand)",color:"white",fontWeight:800,cursor:"pointer"}}>
      {busy ? "Duke përpunuar..." : accepted ? "Korrigjimi u pranua nga ATK TEST" : created ? "Kërkesa u ruajt" : props.kind === "cancel" ? "Regjistro dhe dërgo anulimin në ATK TEST" : "Regjistro dhe dërgo kthimin në ATK TEST"}
    </button>
    {createdAdjustmentId && canRetry && !accepted && <button type="button" disabled={busy} onClick={()=>void sendToATK(createdAdjustmentId)} style={{border:"1px solid var(--line)",borderRadius:9,padding:"10px 14px",background:"white",fontWeight:750,cursor:"pointer"}}>Kontrollo / provo dërgimin në ATK TEST</button>}
    {message && <p role="status" style={{margin:0,fontSize:12,color:accepted?"#26734d":"#a33f36"}}>{message}</p>}
  </form>;
}
