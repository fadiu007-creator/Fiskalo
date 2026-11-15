import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ArrowUpRight, Boxes, ClipboardList, FileBarChart2, FileText, Package, Plus, ReceiptText, ShoppingCart, Truck, Wallet, AlertCircle, Contact } from "lucide-react";

type Props = { params: Promise<{ organizationId: string }> };
const money = (n: number) => new Intl.NumberFormat("sq-XK", { style: "currency", currency: "EUR", maximumFractionDigits: 2 }).format(n);
const dateLabel = (d: string) => new Date(d + "T12:00:00").toLocaleDateString("sq-XK", { day: "2-digit", month: "short" });

export default async function BusinessDashboard({ params }: Props) {
  const { organizationId } = await params;
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) redirect("/login");
  const now = new Date();
  const kosovoParts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Belgrade", year: "numeric", month: "2-digit" }).formatToParts(now);
  const kosovoYear = Number(kosovoParts.find(part => part.type === "year")?.value);
  const kosovoMonth = Number(kosovoParts.find(part => part.type === "month")?.value);
  const monthStart = `${kosovoYear}-${String(kosovoMonth).padStart(2, "0")}-01`;
  const nextMonthStart = kosovoMonth === 12 ? `${kosovoYear + 1}-01-01` : `${kosovoYear}-${String(kosovoMonth + 1).padStart(2, "0")}-01`;
  const [{ data: membership }, { data: organization }, { data: invoices, error: invoiceError }, { count: customerCount, error: customerCountError }, { count: unpaidInvoiceCount, error: unpaidInvoiceError }] = await Promise.all([
    supabase.from("fiskalo_organization_users").select("role").eq("organization_id", organizationId).eq("user_id", auth.user.id).maybeSingle(),
    supabase.from("fiskalo_organizations").select("legal_name,trade_name,municipality").eq("id", organizationId).maybeSingle(),
    supabase.from("fiskalo_invoices").select("id,invoice_number,issue_date,total,payment_status,fiscalization_status").eq("organization_id", organizationId).eq("status", "issued").gte("issue_date", monthStart).lt("issue_date", nextMonthStart).order("created_at", { ascending: false }).order("id", { ascending: false }).limit(100),
    supabase.from("fiskalo_customers").select("id", { count: "exact", head: true }).eq("organization_id", organizationId),
    supabase.from("fiskalo_invoices").select("id", { count: "exact", head: true }).eq("organization_id", organizationId).eq("status", "issued").neq("payment_status", "paid"),
  ]);
  if (!membership || !organization) redirect("/app");
  const role = membership.role;
  const roleLabel: Record<string,string> = { owner:"Pronari", administrator:"Administrator", manager:"Menaxher", accountant:"Kontabilist", cashier:"Arkëtar" };
  const canViewFinance = ["owner", "administrator", "manager", "accountant"].includes(role);
  let financialInvoices: number[] = [];
  let financialExpenses: number[] = [];
  let financialDataError = "";
  let productDataError = "";
  if (canViewFinance) {
    let invoiceOffset = 0;
    while (true) {
      const { data, error } = await supabase.from("fiskalo_invoices").select("total")
        .eq("organization_id", organizationId).eq("status", "issued").gte("issue_date", monthStart).lt("issue_date", nextMonthStart)
        .order("issue_date", { ascending: true }).order("id", { ascending: true })
        .range(invoiceOffset, invoiceOffset + 999);
      if (error) { financialDataError = error.message; break; }
      financialInvoices = financialInvoices.concat((data ?? []).map(row => Math.round(Number(row.total || 0) * 100)));
      if ((data ?? []).length < 1000) break;
      invoiceOffset += 1000;
    }
    let expenseOffset = 0;
    while (true) {
      const { data, error } = await supabase.from("fiskalo_expenses").select("amount")
        .eq("organization_id", organizationId).gte("expense_date", monthStart).lt("expense_date", nextMonthStart)
        .order("expense_date", { ascending: true }).order("id", { ascending: true })
        .range(expenseOffset, expenseOffset + 999);
      if (error) { financialDataError = financialDataError || error.message; break; }
      financialExpenses = financialExpenses.concat((data ?? []).map(row => Math.round(Number(row.amount || 0) * 100)));
      if ((data ?? []).length < 1000) break;
      expenseOffset += 1000;
    }
  }
  let products: { id: string; stock_quantity: number; track_stock: boolean }[] = [];
  let productOffset = 0;
  while (true) {
    const { data, error } = await supabase.from("fiskalo_products").select("id,stock_quantity,track_stock")
      .eq("organization_id", organizationId).eq("is_active", true)
      .order("id", { ascending: true }).range(productOffset, productOffset + 999);
    if (error) { productDataError = error.message; break; }
    products = products.concat((data ?? []).map(row => ({ id: row.id, stock_quantity: Number(row.stock_quantity || 0), track_stock: row.track_stock })));
    if ((data ?? []).length < 1000) break;
    productOffset += 1000;
  }
  const sales = financialInvoices.reduce((sum, invoiceCents) => sum + invoiceCents, 0) / 100;
  const expensesTotal = financialExpenses.reduce((sum, expenseCents) => sum + expenseCents, 0) / 100;
  const unpaidCount = unpaidInvoiceCount ?? 0;
  const lowStock = (products ?? []).filter(product => product.track_stock && Number(product.stock_quantity) <= 5).length;
  const modules = [
    { href:`/app/${organizationId}/pos`, title:"Regjistro shitje", detail:"Hap arkën dhe përfundo një shitje", icon:ShoppingCart, primary:true, roles:["owner","administrator","manager","cashier"] },
    { href:`/app/${organizationId}/invoices`, title:"Shiko faturat", detail:"Kontrollo shitjet dhe pagesat", icon:FileText, roles:["owner","administrator","manager","accountant","cashier"] },
    { href:`/app/${organizationId}/pos/shifts`, title:"Ndërrimet e arkëtarëve", detail:"Hap ose mbyll ndërrimin dhe kontrollo gjendjen e arkës", icon:ClipboardList, roles:["owner","administrator","manager","cashier"] },
    { href:`/app/${organizationId}/pos/products`, title:"Produktet dhe çmimet", detail:"Menaxho katalogun, çmimet, barkodet dhe stokun", icon:Package, roles:["owner","administrator","manager"] },
    { href:`/app/${organizationId}/customers`, title:"Shto klient", detail:"Ruaj të dhënat e klientit", icon:Contact, roles:["owner","administrator","manager","accountant"] },
    { href:`/app/${organizationId}/expenses`, title:"Regjistro shpenzim", detail:"Shto një shpenzim të biznesit", icon:ReceiptText, roles:["owner","administrator","manager","accountant"] },
    { href:`/app/${organizationId}/purchases`, title:"Regjistro blerje", detail:"Faturat e furnitorëve dhe hyrjet e mallit", icon:Truck, roles:["owner","administrator","manager","accountant"] },
    { href:`/app/${organizationId}/reports`, title:"Raportet financiare", detail:"Shitjet, TVSH-ja dhe shpenzimet", icon:FileBarChart2, roles:["owner","administrator","manager","accountant"] },
  ].filter(item => item.roles.includes(role));
  return <main className="qb-dashboard">
    <nav aria-label="Versioni i Fiskalo" className="no-print" style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "0 0 18px" }}>
      <Link href={`/app/${organizationId}`} aria-current="page" className="qb-primary-action" style={{ textDecoration: "none" }}>Versioni aktual</Link>
      <Link href={`/basic`} className="qb-action-link" style={{ textDecoration: "none" }}>Fiskalo Basic MVP <ArrowUpRight size={15}/></Link>
    </nav>
    <section className="qb-welcome"><div><span className="qb-eyebrow">PËRMBLEDHJA E BIZNESIT</span><h1>Përshëndetje, {roleLabel[role] ?? role}</h1><p>{organization.trade_name || organization.legal_name} · {organization.municipality || "Kosovë"}</p></div>{["owner", "administrator", "manager", "cashier"].includes(role) && <Link className="qb-primary-action" href={`/app/${organizationId}/pos`}><Plus size={17}/> Shitje e re</Link>}</section>
    {(invoiceError || financialDataError || productDataError || customerCountError || unpaidInvoiceError) && <div className="qb-inline-alert"><AlertCircle size={16}/> Disa të dhëna nuk u ngarkuan plotësisht: {invoiceError?.message || financialDataError || productDataError || customerCountError?.message || unpaidInvoiceError?.message}</div>}
    <section className="qb-metric-grid" aria-label="Treguesit e muajit">
      {canViewFinance && <article className="qb-metric"><span>Shitjet këtë muaj</span><strong>{financialDataError ? "—" : money(sales)}</strong><small>{financialDataError ? "Të dhënat nuk u verifikuan" : `${financialInvoices.length} fatura të lëshuara`}</small></article>}
      {canViewFinance && <article className="qb-metric"><span>Fatura për arkëtim</span><strong>{unpaidInvoiceError ? "—" : unpaidCount}</strong><small>{unpaidInvoiceError ? "Të dhënat nuk u verifikuan" : "Fatura të papaguara ose pjesërisht të paguara"}</small></article>}
      {canViewFinance && <article className="qb-metric"><span>Shpenzimet këtë muaj</span><strong>{financialDataError ? "—" : money(expensesTotal)}</strong><small>{financialDataError ? "Të dhënat nuk u verifikuan" : "Shpenzime të regjistruara në muajin aktual"}</small></article>}
      {!canViewFinance && <article className="qb-metric"><span>Produktet aktive</span><strong>{productDataError ? "—" : products.length}</strong><small>{productDataError ? "Stoku nuk u verifikua" : `${lowStock} artikuj me stok të ulët`}</small></article>}
      <article className="qb-metric"><span>Klientët</span><strong>{customerCountError ? "—" : customerCount ?? 0}</strong><small>{customerCountError ? "Numri nuk u verifikua" : "Regjistri i klientëve"}</small></article>
    </section>
    <section className="qb-dashboard-grid">
      <div className="qb-panel qb-actions-panel"><div className="qb-panel-heading"><div><h2>Veprimet e shpejta</h2><p>Detyrat që kryhen më shpesh në biznes.</p></div></div><div className="qb-action-grid">{modules.map(item => { const Icon=item.icon; return <Link key={item.href} href={item.href} className={"qb-action-link"+(item.primary?" primary":"")}><span><Icon size={18}/></span><div><strong>{item.title}</strong><small>{item.detail}</small></div><ArrowUpRight size={15}/></Link>; })}</div></div>
      <aside className="qb-panel qb-attention-panel"><div className="qb-panel-heading"><div><h2>Kërkon vëmendje</h2><p>Kontrolle të dobishme për sot.</p></div></div><div className="qb-attention-list">
        {canViewFinance && <Link href={`/app/${organizationId}/invoices`}><span className="qb-attention-icon amber"><FileText size={17}/></span><span><strong>{unpaidInvoiceError ? "Arkëtimet nuk u verifikuan" : `${unpaidCount} fatura për arkëtim`}</strong><small>Kontrollo pagesat e mbetura</small></span><ArrowUpRight size={15}/></Link>}
        {!["cashier", "accountant"].includes(role) && <Link href={`/app/${organizationId}/inventory`}><span className="qb-attention-icon red"><Boxes size={17}/></span><span><strong>{productDataError ? "Stoku nuk u verifikua" : `${lowStock} artikuj me stok të ulët`}</strong><small>Kontrollo nivelet e inventarit</small></span><ArrowUpRight size={15}/></Link>}
        {["owner", "administrator"].includes(role) && <Link href={`/app/${organizationId}/pos/setup`}><span className="qb-attention-icon green"><Wallet size={17}/></span><span><strong>Konfigurimi fiskal</strong><small>Kontrollo statusin e POS dhe ATK</small></span><ArrowUpRight size={15}/></Link>}
      </div></aside>
    </section>
    {canViewFinance && <section className="qb-panel qb-recent-panel"><div className="qb-panel-heading"><div><h2>Shitjet e fundit këtë muaj</h2><p>Faturat e lëshuara në këtë biznes.</p></div><Link href={`/app/${organizationId}/invoices`}>Shiko të gjitha <ArrowUpRight size={14}/></Link></div>
      {invoiceError ? <div className="qb-empty-state"><FileText size={24}/><strong>Shitjet nuk u ngarkuan</strong><p>{invoiceError.message}</p></div> : (invoices ?? []).length ? <div className="qb-table-wrap"><table className="qb-table"><thead><tr><th>Fatura</th><th>Data</th><th>Pagesa</th><th>Fiskalizimi</th><th className="numeric">Totali</th></tr></thead><tbody>{(invoices ?? []).slice(0,6).map(invoice => <tr key={invoice.id}><td><Link href={`/app/${organizationId}/invoices/${invoice.id}`}>{invoice.invoice_number || "Draft"}</Link></td><td>{dateLabel(invoice.issue_date)}</td><td><span className={"qb-status "+(invoice.payment_status === "paid" ? "success" : "warning")}>{invoice.payment_status === "paid" ? "E paguar" : invoice.payment_status === "partial" ? "Pjesërisht" : "E papaguar"}</span></td><td>{invoice.fiscalization_status === "accepted" ? <span className="qb-status success">Pranuar nga ATK</span> : <span className="qb-status neutral">{invoice.fiscalization_status || "Jo e fiskalizuar"}</span>}</td><td className="numeric">{money(Number(invoice.total))}</td></tr>)}</tbody></table></div> : <div className="qb-empty-state"><FileText size={24}/><strong>Nuk ka shitje të regjistruara këtë muaj</strong><p>Shitja e parë mund të regjistrohet nga arka.</p><Link href={`/app/${organizationId}/pos`}>Hap arkën <ArrowUpRight size={14}/></Link></div>}
    </section>}
    <footer className="qb-dashboard-footer"><span>Raporti për muajin aktual · Vlerat në EUR</span>{canViewFinance && <Link href={`/app/${organizationId}/reports`}>Hap raportet financiare</Link>}</footer>
  </main>;
}
