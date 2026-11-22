"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import {
  Activity, ArrowUpRight, Building2, CheckCircle2, CircleAlert, Cpu,
  LayoutDashboard, Search, Settings2, ShieldCheck, Store, ExternalLink, FileCheck2, LogOut,
} from "lucide-react";

export type ProviderBusiness = {
  id: string; trade_name: string | null; legal_name: string;
  municipality: string; fiscalization_status: string; plan_package: "starter" | "standard" | "pro"; product_limit: number; created_at: string;
};
export type ProviderPos = {
  id: string; organization_id: string; label: string; status: string;
  environment: string; last_seen_at: string | null;
};
export type ProviderAtkLookup = {
  id: string; organization_id: string | null; lookup_type: string; lookup_value: string;
  taxpayer_name: string | null; registration_status: string | null; municipality: string | null;
  vat_status: string | null; checked_at: string;
};
export type ProviderSettings = {
  provider_nui: string | null; sef_code: string | null; application_id: number | null;
  solution_name: string; solution_version: string; certification_status: string;
  production_enabled: boolean;
};

const moneyless = (value: number) => new Intl.NumberFormat("sq-XK").format(value);
const statusLabel: Record<string, string> = {
  not_configured: "Pa konfigurim", pending: "Në pritje", test: "TEST",
  certified: "E certifikuar", suspended: "Pezulluar",
  unregistered: "Pa regjistrim", verification_pending: "Verifikim në pritje",
  certificate_pending: "Certifikatë në pritje", active: "Aktiv",
  revoked: "Revokuar",
};
const statusTone = (value: string) => {
  if (["active", "certified", "accepted"].includes(value)) return "good";
  if (["pending", "test", "verification_pending", "certificate_pending"].includes(value)) return "warn";
  if (["suspended", "revoked", "rejected"].includes(value)) return "bad";
  return "neutral";
};
const inputStyle: React.CSSProperties = {
  width: "100%", minWidth: 0, border: "1px solid #dfe7e2", borderRadius: 10,
  padding: "11px 12px", background: "#fff", color: "#18251f",
};

