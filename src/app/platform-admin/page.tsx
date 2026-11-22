"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Building2, RefreshCw, UserRoundCog, Plus, Monitor } from "lucide-react";

type Pos = { id: string; atk_branch_id: number; pos_id: number; label: string; location: string | null; environment: string; status: string };
type Org = { id: string; legal_name: string; trade_name: string | null; nui: string; municipality: string; email: string | null; phone: string | null; owners: { userId: string; email: string }[]; pos: Pos[] };
const field: React.CSSProperties = { width: "100%", border: "1px solid #dce2e8", borderRadius: 8, padding: "10px 11px", background: "#fff", color: "#17212b" };
const panel: React.CSSProperties = { border: "1px solid #e2e7ec", borderRadius: 13, padding: 16, background: "#fff" };

export default function PlatformAdminPage() {
  const [organizations, setOrganizations] = useState<Org[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const [ownerEmails, setOwnerEmails] = useState<Record<string,string>>({});
  const [posForms, setPosForms] = useState<Record<string,{branchId:string;posId:string;label:string;location:string}>>({});
  const [editingPos, setEditingPos] = useState<string>("");
  const [editForms, setEditForms] = useState<Record<string,{branchId:string;posId:string;label:string;location:string}>>({});
  const [verifyingPos, setVerifyingPos] = useState("");
  const [verificationForms, setVerificationForms] = useState<Record<string,{fiscalizationNumber:string;applicationId:string}>>({});

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const response = await fetch("/api/platform-admin", { cache: "no-store" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof data.detail === "string" ? data.detail : typeof data.error === "string" ? data.error : "Nuk u ngarkua paneli.");
      setOrganizations(data.organizations || []);
    } catch (e) { setError(e instanceof Error ? e.message : "Gabim gjatë ngarkimit."); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function submit(action: "assign_owner" | "create_pos", organizationId: string) {
    setBusy(organizationId); setError(""); setNotice("");
    try {
      const form = posForms[organizationId] || { branchId:"",posId:"",label:"",location:"" };
      const response = await fetch("/api/platform-admin", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(action === "assign_owner"
        ? { action, organizationId, email: ownerEmails[organizationId] || "" }
        : { action, organizationId, ...form }) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof data.detail === "string" ? data.detail : typeof data.error === "string" ? data.error : "Veprimi dështoi.");
      setNotice(action === "assign_owner" ? "Pronari u caktua." : "POS TEST u krijua. Pronari duhet ta përfundojë verifikimin dhe certifikatën në pajisjen e vet.");
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "Veprimi dështoi."); }
    finally { setBusy(""); }
  }


  async function verifyPos(org: Org, pos: Pos) {
    const form = verificationForms[pos.id] || { fiscalizationNumber:"", applicationId:"457818860373" };
    if (!form.fiscalizationNumber.trim() || !/^\\d+$/.test(form.applicationId) || Number(form.applicationId) <= 0) {
      setError("Plotëso numrin e fiskalizimit dhe Application ID nga emaili i ATK-së.");
      return;
    }
    setBusy(pos.id); setError(""); setNotice("");
    try {
      const response = await fetch("/api/atk/test/verify", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({
        organizationId:org.id, posInstallationId:pos.id, nui:org.nui,
        fiscalizationNumber:form.fiscalizationNumber.trim(), branchId:pos.atk_branch_id,
        posId:pos.pos_id, applicationId:Number(form.applicationId)
      }) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof data.detail === "string" ? data.detail : typeof data.error === "string" ? data.error : "ATK nuk e verifikoi POS-in.");
      setNotice("ATK e verifikoi POS-in TEST. Verifikimi u ruajt në biznes. Certifikata dhe çelësi privat instalohen më pas në terminalin ku do të përdoret POS-i.");
      setVerifyingPos("");
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "Verifikimi ATK dështoi."); }
    finally { setBusy(""); }
  }

  async function managePos(action: "update_pos" | "delete_pos", organizationId: string, pos: Pos) {
    if (action === "delete_pos" && !window.confirm("A je i sigurt që dëshiron ta fshish këtë POS? POS aktiv nuk mund të fshihet.")) return;
    setBusy(pos.id); setError(""); setNotice("");
    try {
      const form = editForms[pos.id] || { branchId:String(pos.atk_branch_id), posId:String(pos.pos_id), label:pos.label, location:pos.location || "" };
      const response = await fetch("/api/platform-admin", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({
        action, organizationId, posInstallationId:pos.id, ...(action === "update_pos" ? form : {})
      }) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof data.detail === "string" ? data.detail : typeof data.error === "string" ? data.error : "Veprimi dështoi.");
      setNotice(action === "delete_pos" ? "POS u fshi." : data.requires_reregistration ? "POS u përditësua. Ndryshimi i identifikuesve kërkon regjistrim të ri te ATK." : "POS u përditësua.");
      setEditingPos("");
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "Veprimi dështoi."); }
    finally { setBusy(""); }
  }

  return <main style={{maxWidth:1180,margin:"0 auto",padding:"28px 16px 60px",color:"#17212b"}}>
    <header style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:12,flexWrap:"wrap",marginBottom:20}}>
      <div><div style={{fontSize:12,color:"#64748b",fontWeight:700,letterSpacing:".08em"}}>FISKALO · PLATFORM</div><h1 style={{fontSize:28,margin:"5px 0"}}>Paneli i administrimit</h1><p style={{color:"#64748b",margin:0}}>Bizneset, pronarët dhe instalimet POS të klientëve.</p></div>
      <button onClick={() => void load()} style={{...field,width:"auto",display:"flex",alignItems:"center",gap:8,cursor:"pointer"}}><RefreshCw size={15}/> Rifresko</button>
    </header>
    {error && <div role="alert" style={{background:"#fff0ef",color:"#982d25",padding:12,borderRadius:9,marginBottom:12}}>{error}</div>}
    {notice && <div role="status" style={{background:"#edf7f1",color:"#155c3c",padding:12,borderRadius:9,marginBottom:12}}>{notice}</div>}
    <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(170px,1fr))",gap:10,marginBottom:16}}>
      <div style={panel}><Building2/><div style={{fontSize:12,color:"#64748b",marginTop:8}}>Biznese</div><strong style={{fontSize:25}}>{organizations.length}</strong></div>
      <div style={panel}><Monitor/><div style={{fontSize:12,color:"#64748b",marginTop:8}}>POS instalime</div><strong style={{fontSize:25}}>{organizations.reduce((n,o)=>n+o.pos.length,0)}</strong></div>
      <div style={panel}><UserRoundCog/><div style={{fontSize:12,color:"#64748b",marginTop:8}}>Biznese pa pronar të caktuar</div><strong style={{fontSize:25}}>{organizations.filter(o=>!o.owners.length).length}</strong></div>
    </div>
    {loading ? <p>Duke ngarkuar bizneset…</p> : <><div style={{...panel,marginBottom:12}}><h2 style={{fontSize:18,margin:"0 0 5px"}}>Menaxhimi i POS-eve</h2><p style={{fontSize:12,color:"#64748b",margin:0}}>Për çdo biznes: shto POS, regjistroje/verifikoje te ATK, ndrysho identifikuesit ose fshije kur nuk është aktiv.</p></div>{organizations.map(org => <section key={org.id} style={{...panel,marginBottom:12}}>
      <div style={{display:"flex",justifyContent:"space-between",gap:12,flexWrap:"wrap"}}>
        <div><h2 style={{fontSize:18,margin:"0 0 5px"}}>{org.trade_name || org.legal_name}</h2><div style={{fontSize:12,color:"#64748b"}}>{org.legal_name} · NUI {org.nui} · {org.municipality}</div><div style={{fontSize:12,color:"#64748b",marginTop:3}}>{org.email || "Pa email biznesi"} {org.phone ? "· "+org.phone : ""}</div><div style={{fontSize:12,marginTop:7}}>Pronarët: {org.owners.length ? org.owners.map(o=>o.email || o.userId).join(", ") : "Nuk është caktuar"}</div></div>
        <div style={{fontSize:11,color:"#64748b"}}>ID: {org.id}</div>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(230px,1fr))",gap:12,marginTop:15}}>
        <form onSubmit={e=>{e.preventDefault();void submit("assign_owner",org.id)}} style={{borderTop:"1px solid #e5eaf0",paddingTop:12}}>
          <strong style={{display:"flex",alignItems:"center",gap:7,fontSize:13}}><UserRoundCog size={16}/> Cakto pronarin</strong>
          <label style={{display:"block",fontSize:12,margin:"9px 0"}}>Email i llogarisë Fiskalo<input required type="email" value={ownerEmails[org.id] || ""} onChange={e=>setOwnerEmails(v=>({...v,[org.id]:e.target.value}))} style={{...field,marginTop:5}} placeholder="pronari@email.com"/></label>
          <button disabled={!!busy} style={{...field,background:"#17212b",color:"#fff",fontWeight:700,cursor:"pointer"}}>Cakto si pronar</button>
        </form>
        <form onSubmit={e=>{e.preventDefault();void submit("create_pos",org.id)}} style={{borderTop:"1px solid #e5eaf0",paddingTop:12}}>
          <strong style={{display:"flex",alignItems:"center",gap:7,fontSize:13}}><Plus size={16}/> Shto POS të ri për biznesin</strong>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:7,marginTop:9}}>
            <label style={{fontSize:12}}>Dega ATK<input required type="number" min="1" value={posForms[org.id]?.branchId || ""} onChange={e=>setPosForms(v=>({...v,[org.id]:{...(v[org.id]||{branchId:"",posId:"",label:"",location:""}),branchId:e.target.value}}))} style={{...field,marginTop:5}}/></label>
            <label style={{fontSize:12}}>POS ID<input required type="number" min="1" value={posForms[org.id]?.posId || ""} onChange={e=>setPosForms(v=>({...v,[org.id]:{...(v[org.id]||{branchId:"",posId:"",label:"",location:""}),posId:e.target.value}}))} style={{...field,marginTop:5}}/></label>
          </div>
          <label style={{display:"block",fontSize:12,margin:"8px 0"}}>Emri i pajisjes<input required value={posForms[org.id]?.label || ""} onChange={e=>setPosForms(v=>({...v,[org.id]:{...(v[org.id]||{branchId:"",posId:"",label:"",location:""}),label:e.target.value}}))} style={{...field,marginTop:5}} placeholder="Arka kryesore"/></label>
          <label style={{display:"block",fontSize:12,margin:"8px 0"}}>Lokacioni<input value={posForms[org.id]?.location || ""} onChange={e=>setPosForms(v=>({...v,[org.id]:{...(v[org.id]||{branchId:"",posId:"",label:"",location:""}),location:e.target.value}}))} style={{...field,marginTop:5}} placeholder={org.municipality}/></label>
          <button disabled={!!busy} style={{...field,background:"#17212b",color:"#fff",fontWeight:700,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:7}}><Plus size={14}/> Shto POS</button>
        </form>
      </div>
      <div style={{marginTop:14,borderTop:"1px solid #e5eaf0",paddingTop:10}}>
        <strong style={{fontSize:13}}>POS të regjistruara ({org.pos.length})</strong>
        {org.pos.length ? <> <div style={{overflowX:"auto",marginTop:8}}><table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}><thead><tr><th style={{textAlign:"left",padding:7}}>Pajisja</th><th style={{textAlign:"left",padding:7}}>Dega</th><th style={{textAlign:"left",padding:7}}>POS ID</th><th style={{textAlign:"left",padding:7}}>Mjedisi</th><th style={{textAlign:"left",padding:7}}>Statusi</th><th style={{textAlign:"left",padding:7}}>Veprime</th></tr></thead><tbody>{org.pos.map(p=><tr key={p.id} style={{borderTop:"1px solid #e5eaf0"}}><td style={{padding:7}}>{p.label}</td><td style={{padding:7}}>{p.atk_branch_id}</td><td style={{padding:7}}>{p.pos_id}</td><td style={{padding:7}}>{p.environment.toUpperCase()}</td><td style={{padding:7}}>{p.status}</td><td style={{padding:7,whiteSpace:"nowrap"}}><button type="button" disabled={!!busy} onClick={()=>{setVerifyingPos(verifyingPos===p.id?"":p.id);setVerificationForms(v=>({...v,[p.id]:v[p.id]||{fiscalizationNumber:"",applicationId:"457818860373"}}));}} style={{...field,width:"auto",display:"inline-block",marginRight:5,cursor:"pointer"}}>Regjistro te ATK</button><button type="button" disabled={!!busy} onClick={()=>{setEditingPos(editingPos===p.id?"":p.id);setEditForms(v=>({...v,[p.id]:{branchId:String(p.atk_branch_id),posId:String(p.pos_id),label:p.label,location:p.location||""}}));}} style={{...field,width:"auto",display:"inline-block",marginRight:5,cursor:"pointer"}}>Ndrysho</button><button type="button" disabled={!!busy || p.status==="active"} onClick={()=>void managePos("delete_pos",org.id,p)} style={{...field,width:"auto",display:"inline-block",color:"#b42318",cursor:"pointer"}}>Fshij</button></td></tr>)}</tbody></table></div>{org.pos.filter(p=>p.id===editingPos).map(p=><form key={p.id} onSubmit={e=>{e.preventDefault();void managePos("update_pos",org.id,p)}} style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(130px,1fr))",gap:7,marginTop:10,padding:10,background:"#f8fafc",borderRadius:9}}><input aria-label="Emri i POS-it" required value={editForms[p.id]?.label??p.label} onChange={e=>setEditForms(v=>({...v,[p.id]:{...(v[p.id]||{branchId:String(p.atk_branch_id),posId:String(p.pos_id),label:p.label,location:p.location||""}),label:e.target.value}}))} style={field}/><input aria-label="Dega ATK" required type="number" min="1" value={editForms[p.id]?.branchId??String(p.atk_branch_id)} onChange={e=>setEditForms(v=>({...v,[p.id]:{...(v[p.id]||{branchId:String(p.atk_branch_id),posId:String(p.pos_id),label:p.label,location:p.location||""}),branchId:e.target.value}}))} style={field}/><input aria-label="POS ID" required type="number" min="1" value={editForms[p.id]?.posId??String(p.pos_id)} onChange={e=>setEditForms(v=>({...v,[p.id]:{...(v[p.id]||{branchId:String(p.atk_branch_id),posId:String(p.pos_id),label:p.label,location:p.location||""}),posId:e.target.value}}))} style={field}/><input aria-label="Lokacioni" value={editForms[p.id]?.location??p.location??""} onChange={e=>setEditForms(v=>({...v,[p.id]:{...(v[p.id]||{branchId:String(p.atk_branch_id),posId:String(p.pos_id),label:p.label,location:p.location||""}),location:e.target.value}}))} style={field}/><button disabled={!!busy} style={{...field,background:"#17212b",color:"#fff",cursor:"pointer"}}>Ruaj ndryshimet</button></form>)}{org.pos.filter(p=>p.id===verifyingPos).map(p=><form key={"verify-"+p.id} onSubmit={e=>{e.preventDefault();void verifyPos(org,p)}} style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(180px,1fr))",gap:8,marginTop:10,padding:12,background:"#eff6ff",borderRadius:9}}><div style={{gridColumn:"1/-1",fontSize:13,fontWeight:700}}>Regjistrimi i POS-it te ATK · {p.label}</div><label style={{fontSize:12}}>Numri i fiskalizimit TEST<input required value={verificationForms[p.id]?.fiscalizationNumber||""} onChange={e=>setVerificationForms(v=>({...v,[p.id]:{...(v[p.id]||{fiscalizationNumber:"",applicationId:"457818860373"}),fiscalizationNumber:e.target.value}}))} style={{...field,marginTop:5}}/></label><label style={{fontSize:12}}>Application ID<input required inputMode="numeric" value={verificationForms[p.id]?.applicationId||"457818860373"} onChange={e=>setVerificationForms(v=>({...v,[p.id]:{...(v[p.id]||{fiscalizationNumber:"",applicationId:"457818860373"}),applicationId:e.target.value}}))} style={{...field,marginTop:5}}/></label><button disabled={!!busy} style={{...field,alignSelf:"end",background:"#17212b",color:"#fff",fontWeight:700}}>Verifiko me ATK TEST</button><div style={{gridColumn:"1/-1",fontSize:11,color:"#475569"}}>Pas verifikimit nga ofruesi, çelësi privat dhe CSR krijohen lokalisht në pajisjen e POS-it. Nuk ruhen në server.</div></form>)}</> : <p style={{fontSize:12,color:"#64748b"}}>Ende nuk ka POS.</p>}
      </div>
    </section>)}</>}
    <p style={{fontSize:11,color:"#64748b",marginTop:18}}>Ofruesi menaxhon krijimin, regjistrimin/verifikimin ATK, ndryshimin dhe fshirjen e POS-eve. Ndryshimi i degës ose POS ID kërkon verifikim të ri. Çelësi privat dhe CSR/certifikata mbeten në pajisjen ku lëshohen kuponët; POS aktiv nuk fshihet pa çaktivizim/revokim për të ruajtur gjurmën fiskale.</p>
    <Link href="/" style={{color:"#2563eb",fontSize:12}}>Kthehu në Fiskalo</Link>
  </main>;
}
