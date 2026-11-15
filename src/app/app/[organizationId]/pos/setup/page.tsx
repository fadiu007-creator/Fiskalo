"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import {
  createBrowserPosCsr, getBrowserPosCsr, deleteBrowserPosKey, hasBrowserPosCertificate,
  hasBrowserPosKey, installBrowserPosCertificate,
} from "@/lib/atk/browser-key-vault";

type Pos = { id: string; atk_branch_id: number; pos_id: number; label: string; location: string | null; environment: string; status: string; certificate_serial: string | null };
type Profile = { fiscalization_number: string };
type Organization = { nui: string; legal_name: string; municipality: string | null };
type Verification = { businessName: string; verificationCode: string };

const field: React.CSSProperties = { width: "100%", border: "1px solid var(--line)", borderRadius: 9, padding: "11px 12px", color: "var(--ink)", background: "white" };
const panel: React.CSSProperties = { border: "1px solid var(--line)", borderRadius: 13, padding: 16, background: "white" };
const primary: React.CSSProperties = { border: 0, borderRadius: 9, padding: "11px 15px", background: "var(--brand)", color: "white", fontWeight: 750, cursor: "pointer" };
const secondary: React.CSSProperties = { border: "1px solid var(--line)", borderRadius: 9, padding: "10px 13px", background: "white", color: "var(--ink)", fontWeight: 650, cursor: "pointer" };

