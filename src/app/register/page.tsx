"use client";

import { useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";

export default function RegisterPage() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function register(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      const supabase = createClient();
      const { error } = await supabase.auth.signUp({
        email,
        password,
        options: { data: { display_name: name }, emailRedirectTo: `${window.location.origin}/auth/callback` },
      });
      if (error) throw error;
      setMessage("Llogaria u krijua. Nëse konfirmimi me email është aktiv, kontrollo email-in për ta verifikuar.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Regjistrimi nuk u realizua.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 24 }}>
      <section style={{ width: "100%", maxWidth: 440, background: "white", border: "1px solid var(--line)", borderRadius: 18, padding: 30 }}>
        <Link href="/" style={{ color: "var(--brand)", fontWeight: 800 }}>fiskalo</Link>
        <h1 style={{ fontSize: 28, margin: "28px 0 8px" }}>Krijo llogari</h1>
        <p style={{ color: "var(--muted)", margin: "0 0 24px", lineHeight: 1.5 }}>Regjistrohu për të hapur hapësirën e biznesit.</p>
        <form onSubmit={register} style={{ display: "grid", gap: 14 }}>
          <label style={{ display: "grid", gap: 7, fontSize: 13, fontWeight: 600 }}>
            Emri dhe mbiemri
            <input required value={name} onChange={(e) => setName(e.target.value)} style={fieldStyle} />
          </label>
          <label style={{ display: "grid", gap: 7, fontSize: 13, fontWeight: 600 }}>
            Email
            <input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} style={fieldStyle} />
          </label>
          <label style={{ display: "grid", gap: 7, fontSize: 13, fontWeight: 600 }}>
            Fjalëkalimi
            <input type="password" autoComplete="new-password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} style={fieldStyle} />
          </label>
          {message && <p role="status" style={{ color: "var(--brand-dark)", fontSize: 13, margin: 0 }}>{message}</p>}
          <button disabled={busy} type="submit" style={buttonStyle}>{busy ? "Duke krijuar..." : "Krijo llogari"}</button>
        </form>
        <p style={{ marginTop: 20, fontSize: 13, color: "var(--muted)" }}>Ke llogari? <Link href="/login" style={{ color: "var(--brand)", fontWeight: 700 }}>Hyr</Link></p>
      </section>
    </main>
  );
}

const fieldStyle: React.CSSProperties = { width: "100%", border: "1px solid var(--line)", borderRadius: 9, padding: "12px 13px", outlineColor: "var(--brand)" };
const buttonStyle: React.CSSProperties = { border: 0, borderRadius: 9, background: "var(--brand)", color: "white", padding: 13, fontWeight: 700, cursor: "pointer" };
