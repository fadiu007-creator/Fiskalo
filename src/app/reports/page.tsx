"use client";

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  buildSalesReport,
  buildSalesReportCsv,
  localDateRangeToIso,
  type ReportFiscalDocument,
  type ReportSale,
  type ReportSaleItem,
} from "@/lib/reports/sales-report";

type Business = { id: string; name: string; nui: string };
type AccessState = "loading" | "owner" | "signed_out" | "forbidden" | "unconfigured";
const MAX_SALES = 5000;

function dateInputValue(date: Date): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function formatMoney(cents: number): string {
  return new Intl.NumberFormat("sq-XK", { style: "currency", currency: "EUR" }).format(cents / 100);
}

function tableStyle(): CSSProperties {
  return { width: "100%", borderCollapse: "collapse", fontSize: 13 };
}

const headerCell: CSSProperties = {
  textAlign: "left",
  padding: "10px 8px",
  borderBottom: "1px solid var(--line)",
  color: "var(--muted)",
  fontWeight: 700,
  whiteSpace: "nowrap",
};

const bodyCell: CSSProperties = {
  padding: "10px 8px",
  borderBottom: "1px solid var(--line)",
  verticalAlign: "top",
};

export default function ReportsPage() {
  const supabase = useMemo(() => {
    try {
      return createClient();
    } catch {
      return null;
    }
  }, []);

  const today = new Date();
  const [startDate, setStartDate] = useState(() => dateInputValue(new Date(today.getFullYear(), today.getMonth(), 1)));
  const [endDate, setEndDate] = useState(() => dateInputValue(today));
  const [access, setAccess] = useState<AccessState>("loading");
  const [business, setBusiness] = useState<Business | null>(null);
  const [sales, setSales] = useState<ReportSale[]>([]);
  const [items, setItems] = useState<ReportSaleItem[]>([]);
  const [documents, setDocuments] = useState<ReportFiscalDocument[]>([]);
  const [busy, setBusy] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [message, setMessage] = useState("");

  const loadReport = useCallback(async () => {
    if (!supabase) {
      setAccess("unconfigured");
      return;
    }

    setBusy(true);
    setMessage("");
    try {
      const { data: authData, error: authError } = await supabase.auth.getUser();
      if (authError) throw authError;
      if (!authData.user) {
        setAccess("signed_out");
        setBusiness(null);
        setSales([]);
        setItems([]);
        setDocuments([]);
        return;
      }

      const { data: member, error: memberError } = await supabase
        .from("fiskalo_basic_members")
        .select("business_id,role")
        .eq("user_id", authData.user.id)
        .limit(1)
        .maybeSingle();
      if (memberError) throw memberError;
      if (!member || member.role !== "owner") {
        setAccess("forbidden");
        setBusiness(null);
        setSales([]);
        setItems([]);
        setDocuments([]);
        return;
      }

      const { data: businessRow, error: businessError } = await supabase
        .from("fiskalo_basic_businesses")
        .select("id,name,nui")
        .eq("id", member.business_id)
        .single();
      if (businessError) throw businessError;

      const range = localDateRangeToIso(startDate, endDate);
      const { data: reportData, error: reportError } = await supabase.rpc("fiskalo_basic_sales_report", {
        p_business_id: businessRow.id,
        p_from: range.from,
        p_to: range.to,
        p_limit: MAX_SALES,
      });
      if (reportError) throw reportError;
      const payload = (reportData ?? {}) as {
        sales?: ReportSale[];
        items?: ReportSaleItem[];
        documents?: ReportFiscalDocument[];
        truncated?: boolean;
      };
      const saleRows = Array.isArray(payload.sales) ? payload.sales : [];
      const itemRows = Array.isArray(payload.items) ? payload.items : [];
      const documentRows = Array.isArray(payload.documents) ? payload.documents : [];
      setBusiness(businessRow as Business);
      setSales(saleRows);
      setItems(itemRows);
      setDocuments(documentRows);
      setTruncated(!!payload.truncated);
      setAccess("owner");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Raporti nuk u ngarkua.");
    } finally {
      setBusy(false);
    }
  }, [supabase, startDate, endDate]);

  useEffect(() => {
    void loadReport();
  }, [loadReport]);

  const report = useMemo(
    () => buildSalesReport(sales, items, documents),
    [sales, items, documents],
  );

  const exportCsv = useCallback(() => {
    if (!sales.length) return;
    const csv = buildSalesReportCsv(sales, items, documents);
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "fiskalo-raporti-i-shitjeve-" + startDate + "-deri-" + endDate + ".csv";
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, [sales, items, documents, startDate, endDate]);

  if (access === "unconfigured") {
    return <main className="shell"><header className="topbar"><a className="brand" href="/">fiskalo<span>.</span></a></header><section className="panel"><h1>Konfigurimi kërkohet</h1><p className="sub">Supabase nuk është konfiguruar në këtë mjedis.</p></section></main>;
  }
  if (access === "signed_out") {
    return <main className="shell"><header className="topbar"><a className="brand" href="/">fiskalo<span>.</span></a></header><section className="panel"><h1>Hyr në llogari</h1><p className="sub">Hyr në panelin e Fiskalo dhe hape përsëri raportin.</p><a className="btn" href="/">Shko te hyrja</a></section></main>;
  }
  if (access === "forbidden") {
    return <main className="shell"><header className="topbar"><a className="brand" href="/">fiskalo<span>.</span></a></header><section className="panel"><h1>Qasje e kufizuar</h1><p className="sub">Raportet financiare janë të disponueshme vetëm për pronarin e biznesit.</p><a className="btn secondary" href="/">Kthehu në panel</a></section></main>;
  }

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <a className="brand" href="/">fiskalo<span>.</span></a>
          {business && <span className="eyebrow">{business.name} · NUI {business.nui}</span>}
        </div>
        <a className="btn secondary" href="/">Kthehu në panel</a>
      </header>

      <div className="eyebrow">RAPORTET E BIZNESIT</div>
      <h1>Raportet e shitjeve dhe TVSH-së.</h1>
      <p className="sub">Regjistër menaxherial i shitjeve, pagesave, TVSH-së dhe statusit të fiskalizimit për periudhën e zgjedhur.</p>

      <section className="panel" style={{ marginTop: 16 }}>
        <form className="row" style={{ alignItems: "end", flexWrap: "wrap" }} onSubmit={event => { event.preventDefault(); void loadReport(); }}>
          <div className="field" style={{ minWidth: 170, margin: 0 }}>
            <label htmlFor="report-start">Nga data</label>
            <input id="report-start" type="date" required value={startDate} onChange={event => setStartDate(event.target.value)} />
          </div>
          <div className="field" style={{ minWidth: 170, margin: 0 }}>
            <label htmlFor="report-end">Deri më</label>
            <input id="report-end" type="date" required value={endDate} onChange={event => setEndDate(event.target.value)} />
          </div>
          <button className="btn" disabled={busy}>{busy ? "Duke ngarkuar…" : "Apliko periudhën"}</button>
          <button type="button" className="btn secondary" disabled={busy || !sales.length} onClick={exportCsv}>Eksporto CSV</button>
        </form>
        {message && <p className="notice" role="alert" style={{ marginBottom: 0 }}>{message}</p>}
        {truncated && <p className="notice" role="status" style={{ marginBottom: 0 }}>Ky raport përfshin maksimumi 20,000 shitje. Ngushto periudhën për të marrë një eksport të plotë.</p>}
      </section>

      <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(160px,1fr))", marginTop: 16 }}>
        <div className="stat-card"><span className="eyebrow">Shitje</span><strong className="stat">{report.count}</strong></div>
        <div className="stat-card"><span className="eyebrow">Neto</span><strong className="stat">{formatMoney(report.netCents)}</strong></div>
        <div className="stat-card"><span className="eyebrow">TVSH</span><strong className="stat">{formatMoney(report.vatCents)}</strong></div>
        <div className="stat-card"><span className="eyebrow">Bruto</span><strong className="stat">{formatMoney(report.grossCents)}</strong></div>
        <div className="stat-card"><span className="eyebrow">Mesatarja / shitje</span><strong className="stat">{formatMoney(report.averageCents)}</strong></div>
      </div>

      <section className="panel" style={{ marginTop: 16 }}>
        <h2>Statusi i fiskalizimit</h2>
        <p className="sub">Një shitje numërohet si e pranuar vetëm kur dokumenti ka statusin accepted dhe një transaction ID pozitiv të ruajtur.</p>
        <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(140px,1fr))" }}>
          <div className="stat-card"><span className="eyebrow">Pranuar nga ATK</span><strong className="stat">{report.acceptedCount}</strong></div>
          <div className="stat-card"><span className="eyebrow">Në radhë</span><strong className="stat">{report.queuedCount}</strong></div>
          <div className="stat-card"><span className="eyebrow">Refuzuar</span><strong className="stat">{report.rejectedCount}</strong></div>
          <div className="stat-card"><span className="eyebrow">Reconciliim</span><strong className="stat">{report.reconciliationCount}</strong></div>
          <div className="stat-card"><span className="eyebrow">Pa konfirmim</span><strong className="stat">{report.unconfirmedCount}</strong></div>
        </div>
      </section>

      <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(280px,1fr))", marginTop: 16 }}>
        <section className="panel">
          <h2>Pagesat sipas metodës</h2>
          {report.payments.length === 0 ? <p className="sub">Nuk ka shitje në këtë periudhë.</p> : <div style={{ overflowX: "auto" }}>
            <table style={tableStyle()}>
              <thead><tr><th style={headerCell}>Metoda</th><th style={headerCell}>Shitje</th><th style={{ ...headerCell, textAlign: "right" }}>Shuma</th></tr></thead>
              <tbody>{report.payments.map(row => <tr key={row.method}><td style={bodyCell}>{row.label}</td><td style={bodyCell}>{row.count}</td><td style={{ ...bodyCell, textAlign: "right", whiteSpace: "nowrap" }}>{formatMoney(row.amountCents)}</td></tr>)}</tbody>
            </table>
          </div>}
        </section>
        <section className="panel">
          <h2>TVSH sipas kodit ATK</h2>
          {report.vatGroups.length === 0 ? <p className="sub">Nuk ka ndarje të artikujve për këtë periudhë.</p> : <div style={{ overflowX: "auto" }}>
            <table style={tableStyle()}>
              <thead><tr><th style={headerCell}>Kodi</th><th style={headerCell}>Norma</th><th style={{ ...headerCell, textAlign: "right" }}>Baza</th><th style={{ ...headerCell, textAlign: "right" }}>TVSH</th></tr></thead>
              <tbody>{report.vatGroups.map(row => <tr key={row.code + ":" + row.rate}><td style={bodyCell}>{row.code}</td><td style={bodyCell}>{row.rate}%</td><td style={{ ...bodyCell, textAlign: "right", whiteSpace: "nowrap" }}>{formatMoney(row.netCents)}</td><td style={{ ...bodyCell, textAlign: "right", whiteSpace: "nowrap" }}>{formatMoney(row.vatCents)}</td></tr>)}</tbody>
            </table>
          </div>}
        </section>
      </div>

      <section className="panel" style={{ marginTop: 16 }}>
        <h2>Qarkullimi ditor</h2>
        {report.days.length === 0 ? <p className="sub">Nuk ka shitje në këtë periudhë.</p> : <div style={{ overflowX: "auto" }}>
          <table style={tableStyle()}>
            <thead><tr><th style={headerCell}>Data (Kosovë)</th><th style={headerCell}>Shitje</th><th style={{ ...headerCell, textAlign: "right" }}>Qarkullimi bruto</th></tr></thead>
            <tbody>{report.days.map(row => <tr key={row.date}><td style={bodyCell}>{row.date}</td><td style={bodyCell}>{row.count}</td><td style={{ ...bodyCell, textAlign: "right", whiteSpace: "nowrap" }}>{formatMoney(row.grossCents)}</td></tr>)}</tbody>
          </table>
        </div>}
      </section>

      <p className="footer">Ky është raport menaxherial i gjeneruar nga regjistrat e Fiskalo. Nuk është deklaratë zyrtare e ATK-së dhe nuk zëvendëson dorëzimet ose raportet e kërkuara në EDI.</p>
    </main>
  );
}
