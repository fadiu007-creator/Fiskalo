import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ArrowLeft, AlertTriangle, Boxes, PackageCheck, Warehouse } from "lucide-react";
import StockAdjustment from "./stock-adjustment";

type Props = { params: Promise<{ organizationId: string }> };
type Product = { id: string; name: string; sku: string | null; pos_category: string; stock_quantity: number; track_stock: boolean; unit: string; is_active: boolean };
type Movement = { id: string; product_id: string; movement_type: string; quantity: number; note: string | null; created_at: string };

const number = (value: number) => new Intl.NumberFormat("sq-XK", { maximumFractionDigits: 3 }).format(value);
const date = (value: string) => new Date(value).toLocaleString("sq-XK", { dateStyle: "medium", timeStyle: "short" });

export default async function InventoryPage({ params }: Props) {
  const { organizationId } = await params;
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) redirect("/login");
  const { data: membership } = await supabase.from("fiskalo_organization_users").select("role")
    .eq("organization_id", organizationId).eq("user_id", auth.user.id).maybeSingle();
  if (!membership || !["owner", "administrator", "manager"].includes(membership.role)) redirect("/app/" + organizationId);
  const [{ data: products, error: productError }, { data: movements, error: movementError }] = await Promise.all([
    supabase.from("fiskalo_products").select("id,name,sku,pos_category,stock_quantity,track_stock,unit,is_active")
      .eq("organization_id", organizationId).eq("is_active", true).order("name"),
    supabase.from("fiskalo_inventory_movements").select("id,product_id,movement_type,quantity,note,created_at")
      .eq("organization_id", organizationId).order("created_at", { ascending: false }).limit(100),
  ]);
  const rows = (products ?? []) as Product[];
  const tracked = rows.filter((product) => product.track_stock);
  const zeroStock = tracked.filter((product) => Number(product.stock_quantity) <= 0);
  const movementRows = (movements ?? []) as Movement[];
  const productNames = new Map(rows.map((product) => [product.id, product.name]));
  const loadError = productError || movementError;
  return <main style={{ maxWidth: 1180, margin: "0 auto", padding: "26px clamp(15px,3vw,30px) 56px" }}>
    <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 22 }}>
      <div><Link href={"/app/" + organizationId} style={{ display: "inline-flex", alignItems: "center", gap: 7, color: "var(--brand)", fontSize: 12, fontWeight: 750 }}><ArrowLeft size={15}/> Paneli</Link>
        <h1 style={{ fontSize: 29, letterSpacing: "-.04em", margin: "12px 0 5px" }}>Inventari</h1>
        <p style={{ margin: 0, color: "var(--muted)", fontSize: 13 }}>Gjendja e stokut dhe historiku i lëvizjeve.</p>
      </div>
      <Link href={"/app/" + organizationId + "/pos/products"} style={{ display: "inline-flex", alignItems: "center", gap: 8, padding: "11px 14px", borderRadius: 10, background: "var(--brand)", color: "white", fontSize: 12, fontWeight: 800 }}>Menaxho produktet</Link>
    </header>
    {loadError ? <p role="alert" style={{ color: "#a33f36" }}>Disa të dhëna të inventarit nuk u ngarkuan. Kontrollo qasjen në databazë dhe rifresko faqen.</p> : null}
    <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(190px,1fr))", gap: 12, marginBottom: 20 }}>
      <article style={{ background: "white", border: "1px solid var(--line)", borderRadius: 14, padding: 17 }}><Boxes size={19} color="var(--brand)"/><div style={{ color: "var(--muted)", fontSize: 12, marginTop: 10 }}>Produkte aktive</div><strong style={{ display: "block", fontSize: 27 }}>{rows.length}</strong></article>
      <article style={{ background: "white", border: "1px solid var(--line)", borderRadius: 14, padding: 17 }}><Warehouse size={19} color="var(--brand)"/><div style={{ color: "var(--muted)", fontSize: 12, marginTop: 10 }}>Produkte me stok të gjurmuar</div><strong style={{ display: "block", fontSize: 27 }}>{tracked.length}</strong></article>
      <article style={{ background: "white", border: "1px solid var(--line)", borderRadius: 14, padding: 17 }}><AlertTriangle size={19} color={zeroStock.length ? "#a35d13" : "var(--brand)"}/><div style={{ color: "var(--muted)", fontSize: 12, marginTop: 10 }}>Pa stok</div><strong style={{ display: "block", fontSize: 27 }}>{zeroStock.length}</strong></article>
      <article style={{ background: "white", border: "1px solid var(--line)", borderRadius: 14, padding: 17 }}><PackageCheck size={19} color="var(--brand)"/><div style={{ color: "var(--muted)", fontSize: 12, marginTop: 10 }}>Lëvizje të fundit</div><strong style={{ display: "block", fontSize: 27 }}>{movementRows.length}</strong></article>
    </section>
    <section style={{ background: "white", border: "1px solid var(--line)", borderRadius: 14, padding: 16, marginBottom: 16 }}>
      <h2 style={{ margin: "0 0 12px", fontSize: 17 }}>Gjendja e stokut</h2>
      <div style={{ overflowX: "auto" }}><table className="data-table"><thead><tr><th>Produkti</th><th>Kategoria</th><th>SKU / Barkodi</th><th>Gjendja</th><th>Rregullimi</th><th>Statusi</th></tr></thead><tbody>
        {tracked.map((product) => <tr key={product.id}><td><strong>{product.name}</strong></td><td>{product.pos_category || "Tjera"}</td><td>{product.sku || "—"}</td><td>{number(Number(product.stock_quantity))} {product.unit || "copë"}</td><td><StockAdjustment productId={product.id} productName={product.name}/></td><td><span className="status-pill" style={Number(product.stock_quantity) <= 0 ? { background: "#fff0ee", color: "#a23b31" } : { background: "#e8f6ee", color: "#17633f" }}>{Number(product.stock_quantity) <= 0 ? "Pa stok" : "Në stok"}</span></td></tr>)}
        {!tracked.length && <tr><td colSpan={6}>Nuk ka produkte me gjurmim të stokut aktiv.</td></tr>}
      </tbody></table></div>
    </section>
    <section style={{ background: "white", border: "1px solid var(--line)", borderRadius: 14, padding: 16 }}>
      <h2 style={{ margin: "0 0 12px", fontSize: 17 }}>Lëvizjet e fundit</h2>
      <div style={{ overflowX: "auto" }}><table className="data-table"><thead><tr><th>Data</th><th>Produkti</th><th>Lëvizja</th><th>Sasia</th><th>Shënimi</th></tr></thead><tbody>
        {movementRows.map((movement) => <tr key={movement.id}><td>{date(movement.created_at)}</td><td>{productNames.get(movement.product_id) || "Produkt i arkivuar"}</td><td>{({ opening: "Stok fillestar", in: "Hyrje", out: "Dalje", adjustment: "Korrigjim" } as Record<string,string>)[movement.movement_type] || movement.movement_type}</td><td>{number(Number(movement.quantity))}</td><td>{movement.note || "—"}</td></tr>)}
        {!movementRows.length && <tr><td colSpan={5}>Nuk ka lëvizje të regjistruara.</td></tr>}
      </tbody></table></div>
    </section>
  </main>;
}
