"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ArrowLeftRight, Boxes, Building2, ChevronDown, Contact, FileBarChart2, FileText, LayoutDashboard, LogOut, ReceiptText, Settings2, ShoppingCart, Users, UserCircle, Warehouse, Truck, Wallet } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import type { ReactNode } from "react";

type NavItem = { path: string; label: string; hint: string; icon: typeof LayoutDashboard; roles: string[] };
type NavGroup = { label: string; items: NavItem[] };
const allRoles = ["owner", "administrator", "manager", "accountant", "cashier"];
const managers = ["owner", "administrator", "manager"];
const finance = ["owner", "administrator", "manager", "accountant"];

const groups: NavGroup[] = [
  { label: "PUNA E PËRDITSHME", items: [
    { path: "", label: "Përmbledhja", hint: "Gjendja e biznesit", icon: LayoutDashboard, roles: allRoles },
    { path: "/pos", label: "Arka (POS)", hint: "Regjistro shitje dhe prano pagesa", icon: ShoppingCart, roles: ["owner", "administrator", "manager", "cashier"] },
    { path: "/pos/shifts", label: "Ndërrimet e arkës", hint: "Hapja dhe mbyllja e arkës", icon: Wallet, roles: ["owner", "administrator", "manager", "cashier"] },
  ]},
  { label: "SHITJET DHE KLIENTËT", items: [
    { path: "/invoices", label: "Faturat", hint: "Shitjet, pagesat dhe faturat", icon: FileText, roles: allRoles },
    { path: "/customers", label: "Klientët", hint: "Kontaktet dhe të dhënat e klientëve", icon: Contact, roles: finance },
  ]},
  { label: "BLERJET DHE SHPENZIMET", items: [
    { path: "/purchases", label: "Blerjet dhe furnitorët", hint: "Faturat hyrëse dhe furnitorët", icon: Truck, roles: finance },
    { path: "/expenses", label: "Shpenzimet", hint: "Regjistro kostot e biznesit", icon: ReceiptText, roles: finance },
  ]},
  { label: "PRODUKTET DHE STOKU", items: [
    { path: "/pos/products", label: "Produktet", hint: "Çmimet, barkodet dhe kodet ATK", icon: Boxes, roles: managers },
    { path: "/inventory", label: "Inventari", hint: "Sasia dhe lëvizjet e stokut", icon: Warehouse, roles: managers },
  ]},
  { label: "FINANCAT DHE EKIPI", items: [
    { path: "/reports", label: "Raportet", hint: "Shitjet, TVSh-ja dhe shpenzimet", icon: FileBarChart2, roles: finance },
    { path: "/team", label: "Ekipi", hint: "Punëtorët dhe rolet", icon: Users, roles: ["owner", "administrator"] },
    { path: "/pos/setup", label: "Konfigurimi ATK", hint: "POS, certifikata dhe fiskalizimi", icon: Settings2, roles: ["owner", "administrator"] },
  ]},
];
const routeLabels = groups.flatMap(group => group.items).reduce<Record<string, string>>((acc, item) => {
  acc[item.path] = item.label;
  return acc;
}, {});

export default function BusinessWorkspaceNav({ organizationId, businessName, role, isProvider, children }: {
  organizationId: string; businessName: string; role: string; isProvider: boolean; children: ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const base = "/app/" + organizationId;
  const visibleGroups = groups.map(group => ({ ...group, items: group.items.filter(item => item.roles.includes(role)) })).filter(group => group.items.length);
  const current = Object.entries(routeLabels)
    .filter(([path]) => path === "" ? pathname === base : pathname === base + path || pathname.startsWith(base + path + "/"))
    .sort((a, b) => b[0].length - a[0].length)[0]?.[1] ?? "Paneli";

  async function signOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.replace("/login");
    router.refresh();
  }

  const renderLink = (item: NavItem, mobile = false) => {
    const href = base + item.path;
    const active = item.path === "" ? pathname === href : pathname === href || pathname.startsWith(href + "/");
    const Icon = item.icon;
    return <Link key={item.path} href={href} className={"business-nav-link" + (active ? " active" : "") + (mobile ? " mobile" : "")} aria-current={active ? "page" : undefined}>
      <Icon size={17} aria-hidden="true" />
      <span className="business-nav-link-copy"><strong>{item.label}</strong><small>{item.hint}</small></span>
    </Link>;
  };

  return <div className="business-app-shell">
    <aside className="business-sidebar">
      <Link href={base} className="business-sidebar-brand"><span className="business-brand-mark">F</span><strong>fiskalo</strong><small>BUSINESS</small></Link>
      <div className="business-sidebar-company">
        <span>BIZNESI AKTIV</span><strong title={businessName}>{businessName}</strong>
        <Link href="/app?switch=1"><ArrowLeftRight size={13}/> Ndërro biznesin</Link>
      </div>
      <nav className="business-sidebar-nav" aria-label="Menuja kryesore e biznesit">
        {visibleGroups.map(group => <section className="business-nav-group" key={group.label}>
          <h2>{group.label}</h2>
          {group.items.map(item => renderLink(item))}
        </section>)}
      </nav>
      <div className="business-sidebar-bottom">
        {isProvider && <Link href="/provider" className="business-sidebar-provider"><Building2 size={16}/> Paneli i ofruesit</Link>}
        <Link href="/account" className="business-sidebar-account"><UserCircle size={17}/><span>Profili dhe llogaria</span></Link>
        <button type="button" onClick={() => void signOut()} className="business-sidebar-account"><LogOut size={17}/><span>Dil nga llogaria</span></button>
        <div className="business-sidebar-footnote">Fiskalo · Menaxhimi i biznesit</div>
      </div>
    </aside>
    <div className="business-app-main">
      <header className="business-topbar">
        <div><span className="business-topbar-eyebrow">HAPËSIRA E PUNËS / {current.toUpperCase()}</span><strong>{businessName}</strong></div>
        <div className="business-topbar-actions">
          {isProvider && <Link href="/provider" aria-label="Paneli i ofruesit"><Building2 size={15}/><span>Ofruesi</span></Link>}
          <Link href="/account" aria-label="Profili dhe llogaria"><UserCircle size={17}/><span>Llogaria</span></Link>
          <button type="button" onClick={() => void signOut()} aria-label="Dil nga llogaria"><LogOut size={16}/><span>Dil</span></button>
        </div>
      </header>
      <details className="business-mobile-menu">
        <summary><span><LayoutDashboard size={17}/> Menuja e biznesit</span><ChevronDown size={17} className="business-mobile-menu-chevron"/></summary>
        <div className="business-mobile-menu-content">
          <div className="business-mobile-menu-business"><strong>{businessName}</strong><Link href="/app?switch=1"><ArrowLeftRight size={14}/> Ndërro biznesin</Link></div>
          {visibleGroups.map(group => <section className="business-nav-group" key={group.label}>
            <h2>{group.label}</h2>
            <div className="business-mobile-menu-links">{group.items.map(item => renderLink(item, true))}</div>
          </section>)}
          {isProvider && <Link href="/provider" className="business-mobile-extra"><Building2 size={16}/> Paneli i ofruesit</Link>}
          <Link href="/account" className="business-mobile-extra"><UserCircle size={16}/> Profili dhe llogaria</Link>
          <button type="button" onClick={() => void signOut()} className="business-mobile-extra"><LogOut size={16}/> Dil nga llogaria</button>
        </div>
      </details>
      <div className="business-app-content">{children}</div>
    </div>
  </div>;
}
