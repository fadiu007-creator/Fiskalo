"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { getLocalAgentQueue } from "@/lib/pos/local-agent";

type Business = { id: string; name: string; nui: string };
type Pos = { id: string; label: string; location: string; branch_id: number; pos_id: number };
type Incident = {
  id: string; business_id: string; pos_id: string; outage_started_at: string;
  detected_at: string; cause: string; description: string; restored_at: string | null;
  notice_submitted_at: string | null; notice_channel: string | null;
  authority_reference: string | null; evidence_manifest: Array<{storage_path:string;file_name:string;mime_type:string;size_bytes:number;sha256:string}>;
  monthly_export_submitted_at: string | null; monthly_export_channel: string | null;
  monthly_export_reference: string | null; monthly_export_manifest: Array<{file_name:string}>;
};
const BUCKET = "fiskalo-article44-evidence";
const ALLOWED = ["application/pdf", "image/jpeg", "image/png", "text/plain"];
function evidenceMime(file: File) {
  const declared = (file.type || "").toLowerCase().trim();
  const extension = file.name.toLowerCase().split(".").pop() || "";
  const byExtension: Record<string,string> = {
    pdf:"application/pdf",jpg:"image/jpeg",jpeg:"image/jpeg",png:"image/png",
    txt:"text/plain",json:"application/json",csv:"text/csv"
  };
  if (declared && declared !== "application/octet-stream" && declared !== "image/jpg") return declared;
  return byExtension[extension] ?? (declared === "image/jpg" ? "image/jpeg" : declared || "application/octet-stream");
}
function kosovoLocalDateTimeValue(value: Date) {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone:"Europe/Belgrade",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hourCycle:"h23" }).formatToParts(value);
  const get = (type:string) => parts.find(p=>p.type===type)?.value ?? "00";
  return get("year")+"-"+get("month")+"-"+get("day")+"T"+get("hour")+":"+get("minute");
}
function kosovoLocalDateTimeToIso(value: string) {
  const [datePart,timePart] = value.split("T");
  const [year,month,day] = datePart.split("-").map(Number);
  const [hour,minute] = timePart.split(":").map(Number);
  const target = Date.UTC(year,month-1,day,hour,minute);
  let guess = target;
  const formatter = new Intl.DateTimeFormat("en-GB", { timeZone:"Europe/Belgrade",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hourCycle:"h23" });
  for(let i=0;i<4;i++){
    const parts = formatter.formatToParts(new Date(guess));
    const get = (type:string) => Number(parts.find(p=>p.type===type)?.value ?? 0);
    const represented = Date.UTC(get("year"),get("month")-1,get("day"),get("hour"),get("minute"));
    const delta = represented-target;
    if(delta===0) return new Date(guess).toISOString();
    guess -= delta;
  }
  throw new Error("Koha lokale nuk ekziston në zonën kohore të Kosovës. Zgjidh një orë tjetër.");
}
const fmt = (value: string) => new Intl.DateTimeFormat("sq-XK", {
  dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Belgrade"
}).format(new Date(value));
const eligible = (cause: string) => ["isp_failure", "equipment_change", "force_majeure"].includes(cause);
const deadline = (started: string) => new Date(new Date(started).getTime() + 48 * 60 * 60 * 1000);
function localDateKey(value: string | Date) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Belgrade", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value));
}
function monthlySubmissionDeadline(started: string) {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Belgrade", year: "numeric", month: "2-digit" })
    .formatToParts(new Date(started));
  const year = Number(parts.find(p => p.type === "year")?.value);
  const month = Number(parts.find(p => p.type === "month")?.value);
  const tenth = new Date(Date.UTC(year, month, 9));
  const eleventh = new Date(Date.UTC(year, month, 10));
  const display = new Intl.DateTimeFormat("sq-XK", { dateStyle: "long", timeZone: "UTC" }).format(tenth);
  const afterDeadlineKey = new Intl.DateTimeFormat("en-CA", { timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).format(eleventh);
  return { display, afterDeadlineKey };
}
const causeLabel: Record<string,string> = {
  isp_failure: "Pamundësi e ofruesit të internetit",
  equipment_change: "Nevojitet ndërrimi i pajisjes së lidhjes",
  force_majeure: "Forcë madhore",
  atk_service_unavailable: "Shërbimi i ATK-së nuk ishte i disponueshëm",
  other: "Tjetër shkak"
};
function hex(bytes: ArrayBuffer) {
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, "0")).join("");
}
export default function Article44Page() {
  const supabase = useMemo(() => { try { return createClient(); } catch { return null; } }, []);
  const [userId, setUserId] = useState("");
  const [businesses, setBusinesses] = useState<Business[]>([]);
  const [businessId, setBusinessId] = useState("");
  const [positions, setPositions] = useState<Pos[]>([]);
  const [posId, setPosId] = useState("");
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [startedAt, setStartedAt] = useState(() => kosovoLocalDateTimeValue(new Date()));
  const [cause, setCause] = useState("isp_failure");
  const [description, setDescription] = useState("");
  const [noticeChannel, setNoticeChannel] = useState("electronic");
  const [authorityReference, setAuthorityReference] = useState("");
  const [evidenceFile, setEvidenceFile] = useState<File | null>(null);
  const [pendingManifest, setPendingManifest] = useState<Incident["evidence_manifest"]>([]);
  const [monthlyChannel, setMonthlyChannel] = useState("electronic");
  const [monthlyReference, setMonthlyReference] = useState("");
  const [monthlyFiles, setMonthlyFiles] = useState<File[]>([]);
  const [monthlyManifest, setMonthlyManifest] = useState<Array<{storage_path:string;file_name:string;mime_type:string;size_bytes:number;sha256:string}>>([]);
  const [exportingIncidentId, setExportingIncidentId] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);

  const loadIncidents = useCallback(async (id: string) => {
    if (!supabase || !id) { setIncidents([]); return; }
    const { data, error } = await supabase.from("fiskalo_basic_article44_incidents")
      .select("*").eq("business_id", id).order("outage_started_at", { ascending: false }).limit(50);
    if (error) throw error;
    setIncidents((data ?? []) as Incident[]);
  }, [supabase]);

  useEffect(() => {
    if (!supabase) { setLoading(false); setMessage("Supabase nuk është konfiguruar."); return; }
    let active = true;
    void (async () => {
      try {
        const { data: auth, error: authError } = await supabase.auth.getUser();
        if (authError) throw authError;
        if (!auth.user) { if (active) setMessage("Hyr në Fiskalo për të menaxhuar incidentet e Nenit 44."); return; }
        const { data: memberships, error } = await supabase.from("fiskalo_basic_members")
          .select("business_id").eq("user_id", auth.user.id).eq("role", "owner");
        if (error) throw error;
        const ids = (memberships ?? []).map((m: {business_id:string}) => m.business_id);
        if (!ids.length) { if (active) setMessage("Vetëm pronari i biznesit mund të menaxhojë incidentet dhe njoftimet e Nenit 44."); return; }
        const { data: rows, error: businessesError } = await supabase.from("fiskalo_basic_businesses")
          .select("id,name,nui").in("id", ids).order("name");
        if (businessesError) throw businessesError;
        if (!active) return;
        setUserId(auth.user.id);
        setBusinesses((rows ?? []) as Business[]);
        if (rows?.length) setBusinessId(rows[0].id);
      } catch (e) {
        if (active) setMessage(e instanceof Error ? e.message : "Nuk u ngarkuan të dhënat.");
      } finally { if (active) setLoading(false); }
    })();
    return () => { active = false; };
  }, [supabase]);

  useEffect(() => {
    if (!supabase || !businessId) { setPositions([]); setIncidents([]); return; }
    let active = true;
    void (async () => {
      try {
        const [{ data: posRows, error: posError }, { data: incidentRows, error: incidentError }] = await Promise.all([
          supabase.from("fiskalo_basic_pos").select("id,label,location,branch_id,pos_id").eq("business_id", businessId).order("label"),
          supabase.from("fiskalo_basic_article44_incidents").select("*").eq("business_id", businessId).order("outage_started_at", { ascending: false }).limit(50)
        ]);
        if (posError) throw posError;
        if (incidentError) throw incidentError;
        if (!active) return;
        setPositions((posRows ?? []) as Pos[]);
        setIncidents((incidentRows ?? []) as Incident[]);
        if (posRows?.length) setPosId((old: string) => posRows.some((p: Pos) => p.id === old) ? old : posRows[0].id);
      } catch (e) { if (active) setMessage(e instanceof Error ? e.message : "Nuk u ngarkuan incidentet."); }
    })();
    return () => { active = false; };
  }, [supabase, businessId]);

  async function createIncident(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase || !businessId || !posId) return;
    setBusy(true); setMessage("");
    try {
      const { error } = await supabase.rpc("fiskalo_basic_create_article44_incident", {
        p_business_id: businessId, p_pos_id: posId,
        p_outage_started_at: kosovoLocalDateTimeToIso(startedAt),
        p_cause: cause, p_description: description.trim()
      });
      if (error) throw error;
      setDescription("");
      await loadIncidents(businessId);
      setMessage("Incidenti u regjistrua. Ora e ndërprerjes është raportuar nga pronari/pajisja dhe nuk është ende vërtetim i pavarur nga serveri.");
    } catch (e) { setMessage(e instanceof Error ? e.message : "Regjistrimi i incidentit dështoi."); }
    finally { setBusy(false); }
  }

  async function submitNotice(incident: Incident) {
    if (!supabase || !evidenceFile) { setMessage("Ngarko së paku një dokument ose dëshmi para regjistrimit të njoftimit."); return; }
    const mimeType = evidenceMime(evidenceFile);
    if (!ALLOWED.includes(mimeType) || evidenceFile.size < 1 || evidenceFile.size > 10 * 1024 * 1024) {
      setMessage("Dëshmia duhet të jetë PDF, JPG, PNG ose TXT dhe maksimumi 10 MB."); return;
    }
    setBusy(true); setMessage("");
    let uploadedPath = "";
    try {
      let manifest = pendingManifest;
      if (!manifest.length) {
        const safeName = evidenceFile.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-100) || "evidence";
        uploadedPath = businessId + "/" + incident.id + "/" + crypto.randomUUID() + "-" + safeName;
        const { error: uploadError } = await supabase.storage.from(BUCKET).upload(uploadedPath, evidenceFile, {
          upsert: false, contentType: mimeType
        });
        if (uploadError) throw uploadError;
        const hash = hex(await crypto.subtle.digest("SHA-256", await evidenceFile.arrayBuffer()));
        manifest = [{ storage_path: uploadedPath, file_name: evidenceFile.name,
          mime_type: mimeType, size_bytes: evidenceFile.size, sha256: hash }];
        setPendingManifest(manifest);
      }
      const { error } = await supabase.rpc("fiskalo_basic_record_article44_notice", {
        p_incident_id: incident.id, p_notice_channel: noticeChannel,
        p_authority_reference: authorityReference.trim() || null,
        p_evidence_manifest: manifest
      });
      if (error) throw error;
      setEvidenceFile(null); setPendingManifest([]); setAuthorityReference("");
      await loadIncidents(businessId);
      setMessage("Regjistrimi i njoftimit u ruajt me dëshminë. Kjo nuk e dërgon njoftimin te ATK: dërgoje fillimisht përmes kanalit zyrtar ose paraqite në zyrën përkatëse.");
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Nuk u regjistrua njoftimi. Nëse skedari u ngarkua, provo përsëri pa e ndryshuar incidentin.");
    } finally { setBusy(false); }
  }

  async function exportMonthlyUnfiscalized(incident: Incident) {
    if (!supabase) return;
    const business = businesses.find(b => b.id === incident.business_id);
    const pos = positions.find(p => p.id === incident.pos_id);
    if (!business || !pos) { setMessage("Biznesi ose POS-i i incidentit nuk u gjet."); return; }
    setExportingIncidentId(incident.id); setMessage("");
    try {
      const to = incident.restored_at ?? new Date().toISOString();
      const reference = "Article44(6)-" + incident.id.slice(0, 8);
      const { data, error } = await supabase.rpc("fiskalo_basic_article44_unfiscalized_export", {
        p_business_id: incident.business_id, p_pos_id: incident.pos_id,
        p_from: incident.outage_started_at, p_to: to,
        p_authority_request_reference: reference, p_limit: 5000
      });
      if (error) throw error;
      const token = localStorage.getItem("fiskalo.posAgentToken");
      if (!token) throw new Error("Lidh POS Agent në këtë pajisje. Eksporti duhet të përfshijë edhe radhën lokale të kuponëve.");
      const queue = await getLocalAgentQueue(token);
      const prefix = business.nui + ":" + pos.branch_id + ":" + pos.pos_id + ":";
      const localItems = queue.items.filter(item => {
        const issued = item.offlineIssuedAtUtc ? Date.parse(item.offlineIssuedAtUtc) : NaN;
        return item.idempotencyKey.startsWith(prefix) && Number.isFinite(issued) &&
          issued >= Date.parse(incident.outage_started_at) && issued < Date.parse(to) &&
          item.status.toLowerCase() !== "accepted";
      });
      if ((data as {truncated?:boolean})?.truncated) {
        throw new Error("Eksporti i databazës kalon kufirin 5,000 dokumente. Kërko ndarje të eksportit në periudha më të shkurtra përpara dorëzimit.");
      }
      const allServerDocuments = (data as {documents?:Array<{coupon_id?:string}>})?.documents ?? [];
      const localCouponIds = new Set(localItems.map(item => item.idempotencyKey.split(":").at(-1)));
      const serverDocuments = allServerDocuments.filter(doc => !localCouponIds.has(String(doc.coupon_id)));
      const bundle = {
        format: "Fiskalo Article 44(6) un-fiscalized coupon export v1",
        legal_reference: "Administrative Instruction MFPT No. 01/2026, Article 44(6)",
        generated_at_utc: new Date().toISOString(),
        business: { name: business.name, nui: business.nui },
        pos: { id: pos.id, label: pos.label, branch_id: pos.branch_id, pos_number: pos.pos_id },
        period: { from_utc: incident.outage_started_at, to_utc_exclusive: to },
        database_export: { ...data, documents: serverDocuments, count: serverDocuments.length, duplicates_replaced_by_local_agent: allServerDocuments.length - serverDocuments.length },
        local_pos_agent_unaccepted_coupons: localItems,
        totals: {
          database_unaccepted_documents: serverDocuments.length,
          local_agent_unaccepted_documents: localItems.length,
          database_export_truncated: Boolean((data as {truncated?:boolean})?.truncated),
          local_agent_queue_overdue: queue.overdueCount
        },
        notes: [
          "The export combines server-synchronized fiscal documents and the local POS Agent queue.",
          "Review the export against every POS before submitting it to ATK.",
          "Downloading this file does not submit it to ATK."
        ]
      };
      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url; link.download = "fiskalo-article44-unfiscalized-" + incident.id.slice(0, 8) + ".json";
      document.body.appendChild(link); link.click(); link.remove(); URL.revokeObjectURL(url);
      setMessage("Eksporti u krijua: " + (serverDocuments.length + localItems.length) + " dokumente të pafiskalizuara. Kontrolloje dhe dorëzoje te ATK.");
    } catch (e) { setMessage(e instanceof Error ? e.message : "Eksporti i kuponëve dështoi."); }
    finally { setExportingIncidentId(""); }
  }

  async function recordMonthlySubmission(incident: Incident) {
    if (!supabase) return;
    if (monthlyFiles.length < 2) { setMessage("Ngarko eksportin JSON/CSV dhe dëshminë e dorëzimit te ATK (PDF, JPG, PNG ose TXT)."); return; }
    const monthlyMimes = monthlyFiles.map(evidenceMime);
    const hasExport = monthlyMimes.some(type => type === "application/json" || type === "text/csv");
    const hasProof = monthlyMimes.some(type => ["application/pdf","image/jpeg","image/png","text/plain"].includes(type));
    if (!hasExport || !hasProof) { setMessage("Kërkohet një eksport JSON/CSV dhe së paku një dëshmi e dorëzimit."); return; }
    if (monthlyFiles.some((f,index) => f.size < 1 || f.size > 10 * 1024 * 1024 || ![...ALLOWED,"application/json","text/csv"].includes(monthlyMimes[index]))) {
      setMessage("Çdo skedar duhet të jetë PDF/JPG/PNG/TXT/JSON/CSV dhe maksimumi 10 MB."); return;
    }
    setBusy(true); setMessage("");
    try {
      let manifest = monthlyManifest;
      if (!manifest.length) {
        manifest = [];
        for (const file of monthlyFiles) {
          const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-100) || "evidence";
          const path = incident.business_id + "/" + incident.id + "/monthly-" + crypto.randomUUID() + "-" + safeName;
          const { error: uploadError } = await supabase.storage.from(BUCKET).upload(path, file, { upsert: false, contentType: evidenceMime(file) });
          if (uploadError) throw uploadError;
          const hash = hex(await crypto.subtle.digest("SHA-256", await file.arrayBuffer()));
          manifest.push({ storage_path:path,file_name:file.name,mime_type:evidenceMime(file),size_bytes:file.size,sha256:hash });
        }
        setMonthlyManifest(manifest);
      }
      const { error } = await supabase.rpc("fiskalo_basic_record_article44_monthly_submission", {
        p_incident_id: incident.id, p_submission_channel: monthlyChannel,
        p_authority_reference: monthlyReference.trim() || null, p_evidence_manifest: manifest
      });
      if (error) throw error;
      setMonthlyFiles([]); setMonthlyManifest([]); setMonthlyReference("");
      await loadIncidents(businessId);
      setMessage("Dorëzimi sipas Nenit 44(6) u regjistrua bashkë me eksportin dhe dëshminë. Fiskalo nuk e dërgon paketën automatikisht te ATK.");
    } catch (e) { setMessage(e instanceof Error ? e.message : "Nuk u regjistrua dorëzimi mujor."); }
    finally { setBusy(false); }
  }

  async function restoreIncident(incident: Incident) {
    if (!supabase || !window.confirm("Konfirmo që lidhja e internetit është rivendosur për këtë POS.")) return;
    setBusy(true); setMessage("");
    try {
      const { error } = await supabase.rpc("fiskalo_basic_restore_article44_incident", {
        p_incident_id: incident.id, p_restored_at: new Date().toISOString()
      });
      if (error) throw error;
      await loadIncidents(businessId);
      setMessage("Rivendosja u regjistrua. Kontrollo që të gjithë kuponët offline të jenë dorëzuar dhe pranuar nga ATK.");
    } catch (e) { setMessage(e instanceof Error ? e.message : "Nuk u regjistrua rivendosja."); }
    finally { setBusy(false); }
  }

  if (loading) return <main className="article44-shell"><p>Duke ngarkuar…</p></main>;
  if (!userId) return <main className="article44-shell"><Link href="/">← Kthehu në Fiskalo</Link><h1>Neni 44 — Ndërprerja e internetit</h1><p>{message || "Hyr në llogari."}</p></main>;

  return <main className="article44-shell">
    <header className="article44-header"><Link href="/" className="article44-brand">fiskalo<span>.</span></Link><Link href="/">← Kthehu te POS</Link></header>
    <section className="article44-intro">
      <span className="article44-kicker">PAJTUESHMËRIA · UDHËZIMI ADMINISTRATIV MFPT NR. 01/2026</span>
      <h1>Neni 44 — Ndërprerja e lidhjes së internetit</h1>
      <p>Regjistro ndërprerjen, afatin 48-orësh, dëshmitë dhe njoftimin që tatimpaguesi duhet t’ia paraqesë ATK-së kur plotësohen kushtet ligjore.</p>
      <p className="article44-warning">Ora e fillimit këtu regjistrohet nga pronari. Fiskalo ende nuk e vërteton automatikisht me orë të nënshkruar nga serveri.</p>
      <p className="article44-warning">Incidenti dhe eksporti lidhen me një POS. Nëse ndërprerja prek disa POS, regjistro incident dhe krijo eksport për secilin POS nga pajisja/Agent-i përkatës, që të përfshihen të gjitha radhët lokale.</p>
    </section>
    {message && <p className="article44-message" role="status">{message}</p>}
    <section className="article44-card">
      <h2>Regjistro incident të ri</h2>
      <form onSubmit={createIncident} className="article44-form">
        <label>Biznesi<select value={businessId} onChange={e => setBusinessId(e.target.value)}>{businesses.map(b => <option key={b.id} value={b.id}>{b.name} · NUI {b.nui}</option>)}</select></label>
        <label>POS<select value={posId} onChange={e => setPosId(e.target.value)}>{positions.map(p => <option key={p.id} value={p.id}>{p.label} — {p.location}</option>)}</select></label>
        <label>Koha e Kosovës kur filloi ndërprerja<input type="datetime-local" required value={startedAt} onChange={e => setStartedAt(e.target.value)}/></label>
        <label>Shkaku<select value={cause} onChange={e => setCause(e.target.value)}>
          <option value="isp_failure">Ofruesi i internetit nuk mund të vendosë lidhjen</option>
          <option value="equipment_change">Duhet ndërruar pajisja e lidhjes</option>
          <option value="force_majeure">Forcë madhore</option>
          <option value="atk_service_unavailable">Serveri/shërbimi i ATK-së nuk përgjigjet</option>
          <option value="other">Tjetër shkak</option>
        </select></label>
        <label className="article44-wide">Përshkrimi dhe rrethanat<textarea required minLength={10} maxLength={2000} value={description} onChange={e => setDescription(e.target.value)} placeholder="Përshkruaj çfarë ndodhi, pajisjen/lidhjen e prekur dhe veprimet e ndërmarra."/></label>
        <button className="article44-primary" disabled={busy || !positions.length}>{busy ? "Duke ruajtur…" : "Regjistro incidentin"}</button>
      </form>
    </section>
    <section className="article44-list">
      <h2>Historiku i incidenteve</h2>
      {!incidents.length && <p className="article44-muted">Nuk ka incidente të regjistruara për këtë biznes.</p>}
      {incidents.map(incident => {
        const due = deadline(incident.outage_started_at);
        const effectiveEnd = incident.restored_at ? Date.parse(incident.restored_at) : Date.now();
        const requiresNotice = eligible(incident.cause) && effectiveEnd >= due.getTime() && !incident.notice_submitted_at;
        const monthlyDue = monthlySubmissionDeadline(incident.outage_started_at);
        const monthlyEffectiveEndKey = localDateKey(incident.restored_at ?? new Date());
        const monthlyRequired = eligible(incident.cause) && monthlyEffectiveEndKey >= monthlyDue.afterDeadlineKey &&
          !incident.monthly_export_submitted_at;
        return <article className="article44-card" key={incident.id}>
          <div className="article44-incident-head"><div><span className="article44-kicker">{causeLabel[incident.cause] || incident.cause}</span><h3>{positions.find(p => p.id === incident.pos_id)?.label || "POS"}</h3></div>
            <span className={incident.restored_at ? "article44-status done" : "article44-status open"}>{incident.restored_at ? "Lidhja u rivendos" : "Incident aktiv"}</span></div>
          <p>{incident.description}</p>
          <dl className="article44-details"><div><dt>Fillimi</dt><dd>{fmt(incident.outage_started_at)}</dd></div><div><dt>Afati 48h</dt><dd>{fmt(due.toISOString())}</dd></div>
            <div><dt>Rivendosja</dt><dd>{incident.restored_at ? fmt(incident.restored_at) : "Në pritje"}</dd></div>
            <div><dt>Njoftimi ATK</dt><dd>{incident.notice_submitted_at ? fmt(incident.notice_submitted_at) + " · " + (incident.notice_channel === "electronic" ? "Elektronik" : "Personalisht") : "Nuk është regjistruar"}</dd></div><div><dt>Dorëzimi mujor</dt><dd>{incident.monthly_export_submitted_at ? fmt(incident.monthly_export_submitted_at) : "Nuk është regjistruar"}</dd></div></dl>
          {requiresNotice && <div className="article44-notice">
            <strong>Afati 48-orësh ka kaluar.</strong>
            <p>Sipas Nenit 44(5), kur lidhja nuk mund të rikthehet për shkak të pajisjes, ofruesit të internetit ose forcës madhore, tatimpaguesi duhet ta njoftojë ATK-në dhe të paraqesë dëshmi. Dërgoje njoftimin zyrtarisht përpara se ta shënosh këtu.</p>
            <label>Kanal i njoftimit<select value={noticeChannel} onChange={e => setNoticeChannel(e.target.value)}><option value="electronic">Elektronik</option><option value="in_person">Personalisht në zyrën përkatëse</option></select></label>
            <label>Referenca e pranimit (nëse ka)<input value={authorityReference} onChange={e => setAuthorityReference(e.target.value)} maxLength={200}/></label>
            <label>Dëshmi (PDF/JPG/PNG/TXT, max 10 MB)<input type="file" accept=".pdf,.jpg,.jpeg,.png,.txt" onChange={e => {setEvidenceFile(e.target.files?.[0] ?? null);setPendingManifest([]);}}/></label>
            {pendingManifest.length > 0 && <p className="article44-muted">Dëshmia është ngarkuar dhe mund të regjistrohet përsëri: {pendingManifest[0].file_name}</p>}
            <button className="article44-primary" disabled={busy || (!evidenceFile && !pendingManifest.length)} onClick={() => void submitNotice(incident)}>{busy ? "Duke ruajtur…" : "Regjistro njoftimin dhe dëshminë"}</button>
          </div>}
          {monthlyRequired && <div className="article44-notice">
            <strong>Afati i datës 10 të muajit vijues ka kaluar.</strong>
            <p>Sipas Nenit 44(6), nëse lidhja nuk është rivendosur deri më 10 të muajit pasues, tatimpaguesi duhet t’ia paraqesë ATK-së të gjithë kuponët e pafiskalizuar. Gjenero paketën e kombinuar nga databaza dhe radha lokale e POS Agent, kontrolloje dhe dorëzoje te ATK.</p>
            <p className="article44-muted">Afati: {monthlyDue.display}. Eksporti kërkon POS Agent aktiv në këtë pajisje.</p>
            <button className="article44-primary" disabled={!!exportingIncidentId || busy} onClick={() => void exportMonthlyUnfiscalized(incident)}>{exportingIncidentId === incident.id ? "Duke përgatitur…" : "Eksporto kuponët e pafiskalizuar"}</button>
            <label>Kanal i dorëzimit<select value={monthlyChannel} onChange={e => setMonthlyChannel(e.target.value)}><option value="electronic">Elektronik</option><option value="in_person">Personalisht në zyrën përkatëse</option></select></label>
            <label>Referenca e pranimit (nëse ka)<input value={monthlyReference} onChange={e => setMonthlyReference(e.target.value)} maxLength={200}/></label>
            <label>Eksporti JSON/CSV dhe dëshmia e dorëzimit (PDF/JPG/PNG/TXT)<input type="file" multiple accept=".json,.csv,.pdf,.jpg,.jpeg,.png,.txt" onChange={e => {setMonthlyFiles(Array.from(e.target.files ?? []));setMonthlyManifest([]);}}/></label>
            {monthlyManifest.length > 0 && <p className="article44-muted">Skedarët janë ngarkuar: {monthlyManifest.length}. Mund ta riprovosh regjistrimin.</p>}
            <button className="article44-primary" disabled={busy || monthlyFiles.length < 2 && monthlyManifest.length < 2} onClick={() => void recordMonthlySubmission(incident)}>{busy ? "Duke ruajtur…" : "Regjistro dorëzimin dhe dëshmitë"}</button>
          </div>}
          {incident.monthly_export_submitted_at && <p className="article44-evidence">Dorëzimi sipas paragrafit 6 u regjistrua. Dëshmi: {incident.monthly_export_manifest.length}. Referenca: {incident.monthly_export_reference || "Nuk është dhënë"}.</p>}
          {incident.notice_submitted_at && <p className="article44-evidence">Dëshmi të arkivuara: {incident.evidence_manifest.length}. Referenca: {incident.authority_reference || "Nuk është dhënë"}.</p>}
          {!incident.restored_at && <button className="article44-secondary" disabled={busy} onClick={() => void restoreIncident(incident)}>Shëno lidhjen si të rivendosur</button>}
        </article>;
      })}
    </section>
    <footer className="article44-foot">Fiskalo regjistron deklarimet dhe dokumentet e ngarkuara; nuk paraqet njoftim në emër të tatimpaguesit dhe nuk zëvendëson konfirmimin e ATK-së.</footer>
    <style jsx>{`
      .article44-shell{max-width:980px;margin:0 auto;padding:24px;color:#17251e;font-family:Arial,sans-serif}
      .article44-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:34px}
      .article44-brand{font-size:23px;font-weight:800;color:#137a55}.article44-brand span{color:#e27b46}
      .article44-header a:last-child{color:#137a55;font-weight:700}
      .article44-intro{margin-bottom:26px}.article44-kicker{font-size:11px;letter-spacing:.08em;font-weight:800;color:#137a55}
      h1{font-size:clamp(27px,5vw,38px);line-height:1.1;margin:10px 0}.article44-intro p{color:#687970;line-height:1.6;max-width:760px}
      .article44-warning{background:#fff6e8;border:1px solid #f0d8a9;border-radius:10px;padding:12px;color:#79531b!important}
      .article44-card{background:#fff;border:1px solid #e1e9e3;border-radius:14px;padding:20px;margin:14px 0}
      h2{font-size:20px;margin:0 0 16px}h3{font-size:18px;margin:6px 0}
      .article44-form{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}
      label{display:grid;gap:7px;font-size:13px;font-weight:700;color:#34463b}
      input,select,textarea{width:100%;border:1px solid #d7e1da;border-radius:8px;padding:10px;background:#fff;color:#17251e;font:inherit}
      textarea{min-height:90px;resize:vertical}.article44-wide{grid-column:1/-1}
      .article44-primary,.article44-secondary{border:0;border-radius:9px;padding:11px 15px;font-weight:700;cursor:pointer}
      .article44-primary{background:#137a55;color:#fff}.article44-secondary{background:#edf4ef;color:#145b40;margin-top:14px}
      button:disabled{opacity:.55;cursor:not-allowed}.article44-message{padding:12px;background:#eef6f0;border-radius:9px;color:#225b3c}
      .article44-list{margin-top:30px}.article44-muted{color:#687970;font-size:13px}
      .article44-incident-head{display:flex;justify-content:space-between;gap:12px;align-items:center}
      .article44-status{font-size:11px;font-weight:800;padding:6px 9px;border-radius:20px}
      .article44-status.open{background:#fff3df;color:#8a5a0b}.article44-status.done{background:#e7f4eb;color:#1c6942}
      .article44-details{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin:16px 0}
      .article44-details div{background:#f6f9f7;padding:10px;border-radius:8px}.article44-details dt{font-size:11px;color:#687970}.article44-details dd{margin:5px 0 0;font-size:12px;font-weight:700}
      .article44-notice{background:#fff9ee;border:1px solid #f0dfbd;border-radius:10px;padding:14px;margin-top:14px;display:grid;gap:12px}
      .article44-notice p{font-size:13px;line-height:1.5;color:#72521d;margin:0}
      .article44-notice button{justify-self:start}.article44-evidence{font-size:12px;color:#286343}
      .article44-foot{font-size:12px;color:#687970;margin:24px 0}
      @media(max-width:680px){.article44-form{grid-template-columns:1fr}.article44-wide{grid-column:auto}.article44-details{grid-template-columns:repeat(2,minmax(0,1fr))}.article44-shell{padding:16px}}
      @media print{.article44-header,.article44-form,.article44-primary,.article44-secondary,.article44-notice,.article44-foot{display:none!important}.article44-card{break-inside:avoid;box-shadow:none}}
    `}</style>
  </main>;
}
