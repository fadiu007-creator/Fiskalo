"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export default function StockAdjustment({ productId, productName }: { productId: string; productName: string }) {
  const [open, setOpen] = useState(false);
  const [quantity, setQuantity] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const router = useRouter();

  async function save() {
    const parsed = Number(quantity);
    if (!Number.isFinite(parsed) || parsed === 0) { setError("Shkruaj sasi pozitive ose negative, jo zero."); return; }
    setSaving(true); setError("");
    try {
      const supabase = createClient();
      const { error: rpcError } = await supabase.rpc("fiskalo_adjust_stock", {
        target_product: productId,
        quantity_delta: parsed,
        movement_note: note.trim() || null,
      });
      if (rpcError) throw rpcError;
      setOpen(false); setQuantity(""); setNote("");
      router.refresh();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Stoku nuk u përditësua.");
    } finally { setSaving(false); }
  }

  return <div style={{ minWidth: 118 }}>
    {!open ? <button type="button" onClick={() => setOpen(true)} style={{ border: "1px solid var(--line)", borderRadius: 8, background: "#fff", color: "var(--ink)", padding: "7px 10px", fontSize: 11, fontWeight: 750 }}>Rregullo stokun</button> :
      <div style={{ display: "grid", gap: 6, minWidth: 190 }}>
        <label style={{ fontSize: 10, color: "var(--muted)" }} htmlFor={"stock-delta-" + productId}>Ndryshimi (+ hyrje / − dalje)</label>
        <input id={"stock-delta-" + productId} type="number" step="0.001" value={quantity} onChange={e => setQuantity(e.target.value)} placeholder="p.sh. 5 ose -2" style={{ width: "100%", boxSizing: "border-box", padding: "8px", border: "1px solid var(--line)", borderRadius: 7 }} />
        <input value={note} onChange={e => setNote(e.target.value)} placeholder="Arsyeja (opsionale)" aria-label={"Arsyeja e rregullimit për " + productName} style={{ width: "100%", boxSizing: "border-box", padding: "8px", border: "1px solid var(--line)", borderRadius: 7 }} />
        {error ? <span role="alert" style={{ color: "#a33b31", fontSize: 11, maxWidth: 210 }}>{error}</span> : null}
        <div style={{ display: "flex", gap: 5 }}>
          <button type="button" disabled={saving} onClick={() => void save()} style={{ border: 0, borderRadius: 7, background: "var(--brand)", color: "#fff", padding: "7px 9px", fontSize: 11, fontWeight: 750 }}>{saving ? "Duke ruajtur…" : "Ruaj"}</button>
          <button type="button" disabled={saving} onClick={() => { setOpen(false); setError(""); }} style={{ border: "1px solid var(--line)", borderRadius: 7, background: "#fff", padding: "7px 9px", fontSize: 11 }}>Anulo</button>
        </div>
      </div>}
  </div>;
}
