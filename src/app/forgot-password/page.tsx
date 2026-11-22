"use client";

import { useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setMessage("");
    const { error } = await createClient().auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/auth/callback?next=/reset-password`,
    });
    setBusy(false);
    setMessage(error ? error.message : "Nëse email-i ekziston, do të marrësh një lidhje për rivendosjen e fjalëkalimit.");
  }

  return <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 24 }}>
    <section style={{ width: "100%", maxWidth: 420, background: "white", border: "1px solid var(--line)", borderRadius: 18, padding: 30 }}>
      <Link href="/login" style={{ color: "var(--brand)", fontWeight: 800 }}>fiskalo</Link>
      <h1 style={{ fontSize: 27 }}>Rivendos fjalëkalimin</h1>
      <p style={{ color: "var(--muted)", fontSize: 13 }}>Shkruaj email-in e llogarisë për të marrë lidhjen e rivendosjes.</p>
      <form onSubmit={submit} style={{ display: "grid", gap: 14 }}>
        <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email" style={{ width: "100%", border: "1px solid var(--line)", borderRadius: 9, padding: "12px 13px" }} />
        {message && <p role="status" style={{ color: "var(--brand-dark)", fontSize: 13 }}>{message}</p>}
        <button disabled={busy} style={{ border: 0, borderRadius: 9, background: "var(--brand)", color: "white", padding: 13, fontWeight: 700 }}>{busy ? "Duke dërguar..." : "Dërgo lidhjen"}</button>
      </form>
    </section>
  </main>;
}
