"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";

type BusinessForm = {
  legal_name: string; trade_name: string; nui: string; fiscal_number: string;
  business_type: string; business_activity: string; municipality: string;
  address: string; phone: string; email: string; vat_registered: boolean;
};


export default function OnboardingPage() {
  const router = useRouter();
  const [form, setForm] = useState<BusinessForm>({
    legal_name: "", trade_name: "", nui: "", fiscal_number: "", business_type: "",
    business_activity: "", municipality: "", address: "", phone: "", email: "", vat_registered: false,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  function update<K extends keyof BusinessForm>(key: K, value: BusinessForm[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const supabase = createClient();
      const { data: { user }, error: userError } = await supabase.auth.getUser();
      if (userError || !user) throw new Error("Sesioni ka skaduar. Hyr përsëri.");
      const { data: organizationId, error: orgError } = await supabase.rpc("fiskalo_create_organization", { payload: form });
      if (orgError) throw orgError;
      router.replace(`/app/${organizationId}`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Regjistrimi i biznesit dështoi.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "40px 24px" }}>
      <Link href="/app" style={{ color: "var(--brand)", fontWeight: 700 }}>← Kthehu te bizneset</Link>
      <h1 style={{ fontSize: 32 }}>Regjistro biznesin</h1>
      <p style={{ color: "var(--muted)", lineHeight: 1.6 }}>
        Plotëso të dhënat bazë të biznesit. Verifikimet zyrtare të tatimpaguesit kryhen veçmas nga ekipi i ofruesit Fiskalo.
      </p>
      <form onSubmit={submit} style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))", gap: 16, background: "white", padding: 24, border: "1px solid var(--line)", borderRadius: 16 }}>
        <Field label="NUI" required value={form.nui} onChange={(v) => update("nui", v.replace(/\D/g, "").slice(0, 9))} />
        <Field label="Emri ligjor i biznesit" required value={form.legal_name} onChange={(v) => update("legal_name", v)} />
        <Field label="Emri tregtar" value={form.trade_name} onChange={(v) => update("trade_name", v)} />
        <Field label="Numri fiskal (ATK)" value={form.fiscal_number} onChange={(v) => update("fiscal_number", v)} />
        <Field label="Forma e biznesit" value={form.business_type} onChange={(v) => update("business_type", v)} />
        <Field label="Veprimtaria" value={form.business_activity} onChange={(v) => update("business_activity", v)} />
        <Field label="Komuna" required value={form.municipality} onChange={(v) => update("municipality", v)} />
        <Field label="Adresa" value={form.address} onChange={(v) => update("address", v)} />
        <Field label="Telefoni" value={form.phone} onChange={(v) => update("phone", v)} />
        <Field label="Email i biznesit" type="email" value={form.email} onChange={(v) => update("email", v)} />
        <label style={{ display: "flex", alignItems: "center", gap: 9, fontSize: 13 }}>
          <input type="checkbox" checked={form.vat_registered} onChange={(e) => update("vat_registered", e.target.checked)} />
          Biznesi është i regjistruar për TVSH (konfirmoje në ATK)
        </label>
        {error && <p role="alert" style={{ color: "#a12b2b", gridColumn: "1 / -1", fontSize: 13 }}>{error}</p>}
        <button disabled={busy} type="submit" style={{ gridColumn: "1 / -1", border: 0, borderRadius: 9, background: "var(--brand)", color: "white", padding: 13, fontWeight: 700 }}>{busy ? "Duke ruajtur..." : "Ruaj biznesin"}</button>
      </form>
    </main>
  );
}

function Field({ label, value, onChange, required = false, type = "text" }: { label: string; value: string; onChange: (value: string) => void; required?: boolean; type?: string }) {
  return (
    <label style={{ display: "grid", gap: 7, fontSize: 13, fontWeight: 600 }}>
      {label}
      <input type={type} required={required} value={value} onChange={(e) => onChange(e.target.value)} style={{ width: "100%", border: "1px solid var(--line)", borderRadius: 9, padding: "12px 13px" }} />
    </label>
  );
}