export default function WebPosSetupPage() {
  const { organizationId } = useParams<{ organizationId: string }>();
  const supabase = useMemo(() => createClient(), []);
  const [org, setOrg] = useState<Organization | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [positions, setPositions] = useState<Pos[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [applicationId, setApplicationId] = useState("457818860373");
  const [fiscalizationNumber, setFiscalizationNumber] = useState("");
  const [form, setForm] = useState({ label: "Web POS – Arka kryesore", branch: "761", pos: "1", location: "" });
  const [verification, setVerification] = useState<Verification | null>(null);
  const [keyReady, setKeyReady] = useState(false);
  const [certificateReady, setCertificateReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [permissionChecked, setPermissionChecked] = useState(false);
  const [canManage, setCanManage] = useState(false);

  const selected = positions.find((p) => p.id === selectedId);
  const keyId = selected ? organizationId + ":" + selected.id : "";

  const load = useCallback(async () => {
    setError("");
    const { data: auth } = await supabase.auth.getUser();
    if (!auth.user) { setCanManage(false); setPermissionChecked(true); setError("Sesioni ka skaduar. Hyr përsëri."); return; }
    const { data: membership } = await supabase.from("fiskalo_organization_users")
      .select("role").eq("organization_id", organizationId).eq("user_id", auth.user.id).maybeSingle();
    const allowed = Boolean(membership && ["owner", "administrator"].includes(membership.role));
    setCanManage(allowed);
    setPermissionChecked(true);
    if (!allowed) return;
    const [orgRes, profileRes, posRes, providerApplicationIdRes] = await Promise.all([
      supabase.from("fiskalo_organizations").select("nui,legal_name,municipality").eq("id", organizationId).single(),
      supabase.from("fiskalo_atk_taxpayer_profiles").select("fiscalization_number").eq("organization_id", organizationId).maybeSingle(),
      supabase.from("fiskalo_atk_pos_installations").select("id,atk_branch_id,pos_id,label,location,environment,status,certificate_serial").eq("organization_id", organizationId).eq("environment", "test").order("atk_branch_id", { ascending: true }).order("pos_id", { ascending: true }),
      supabase.rpc("fiskalo_get_business_application_id", { target_org: organizationId }),
    ]);
    if (orgRes.error || !orgRes.data) setError("Nuk u lexuan të dhënat e biznesit.");
    else setOrg(orgRes.data as Organization);
    setProfile((profileRes.data as Profile | null) ?? null);
    const configuredApplicationId = providerApplicationIdRes.data;
    if (providerApplicationIdRes.error) setError("Application ID i ofruesit nuk u lexua: " + providerApplicationIdRes.error.message);
    if (configuredApplicationId) {
      setApplicationId(String(configuredApplicationId));
      window.localStorage.setItem("fiskalo-atk-application-id:" + organizationId, String(configuredApplicationId));
    }
    setFiscalizationNumber(profileRes.data?.fiscalization_number ?? "");
    const list = (posRes.data ?? []) as Pos[];
    setPositions(list);
    if (list.length) setSelectedId((current) => current || list[0].id);
  }, [organizationId, supabase]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const used = positions.filter((pos) => pos.atk_branch_id === Number(form.branch)).map((pos) => pos.pos_id);
    if (used.length) {
      setForm((current) => used.includes(Number(current.pos))
        ? { ...current, pos: String(Math.max(0, ...used) + 1) }
        : current);
    }
  }, [positions, form.branch]);
  useEffect(() => {
    let cancelled = false;
    if (!selected) { setKeyReady(false); setCertificateReady(false); setVerification(null); return; }
    void Promise.all([
      hasBrowserPosKey(organizationId + ":" + selected.id).catch(() => false),
      hasBrowserPosCertificate(organizationId + ":" + selected.id).catch(() => false),
      supabase.from("fiskalo_atk_pos_verifications")
        .select("business_name,verification_code,nui,atk_branch_id,pos_id,application_id")
        .eq("organization_id", organizationId).eq("pos_installation_id", selected.id).maybeSingle(),
    ]).then(([key, cert, saved]) => {
      if (cancelled) return;
      setKeyReady(key);
      setCertificateReady(cert);
      const row = saved && "data" in saved ? saved.data : null;
      if (row && !saved.error && row.nui === org?.nui &&
          Number(row.atk_branch_id) === selected.atk_branch_id &&
          Number(row.pos_id) === selected.pos_id &&
          Number(row.application_id) === Number(applicationId) &&
          row.verification_code) {
        setVerification({ businessName: row.business_name || org?.legal_name || "", verificationCode: row.verification_code });
      } else setVerification(null);
    });
    return () => { cancelled = true; };
  }, [organizationId, selectedId, selected?.id, org?.nui, org?.legal_name, applicationId, supabase]);

  async function saveProfile() {
    setBusy(true); setError(""); setNotice("");
    const value = fiscalizationNumber.trim();
    if (!value) { setBusy(false); setError("Shëno numrin e fiskalizimit TEST që ATK ta dërgoi me email."); return; }
    const { data: auth } = await supabase.auth.getUser();
    if (!auth.user) { setBusy(false); setError("Sesioni ka skaduar. Hyr përsëri."); return; }
    const { error: saveError } = await supabase.from("fiskalo_atk_taxpayer_profiles").upsert({
      organization_id: organizationId, fiscalization_number: value, created_by: auth.user.id,
    }, { onConflict: "organization_id" });
    setBusy(false);
    if (saveError) { setError(saveError.message); return; }
    setNotice("Numri i fiskalizimit TEST u ruajt.");
    await load();
  }

  async function createPos(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(""); setNotice("");
    if (!profile && !fiscalizationNumber.trim()) { setBusy(false); setError("Ruaje fillimisht numrin e fiskalizimit TEST."); return; }
    const branch = Number(form.branch), pos = Number(form.pos);
    if (!Number.isSafeInteger(branch) || branch <= 0 || !Number.isSafeInteger(pos) || pos <= 0 || !form.label.trim()) {
      setBusy(false); setError("Plotëso emrin e POS-it dhe ID-të numerike pozitive të degës dhe arkës."); return;
    }
    const { data: auth } = await supabase.auth.getUser();
    if (!auth.user) { setBusy(false); setError("Sesioni ka skaduar. Hyr përsëri."); return; }
    const { data, error: insertError } = await supabase.from("fiskalo_atk_pos_installations").insert({
      organization_id: organizationId, atk_branch_id: branch, pos_id: pos,
      label: form.label.trim(), location: form.location.trim() || org?.municipality || null,
      environment: "test", status: "unregistered", created_by: auth.user.id,
    }).select("id").single();
    setBusy(false);
    if (insertError || !data) { setError(insertError?.code === "23505" ? "Ky kombinim degë/POS ekziston tashmë në TEST." : insertError?.message ?? "POS nuk u krijua."); return; }
    setForm((v) => ({ ...v, label: "Web POS – Arka tjetër", pos: String(pos + 1) }));
    setNotice("POS TEST u krijua në Fiskalo. Tani kryej verifikimin dhe certifikatën ATK.");
    await load();
    setSelectedId(data.id);
  }

  async function verifyPos() {
    if (!selected || !org || !profile?.fiscalization_number) { setError("Ruaje numrin e fiskalizimit TEST dhe zgjidh POS-in."); return; }
    setBusy(true); setError(""); setNotice("");
    try {
      const appId = Number(applicationId);
      if (!Number.isSafeInteger(appId) || appId <= 0) throw new Error("Application ID duhet të jetë numër pozitiv.");
      if (!/^\d{9}$/.test(org.nui)) throw new Error("NUI i biznesit duhet të jetë 9 shifra.");
      window.localStorage.setItem("fiskalo-atk-application-id:" + organizationId, String(appId));
      const response = await fetch("/api/atk/test/verify", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ organizationId, posInstallationId: selected.id, nui: org.nui, fiscalizationNumber: profile.fiscalization_number, branchId: selected.atk_branch_id, posId: selected.pos_id, applicationId: appId }) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.detail || data.error || "ATK nuk e verifikoi POS-in.");
      setVerification({ businessName: data.businessName, verificationCode: data.verificationCode });
      setNotice("ATK e verifikoi POS-in TEST. Verifikimi u ruajt në llogarinë e biznesit dhe do të jetë i disponueshëm edhe pas hyrjes nga pajisje tjetër.");
    } catch (e) { setError(e instanceof Error ? e.message : "Verifikimi dështoi."); }
    finally { setBusy(false); }
  }

  async function generateCsr() {
    if (!selected || !org) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const id = organizationId + ":" + selected.id;
      const existing = await getBrowserPosCsr(id);
      const result = existing ?? await createBrowserPosCsr(id, {
        businessName: verification?.businessName || org.legal_name, nui: org.nui,
        branchId: String(selected.atk_branch_id), posId: String(selected.pos_id),
      });
      const blob = new Blob([result.csrPem], { type: "application/pkcs10" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a"); anchor.href = url;
      anchor.download = "fiskalo-" + selected.atk_branch_id + "-" + selected.pos_id + ".csr.pem";
      document.body.appendChild(anchor); anchor.click(); anchor.remove(); URL.revokeObjectURL(url);
      setKeyReady(true);
      setNotice("CSR u krijua dhe u shkarkua. Çelësi privat mbetet në këtë shfletues. Mos i fshi të dhënat e faqes.");
    } catch (e) { setError(e instanceof Error ? e.message : "CSR nuk u krijua."); }
    finally { setBusy(false); }
  }

  async function resetLocalKey() {
    if (!selected || certificateReady) return;
    if (!window.confirm("Kjo do ta fshijë çelësin dhe CSR-në lokale për këtë POS. Vazhdo vetëm nëse certifikata nuk është lëshuar ende.")) return;
    setBusy(true); setError(""); setNotice("");
    try {
      await deleteBrowserPosKey(organizationId + ":" + selected.id);
      window.localStorage.removeItem("fiskalo-atk-verification:" + organizationId + ":" + selected.id);
      setVerification(null);
      setKeyReady(false);
      setNotice("Çelësi lokal u fshi. Verifiko POS-in dhe gjenero CSR të ri me emrin që ktheu ATK.");
    } catch (e) { setError(e instanceof Error ? e.message : "Çelësi lokal nuk u fshi."); }
    finally { setBusy(false); }
  }

  async function requestCertificate() {
    if (!selected || !org || !verification) { setError("Kryej verifikimin ATK në këtë sesion para kërkesës për certifikatë."); return; }
    setBusy(true); setError(""); setNotice("");
    try {
      const id = organizationId + ":" + selected.id;
      const csr = await getBrowserPosCsr(id);
      if (!csr) throw new Error("CSR/çelësi lokal nuk u gjet. Gjeneroje përsëri në këtë shfletues.");
      const response = await fetch("/api/atk/test/sign-csr", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ organizationId, posInstallationId: selected.id, nui: org.nui, businessName: verification.businessName,
          verificationCode: verification.verificationCode, branchId: selected.atk_branch_id,
          posId: selected.pos_id, applicationId: Number(applicationId), csrPem: csr.csrPem }) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.detail || data.error || "ATK nuk e lëshoi certifikatën.");
      const installed = await installBrowserPosCertificate(id, data.signedCertificate);
      const { error: updateError } = await supabase.from("fiskalo_atk_pos_installations")
        .update({ status: "active" }).eq("id", selected.id).eq("organization_id", organizationId);
      if (updateError) throw new Error("Certifikata u ruajt lokalisht, por statusi i POS-it nuk u përditësua: " + updateError.message);
      setCertificateReady(installed.installed);
      setNotice("Certifikata TEST e lëshuar nga ATK u verifikua kundrejt çelësit lokal dhe u instalua në këtë shfletues.");
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "Certifikata nuk u instalua."); }
    finally { setBusy(false); }
  }

  if (!permissionChecked) return <main style={{ maxWidth: 900, margin: "0 auto", padding: 24 }}>Po kontrollohet qasja…</main>;
  if (!canManage) return <main style={{ maxWidth: 650, margin: "0 auto", padding: "30px 16px" }}><h1>Qasje e kufizuar</h1><p style={{ color: "var(--muted)", lineHeight: 1.6 }}>Regjistrimi dhe certifikimi i POS-it menaxhohet vetëm nga pronari ose administratori i biznesit. Punëtorët mund ta përdorin POS-in pasi të jetë konfiguruar.</p><Link href={"/app/" + organizationId + "/pos"} style={{ color: "var(--brand)", fontWeight: 750 }}>Kthehu te Web POS</Link></main>;

  return <main style={{ maxWidth: 900, margin: "0 auto", padding: "22px 16px 50px" }}>
    <header style={{ marginBottom: 18 }}>
      <Link href={"/app/" + organizationId + "/pos"} style={{ color: "var(--brand)", fontWeight: 750 }}>← Kthehu te Web POS</Link>
      <h1 style={{ margin: "10px 0 5px", fontSize: 26 }}>Regjistro dhe certifiko Web POS</h1>
      <p style={{ color: "var(--muted)", fontSize: 13, lineHeight: 1.6 }}>Krijo POS-in, verifikoje me ATK TEST, gjenero CSR dhe instalo certifikatën pa Windows ose Android POS Agent. Ky është rrjedhë eksperimentale për TEST; ruajtja e çelësit në shfletues nuk është zëvendësim i një pajisjeje me keystore të certifikuar.</p>
    </header>
    {error && <div role="alert" style={{ background: "#fff0ef", color: "#982d25", padding: 12, borderRadius: 9, marginBottom: 12 }}>{error}</div>}
    {notice && <div role="status" style={{ background: "#edf7f1", color: "#155c3c", padding: 12, borderRadius: 9, marginBottom: 12 }}>{notice}</div>}
    <section style={{ ...panel, display: "grid", gap: 12, marginBottom: 12 }}>
      <strong>1. Identiteti dhe kredencialet ATK TEST</strong>
      <div style={{ color: "var(--muted)", fontSize: 13 }}>NUI: {org?.nui || "—"} · Biznesi: {org?.legal_name || "—"}</div>
      <label>Numri i fiskalizimit TEST<input value={fiscalizationNumber} onChange={(e) => setFiscalizationNumber(e.target.value)} style={field} placeholder="Nga emaili i ATK-së" /></label>
      <button disabled={busy} onClick={() => void saveProfile()} style={primary}>Ruaj numrin e fiskalizimit</button>
      <label>Application ID · menaxhohet nga Fiskalo<input value={applicationId} readOnly style={{ ...field, background: "#f1f5f2", color: "var(--muted)" }} inputMode="numeric" /></label>
    </section>
    <section style={{ ...panel, display: "grid", gap: 12, marginBottom: 12 }}>
      <strong>2. Krijo POS TEST drejtpërdrejt në Web</strong>
      <form onSubmit={(e) => void createPos(e)} style={{ display: "grid", gap: 10 }}>
        <label>Emri i POS-it<input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} style={field} required /></label>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2,minmax(0,1fr))", gap: 10 }}>
          <label>ID e degës/njësisë ATK<input value={form.branch} onChange={(e) => setForm({ ...form, branch: e.target.value })} style={field} inputMode="numeric" required /></label>
          <label>POS ID unik<input value={form.pos} onChange={(e) => setForm({ ...form, pos: e.target.value })} style={field} inputMode="numeric" required /></label>
        </div>
        <label>Lokacioni<input value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} style={field} placeholder={org?.municipality || "Lokacioni i arkës"} /></label>
        <button disabled={busy} style={primary}>Krijo POS TEST</button>
      </form>
      <p style={{ color: "var(--muted)", fontSize: 12 }}>Vlerat 761 dhe 1 janë të paraplotësuara nga konfigurimi i testit tënd. Ndryshoji vetëm nëse ATK ka konfirmuar identifikues të tjerë. Krijimi këtu regjistron instalimin në Fiskalo; nuk anashkalon regjistrimin/lejimin e ATK-së.</p>
    </section>
    <section style={{ ...panel, display: "grid", gap: 12 }}>
      <strong>3. Verifiko, krijo çelësin dhe merr certifikatën</strong>
      <label>Zgjidh POS TEST<select value={selectedId} onChange={(e) => setSelectedId(e.target.value)} style={field}><option value="">Zgjidh POS</option>{positions.map((p) => <option key={p.id} value={p.id}>{p.label} · Njësia {p.atk_branch_id} · POS {p.pos_id} · {p.status}</option>)}</select></label>
      {selected && <>
        <div style={{ display: "grid", gap: 7, fontSize: 13 }}>
          <div>{profile?.fiscalization_number ? "✓" : "○"} Numri TEST është ruajtur</div>
          <div>{verification ? "✓" : "○"} Verifikimi ATK në këtë sesion</div>
          <div>{keyReady ? "✓" : "○"} Çelësi privat dhe CSR në këtë shfletues</div>
          <div>{certificateReady ? "✓" : "○"} Certifikata TEST e instaluar</div>
        </div>
        <button disabled={busy || !profile?.fiscalization_number} onClick={() => void verifyPos()} style={secondary}>1. Verifiko POS-in te ATK</button>
        <button disabled={busy || !verification} onClick={() => void generateCsr()} style={secondary}>2. Gjenero CSR / çelës lokal</button>
        <button disabled={busy || !verification || !keyReady} onClick={() => void requestCertificate()} style={primary}>3. Kërko dhe instalo certifikatën ATK</button>
        {keyReady && !certificateReady && <button disabled={busy} onClick={() => void resetLocalKey()} style={secondary}>Rifillo çelësin / CSR nëse emri i biznesit është i pasaktë</button>}
      </>}
      <button disabled={busy} onClick={() => void load()} style={secondary}>Rifresko POS-et</button>
    </section>
    <p style={{ marginTop: 14, color: "var(--muted)", fontSize: 12, lineHeight: 1.6 }}>Nëse ATK refuzon verifikimin ose CSR-në, Fiskalo shfaq përgjigjen e ATK-së. Nuk krijohet certifikatë artificiale. Përdor të njëjtin shfletues dhe profil për kuponin testues; mos përdor Incognito dhe mos pastro të dhënat e faqes.</p>
  </main>;
}
