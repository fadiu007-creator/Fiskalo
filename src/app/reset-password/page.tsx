"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export default function ResetPasswordPage() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage("");
    if (password !== confirm) { setMessage("Fjalëkalimet nuk përputhen."); return; }
    setBusy(true);
    const { error } = await createClient().auth.updateUser({ password });
    setBusy(false);
    if (error) { setMessage(error.message); return; }
    setMessage("Fjalëkalimi u ndryshua. Po të ridrejtojmë te hyrja...");
    setTimeout(() => router.replace("/login"), 900);
  }

  return <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 24 }}>
    <section style={{ width: "100%", maxWidth: 420, background: "white", border: "1px solid var(--line)", borderRadius: 18, padding: 30 }}>
      <h1 style={{ fontSize: 27 }}>Vendos fjalëkalim të ri</h1>
      <form onSubmit={save} style={{ display: "grid", gap: 14 }}>
        <label style={{ display: "grid", gap: 7, fontSize: 13 }}>Fjalëkalimi i ri<input type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} style={fieldStyle} /></label>
        <label style={{ display: "grid", gap: 7, fontSize: 13 }}>Përsërite fjalëkalimin<input type="password" required minLength={8} value={confirm} onChange={(e) => setConfirm(e.target.value)} style={fieldStyle} /></label>
        {message && <p role="status" style={{ color: "var(--brand-dark)", fontSize: 13 }}>{message}</p>}
        <button disabled={busy} style={buttonStyle}>{busy ? "Duke ruajtur..." : "Ndrysho fjalëkalimin"}</button>
      </form>
    </section>
  </main>;
}

const fieldStyle: React.CSSProperties = { width: "100%", border: "1px solid var(--line)", borderRadius: 9, padding: "12px 13px" };
const buttonStyle: React.CSSProperties = { border: 0, borderRadius: 9, background: "var(--brand)", color: "white", padding: 13, fontWeight: 700 };
