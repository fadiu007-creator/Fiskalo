"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function signIn(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      const supabase = createClient();
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
      const { data: providerAccess } = await supabase
        .from("fiskalo_provider_users")
        .select("role")
        .eq("user_id", data.user.id)
        .maybeSingle();
      router.replace(providerAccess ? "/provider" : "/app");
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Hyrja nuk u realizua.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 24 }}>
      <section style={{ width: "100%", maxWidth: 420, background: "white", border: "1px solid var(--line)", borderRadius: 18, padding: 30 }}>
        <Link href="/" style={{ color: "var(--brand)", fontWeight: 800 }}>fiskalo</Link>
        <h1 style={{ fontSize: 28, margin: "28px 0 8px" }}>Hyr në llogari</h1>
        <p style={{ color: "var(--muted)", margin: "0 0 24px", lineHeight: 1.5 }}>Përdor email-in dhe fjalëkalimin e llogarisë tënde.</p>
        <form onSubmit={signIn} style={{ display: "grid", gap: 14 }}>
          <label style={{ display: "grid", gap: 7, fontSize: 13, fontWeight: 600 }}>
            Email
            <input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} style={fieldStyle} />
          </label>
          <label style={{ display: "grid", gap: 7, fontSize: 13, fontWeight: 600 }}>
            Fjalëkalimi
            <input type="password" autoComplete="current-password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} style={fieldStyle} />
          </label>
          {message && <p role="alert" style={{ color: "#a12b2b", fontSize: 13, margin: 0 }}>{message}</p>}
          <button disabled={busy} type="submit" style={buttonStyle}>{busy ? "Duke hyrë..." : "Hyr"}</button>
        </form>
        <p style={{ marginTop: 14, fontSize: 13 }}><Link href="/forgot-password" style={{ color: "var(--brand)", fontWeight: 700 }}>Ke harruar fjalëkalimin?</Link></p>
        <p style={{ marginTop: 20, fontSize: 13, color: "var(--muted)" }}>Nuk ke llogari? <Link href="/register" style={{ color: "var(--brand)", fontWeight: 700 }}>Regjistro biznesin</Link></p>
        <p style={{ marginTop: 10, fontSize: 13, color: "var(--muted)" }}>Je pjesë e ekipit të Fiskalo? <Link href="/provider" style={{ color: "var(--brand)", fontWeight: 700 }}>Hyr në hapësirën e ofruesit</Link>. Përdor të njëjtin email dhe fjalëkalim; paneli hapet sipas rolit të llogarisë.</p>
      </section>
    </main>
  );
}

const fieldStyle: React.CSSProperties = { width: "100%", border: "1px solid var(--line)", borderRadius: 9, padding: "12px 13px", outlineColor: "var(--brand)" };
const buttonStyle: React.CSSProperties = { border: 0, borderRadius: 9, background: "var(--brand)", color: "white", padding: 13, fontWeight: 700, cursor: "pointer" };
