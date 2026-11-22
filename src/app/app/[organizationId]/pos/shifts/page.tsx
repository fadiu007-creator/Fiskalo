"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

type ShiftReport = { id: string; cashier_shift_id: string; report_number: string; generated_at: string };

type Shift = {
  id: string;
  status: "open" | "closed";
  opening_cash: number;
  expected_cash: number | null;
  counted_cash: number | null;
  cash_difference: number | null;
  opened_at: string;
  closed_at: string | null;
  note: string | null;
};

const field: React.CSSProperties = { width: "100%", border: "1px solid var(--line)", borderRadius: 8, padding: "11px 12px", background: "white", color: "var(--ink)" };
const primary: React.CSSProperties = { border: 0, borderRadius: 8, padding: "11px 15px", background: "var(--brand)", color: "white", fontWeight: 750, cursor: "pointer" };
const money = (value: number) => new Intl.NumberFormat("sq-XK", { style: "currency", currency: "EUR" }).format(value);

export default function CashierShiftsPage() {
  const params = useParams<{ organizationId: string }>();
  const organizationId = params.organizationId;
  const supabase = useMemo(() => createClient(), []);
  const [shift, setShift] = useState<Shift | null>(null);
  const [recent, setRecent] = useState<Shift[]>([]);
  const [recentReports, setRecentReports] = useState<ShiftReport[]>([]);
  const [latestReportId, setLatestReportId] = useState("");
  const [openingCash, setOpeningCash] = useState("0");
  const [countedCash, setCountedCash] = useState("");
  const [closingNote, setClosingNote] = useState("");
  const [movementType, setMovementType] = useState<"cash_in" | "cash_out">("cash_out");
  const [movementAmount, setMovementAmount] = useState("");
  const [movementNote, setMovementNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [permissionChecked, setPermissionChecked] = useState(false);
  const [canUseShift, setCanUseShift] = useState(false);

  const load = useCallback(async () => {
    const { data: auth } = await supabase.auth.getUser();
    if (!auth.user) { setError("Sesioni ka skaduar. Hyr përsëri."); return; }
    const { data: membership, error: membershipError } = await supabase
      .from("fiskalo_organization_users")
      .select("role")
      .eq("organization_id", organizationId)
      .eq("user_id", auth.user.id)
      .maybeSingle();
    if (membershipError || !membership) {
      setError("Nuk u verifikua anëtarësia në këtë biznes.");
      return;
    }
    const allowed = ["owner", "administrator", "manager", "cashier"].includes(membership.role);
    setCanUseShift(allowed);
    setPermissionChecked(true);
    if (!allowed) return;
    const historyQuery = supabase.from("fiskalo_cashier_shifts").select("*")
      .eq("organization_id", organizationId)
      .order("opened_at", { ascending: false })
      .limit(10);
    const scopedHistoryQuery = ["owner", "administrator", "manager"].includes(membership.role)
      ? historyQuery
      : historyQuery.eq("opened_by", auth.user.id);
    const [active, history] = await Promise.all([
      supabase.from("fiskalo_cashier_shifts").select("*").eq("organization_id", organizationId).eq("opened_by", auth.user.id).eq("status", "open").maybeSingle(),
      scopedHistoryQuery,
    ]);
    if (active.error || history.error) {
      setError("Nuk mund të lexohen ndërrimet. Kontrollo nëse migrimi i arkës është aplikuar në Supabase.");
      return;
    }
    setShift(active.data as Shift | null);
    setRecent((history.data ?? []) as Shift[]);
    const shiftIds = (history.data ?? []).map((row) => row.id);
    const { data: reports, error: reportsError } = shiftIds.length
      ? await supabase.from("fiskalo_cashier_shift_reports").select("id,cashier_shift_id,report_number,generated_at")
          .eq("organization_id", organizationId).in("cashier_shift_id", shiftIds).order("generated_at", { ascending: false })
      : { data: [], error: null };
    if (reportsError) { setError("Ndërrimet u lexuan, por raportet Z nuk u ngarkuan. Apliko migrimin e raporteve të arkës."); return; }
    setRecentReports((reports ?? []) as ShiftReport[]);
    setError("");
  }, [organizationId, supabase]);

  useEffect(() => { void load(); }, [load]);

  async function openShift(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const amount = Number(openingCash);
    if (!Number.isFinite(amount) || amount < 0) { setError("Shkruaj gjendjen fillestare të arkës."); return; }
    setBusy(true); setError(""); setMessage("");
    const { error: rpcError } = await supabase.rpc("fiskalo_open_cashier_shift", { target_org: organizationId, opening_amount: amount });
    if (rpcError) setError(rpcError.message);
    else { setMessage("Ndërrimi u hap."); await load(); }
    setBusy(false);
  }

  async function addMovement(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const amount = Number(movementAmount);
    if (!Number.isFinite(amount) || amount <= 0 || !movementNote.trim()) { setError("Shkruaj shumën dhe arsyen e lëvizjes së parasë."); return; }
    if (!shift) return;
    setBusy(true); setError(""); setMessage("");
    const { error: rpcError } = await supabase.rpc("fiskalo_record_cash_movement", {
      target_shift: shift.id, movement: movementType, movement_amount: amount, movement_note: movementNote.trim(),
    });
    if (rpcError) setError(rpcError.message);
    else { setMovementAmount(""); setMovementNote(""); setMessage("Lëvizja e arkës u regjistrua."); await load(); }
    setBusy(false);
  }

  async function closeShift(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!shift) return;
    const amount = Number(countedCash);
    if (!Number.isFinite(amount) || amount < 0) { setError("Shkruaj shumën e numëruar në arkë."); return; }
    setBusy(true); setError(""); setMessage("");
    const { data, error: rpcError } = await supabase.rpc("fiskalo_close_cashier_shift", {
      target_shift: shift.id, counted_amount: amount, closing_note: closingNote.trim() || null,
    });
    if (rpcError) setError(rpcError.message);
    else {
      const result = Array.isArray(data) ? data[0] : data;
      setLatestReportId(String(result?.report_id ?? ""));
      setMessage("Ndërrimi u mbyll. Raporti i brendshëm Z u krijua me gjendjen e arkës dhe evidencën e pagesave.");
      setCountedCash(""); setClosingNote(""); await load();
    }
    setBusy(false);
  }

  if (!permissionChecked) return <main style={{ maxWidth: 1050, margin: "0 auto", padding: 24 }}>Po kontrollohet qasja…</main>;
  if (!canUseShift) return <main style={{ maxWidth: 650, margin: "40px auto", padding: 24 }}><h1>Qasje e kufizuar</h1><p style={{ color: "var(--muted)" }}>Ndërrimet e arkës përdoren nga pronari, administratori, menaxheri ose arkëtari.</p><Link href={"/app/" + organizationId} style={{ color: "var(--brand)", fontWeight: 750 }}>Kthehu te paneli</Link></main>;

  return <main style={{ maxWidth: 1050, margin: "0 auto", padding: "22px 16px 50px" }}>
    <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 20 }}>
      <div><Link href={`/app/${organizationId}/pos`} style={{ color: "var(--brand)", fontWeight: 750 }}>← Kthehu te POS</Link><h1 style={{ margin: "8px 0 4px", fontSize: 27 }}>Ndërrimi i arkëtarit</h1><p style={{ margin: 0, color: "var(--muted)", fontSize: 13 }}>Hap arkën, regjistro hyrje/dalje dhe barazo paratë në fund të ndërrimit.</p></div>
      <button onClick={() => void load()} style={{ ...field, width: "auto", cursor: "pointer" }}>Rifresko</button>
    </header>
    {error && <div role="alert" style={{ padding: 12, borderRadius: 8, background: "#fff0ef", color: "#982d25", marginBottom: 14 }}>{error}</div>}
    {message && <div role="status" style={{ padding: 12, borderRadius: 8, background: "#edf7f1", color: "#155c3c", marginBottom: 14 }}>{message}{latestReportId && <div style={{marginTop:6}}><Link href={`/app/${organizationId}/pos/shifts/reports/${latestReportId}`} style={{fontWeight:800,textDecoration:"underline"}}>Hap raportin Z</Link></div>}</div>}
    {shift ? <section style={{ border: "1px solid var(--line)", borderRadius: 12, padding: 18, background: "var(--surface)", display: "grid", gap: 16 }}>
      <div><strong style={{ color: "#167044" }}>Ndërrimi është i hapur</strong><div style={{ color: "var(--muted)", fontSize: 12, marginTop: 4 }}>Hapur: {new Date(shift.opened_at).toLocaleString("sq-XK")}</div><div style={{ marginTop: 8 }}>Para fillestare: <strong>{money(Number(shift.opening_cash))}</strong></div></div>
      <form onSubmit={addMovement} style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(160px,1fr))", gap: 10, alignItems: "end" }}>
        <label style={{ display: "grid", gap: 5, fontSize: 12 }}>Lëvizja<select value={movementType} onChange={e => setMovementType(e.target.value as "cash_in" | "cash_out")} style={field}><option value="cash_in">Hyrje në arkë</option><option value="cash_out">Dalje nga arka</option></select></label>
        <label style={{ display: "grid", gap: 5, fontSize: 12 }}>Shuma (€)<input required type="number" min="0.01" step="0.01" value={movementAmount} onChange={e => setMovementAmount(e.target.value)} style={field} /></label>
        <label style={{ display: "grid", gap: 5, fontSize: 12 }}>Arsyeja<input required value={movementNote} onChange={e => setMovementNote(e.target.value)} placeholder="p.sh. furnizim me kusur" style={field} /></label>
        <button disabled={busy} style={primary}>Regjistro lëvizjen</button>
      </form>
      <form onSubmit={closeShift} style={{ borderTop: "1px solid var(--line)", paddingTop: 16, display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(190px,1fr))", gap: 10, alignItems: "end" }}>
        <label style={{ display: "grid", gap: 5, fontSize: 12 }}>Para të numëruara në fund (€)<input required type="number" min="0" step="0.01" value={countedCash} onChange={e => setCountedCash(e.target.value)} style={field} /></label>
        <label style={{ display: "grid", gap: 5, fontSize: 12 }}>Shënim (opsional)<input value={closingNote} onChange={e => setClosingNote(e.target.value)} style={field} /></label>
        <button disabled={busy} style={primary}>Mbyll ndërrimin dhe barazo arkën</button>
      </form>
    </section> : <form onSubmit={openShift} style={{ border: "1px solid var(--line)", borderRadius: 12, padding: 18, display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(210px,1fr))", gap: 12, alignItems: "end" }}>
      <div style={{ gridColumn: "1 / -1" }}><strong>Nuk ke ndërrim të hapur</strong><p style={{ margin: "5px 0 0", color: "var(--muted)", fontSize: 13 }}>Shëno sa para gjenden në arkë para shitjes së parë.</p></div>
      <label style={{ display: "grid", gap: 5, fontSize: 12 }}>Gjendja fillestare (€)<input required type="number" min="0" step="0.01" value={openingCash} onChange={e => setOpeningCash(e.target.value)} style={field} /></label>
      <button disabled={busy} style={primary}>Hap ndërrimin</button>
    </form>}
    <section style={{ marginTop: 24 }}>
      <h2 style={{ fontSize: 18 }}>Ndërrimet e fundit</h2>
      <div style={{ overflowX: "auto", border: "1px solid var(--line)", borderRadius: 10 }}>
        <table className="data-table" style={{ width: "100%", minWidth: 620 }}>
          <thead><tr><th>Hapur</th><th>Statusi</th><th>Fillimi</th><th>Praktikisht</th><th>Diferenca</th></tr></thead>
          <tbody>{recent.map(row => <tr key={row.id}><td>{new Date(row.opened_at).toLocaleString("sq-XK")}</td><td>{row.status === "open" ? "Hapur" : "Mbyllur"}</td><td>{money(Number(row.opening_cash))}</td><td>{row.counted_cash === null ? "—" : money(Number(row.counted_cash))}</td><td>{row.cash_difference === null ? "—" : money(Number(row.cash_difference))}</td></tr>)}{!recent.length && <tr><td colSpan={5}>Ende nuk ka ndërrime.</td></tr>}</tbody>
        </table>
      </div>
    </section>
    <section style={{ marginTop: 24 }}>
      <h2 style={{ fontSize: 18 }}>Raportet Z të arkës</h2>
      <div style={{ overflowX: "auto", border: "1px solid var(--line)", borderRadius: 10 }}>
        <table className="data-table" style={{ width: "100%", minWidth: 520 }}>
          <thead><tr><th>Raporti</th><th>Gjeneruar</th><th>Dokumenti</th></tr></thead>
          <tbody>{recentReports.map(report => <tr key={report.id}><td><strong>{report.report_number}</strong></td><td>{new Date(report.generated_at).toLocaleString("sq-XK")}</td><td><Link href={`/app/${organizationId}/pos/shifts/reports/${report.id}`} style={{color:"var(--brand)",fontWeight:800}}>Hap raportin Z</Link></td></tr>)}{!recentReports.length && <tr><td colSpan={3}>Ende nuk ka raporte Z.</td></tr>}</tbody>
        </table>
      </div>
    </section>
    <p style={{ marginTop: 14, color: "var(--muted)", fontSize: 11, lineHeight: 1.5 }}>Raportet X/Z në Fiskalo janë vetëm raporte të brendshme menaxheriale. Nuk janë raporte tatimore zyrtare të ATK-së dhe nuk dërgohen në ATK. Pagesat me para në dorë lidhen automatikisht me ndërrimin aktiv të arkëtarit.</p>
  </main>;
}
