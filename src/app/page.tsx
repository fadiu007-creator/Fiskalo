import Link from "next/link";

const modules = [
  { title: "Arka / POS", description: "Zgjedh produktet, llogarit totalin automatikisht dhe regjistro pagesat." },
  { title: "Faturat", description: "Kërko shitjet, kontrollo pagesat dhe statusin e dërgimit në ATK TEST." },
  { title: "Produktet", description: "Menaxho çmimet, normat e TVSH-së, barkodet dhe kodet fiskale." },
  { title: "Ekipi dhe ndërrimet", description: "Cakto rolet e punëtorëve dhe menaxho hapjen e mbylljen e arkës." },
];

export default function Home() {
  return (
    <main style={{ maxWidth: 1180, margin: "0 auto", padding: "32px 24px 48px" }}>
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 18, marginBottom: 64, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ width: 42, height: 42, borderRadius: 12, background: "var(--brand)", color: "white", display: "grid", placeItems: "center", fontWeight: 800, fontSize: 21 }}>F</div>
          <strong style={{ fontSize: 23, letterSpacing: "-0.8px" }}>fiskalo</strong>
        </div>
        <nav style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <Link href="/platform-admin" style={{ color: "var(--brand)", fontWeight: 700, fontSize: 14 }}>Paneli i ofruesit</Link>
          <Link href="/login" style={{ color: "var(--brand)", fontWeight: 700, fontSize: 14 }}>Hyr</Link>
          <Link href="/register" style={{ background: "var(--brand)", color: "white", borderRadius: 9, padding: "11px 16px", fontWeight: 700, fontSize: 14 }}>Krijo llogari</Link>
        </nav>
      </header>

      <section style={{ marginBottom: 44 }}>
        <p style={{ color: "var(--brand)", fontWeight: 700, fontSize: 12, letterSpacing: 1.5, textTransform: "uppercase" }}>POS dhe menaxhim biznesi në Kosovë</p>
        <h1 style={{ fontSize: "clamp(36px, 5vw, 58px)", lineHeight: 1.06, letterSpacing: "-2.4px", maxWidth: 760, margin: "12px 0" }}>Shitjet dhe fiskalizimi. Një rrjedhë e vetme pune.</h1>
        <p style={{ color: "var(--muted)", fontSize: 17, maxWidth: 660, lineHeight: 1.7 }}>Menaxho arkën, produktet, faturat dhe ekipin e biznesit nga një panel i vetëm. Përdor Web POS ose aplikacionin Android.</p>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 24 }}>
          <Link href="/register" style={{ background: "var(--brand)", color: "white", borderRadius: 9, padding: "13px 18px", fontWeight: 700 }}>Fillo tani</Link>
          <Link href="/login" style={{ background: "white", border: "1px solid var(--line)", borderRadius: 9, padding: "13px 18px", fontWeight: 700 }}>Hyr në llogari</Link>
        </div>
      </section>

      <section style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16, gap: 12 }}>
        <h2 style={{ fontSize: 19, margin: 0 }}>Modulet e disponueshme</h2>
        <span style={{ color: "var(--muted)", fontSize: 12 }}>MVP</span>
      </section>
      <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 14 }}>
        {modules.map((module) => (
          <article key={module.title} style={{ background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 16, padding: 22 }}>
            <h3 style={{ margin: 0, fontSize: 16 }}>{module.title}</h3>
            <p style={{ color: "var(--muted)", lineHeight: 1.6, fontSize: 13, margin: "14px 0 0" }}>{module.description}</p>
          </article>
        ))}
      </section>
      <section style={{ marginTop: 36, background: "white", border: "1px solid var(--line)", borderRadius: 14, padding: 20 }}>
        <strong style={{ fontSize: 14 }}>Statusi i integrimit ATK</strong>
        <p style={{ color: "var(--muted)", lineHeight: 1.65, fontSize: 13, marginBottom: 0 }}>Dërgimi automatik i faturave të paguara është implementuar për ambientin ATK TEST. Kjo nuk është certifikim për prodhim. Aktivizimi i prodhimit mbetet i çaktivizuar derisa Fiskalo të përfundojë procesin zyrtar të certifikimit dhe konfigurimit me ATK.</p>
      </section>
      <footer style={{ marginTop: 32, borderTop: "1px solid var(--line)", paddingTop: 18, color: "var(--muted)", fontSize: 12 }}>Fiskalo · Platformë për shitje dhe menaxhim biznesi</footer>
    </main>
  );
}
