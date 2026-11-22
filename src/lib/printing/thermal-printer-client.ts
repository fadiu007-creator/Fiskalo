import { buildEscPosReceipt, bytesToBase64, type ReceiptPrintData } from "./escpos";

const AGENT = "http://127.0.0.1:17843";
const TOKEN_KEY = "fiskalo-pos-agent-token";
const SETTINGS_KEY = "fiskalo-printer-settings";

export type PrinterSettings = {
  target: "windows" | "lan";
  printerName: string;
  networkHost: string;
  paperWidthMm: 58 | 80;
  autoPrint: boolean;
};

export type AgentPrinter = { name: string; isDefault: boolean; isNetwork: boolean };

export const defaultPrinterSettings: PrinterSettings = {
  target: "windows", printerName: "", networkHost: "", paperWidthMm: 80, autoPrint: false,
};

export function readPrinterSettings(): PrinterSettings {
  if (typeof window === "undefined") return defaultPrinterSettings;
  try {
    return { ...defaultPrinterSettings, ...JSON.parse(window.localStorage.getItem(SETTINGS_KEY) || "{}") };
  } catch { return defaultPrinterSettings; }
}

export function savePrinterSettings(settings: PrinterSettings) {
  if (typeof window !== "undefined") window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

export function getAgentToken() {
  return typeof window === "undefined" ? "" : window.sessionStorage.getItem(TOKEN_KEY) || "";
}

async function agentRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getAgentToken();
  if (!token) throw new Error("Lidhe fillimisht Fiskalo POS Agent me kodin e çiftimit.");
  let response: Response;
  try {
    response = await fetch(AGENT + path, {
      ...init,
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + token, ...(init.headers || {}) },
      cache: "no-store",
    });
  } catch {
    throw new Error("Fiskalo POS Agent nuk u gjet. Nise aplikacionin lokal në Windows dhe provo përsëri.");
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.detail || body.message || body.error || "Gabim nga printeri (HTTP " + response.status + ").");
  }
  return response.json() as Promise<T>;
}

export async function pairAgent(pairingCode: string) {
  let response: Response;
  try {
    response = await fetch(AGENT + "/api/v1/pair", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pairingCode: pairingCode.trim() }), cache: "no-store",
    });
  } catch {
    throw new Error("Nuk u lidh me POS Agent. Kontrollo që aplikacioni lokal është i hapur.");
  }
  if (!response.ok) throw new Error(response.status === 409 ? "Agjenti është çiftuar tashmë. Rinis POS Agent për kod të ri." : "Kodi i çiftimit nuk është i saktë ose ka skaduar.");
  const result = await response.json() as { sessionToken: string };
  window.sessionStorage.setItem(TOKEN_KEY, result.sessionToken);
  return result;
}

export async function loadAgentPrinters() {
  return agentRequest<{ printers: AgentPrinter[]; networkPrinting: boolean; networkPort: number }>("/api/v1/printers");
}

export async function testAgentPrinter(settings: PrinterSettings) {
  return agentRequest<{ printed: boolean; testOnly: boolean }>("/api/v1/printers/test", {
    method: "POST",
    body: JSON.stringify({
      printerName: settings.target === "windows" ? settings.printerName : null,
      networkHost: settings.target === "lan" ? settings.networkHost : null,
      paperWidthMm: settings.paperWidthMm,
    }),
  });
}

export async function printWithAgent(receipt: ReceiptPrintData, settings = readPrinterSettings()) {
  const dataBase64 = bytesToBase64(buildEscPosReceipt(receipt));
  return agentRequest<{ printed: boolean; transport: string }>("/api/v1/printers/print", {
    method: "POST",
    body: JSON.stringify({
      printerName: settings.target === "windows" ? settings.printerName : null,
      networkHost: settings.target === "lan" ? settings.networkHost : null,
      dataBase64,
    }),
  });
}
