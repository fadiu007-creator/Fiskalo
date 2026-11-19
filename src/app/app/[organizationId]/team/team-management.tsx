"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { ArrowLeft, UserPlus, Users, ShieldCheck, Trash2, RefreshCw } from "lucide-react";

type Member = { member_user_id: string; member_email: string; member_role: "owner" | "administrator" | "manager" | "accountant" | "cashier"; joined_at: string };
const roles = [
  { value: "cashier", label: "Punëtor / Arkëtar", description: "POS, shitje dhe ndërrimi i vet i arkës" },
  { value: "manager", label: "Menaxher", description: "POS, produkte dhe mbikëqyrje e ndërrimeve" },
  { value: "accountant", label: "Kontabilist", description: "Qasje financiare dhe faturat" },
  { value: "administrator", label: "Administrator", description: "Menaxhim i biznesit dhe stafit, pa pronësinë" },
] as const;
const labels: Record<string,string> = { owner: "Pronari", administrator: "Administrator", manager: "Menaxher", accountant: "Kontabilist", cashier: "Punëtor / Arkëtar" };
const field: React.CSSProperties = { width:"100%", border:"1px solid var(--line)", borderRadius:10, padding:"12px 13px", background:"white", color:"var(--ink)" };

export default function TeamManagement({ organizationId }: { organizationId: string }) {
  const supabase = useMemo(() => createClient(), []);
  const [members,setMembers] = useState<Member[]>([]);
  const [canManageAdministrators,setCanManageAdministrators] = useState(false);
  const [email,setEmail] = useState("");
  const [displayName,setDisplayName] = useState("");
  const [phone,setPhone] = useState("");
  const [password,setPassword] = useState("");
  const [role,setRole] = useState("cashier");
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState("");
  const [notice,setNotice] = useState("");
  const load = useCallback(async () => {
    setBusy(true); setError("");
    const [{ data,error }, { data: auth }] = await Promise.all([
      supabase.rpc("fiskalo_list_members",{target_org:organizationId}),
      supabase.auth.getUser(),
    ]);
    if(error) setError(error.message);
    else {
      const rows = (data ?? []) as Member[];
      setMembers(rows);
      setCanManageAdministrators(Boolean(auth.user && rows.some((member) => member.member_user_id === auth.user?.id && member.member_role === "owner")));
    }
    setBusy(false);
  },[organizationId,supabase]);
  useEffect(()=>{void load()},[load]);

  async function addMember(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/team/add-worker", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ organizationId, email, displayName, phone, password, role }),
      });
      const result = await response.json() as { error?: string; detail?: string; message?: string };
      if (!response.ok) throw new Error(result.detail || result.error || "Punëtori nuk u shtua.");
      setEmail(""); setDisplayName(""); setPhone(""); setPassword("");
      setNotice(result.message || "Punëtori u shtua në ekip.");
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Punëtori nuk u shtua.");
    } finally { setBusy(false); }
  }
  async function removeMember(member: Member) {
    if(!window.confirm(`A dëshiron t'ia heqësh qasjen ${member.member_email}?`)) return;
    setBusy(true); setError(""); setNotice("");
    const { error } = await supabase.rpc("fiskalo_remove_member",{target_org:organizationId,target_user:member.member_user_id});
    setBusy(false);
    if(error) setError(error.message); else { setNotice("Qasja u hoq."); await load(); }
  }

  return <main style={{maxWidth:1050,margin:"0 auto",padding:"26px clamp(15px,3vw,30px) 56px"}}>
    <header style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:12,flexWrap:"wrap",marginBottom:26}}>
      <div><Link href={`/app/${organizationId}`} style={{display:"inline-flex",alignItems:"center",gap:7,color:"var(--brand)",fontWeight:700,textDecoration:"none",fontSize:13}}><ArrowLeft size={16}/> Paneli i biznesit</Link><h1 style={{fontSize:30,letterSpacing:"-.04em",margin:"13px 0 5px"}}>Punëtorët dhe qasjet</h1><p style={{margin:0,color:"var(--muted)",fontSize:13}}>Shto ekipin dhe cakto saktë çfarë mund të përdorë secili.</p></div>
      <button onClick={()=>void load()} disabled={busy} style={{display:"inline-flex",alignItems:"center",gap:8,border:"1px solid var(--line)",background:"white",borderRadius:10,padding:"10px 13px",cursor:"pointer"}}><RefreshCw size={15}/> Rifresko</button>
    </header>
    <section style={{display:"grid",gridTemplateColumns:"minmax(0,1fr) minmax(260px,.8fr)",gap:18,alignItems:"start"}}>
      <div style={{background:"white",border:"1px solid var(--line)",borderRadius:15,padding:18}}>
        <div style={{display:"flex",alignItems:"center",gap:9,marginBottom:16}}><Users color="var(--brand)"/><h2 style={{fontSize:17,margin:0}}>Ekipi ({members.length})</h2></div>
        {members.map(member=><div key={member.member_user_id} style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:10,padding:"13px 0",borderTop:"1px solid var(--line)"}}>
          <div style={{minWidth:0}}><strong style={{display:"block",fontSize:13,overflowWrap:"anywhere"}}>{member.member_email}</strong><span style={{fontSize:12,color:"var(--muted)"}}>{labels[member.member_role] ?? member.member_role}</span></div>
          {member.member_role!=="owner" && (member.member_role!=="administrator" || canManageAdministrators) && <button aria-label={`Hiq qasjen e ${member.member_email}`} title="Hiq qasjen" onClick={()=>void removeMember(member)} disabled={busy} style={{border:"1px solid #f0d9d6",background:"#fff8f7",color:"#a4473e",borderRadius:9,padding:9,cursor:"pointer"}}><Trash2 size={16}/></button>}
        </div>)}
        {!members.length && !busy && <p style={{color:"var(--muted)",fontSize:13}}>Nuk ka anëtarë të listuar.</p>}
      </div>
      <div style={{background:"white",border:"1px solid var(--line)",borderRadius:15,padding:18}}>
        <div style={{display:"flex",alignItems:"center",gap:9,marginBottom:15}}><UserPlus color="var(--brand)"/><h2 style={{fontSize:17,margin:0}}>Shto punëtor</h2></div>
        <form onSubmit={addMember} style={{display:"grid",gap:12}}>
          <label style={{fontSize:12,fontWeight:700}}>Emri dhe mbiemri<input required value={displayName} onChange={e=>setDisplayName(e.target.value)} placeholder="Emri i punëtorit" style={{...field,display:"block",marginTop:6}}/></label>
          <label style={{fontSize:12,fontWeight:700}}>Email<input required type="email" value={email} onChange={e=>setEmail(e.target.value)} placeholder="punetori@email.com" style={{...field,display:"block",marginTop:6}}/></label>
          <label style={{fontSize:12,fontWeight:700}}>Telefoni (opsional)<input value={phone} onChange={e=>setPhone(e.target.value)} placeholder="+383…" style={{...field,display:"block",marginTop:6}}/></label>
          <label style={{fontSize:12,fontWeight:700}}>Fjalëkalimi fillestar<input type="password" minLength={8} value={password} onChange={e=>setPassword(e.target.value)} placeholder="Së paku 8 karaktere për llogari të re" autoComplete="new-password" style={{...field,display:"block",marginTop:6}}/></label>
          <label style={{fontSize:12,fontWeight:700}}>Roli<select value={role} onChange={e=>setRole(e.target.value)} style={{...field,display:"block",marginTop:6}}>{roles.filter(r=>r.value!=="administrator" || canManageAdministrators).map(r=><option key={r.value} value={r.value}>{r.label}</option>)}</select></label>
          <p style={{fontSize:12,color:"var(--muted)",lineHeight:1.5,margin:0}}>{roles.find(r=>r.value===role)?.description}. Nëse emaili ka llogari, shtohet menjëherë. Për llogari të re, vendos fjalëkalim fillestar. Llogaria krijohet dhe verifikohet automatikisht nga sistemi; punëtori nuk ka nevojë të konfirmojë email-in.</p>
          <button disabled={busy} style={{border:0,borderRadius:10,padding:13,background:"var(--brand)",color:"white",fontWeight:800,cursor:"pointer"}}>{busy?"Duke ruajtur…":"Shto në ekip"}</button>
        </form>
      </div>
    </section>
    <section style={{marginTop:18,background:"#f8faf8",border:"1px solid var(--line)",borderRadius:14,padding:17}}>
      <h2 style={{fontSize:15,margin:"0 0 12px",display:"flex",alignItems:"center",gap:8}}><ShieldCheck size={18}/> Përmbledhje e qasjeve</h2>
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(190px,1fr))",gap:12,fontSize:12,color:"var(--muted)",lineHeight:1.6}}>
        <div><b style={{color:"var(--ink)"}}>Pronari</b><br/>Kontroll i plotë, përfshirë konfigurimin fiskal.</div>
        <div><b style={{color:"var(--ink)"}}>Administratori</b><br/>Menaxhon ekipin dhe biznesin, pa ndryshuar pronësinë.</div>
        <div><b style={{color:"var(--ink)"}}>Menaxheri</b><br/>Operacione, produkte dhe ndërrime.</div>
        <div><b style={{color:"var(--ink)"}}>Kontabilisti</b><br/>Fatura dhe informata financiare.</div>
        <div><b style={{color:"var(--ink)"}}>Punëtori / Arkëtari</b><br/>POS dhe ndërrimi i vet i arkës.</div>
      </div>
    </section>
    {(error||notice)&&<p role="status" style={{marginTop:16,padding:12,borderRadius:9,background:error?"#fff2f0":"#edf8f0",color:error?"#a33f36":"#176b45",fontSize:13}}>{error||notice}</p>}
    <style>{`@media(max-width:700px){main section:first-of-type{grid-template-columns:1fr!important}}`}</style>
  </main>;
}
