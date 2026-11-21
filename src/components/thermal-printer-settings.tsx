"use client";

import { useEffect, useState } from "react";
import {
  defaultPrinterSettings, loadAgentPrinters, pairAgent, readPrinterSettings,
  savePrinterSettings, testAgentPrinter, getAgentToken,
  type AgentPrinter, type PrinterSettings,
} from "@/lib/printing/thermal-printer-client";

const card: React.CSSProperties = { border: "1px solid var(--line)", borderRadius: 12, background: "white", padding: 14, display: "grid", gap: 10 };
const field: React.CSSProperties = { width: "100%", minWidth: 0, border: "1px solid var(--line)", borderRadius: 8, padding: "9px 10px", background: "white", color: "var(--ink)" };
const action: React.CSSProperties = { border: "1px solid var(--line)", borderRadius: 8, padding: "9px 12px", background: "white", color: "var(--ink)", fontWeight: 700, cursor: "pointer" };

export function ThermalPrinterSettings() {
  const [settings, setSettings] = useState<PrinterSettings>(defaultPrinterSettings);
  const [pairingCode, setPairingCode] = useState("");
  const [printers, setPrinters] = useState<AgentPrinter[]>([]);
  const [paired, setPaired] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    const saved = readPrinterSettings();
    setSettings(saved);
    setPaired(Boolean(getAgentToken()));
    if (getAgentToken()) void refreshPrinters();
  }, []);

  function update(next: Partial<PrinterSettings>) {
    setSettings((current) => {
      const value = { ...current, ...next };
      savePrinterSettings(value);
      return value;
    });
  }

  async function refreshPrinters() {
    setBusy(true); setMessage("");
    try {
      const result = await loadAgentPrinters();
      setPrinters(result.printers || []);
      setPaired(true);
      setMessage("POS Agent u lidh. U gjetën " + (result.printers?.length ?? 0) + " printerë të instaluar.");
    } catch (error) {
      setPaired(Boolean(getAgentToken()));
      setMessage(error instanceof Error ? error.message : "Printerët nuk u lexuan.");
    } finally { setBusy(false); }
  }

  async function connect() {
    setBusy(true); setMessage("");
    try {
      await pairAgent(pairingCode);
      setPairingCode("");
      setPaired(true);
      const result = await loadAgentPrinters();
      setPrinters(result.printers || []);
      setMessage("POS Agent u çiftua me sukses.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Çiftimi dështoi.");
    } finally { setBusy(false); }
  }

  async function test() {
    setBusy(true); setMessage("");
    try {
      await testAgentPrinter(settings);
      setMessage("Testi u dërgua. Kontrollo printerin; ky nuk është kupon fiskal.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Test-printimi dështoi.");
    } finally { setBusy(false); }
  }

  return <section style={card} aria-label="Konfigurimi i printerit">
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
      <div><strong>Printeri termik</strong><div style={{ color: "var(--muted)", fontSize: 12, marginTop: 3 }}>58 mm / 80 mm · USB, Bluetooth përmes Windows, ose LAN</div></div>
      <span className="status-pill">{paired ? "Agjenti i lidhur" : "Agjenti nuk është lidhur"}</span>
    </div>
    {!paired ? <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      <input aria-label="Kodi njëpërdorimësh i çiftimit" placeholder="Kodi i çiftimit nga Fiskalo POS Agent" value={pairingCode} onChange={(event) => setPairingCode(event.target.value)} style={{ ...field, flex: "1 1 240px" }} />
      <button type="button" disabled={busy || !pairingCode.trim()} onClick={() => void connect()} style={action}>{busy ? "Duke u lidhur..." : "Lidhe agjentin"}</button>
    </div> : <>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(170px,1fr))", gap: 9 }}>
        <label style={{ display: "grid", gap: 5, fontSize: 12, fontWeight: 650 }}>Lloji i lidhjes
          <select value={settings.target} onChange={(event) => update({ target: event.target.value as PrinterSettings["target"] })} style={field}>
            <option value="windows">USB / Bluetooth / printer Windows</option><option value="lan">Printer në rrjet (LAN)</option>
          </select>
        </label>
        <label style={{ display: "grid", gap: 5, fontSize: 12, fontWeight: 650 }}>Gjerësia e letrës
          <select value={settings.paperWidthMm} onChange={(event) => update({ paperWidthMm: Number(event.target.value) as 58 | 80 })} style={field}>
            <option value={58}>58 mm</option><option value={80}>80 mm</option>
          </select>
        </label>
      </div>
      {settings.target === "windows" ? <label style={{ display: "grid", gap: 5, fontSize: 12, fontWeight: 650 }}>Printer i instaluar në Windows
        <select value={settings.printerName} onChange={(event) => update({ printerName: event.target.value })} style={field}>
          <option value="">Zgjidh printerin</option>{printers.map((printer) => <option key={printer.name} value={printer.name}>{printer.name}</option>)}
        </select>
      </label> : <label style={{ display: "grid", gap: 5, fontSize: 12, fontWeight: 650 }}>IP private e printerit (porti 9100)
        <input value={settings.networkHost} onChange={(event) => update({ networkHost: event.target.value.trim() })} placeholder="192.168.1.50" style={field} />
      </label>}
      <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>
        <input type="checkbox" checked={settings.autoPrint} onChange={(event) => update({ autoPrint: event.target.checked })} />
        Printo automatikisht pas shitjes së paguar
      </label>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button type="button" disabled={busy} onClick={() => void refreshPrinters()} style={action}>Rifresko printerët</button>
        <button type="button" disabled={busy || (settings.target === "windows" ? !settings.printerName : !settings.networkHost)} onClick={() => void test()} style={{ ...action, background: "var(--brand)", color: "white", borderColor: "var(--brand)" }}>{busy ? "Duke testuar..." : "Printo testin"}</button>
      </div>
    </>}
    {message && <p role="status" style={{ margin: 0, color: "var(--muted)", fontSize: 12, lineHeight: 1.5 }}>{message}</p>}
    <p style={{ margin: 0, color: "var(--muted)", fontSize: 11, lineHeight: 1.5 }}>Për USB/Bluetooth në Windows, instalo printerin në Windows fillimisht. Për LAN përdor IP-në private të printerit. Ky konfigurim nuk certifikon fiskalizimin ATK.</p>
  </section>;
}