export default function ProviderDashboard({
  role, userEmail, businesses, posDevices, settings, atkLookups, loadError,
}: {
  role: string; userEmail: string; businesses: ProviderBusiness[];
  posDevices: ProviderPos[]; settings: ProviderSettings | null;
  atkLookups: ProviderAtkLookup[]; loadError: string;
}) {
  const [search, setSearch] = useState("");
  const [config, setConfig] = useState<ProviderSettings | null>(settings);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [planSaving, setPlanSaving] = useState("");
  const [planFeedback, setPlanFeedback] = useState("");
  const [atkSaving, setAtkSaving] = useState(false);
  const [atkMessage, setAtkMessage] = useState("");
  const [atkError, setAtkError] = useState("");
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState("");
  const [atkForm, setAtkForm] = useState({
    organization_id: "", lookup_type: "fiscal_number", lookup_value: "",
    fiscal_number: "", nrb: "", taxpayer_name: "", registration_status: "",
    address: "", city: "", municipality: "", tax_center: "", vat_number: "",
    vat_status: "", notes: "",
  });
  const router = useRouter();
  const supabase = useMemo(() => createClient(), []);
  const filteredBusinesses = businesses.filter((business) =>
    [business.trade_name, business.legal_name, business.municipality]
      .filter(Boolean).join(" ").toLocaleLowerCase().includes(search.toLocaleLowerCase())
  );
  const activePos = posDevices.filter((pos) => pos.status === "active").length;
  const testPos = posDevices.filter((pos) => pos.environment === "test").length;
  const productionPos = posDevices.filter((pos) => pos.environment === "production").length;

  async function signOut() {
    if (signingOut) return;
    setSigningOut(true); setSignOutError("");
    try {
      const { error: signOutFailure } = await supabase.auth.signOut();
      if (signOutFailure) throw signOutFailure;
      router.replace("/login");
      router.refresh();
    } catch (failure) {
      setSignOutError(failure instanceof Error ? failure.message : "Dalja nga llogaria dështoi. Provo përsëri.");
      setSigningOut(false);
    }
  }

  async function updateBusinessPlan(organizationId: string, plan: "starter" | "standard" | "pro") {
    if (role !== "provider_admin") return;
    setPlanSaving(organizationId); setPlanFeedback("");
    try {
      const { data, error: planError } = await supabase.rpc("fiskalo_provider_set_plan", {
        target_organization: organizationId,
        target_package: plan,
      });
      if (planError) throw planError;
      const assigned = Array.isArray(data) ? data[0] : data;
      setPlanFeedback("Paketa u ndryshua. Limiti i ri: " + (assigned?.product_limit ?? (plan === "starter" ? 10 : plan === "standard" ? 50 : 100)) + " produkte.");
      router.refresh();
    } catch (e) {
      setPlanFeedback(e instanceof Error ? e.message : "Paketa nuk u ndryshua.");
    } finally { setPlanSaving(""); }
  }

  async function saveAtkLookup(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAtkSaving(true); setAtkError(""); setAtkMessage("");
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      setAtkSaving(false); setAtkError("Sesioni ka skaduar. Hyr përsëri."); return;
    }
    const { error: saveError } = await supabase.from("fiskalo_provider_atk_lookups").insert({
      ...atkForm, organization_id: atkForm.organization_id || null, checked_by: user.id,
      source_url: "https://apps.atk-ks.org/BizPasiveApp/VatRegist/Index",
    });
    setAtkSaving(false);
    if (saveError) setAtkError("Regjistrimi nuk u ruajt: " + saveError.message);
    else {
      setAtkMessage("Kontrolli nga ATK u regjistrua në historikun e ofruesit.");
      setAtkForm({ organization_id: "", lookup_type: "fiscal_number", lookup_value: "",
        fiscal_number: "", nrb: "", taxpayer_name: "", registration_status: "",
        address: "", city: "", municipality: "", tax_center: "", vat_number: "",
        vat_status: "", notes: "" });
      router.refresh();
    }
  }

  async function saveSettings(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!config || role !== "provider_admin") return;
    setSaving(true); setError(""); setMessage("");
    const { error: saveError } = await supabase.from("fiskalo_atk_provider_settings").update({
      provider_nui: config.provider_nui?.trim() || null,
      sef_code: config.sef_code?.trim() || null,
      application_id: config.application_id ? Number(config.application_id) : null,
      solution_name: config.solution_name.trim(),
      solution_version: config.solution_version.trim(),
      updated_at: new Date().toISOString(),
    }).eq("singleton", true);
    setSaving(false);
    if (saveError) setError("Konfigurimi nuk u ruajt: " + saveError.message);
    else setMessage("Konfigurimi i ofruesit u ruajt.");
  }

  return (
    <div className="provider-shell">
      <aside className="provider-sidebar">
        <Link href="/provider" className="provider-logo"><span>F</span><strong>fiskalo</strong><small>PROVIDER</small></Link>
        <div className="provider-nav-label">HAPËSIRA E OFRUESIT</div>
        <a className="provider-nav-item active" href="#overview"><LayoutDashboard size={17}/> Përmbledhja</a>
        <a className="provider-nav-item" href="#businesses"><Building2 size={17}/> Bizneset <span>{businesses.length}</span></a>
        <a className="provider-nav-item" href="#devices"><Cpu size={17}/> POS instalimet <span>{posDevices.length}</span></a>
        <a className="provider-nav-item" href="#atk-lookup"><FileCheck2 size={17}/> Verifikimi ATK</a>
        {role !== "provider_support" && <button className="provider-nav-item" onClick={() => setShowSettings((v) => !v)}><Settings2 size={17}/> Konfigurimi ATK</button>}
        <div className="provider-sidebar-bottom">
          <div className="provider-account"><span className="provider-avatar">{userEmail.slice(0,1).toUpperCase() || "F"}</span><div><strong>{role === "provider_admin" ? "Administrator" : role === "provider_support" ? "Mbështetje" : "Përputhshmëri"}</strong><small>{userEmail}</small></div></div>
          <button type="button" className="provider-signout" onClick={signOut}>Dil nga llogaria</button>

        </div>
      </aside>

      <main className="provider-main" id="overview">
        <header className="provider-topbar"><div><span className="provider-eyebrow">MENAXHIM I PLATFORMËS</span><h1>Qendra e ofruesit</h1></div><div className="provider-top-actions"><Link href="/app" className="provider-workspace-link">Hap bizneset <ArrowUpRight size={14}/></Link><span className="provider-live"><i/> Hapësira e ofruesit</span><span className="provider-user-chip">{userEmail}</span><button type="button" className="provider-top-signout" onClick={() => void signOut()} disabled={signingOut}><LogOut size={15}/>{signingOut ? "Duke dalë…" : "Dil"}</button></div></header>
        <section className="provider-welcome"><div><span className="provider-eyebrow">PANELI I OFRUESIT</span><h2>Kontrollo Fiskalo nga një vend.</h2><p>Menaxho bizneset kliente, instalimet POS dhe konfigurimin e softuerit fiskal.</p></div><div className="provider-welcome-mark"><ShieldCheck size={42}/><span>Qasje e ndarë</span></div></section>

        {signOutError && <div className="provider-alert bad" role="alert"><CircleAlert size={17}/> Dalja nga llogaria dështoi: {signOutError}</div>}{loadError && <div className="provider-alert bad"><CircleAlert size={17}/> Nuk u ngarkuan të gjitha të dhënat: {loadError}</div>}
        <section className="provider-stats">
          <article><span className="provider-stat-icon"><Store size={19}/></span><small>Biznese kliente</small><strong>{moneyless(businesses.length)}</strong><em>Organizata të regjistruara</em></article>
          <article><span className="provider-stat-icon"><Cpu size={19}/></span><small>Instalime POS</small><strong>{moneyless(posDevices.length)}</strong><em>{testPos} TEST · {productionPos} PRODUCTION</em></article>
          <article><span className="provider-stat-icon"><CheckCircle2 size={19}/></span><small>POS aktivë</small><strong>{moneyless(activePos)}</strong><em>Instalime me status aktiv</em></article>
          <article><span className="provider-stat-icon"><Activity size={19}/></span><small>Certifikimi</small><strong className="provider-stat-status">{statusLabel[config?.certification_status ?? "not_configured"]}</strong><em>{config?.production_enabled ? "Prodhimi i aktivizuar" : "Vetëm ambienti TEST"}</em></article>
        </section>

        <section className="provider-panel" id="businesses">
          <div className="provider-panel-heading"><div><span className="provider-eyebrow">KLIENTËT</span><h3>Bizneset në Fiskalo</h3><p>Çdo biznes ka organizatën, degët dhe POS-et e veta.</p></div><label className="provider-search"><Search size={16}/><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Kërko biznes ose qytet…"/></label></div>
          {planFeedback && <p className="provider-feedback" role="status">{planFeedback}</p>}
          <div className="provider-table-wrap"><table className="provider-table"><thead><tr><th>Biznesi</th><th>Komuna</th><th>Paketa</th><th>Fiskalizimi</th><th>POS</th></tr></thead><tbody>
            {filteredBusinesses.map((business) => {
              const devices = posDevices.filter((pos) => pos.organization_id === business.id);
              return <tr key={business.id}><td><strong>{business.trade_name || business.legal_name}</strong><small>{business.legal_name}</small></td><td>{business.municipality}</td><td><div style={{display:"grid",gap:4,minWidth:132}}><select aria-label={"Paketa për " + (business.trade_name || business.legal_name)} value={business.plan_package || "starter"} disabled={role !== "provider_admin" || planSaving === business.id} onChange={(event) => void updateBusinessPlan(business.id,event.target.value as "starter" | "standard" | "pro")} style={{border:"1px solid #dfe7e2",borderRadius:8,padding:"7px 8px",background:"white",color:"#18251f",fontSize:12}}><option value="starter">Starter · 10</option><option value="standard">Standard · 50</option><option value="pro">Pro · 100</option></select><small>Limit: {business.product_limit ?? 10} produkte</small></div></td><td><span className={"provider-status " + statusTone(business.fiscalization_status)}>{statusLabel[business.fiscalization_status] ?? business.fiscalization_status}</span></td><td>{devices.length} pajisje <small>{devices.filter((device) => device.status === "active").length} aktive</small></td></tr>;
            })}
            {!filteredBusinesses.length && <tr><td colSpan={5} className="provider-empty">Nuk u gjet asnjë biznes me këtë kërkim.</td></tr>}
          </tbody></table></div>
        </section>

        <section className="provider-panel" id="devices">
          <div className="provider-panel-heading"><div><span className="provider-eyebrow">PAJISJET</span><h3>Instalimet POS</h3><p>Shiko ambientin dhe statusin e secilit instalim pa përzier të dhënat e bizneseve.</p></div><span className="provider-count">{posDevices.length} gjithsej</span></div>
          <div className="provider-device-grid">{posDevices.slice(0,8).map((pos) => {
            const business = businesses.find((item) => item.id === pos.organization_id);
            return <article key={pos.id}><div className="provider-device-top"><span className="provider-device-icon"><Cpu size={18}/></span><span className={"provider-status " + statusTone(pos.status)}>{statusLabel[pos.status] ?? pos.status}</span></div><strong>{pos.label}</strong><small>{business?.trade_name || business?.legal_name || "Biznes"}</small><div className="provider-device-foot"><span>{pos.environment.toUpperCase()}</span><span>{pos.last_seen_at ? "Aktivitet: " + new Date(pos.last_seen_at).toLocaleString("sq-XK") : "Pa aktivitet të regjistruar"}</span></div></article>;
          })}{!posDevices.length && <p className="provider-empty">Nuk ka instalime POS.</p>}</div>
        </section>


        <section className="provider-panel provider-settings" id="atk-lookup">
          <div className="provider-panel-heading">
            <div><span className="provider-eyebrow">VETËM OFRUESI</span><h3>Verifikimi i tatimpaguesit në ATK</h3>
              <p>Kërko në faqen zyrtare të ATK-së dhe regjistro këtu rezultatet e publikuara. Nuk ka API publike të dokumentuar për kërkim automatik.</p>
            </div>
            <a className="provider-workspace-link" href="https://apps.atk-ks.org/BizPasiveApp/VatRegist/Index" target="_blank" rel="noopener noreferrer">Hap ATK <ExternalLink size={14}/></a>
          </div>
          <form onSubmit={saveAtkLookup} className="provider-settings-grid">
            <label>Lidhe me biznesin (opsionale)
              <select style={inputStyle} value={atkForm.organization_id} onChange={(e) => setAtkForm({...atkForm,organization_id:e.target.value})}>
                <option value="">Pa lidhje me biznes</option>
                {businesses.map((b) => <option key={b.id} value={b.id}>{b.trade_name || b.legal_name} · {b.municipality}</option>)}
              </select>
            </label>
            <label>Kërko sipas
              <select style={inputStyle} value={atkForm.lookup_type} onChange={(e) => setAtkForm({...atkForm,lookup_type:e.target.value})}>
                <option value="fiscal_number">Numrit fiskal</option><option value="nrb">NRB</option><option value="vat_number">Numrit të TVSh-së</option>
              </select>
            </label>
            <label>Vlera e kërkimit<input required style={inputStyle} value={atkForm.lookup_value} onChange={(e) => setAtkForm({...atkForm,lookup_value:e.target.value})}/></label>
            <label>Emri i tatimpaguesit<input style={inputStyle} value={atkForm.taxpayer_name} onChange={(e) => setAtkForm({...atkForm,taxpayer_name:e.target.value})}/></label>
            <label>Numri fiskal<input style={inputStyle} value={atkForm.fiscal_number} onChange={(e) => setAtkForm({...atkForm,fiscal_number:e.target.value})}/></label>
            <label>NRB<input style={inputStyle} value={atkForm.nrb} onChange={(e) => setAtkForm({...atkForm,nrb:e.target.value})}/></label>
            <label>Statusi i biznesit<input style={inputStyle} value={atkForm.registration_status} onChange={(e) => setAtkForm({...atkForm,registration_status:e.target.value})}/></label>
            <label>Numri i TVSh-së<input style={inputStyle} value={atkForm.vat_number} onChange={(e) => setAtkForm({...atkForm,vat_number:e.target.value})}/></label>
            <label>Statusi në TVSh<input style={inputStyle} value={atkForm.vat_status} onChange={(e) => setAtkForm({...atkForm,vat_status:e.target.value})}/></label>
            <label>Adresa<input style={inputStyle} value={atkForm.address} onChange={(e) => setAtkForm({...atkForm,address:e.target.value})}/></label>
            <label>Qyteti<input style={inputStyle} value={atkForm.city} onChange={(e) => setAtkForm({...atkForm,city:e.target.value})}/></label>
            <label>Komuna<input style={inputStyle} value={atkForm.municipality} onChange={(e) => setAtkForm({...atkForm,municipality:e.target.value})}/></label>
            <label>Qendra tatimore<input style={inputStyle} value={atkForm.tax_center} onChange={(e) => setAtkForm({...atkForm,tax_center:e.target.value})}/></label>
            <label style={{gridColumn:"1 / -1"}}>Shënime<textarea style={{...inputStyle,minHeight:76}} value={atkForm.notes} onChange={(e) => setAtkForm({...atkForm,notes:e.target.value})}/></label>
            <div className="provider-toggle" role="note"><ShieldCheck size={16}/> Ruhet si rezultat i regjistruar manualisht nga faqja zyrtare e ATK-së, jo si përgjigje API e verifikuar nga Fiskalo.</div>
            <button className="provider-primary" disabled={atkSaving}>{atkSaving ? "Duke ruajtur…" : "Ruaj kontrollin ATK"}</button>
          </form>
          {(atkError || atkMessage) && <p className={"provider-feedback " + (atkError ? "bad" : "good")}>{atkError || atkMessage}</p>}
          <div className="provider-panel-heading" style={{marginTop:24}}><div><h3>Historiku i kontrolleve</h3><p>Kontrollet e fundit të regjistruara nga ekipi i ofruesit.</p></div></div>
          <div className="provider-table-wrap"><table className="provider-table"><thead><tr><th>Tatimpaguesi</th><th>Kërkimi</th><th>Statusi</th><th>TVSh</th><th>Kontrolluar</th></tr></thead><tbody>
            {atkLookups.map((item) => <tr key={item.id}><td><strong>{item.taxpayer_name || "Pa emër të regjistruar"}</strong><small>{businesses.find((b) => b.id === item.organization_id)?.trade_name || businesses.find((b) => b.id === item.organization_id)?.legal_name || "Pa biznes të lidhur"}</small></td><td>{item.lookup_type === "nrb" ? "NRB" : item.lookup_type === "vat_number" ? "TVSh" : "Nr. fiskal"}: {item.lookup_value}</td><td>{item.registration_status || "—"}</td><td>{item.vat_status || "—"}</td><td>{new Date(item.checked_at).toLocaleString("sq-XK")}</td></tr>)}
            {!atkLookups.length && <tr><td colSpan={5} className="provider-empty">Nuk ka kontrolle të regjistruara.</td></tr>}
          </tbody></table></div>
        </section>

        {showSettings && <section className="provider-panel provider-settings" id="settings"><div className="provider-panel-heading"><div><span className="provider-eyebrow">VETËM OFRUESI</span><h3>Konfigurimi ATK i Fiskalo</h3><p>Application ID dhe kodi i zgjidhjes i përkasin softuerit, jo biznesit klient.</p></div><span className="provider-lock"><ShieldCheck size={16}/> {role === "provider_admin" ? "Administrator" : "Vetëm lexim"}</span></div>
          {config ? <form onSubmit={saveSettings} className="provider-settings-grid">
            <label>NUI i ofruesit<input style={inputStyle} value={config.provider_nui ?? ""} onChange={(e) => setConfig({...config,provider_nui:e.target.value})} disabled={role !== "provider_admin"}/></label>
            <label>Application ID<input style={inputStyle} inputMode="numeric" value={config.application_id ?? ""} onChange={(e) => setConfig({...config,application_id:e.target.value ? Number(e.target.value) : null})} disabled={role !== "provider_admin"}/></label>
            <label>Kodi i zgjidhjes (SEF)<input style={inputStyle} value={config.sef_code ?? ""} onChange={(e) => setConfig({...config,sef_code:e.target.value})} disabled={role !== "provider_admin"}/></label>
            <label>Emri i softuerit<input style={inputStyle} value={config.solution_name} onChange={(e) => setConfig({...config,solution_name:e.target.value})} disabled={role !== "provider_admin"}/></label>
            <label>Versioni<input style={inputStyle} value={config.solution_version} onChange={(e) => setConfig({...config,solution_version:e.target.value})} disabled={role !== "provider_admin"}/></label>
            <label>Statusi i certifikimit<input style={inputStyle} value={statusLabel[config.certification_status] ?? config.certification_status} readOnly disabled /></label>
            <div className="provider-toggle" role="note"><ShieldCheck size={16}/> Prodhimi mbetet i çaktivizuar në këtë version. Aktivizimi kërkon integrim dhe certifikim zyrtar të veçantë nga ATK.</div>
            {role === "provider_admin" && <button className="provider-primary" disabled={saving}>{saving ? "Duke ruajtur…" : "Ruaj konfigurimin"}</button>}
          </form> : <div className="provider-alert">Nuk ke qasje për të lexuar konfigurimin e ofruesit.</div>}
          {(error || message) && <p className={"provider-feedback " + (error ? "bad" : "good")}>{error || message}</p>}
        </section>}
        <footer className="provider-footer">Fiskalo · Hapësira e sigurt e ofruesit · Të dhënat e bizneseve mbeten të ndara sipas organizatës.</footer>
      </main>
    </div>
  );
}
