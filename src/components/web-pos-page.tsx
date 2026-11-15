"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { submitPaidInvoiceToATK } from "@/lib/atk/submit-paid-invoice";
import { FiscalQrCode } from "@/components/fiscal-qr-code";
import { ThermalPrinterSettings } from "@/components/thermal-printer-settings";
import { printWithAgent, readPrinterSettings } from "@/lib/printing/thermal-printer-client";
import { readAtkVerificationNo } from "@/lib/printing/escpos";
import { ensureATKTestPosReady } from "@/lib/atk/ensure-test-pos-ready";
import { deleteOfflinePosDraft, listOfflinePosDrafts, saveOfflinePosDraft, type OfflinePosDraft } from "@/lib/pos/offline-drafts";
import { ArrowRight, FileText, Plus, RefreshCw, Search, Settings2, ShoppingCart } from "lucide-react";

type Product = { id: string; name: string; sku: string | null; pos_category: string; image_url: string | null; unit_price: number; vat_rate: number; stock_quantity: number; track_stock: boolean; item_type: string; is_active: boolean; atk_unit_code: string | null; atk_tax_code: string | null; atk_item_category_code: string | null };
type Customer = { id: string; name: string; phone: string | null };
type InvoiceRow = { id: string; invoice_number: string | null; issue_date: string; status: string; payment_status: string; payment_method: string; total: number; customer_id: string | null; atk_test_status?: string | null };
type CartLine = { productId: string; quantity: string };

const panel: React.CSSProperties = { background: "white", border: "1px solid var(--line)", borderRadius: 14, padding: 16 };
const field: React.CSSProperties = { width: "100%", minWidth: 0, border: "1px solid var(--line)", borderRadius: 9, padding: "11px 12px", background: "white", color: "var(--ink)" };
const button: React.CSSProperties = { border: 0, borderRadius: 9, padding: "12px 15px", background: "var(--brand)", color: "white", fontWeight: 750, cursor: "pointer" };
const secondary: React.CSSProperties = { border: "1px solid var(--line)", borderRadius: 9, padding: "10px 12px", background: "white", color: "var(--ink)", fontWeight: 650, cursor: "pointer" };
const money = (n: number) => new Intl.NumberFormat("sq-XK", { style: "currency", currency: "EUR" }).format(n);
const createPosRequestId = () => { if (typeof crypto.randomUUID === "function") return crypto.randomUUID(); const bytes = crypto.getRandomValues(new Uint8Array(16)); bytes[6] = (bytes[6] & 0x0f) | 0x40; bytes[8] = (bytes[8] & 0x3f) | 0x80; const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(""); return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`; };
const roundMoney = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const CATEGORY_VISUALS: Record<string, { icon: string; label: string }> = { TT: { icon: "▦", label: "Mallra" } };
const categoryVisual = (code: string) => CATEGORY_VISUALS[code] ?? { icon: "◇", label: "Artikull" };

export function WebPosPage({ basicMode = false }: { basicMode?: boolean } = {}) {
  const params = useParams<{ organizationId: string }>();
  const organizationId = params.organizationId;
  const supabase = useMemo(() => createClient(), []);
  const [products, setProducts] = useState<Product[]>([]);
  const [invoices, setInvoices] = useState<InvoiceRow[]>([]);
  const [activeView, setActiveView] = useState<"pos" | "invoices">("pos");
  const [invoiceSearch, setInvoiceSearch] = useState("");
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [customerId, setCustomerId] = useState("");
  const [paymentMethod, setPaymentMethod] = useState("cash");
  const [discountPercent, setDiscountPercent] = useState("0");
  const [confirmedPayment, setConfirmedPayment] = useState(false);
  const [atkSetupNotice, setAtkSetupNotice] = useState("Duke kontrolluar qasjen në arkë…");
  const [isManagement, setIsManagement] = useState(false);
  const atkAutoInitRef = useRef(false);
  const [search, setSearch] = useState("");
  const [activeCategory, setActiveCategory] = useState("Të gjitha");
  const searchRef = useRef<HTMLInputElement>(null);
  const [loading, setLoading] = useState(true);
  const [userRole, setUserRole] = useState<string>("");
  const [activeShiftId, setActiveShiftId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [issuedInvoiceId, setIssuedInvoiceId] = useState("");
  const [issuedNumber, setIssuedNumber] = useState("");
  const [issuedQrPayload, setIssuedQrPayload] = useState("");
  const [issuedFiscalStatus, setIssuedFiscalStatus] = useState("");
  const [offlineDrafts, setOfflineDrafts] = useState<OfflinePosDraft[]>([]);
  const [restoredDraftId, setRestoredDraftId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const { data: currentAuth } = await supabase.auth.getUser();
    const [productResult, customerResult, invoiceResult, membershipResult, shiftResult] = await Promise.all([
      supabase.from("fiskalo_products").select("id,name,sku,pos_category,image_url,unit_price,vat_rate,stock_quantity,track_stock,item_type,is_active,atk_unit_code,atk_tax_code,atk_item_category_code").eq("organization_id", organizationId).eq("is_active", true).order("name"),
      supabase.from("fiskalo_customers").select("id,name,phone").eq("organization_id", organizationId).order("name"),
      supabase.from("fiskalo_invoices").select("id,invoice_number,issue_date,status,payment_status,payment_method,total,customer_id").eq("organization_id", organizationId).order("created_at", { ascending: false }).limit(100),
      supabase.from("fiskalo_organization_users").select("role").eq("organization_id", organizationId).eq("user_id", currentAuth.user?.id ?? "").maybeSingle(),
      currentAuth.user
        ? supabase.from("fiskalo_cashier_shifts").select("id").eq("organization_id", organizationId).eq("opened_by", currentAuth.user.id).eq("status", "open").maybeSingle()
        : Promise.resolve({ data: null, error: null }),
    ]);
    if (productResult.error || customerResult.error || invoiceResult.error) setError("Nuk u ngarkuan të gjitha të dhënat. Rifresko faqen ose kontrollo qasjen në biznes.");
    setUserRole(membershipResult.data?.role ?? "");
    setActiveShiftId(shiftResult.data?.id ?? null);
    if (shiftResult.error) setError("Nuk u verifikua ndërrimi i arkës. Rifresko faqen para shitjes.");
    setProducts((productResult.data ?? []) as Product[]);
    setCustomers((customerResult.data ?? []) as Customer[]);
    const invoiceRows = (invoiceResult.data ?? []) as InvoiceRow[];
    const invoiceIds = invoiceRows.map((row) => row.id);
    const fiscalResult = invoiceIds.length
      ? await supabase.from("fiskalo_atk_fiscal_documents").select("source_invoice_id,status,created_at").eq("organization_id", organizationId).in("source_invoice_id", invoiceIds).order("created_at", { ascending: false })
      : { data: [], error: null };
    const latestFiscalStatus = new Map<string, string>();
    for (const doc of (fiscalResult.data ?? []) as Array<{ source_invoice_id: string | null; status: string }>) {
      if (doc.source_invoice_id && !latestFiscalStatus.has(doc.source_invoice_id)) latestFiscalStatus.set(doc.source_invoice_id, doc.status);
    }
    setInvoices(invoiceRows.map((row) => ({ ...row, atk_test_status: latestFiscalStatus.get(row.id) ?? null })));
    setLoading(false);
  }, [organizationId, supabase]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    let active = true;
    void listOfflinePosDrafts(organizationId).then((drafts) => { if (active) setOfflineDrafts(drafts); }).catch(() => {
      if (active) setError("Ruajtja e porosive lokale nuk është e disponueshme në këtë shfletues.");
    });
    return () => { active = false; };
  }, [organizationId]);

  useEffect(() => {
    if (!userRole || !["owner", "administrator"].includes(userRole) || atkAutoInitRef.current) return;
    atkAutoInitRef.current = true;
    let cancelled = false;
    void (async () => {
      const { data: auth } = await supabase.auth.getUser();
      if (!auth.user) {
        if (!cancelled) setAtkSetupNotice("Sesioni ka skaduar. Hyr përsëri.");
        return;
      }
      const { data: membership, error: membershipError } = await supabase
        .from("fiskalo_organization_users")
        .select("role")
        .eq("organization_id", organizationId)
        .eq("user_id", auth.user.id)
        .maybeSingle();
      if (membershipError || !membership) {
        if (!cancelled) setAtkSetupNotice("Nuk u verifikua qasja në këtë biznes.");
        return;
      }
      const management = ["owner", "administrator"].includes(String(membership.role));
      if (!cancelled) setIsManagement(management);
      if (!management) {
        if (!cancelled) setAtkSetupNotice("Arka është gati për shitje. Konfigurimi fiskal menaxhohet nga pronari ose administratori.");
        return;
      }
      try {
        const result = await ensureATKTestPosReady(supabase, organizationId);
        if (!cancelled) setAtkSetupNotice(result.message);
      } catch (error) {
        if (!cancelled) setAtkSetupNotice(error instanceof Error ? error.message : "Konfigurimi automatik ATK TEST dështoi.");
      }
    })();
    return () => { cancelled = true; };
  }, [organizationId, supabase, userRole]);

  const visibleInvoices = invoices.filter((invoice) => `${invoice.invoice_number ?? ""} ${invoice.status} ${invoice.payment_status} ${invoice.issue_date}`.toLocaleLowerCase().includes(invoiceSearch.trim().toLocaleLowerCase()));
  const categories = ["Të gjitha", ...Array.from(new Set(products.map((product) => (product.pos_category || "Tjera").trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b, "sq"))];
  const selectedCategory = categories.includes(activeCategory) ? activeCategory : "Të gjitha";
  const visibleProducts = products.filter((product) => {
    const q = search.trim().toLocaleLowerCase();
    const matchesCategory = selectedCategory === "Të gjitha" || (product.pos_category || "Tjera") === selectedCategory;
    const matchesSearch = !q || product.name.toLocaleLowerCase().includes(q) || (product.sku ?? "").toLocaleLowerCase().includes(q);
    return matchesCategory && matchesSearch;
  });
  const appliedDiscountPercent = Number.isFinite(Number(discountPercent)) ? Math.min(99.99, Math.max(0, Number(discountPercent))) : 0;
  const lines = cart.map((line) => {
    const product = products.find((item) => item.id === line.productId);
    const quantity = Number(line.quantity);
    const lineSubtotal = product && Number.isFinite(quantity) ? roundMoney(Number(product.unit_price) * quantity * (100 - appliedDiscountPercent) / 100) : 0;
    const lineVat = product && Number.isFinite(quantity) ? roundMoney(Number(product.unit_price) * quantity * (100 - appliedDiscountPercent) / 100 * Number(product.vat_rate) / 100) : 0;
    return { ...line, product, quantity, lineSubtotal, lineVat, lineTotal: lineSubtotal + lineVat };
  }).filter((line) => line.product);
  const subtotal = roundMoney(lines.reduce((sum, line) => sum + line.lineSubtotal, 0));
  const vatTotal = roundMoney(lines.reduce((sum, line) => sum + line.lineVat, 0));
  const total = roundMoney(subtotal + vatTotal);
  const grossSubtotal = roundMoney(lines.reduce((sum, line) => sum + (line.product ? roundMoney(Number(line.product.unit_price) * line.quantity) : 0), 0));
  const grossVatTotal = roundMoney(lines.reduce((sum, line) => sum + (line.product ? roundMoney(Number(line.product.unit_price) * line.quantity * Number(line.product.vat_rate) / 100) : 0), 0));
  const discountTotal = roundMoney(grossSubtotal + grossVatTotal - total);

  function addProduct(product: Product) {
    setCart((current) => {
      const existing = current.find((line) => line.productId === product.id);
      if (existing) return current.map((line) => line.productId === product.id ? { ...line, quantity: String(Number(line.quantity) + 1) } : line);
      return [...current, { productId: product.id, quantity: "1" }];
    });
    setNotice(""); setError("");
  }

  function updateQuantity(productId: string, quantity: string) {
    setCart((current) => current.map((line) => line.productId === productId ? { ...line, quantity } : line));
  }

  async function saveCurrentOrderDraft() {
    if (!cart.length) { setError("Shporta është bosh."); return; }
    try {
      const draft: OfflinePosDraft = {
        id: restoredDraftId ?? createPosRequestId(),
        organizationId,
        createdAt: new Date().toISOString(),
        cart: cart.map((line) => ({ ...line })),
        customerId,
        paymentMethod,
        discountPercent: Number(discountPercent) || 0,
      };
      await saveOfflinePosDraft(draft);
      setOfflineDrafts(await listOfflinePosDrafts(organizationId));
      const safeRequestId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(draft.id) ? draft.id : createPosRequestId();
    if (safeRequestId !== draft.id) {
      const migratedDraft = { ...draft, id: safeRequestId };
      void saveOfflinePosDraft(migratedDraft).then(() => deleteOfflinePosDraft(draft.id)).then(() => listOfflinePosDrafts(organizationId).then(setOfflineDrafts));
    }
    setRestoredDraftId(safeRequestId);
      setNotice("Porosia u ruajt në këtë pajisje si draft. Nuk u krijua faturë, nuk u regjistrua pagesë dhe nuk u dërgua asgjë në ATK.");
      setError("");
    } catch (draftError) {
      setError(draftError instanceof Error ? draftError.message : "Porosia nuk u ruajt lokalisht.");
    }
  }

  function restoreOrderDraft(draft: OfflinePosDraft) {
    const missing = draft.cart.filter((line) => !products.some((product) => product.id === line.productId));
    if (missing.length) {
      setError("Disa produkte të këtij drafti nuk janë në katalogun aktual. Lidhu me internetin dhe rifresko produktet para rikthimit.");
      return;
    }
    setCart(draft.cart.map((line) => ({ ...line })));
    setCustomerId(draft.customerId);
    setPaymentMethod(draft.paymentMethod);
    setDiscountPercent(String(draft.discountPercent ?? 0));
    setConfirmedPayment(false);
    setRestoredDraftId(draft.id);
    setActiveView("pos");
    setError("");
    setNotice("Drafti u rikthye në shportë. Kontrollo çmimet, stokun dhe pagesën para se të lëshosh faturën.");
  }

  async function removeOrderDraft(id: string) {
    try {
      await deleteOfflinePosDraft(id);
      setOfflineDrafts(await listOfflinePosDrafts(organizationId));
      if (restoredDraftId === id) setRestoredDraftId(null);
    } catch (draftError) {
      setError(draftError instanceof Error ? draftError.message : "Drafti nuk u fshi.");
    }
  }

  function handleProductSearchKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Enter") return;
    event.preventDefault();
    const code = search.trim().toLocaleLowerCase();
    if (!code) return;
    const exact = products.find((product) => product.is_active && (product.sku ?? "").trim().toLocaleLowerCase() === code);
    if (!exact) {
      setError("Nuk u gjet produkt me këtë barkod ose SKU. Kontrollo kodin ose kërko produktin me emër.");
      return;
    }
    addProduct(exact);
    setSearch("");
    requestAnimationFrame(() => searchRef.current?.focus());
  }

  async function completeSale() {
    setError(""); setNotice(""); setIssuedInvoiceId(""); setIssuedNumber(""); setIssuedQrPayload(""); setIssuedFiscalStatus("");
    const valid = lines.filter((line) => Number.isFinite(line.quantity) && line.quantity > 0);
    if (!valid.length || valid.length !== lines.length) { setError("Shto artikuj dhe kontrollo sasitë."); return; }
    if (!Number.isFinite(Number(discountPercent)) || Number(discountPercent) < 0 || Number(discountPercent) > 99.99) { setError("Zbritja duhet të jetë nga 0% deri në 99.99%."); return; }
    if (paymentMethod !== "credit") {
      const unmapped = valid.filter(({ product }) =>
        !product!.atk_unit_code?.trim() ||
        !/^[A-Z]$/.test(product!.atk_tax_code?.trim() ?? "") ||
        (Number(product!.vat_rate) === 8 && product!.atk_tax_code !== "D") ||
        (Number(product!.vat_rate) === 18 && product!.atk_tax_code !== "E") ||
        (Number(product!.vat_rate) === 0 && !["A", "C"].includes(product!.atk_tax_code ?? "")) ||
        !product!.atk_item_category_code?.trim()
      );
      if (unmapped.length) {
        setError("Fatura nuk u krijua. Për dërgim automatik në ATK, plotëso kodet fiskale zyrtare për: " +
          unmapped.map(({ product }) => product!.name).join(", ") +
          ". Hape Produktet dhe shërbimet dhe plotëso njësinë, kodin e TVSH-së dhe kategorinë ATK.");
        return;
      }
    }
    if (paymentMethod !== "credit" && !confirmedPayment) { setError("Konfirmo që pagesa është pranuar para se ta regjistrosh si të paguar."); return; }
    if (paymentMethod === "cash" && !activeShiftId) { setError("Hap fillimisht ndërrimin e arkës. Pagesat me para në dorë duhet të lidhen me një arkë aktive."); return; }
    for (const line of valid) {
      if (line.product!.track_stock && line.quantity > Number(line.product!.stock_quantity)) {
        setError("Stoku i pamjaftueshëm për: " + line.product!.name + ". Ndrysho sasinë ose rifresko produktet.");
        return;
      }
    }

    setBusy(true);
    const requestId = restoredDraftId ?? createPosRequestId();
    const pendingDraft: OfflinePosDraft = {
      id: requestId,
      organizationId,
      createdAt: new Date().toISOString(),
      cart: valid.map((line) => ({ productId: line.productId, quantity: String(line.quantity) })),
      customerId,
      paymentMethod,
      discountPercent: appliedDiscountPercent,
    };
    try {
      await saveOfflinePosDraft(pendingDraft);
      setOfflineDrafts(await listOfflinePosDrafts(organizationId));
      setRestoredDraftId(requestId);
    } catch (draftError) {
      setBusy(false);
      setError("Shitja nuk u dërgua sepse porosia nuk u ruajt në mënyrë të sigurt në këtë pajisje: " +
        (draftError instanceof Error ? draftError.message : "Gabim i ruajtjes lokale."));
      return;
    }

    const { data: saleRows, error: saleError } = await supabase.rpc("fiskalo_create_pos_sale", {
      target_org: organizationId,
      request_id: requestId,
      target_customer: customerId || null,
      target_payment_method: paymentMethod,
      sale_items: valid.map((line) => ({ product_id: line.productId, quantity: line.quantity })),
      target_discount_percent: appliedDiscountPercent,
    });
    const sale = Array.isArray(saleRows) ? saleRows[0] : saleRows;
    if (saleError || !sale?.invoice_id) {
      setBusy(false);
      setError("Rezultati i shitjes nuk u konfirmua. Drafti dhe ID-ja e kërkesës u ruajtën; provo përsëri pa krijuar shitje të re. " +
        (saleError?.message ?? "Përgjigje e pavlefshme nga serveri."));
      return;
    }
    const invoiceId = String(sale.invoice_id);
    const invoiceNumber = sale.invoice_number;
    const issuedInvoice = { total: Number(sale.invoice_total) };
    const { data: persistedItems, error: persistedItemsError } = await supabase.from("fiskalo_invoice_items")
      .select("description,quantity,unit_price,vat_rate,line_subtotal,line_vat,discount_percent").eq("invoice_id", invoiceId).order("id");
    if (persistedItemsError || !persistedItems?.length) {
      setBusy(false);
      setIssuedInvoiceId(invoiceId);
      setIssuedNumber(String(invoiceNumber ?? ""));
      setError("Shitja u regjistrua, por artikujt e faturës nuk u lexuan. Drafti lokal mbetet për rikuperim; mos krijo shitje të re.");
      return;
    }
    const { data: savedInvoiceDiscount } = await supabase.from("fiskalo_invoices").select("discount_total").eq("id", invoiceId).maybeSingle();
    const receiptDiscountTotal = Number(savedInvoiceDiscount?.discount_total ?? discountTotal);
    const receiptLines = persistedItems.map((item) => ({
      name: item.description,
      quantity: Number(item.quantity),
      unitPrice: Number(item.unit_price) * (100 - Number(item.discount_percent ?? appliedDiscountPercent)) / 100,
      vatRate: Number(item.vat_rate),
      lineTotal: Number(item.line_subtotal) + Number(item.line_vat),
    }));
    const receiptSubtotal = persistedItems.reduce((sum, item) => sum + Number(item.line_subtotal), 0);
    const receiptVatTotal = persistedItems.reduce((sum, item) => sum + Number(item.line_vat), 0);
    setIssuedInvoiceId(invoiceId);
    setIssuedNumber(String(invoiceNumber ?? ""));
    let fiscalNotice = "";
    let receiptQrPayload = "";
    let receiptFiscalStatus = "";
    if (paymentMethod !== "credit") {
      try {
        const fiscalResult = await submitPaidInvoiceToATK(supabase, organizationId, invoiceId);
        fiscalNotice = " " + fiscalResult.message;
        setIssuedFiscalStatus(fiscalResult.status);
        if (fiscalResult.qrPayload) { receiptQrPayload = fiscalResult.qrPayload; setIssuedQrPayload(fiscalResult.qrPayload); }
        receiptFiscalStatus = fiscalResult.status;
      } catch (fiscalError) {
        fiscalNotice = " Pagesa u ruajt, por dërgimi automatik në ATK nuk u përfundua: " +
          (fiscalError instanceof Error ? fiscalError.message : "Gabim i panjohur.") +
          " Kontrollo statusin e faturës para çdo prove tjetër.";
        const { data: fiscalDocument } = await supabase.from("fiskalo_atk_fiscal_documents")
          .select("qr_payload,status").eq("organization_id", organizationId)
          .eq("source_invoice_id", invoiceId).maybeSingle();
        if (typeof fiscalDocument?.qr_payload === "string") { receiptQrPayload = fiscalDocument.qr_payload; setIssuedQrPayload(fiscalDocument.qr_payload); }
        if (typeof fiscalDocument?.status === "string") { receiptFiscalStatus = fiscalDocument.status; setIssuedFiscalStatus(fiscalDocument.status); }
      }
    }
    let receiptFiscalDocument: {
      qr_payload: string | null; status: string; coupon_id: number;
      pos_installation_id: string; document_type: string; pos_coupon_base64: string | null;
    } | null = null;
    let receiptPos: { atk_branch_id: number; pos_id: number; environment: string } | null = null;
    if (paymentMethod !== "credit") {
      const { data: fiscalDocument } = await supabase.from("fiskalo_atk_fiscal_documents")
        .select("qr_payload,status,coupon_id,pos_installation_id,document_type,pos_coupon_base64")
        .eq("organization_id", organizationId).eq("source_invoice_id", invoiceId).maybeSingle();
      receiptFiscalDocument = fiscalDocument;
      if (typeof fiscalDocument?.qr_payload === "string") {
        receiptQrPayload = fiscalDocument.qr_payload;
        setIssuedQrPayload(fiscalDocument.qr_payload);
      }
      if (typeof fiscalDocument?.status === "string") {
        receiptFiscalStatus = fiscalDocument.status;
        setIssuedFiscalStatus(fiscalDocument.status);
      }
      if (fiscalDocument?.pos_installation_id) {
        const { data: posDetails } = await supabase.from("fiskalo_atk_pos_installations")
          .select("atk_branch_id,pos_id,environment")
          .eq("id", fiscalDocument.pos_installation_id).eq("organization_id", organizationId).maybeSingle();
        receiptPos = posDetails;
      }
    }
    if (paymentMethod !== "credit") {
      const printerSettings = readPrinterSettings();
      if (printerSettings.autoPrint && (receiptFiscalStatus !== "accepted" || !receiptQrPayload)) {
        fiscalNotice += " Printimi automatik u ndal: kuponi nuk ka QR me status të pranuar nga ATK TEST. Nuk u printua si kupon fiskal.";
      } else if (printerSettings.autoPrint) {
        try {
          const { data: business } = await supabase.from("fiskalo_organizations")
            .select("legal_name,trade_name,nui,fiscal_number,vat_registered,address,municipality,phone")
            .eq("id", organizationId).maybeSingle();
          const { data: operatorAuth } = await supabase.auth.getUser();
          const operatorMetadata = operatorAuth.user?.user_metadata ?? {};
          const operatorName = typeof operatorMetadata.full_name === "string" ? operatorMetadata.full_name
            : typeof operatorMetadata.name === "string" ? operatorMetadata.name
            : operatorAuth.user?.email ?? null;
          const receiptTaxGroups = [0, 8, 18].map((rate) => ({
            rate,
            net: persistedItems.filter((item) => Number(item.vat_rate) === rate)
              .reduce((sum, item) => sum + Number(item.line_subtotal), 0),
            tax: persistedItems.filter((item) => Number(item.vat_rate) === rate)
              .reduce((sum, item) => sum + Number(item.line_vat), 0),
          })).filter((group) => group.net !== 0 || group.tax !== 0);
          await printWithAgent({
            businessName: business?.trade_name || business?.legal_name || "Biznesi",
            nui: business?.nui ?? null,
            fiscalNumber: business?.fiscal_number ?? null,
            vatNumber: business?.vat_registered ? business?.fiscal_number ?? null : null,
            unitNumber: receiptPos?.atk_branch_id ?? null,
            posId: receiptPos?.pos_id ?? null,
            sefIdentifier: receiptPos && business?.nui
              ? String(receiptPos.atk_branch_id) + "-" + String(business.nui) + "-" + String(receiptPos.pos_id)
              : null,
            couponId: receiptFiscalDocument?.coupon_id ?? null,
            verificationNo: readAtkVerificationNo(receiptFiscalDocument?.pos_coupon_base64),
            couponType: receiptFiscalDocument?.document_type === "sale" ? "SHITJE"
              : receiptFiscalDocument?.document_type === "cancel" ? "ANULIM"
              : receiptFiscalDocument?.document_type === "return" ? "KTHIM" : null,
            operatorName,
            operatorId: operatorAuth.user?.id ?? null,
            isTest: receiptPos?.environment === "test",
            taxGroups: receiptTaxGroups,
            address: business?.address ?? null,
            municipality: business?.municipality ?? null,
            phone: business?.phone ?? null,
            invoiceNumber: String(invoiceNumber ?? ""),
            issuedAt: new Date().toLocaleString("sq-XK"),
            paymentMethod: paymentMethod === "cash" ? "PARA NE DORE" : paymentMethod === "card" ? "KARTELE" : "TRANSFER BANKAR",
            items: receiptLines,
            subtotal: receiptSubtotal,
            vatTotal: receiptVatTotal,
            total: Number(issuedInvoice.total),
            discountTotal: receiptDiscountTotal,
            qrPayload: receiptQrPayload,
            fiscalStatus: receiptFiscalStatus,
            paperWidthMm: printerSettings.paperWidthMm,
          }, printerSettings);
          fiscalNotice += " Kuponi u dërgua te printeri.";
        } catch (printError) {
          fiscalNotice += " Shitja u ruajt, por printimi dështoi: " +
            (printError instanceof Error ? printError.message : "Gabim i panjohur.");
        }
      }
    }
    setNotice(paymentMethod === "credit"
      ? "Fatura u lëshua. Pagesa mbeti e papaguar."
      : "Shitja u regjistrua dhe pagesa u shënua si e pranuar." + fiscalNotice);
    const fiscalConfirmed = paymentMethod === "credit" || (receiptFiscalStatus === "accepted" && Boolean(receiptQrPayload));
    if (fiscalConfirmed) {
      try { await deleteOfflinePosDraft(requestId); setOfflineDrafts(await listOfflinePosDrafts(organizationId)); }
      catch { setNotice((current) => current + " Kujdes: drafti lokal mbeti i ruajtur; fshije vetëm pasi ta verifikosh faturën."); }
      setRestoredDraftId(null);
      setCart([]);
      setCustomerId("");
      setPaymentMethod("cash");
      setDiscountPercent("0");
      setDiscountPercent("0");
      setConfirmedPayment(false);
    } else {
      setNotice((current) => current + " Porosia mbetet e ruajtur në këtë pajisje me të njëjtën ID. Kontrollo statusin ATK dhe provo përsëri; nuk krijohet faturë e re.");
    }
    setBusy(false);
    await load();
  }

  if (loading) return <main style={{ maxWidth: 1200, margin: "0 auto", padding: 24 }}>Duke hapur POS...</main>;
  if (userRole === "accountant") return <main style={{ maxWidth: 720, margin: "40px auto", padding: 24 }}><h1>Qasje vetëm për lexim financiar</h1><p style={{ color: "var(--muted)", lineHeight: 1.6 }}>Roli Kontabilist mund t’i kontrollojë faturat dhe të dhënat financiare, por nuk mund të përdorë arkën e shitjeve.</p><Link href={`/app/${organizationId}/invoices`} style={{ color: "var(--brand)", fontWeight: 750 }}>Hap faturat</Link></main>;

  return <main className="fiskalo-pos hybrid-pos" style={{ maxWidth: 1440, margin: "0 auto", padding: "22px clamp(12px,3vw,28px) 50px" }}>
    <nav aria-label="Versioni i Fiskalo" className="no-print" style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
      <Link href={`/app/${organizationId}`} aria-current={!basicMode ? "page" : undefined} style={{ border: "1px solid var(--line)", borderRadius: 9, padding: "10px 12px", color: "var(--ink)", textDecoration: "none", fontWeight: 650 }}>Versioni aktual</Link>
      <Link href={`/app/${organizationId}/basic`} aria-current={basicMode ? "page" : undefined} style={{ borderRadius: 9, padding: "10px 12px", background: basicMode ? "var(--brand)" : "transparent", color: basicMode ? "white" : "var(--ink)", border: "1px solid var(--line)", textDecoration: "none", fontWeight: 750 }}>Fiskalo Basic MVP</Link>
    </nav>
    <header className="hybrid-pos-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 18 }}>
      <div><span className="pos-kicker">{basicMode ? "FISKALO BASIC / MVP" : "KASA / SHITJE E SHPEJTË"}</span><h1 style={{ margin: "8px 0 0", fontSize: 28 }}>{basicMode ? "Fiskalo Basic MVP" : "Pika e shitjes"}</h1><div className="pos-header-subtitle" style={{ color: "var(--muted)", fontSize: 13 }}>{basicMode ? "Version i thjeshtuar për shitje, pagesë, kupon ATK TEST dhe fatura." : "Zgjidh produktet me një prekje. Shporta dhe pagesa përditësohen automatikisht."}</div></div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}><Link href={`/app/${organizationId}/pos/shifts`} style={{ ...secondary, textDecoration: "none" }}>Ndërrimi i arkës</Link>{["owner", "administrator", "manager"].includes(userRole) && <Link href={`/app/${organizationId}/pos/products`} style={{ ...secondary, textDecoration: "none" }}>Produktet</Link>}{isManagement && <Link href={`/app/${organizationId}/pos/setup`} style={{ ...secondary, textDecoration: "none" }}><Settings2 size={15} /> Konfiguro ATK</Link>}
        {userRole !== "cashier" && <Link href={`/app/${organizationId}`} style={{ ...secondary, textDecoration: "none" }}>Paneli i biznesit</Link>}<button style={secondary} onClick={() => void load()}><RefreshCw size={15} /> Rifresko</button></div>
    </header>
    <ThermalPrinterSettings />
    <div role="status" style={{ marginBottom: 12, border: "1px solid var(--line)", borderRadius: 10, padding: "10px 12px", color: "var(--muted)", fontSize: 13 }}>{["owner", "administrator"].includes(userRole) ? atkSetupNotice : "Arka është gati për përdorim. Konfigurimi dhe certifikata ATK TEST menaxhohen nga pronari ose administratori."}</div>
    {!activeShiftId && <div role="status" style={{ marginBottom: 12, border: "1px solid #e8c98d", background: "#fff9ed", borderRadius: 10, padding: 13, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}><div><strong>Hape ndërrimin para pagesave me para në dorë</strong><div style={{ fontSize: 12, marginTop: 3 }}>Kjo lidh çdo pagesë me arkën e arkëtarit dhe mundëson barazimin e saktë në fund të ndërrimit.</div></div><Link href={`/app/${organizationId}/pos/shifts`} style={{ ...button, textDecoration: "none" }}>Hap arkën</Link></div>}
    <nav className="pos-mode-tabs" aria-label="POS dhe faturat" style={{ display: "flex", gap: 8, marginBottom: 14, borderBottom: "1px solid var(--line)", paddingBottom: 10 }}><button aria-pressed={activeView === "pos"} onClick={() => setActiveView("pos")} style={{ ...(activeView === "pos" ? button : secondary) }}><ShoppingCart size={15} /> Shitje</button><button aria-pressed={activeView === "invoices"} onClick={() => setActiveView("invoices")} style={{ ...(activeView === "invoices" ? button : secondary) }}><FileText size={15} /> Faturat <span className="status-pill">{invoices.length}</span></button></nav>
    {offlineDrafts.length > 0 && <section style={{ ...panel, marginBottom: 14, borderColor: "#d8c49a" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <div><strong>Porositë e ruajtura në këtë pajisje</strong><div style={{ color: "var(--muted)", fontSize: 12 }}>Draftet ruhen lokalisht në shfletues dhe mund të rikthehen pas rilidhjes.</div></div>
        <span className="status-pill">{offlineDrafts.length} draft(e)</span>
      </div>
      <div style={{ display: "grid", gap: 8, marginTop: 10 }}>
        {offlineDrafts.map((draft) => <div key={draft.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap", paddingTop: 8, borderTop: "1px solid var(--line)" }}>
          <div><strong>{draft.cart.length} artikuj</strong><div style={{ color: "var(--muted)", fontSize: 11 }}>{new Date(draft.createdAt).toLocaleString("sq-XK")} · {draft.paymentMethod === "credit" ? "Me afat" : draft.paymentMethod === "cash" ? "Para në dorë" : draft.paymentMethod}</div></div>
          <div style={{ display: "flex", gap: 7 }}><button type="button" style={secondary} onClick={() => restoreOrderDraft(draft)}>Rikthe në shportë</button><button type="button" style={{ ...secondary, color: "#982d25" }} onClick={() => void removeOrderDraft(draft.id)}>Fshije</button></div>
        </div>)}
      </div>
      <p style={{ color: "#8a5a18", fontSize: 11, margin: "10px 0 0" }}>Këto janë vetëm draftet e porosive. Nuk janë fatura, pagesa të regjistruara ose kuponë fiskalë. Fiskalizimi kërkon lidhje aktive dhe konfirmim nga ATK.</p>
    </section>}

    {error && <div role="alert" style={{ background: "#fff0ef", color: "#982d25", padding: 12, borderRadius: 9, marginBottom: 12 }}>{error}</div>}
    {notice && <div role="status" style={{ background: "#edf7f1", color: "#155c3c", padding: 12, borderRadius: 9, marginBottom: 12 }}>{notice}</div>}
    {issuedInvoiceId && <div style={{ ...panel, marginBottom: 12, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
      <div><strong>{issuedNumber ? "Fatura " + issuedNumber : "Draft i ruajtur"}</strong><div style={{ color: "var(--muted)", fontSize: 12, marginTop: 3 }}>{"Kontrollo statusin e pagesës dhe fiskalizimit."}</div></div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Link href={`/app/${organizationId}/invoices/${issuedInvoiceId}`} style={{ color: "var(--brand)", fontWeight: 750, alignSelf: "center" }}>Hap faturën →</Link>
      </div>
      {issuedQrPayload && <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, flexWrap: "wrap", borderTop: "1px solid var(--line)", marginTop: 12, paddingTop: 14 }}>
        <div style={{ flex: "1 1 220px" }}>
          <strong>Kodi QR i kuponit</strong>
          <p style={{ color: "var(--muted)", fontSize: 12, lineHeight: 1.5, margin: "5px 0" }}>Klienti mund ta skanojë për të verifikuar të dhënat e nënshkruara të kuponit në sistemin e ATK-së.</p>
          <span className="status-pill">{issuedFiscalStatus === "accepted" ? "Pranuar nga ATK TEST" : "ATK TEST · " + (issuedFiscalStatus || "në pritje")}</span>
          <p style={{ color: "#9a3412", fontSize: 11, margin: "7px 0 0" }}>Kupon prove — nuk është kupon fiskal për përdorim në prodhim.</p>
        </div>
        <FiscalQrCode payload={issuedQrPayload} size={156} label="Kodi QR i kuponit fiskal TEST" />
      </div>}
    </div>}
    <div className="pos-layout" style={{ display: activeView === "pos" ? "grid" : "none", gridTemplateColumns: "minmax(0,1.55fr) minmax(310px,0.85fr)", gap: 14, alignItems: "start" }}>
      <section className="pos-catalog-panel" style={panel}>
        <div className="pos-catalog-heading"><div><span className="pos-kicker">MENUJA</span><h2>Çfarë po porosit klienti?</h2><p>Prek një produkt për ta shtuar në shportë</p></div><span className="pos-live-count">{visibleProducts.length} produkte</span></div>
        <input className="pos-search-input" ref={searchRef} aria-label="Kërko produkt ose skano barkod" placeholder="Kërko produkt ose skano barkod / SKU..." value={search} onChange={(event) => { setSearch(event.target.value); setError(""); }} onKeyDown={handleProductSearchKeyDown} style={{ ...field, marginBottom: 12 }} />
        <div className="pos-categories" aria-label="Kategoritë e produkteve">{categories.map((category) => <button key={category} type="button" aria-pressed={selectedCategory === category} onClick={() => setActiveCategory(category)} className={selectedCategory === category ? "pos-category active" : "pos-category"}>{category}</button>)}</div>
        <div className="pos-product-grid">
          {visibleProducts.map((product) => <button key={product.id} type="button" onClick={() => addProduct(product)} className="pos-product-card">
            <div className="pos-product-image" aria-label={product.name}>{product.image_url ? <img src={product.image_url} alt="" loading="lazy" /> : <span className="pos-product-placeholder">{categoryVisual(product.atk_item_category_code || product.pos_category || "TT").icon}</span>}<span className="pos-product-add"><Plus size={17}/></span></div>
            <span className="pos-product-category-code">{categoryVisual(product.atk_item_category_code || product.pos_category || "TT").label}</span>
            <span className="pos-product-name">{product.name}</span>
            <span className="pos-product-price">{money(Number(product.unit_price) * (1 + Number(product.vat_rate) / 100))}</span>
            <small className="pos-product-stock">{product.track_stock ? (product.stock_quantity > 0 ? "Në stok · " + product.stock_quantity : "Pa stok") : "Gati për porosi"}</small>
          </button>)}
          {!visibleProducts.length && <p style={{ color: "var(--muted)" }}>Nuk u gjetën produkte aktive.</p>}
        </div>
      </section>
      <aside className="pos-cart-panel" style={{ ...panel, position: "sticky", top: 12 }}>
        <div className="pos-cart-heading"><div><span className="pos-kicker">POROSIA AKTUALE</span><h2><ShoppingCart size={19} /> Shporta</h2></div><span className="pos-cart-count">{lines.length} artikuj</span></div>
        <div style={{ display: "grid", gap: 10, maxHeight: "42vh", overflowY: "auto" }}>
          {lines.map((line) => <div key={line.productId} style={{ borderBottom: "1px solid var(--line)", paddingBottom: 9 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}><strong>{line.product!.name}</strong><strong>{money(line.lineTotal)}</strong></div>
            <div className="pos-quantity-stepper">
              <button type="button" aria-label={"Zvogëlo " + line.product!.name} style={secondary} onClick={() => line.quantity <= 1 ? setCart((current) => current.filter((row) => row.productId !== line.productId)) : updateQuantity(line.productId, String(line.quantity - 1))}>−</button>
              <strong>{line.quantity}</strong>
              <button type="button" aria-label={"Shto " + line.product!.name} style={secondary} onClick={() => updateQuantity(line.productId, String(line.quantity + 1))}>+</button>
              <button type="button" style={{ ...secondary, marginLeft: "auto" }} onClick={() => setCart((current) => current.filter((row) => row.productId !== line.productId))}>Hiq</button>
            </div>
          </div>)}
          {!lines.length && <p className="cart-empty" style={{ color: "var(--muted)", textAlign: "center", padding: 20 }}>Shporta është bosh.<br/>Zgjidh produktet për të filluar.</p>}
        </div>
        <div className="pos-cart-summary" style={{ borderTop: "1px solid var(--line)", marginTop: 12, paddingTop: 12, display: "grid", gap: 8 }}>
          <div style={{ display: "flex", justifyContent: "space-between" }}><span>Baza tatimore pas zbritjes</span><strong>{money(subtotal)}</strong></div>
          <div style={{ display: "flex", justifyContent: "space-between" }}><span>TVSH</span><strong>{money(vatTotal)}</strong></div>
          <label style={{ display: "grid", gap: 5, fontSize: 12, fontWeight: 650 }}>Zbritja tregtare (%)
            <input type="number" min="0" max="99.99" step="0.01" inputMode="decimal" value={discountPercent} onChange={(event) => setDiscountPercent(event.target.value)} style={field} aria-label="Zbritja tregtare në përqindje" />
            <span style={{ color: "var(--muted)", fontWeight: 400 }}>Aplikohet në të gjithë artikujt para llogaritjes së TVSH-së.</span>
          </label>
          {appliedDiscountPercent > 0 && <div style={{ display: "flex", justifyContent: "space-between", color: "#16734a" }}><span>Zbritja e dhënë ({appliedDiscountPercent.toFixed(2)}%)</span><strong>−{money(discountTotal)}</strong></div>}
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 20 }}><strong>Totali për pagesë</strong><strong>{money(total)}</strong></div>
          <label style={{ display: "grid", gap: 5, fontSize: 12, fontWeight: 650 }}>Klienti
            <select value={customerId} onChange={(event) => setCustomerId(event.target.value)} style={field}><option value="">Klient pa emër</option>{customers.map((customer) => <option key={customer.id} value={customer.id}>{customer.name}{customer.phone ? " · " + customer.phone : ""}</option>)}</select>
          </label>
          <label style={{ display: "grid", gap: 5, fontSize: 12, fontWeight: 650 }}>Mënyra e pagesës
            <select value={paymentMethod} onChange={(event) => { setPaymentMethod(event.target.value); setConfirmedPayment(false); }} style={field}>
              <option value="cash">Para në dorë</option><option value="card">Kartelë (e pranuar manualisht)</option><option value="bank_transfer">Transfer bankar (i konfirmuar)</option><option value="credit">Me afat — pa pagesë</option>
            </select>
          </label>
          
          {paymentMethod !== "credit" && <label style={{ display: "flex", alignItems: "start", gap: 8, fontSize: 12, lineHeight: 1.4 }}>
            <input type="checkbox" checked={confirmedPayment} onChange={(event) => setConfirmedPayment(event.target.checked)} style={{ marginTop: 2 }} />
            Konfirmoj se pagesa është pranuar. Fiskalo nuk proceson pagesa me kartelë.
          </label>}
          <button disabled={busy || !cart.length} onClick={() => void saveCurrentOrderDraft()} style={{ ...secondary, width: "100%" }}>Ruaj porosinë në këtë pajisje</button>
          <button className="pos-checkout-button" disabled={busy || !lines.length} onClick={() => void completeSale()} style={{ ...button, width: "100%", opacity: busy || !lines.length ? 0.55 : 1 }}>{busy ? "Duke regjistruar..." : paymentMethod === "credit" ? "Lësho faturën" : "Përfundo shitjen · " + money(total)}</button>
          <button disabled={busy || !cart.length} onClick={() => { setCart([]); setDiscountPercent("0"); setConfirmedPayment(false); }} style={{ ...secondary, width: "100%" }}>Pastro shportën</button>
        </div>
      </aside>
    </div>
    <p style={{ display: activeView === "pos" ? "block" : "none", color: "var(--muted)", fontSize: 11, lineHeight: 1.5, marginTop: 14 }}>Shitjet regjistrohen në arkë. Pas pagesës së plotë, Fiskalo tenton dërgimin automatik në ATK TEST. Pagesat me kartelë nuk procesohen nga aplikacioni.</p>
    <section style={{ display: activeView === "invoices" ? "block" : "none", ...panel }}><div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 14 }}><div><h2 style={{ margin: 0, fontSize: 20 }}>Faturat</h2><p style={{ margin: "4px 0 0", color: "var(--muted)", fontSize: 12 }}>Shitjet e regjistruara së fundmi</p></div><button onClick={() => setActiveView("pos")} style={button}><Plus size={16} /> Shitje e re</button></div><div style={{ display: "flex", gap: 8, marginBottom: 12 }}><div style={{ position: "relative", flex: 1, maxWidth: 360 }}><Search size={16} style={{ position: "absolute", left: 12, top: 13, color: "var(--muted)" }} /><input className="invoice-search" aria-label="Kërko faturë" value={invoiceSearch} onChange={(e) => setInvoiceSearch(e.target.value)} placeholder="Kërko sipas numrit ose statusit..." style={{ ...field, paddingLeft: 36 }} /></div></div><div style={{ overflowX: "auto" }}><table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}><thead><tr><th style={{ textAlign: "left", padding: 9 }}>Numri</th><th style={{ textAlign: "left", padding: 9 }}>Data</th><th style={{ textAlign: "left", padding: 9 }}>Statusi</th><th style={{ textAlign: "left", padding: 9 }}>Fiskalizimi ATK</th><th style={{ textAlign: "right", padding: 9 }}>Totali</th><th style={{ textAlign: "right", padding: 9 }}> </th></tr></thead><tbody>{visibleInvoices.map((invoice) => <tr key={invoice.id} style={{ borderTop: "1px solid var(--line)" }}><td style={{ padding: 9 }}>{invoice.invoice_number || "Draft"}</td><td style={{ padding: 9 }}>{invoice.issue_date}</td><td style={{ padding: 9 }}><span className={"status-pill " + (invoice.status === "draft" ? "" : invoice.payment_status === "paid" ? "paid" : "unpaid")}>{invoice.status === "draft" ? "Draft" : invoice.payment_status === "paid" ? "Paguar" : "E papaguar"}</span></td><td style={{ padding: 9 }}>{invoice.atk_test_status ? <span className={"status-pill " + (invoice.atk_test_status === "accepted" ? "accepted" : invoice.atk_test_status === "rejected" ? "rejected" : invoice.atk_test_status === "queued" || invoice.atk_test_status === "offline_pending" ? "queued" : "")}>{({ queued: "Në radhë", submitted: "Dërguar", accepted: "Pranuar", rejected: "Refuzuar", offline_pending: "Në pritje", draft: "Draft" } as Record<string,string>)[invoice.atk_test_status] || invoice.atk_test_status}</span> : <span style={{ color: "var(--muted)", fontSize: 12 }}>{invoice.payment_status === "paid" ? "Dërgimi nuk u krye" : "Pas pagesës"}</span>}</td><td style={{ padding: 9, textAlign: "right", fontWeight: 700 }}>{money(Number(invoice.total))}</td><td style={{ padding: 9, textAlign: "right", whiteSpace: "nowrap" }}><Link href={`/app/${organizationId}/invoices/${invoice.id}`} style={{ color: "var(--brand)", fontWeight: 700 }}>Hap <ArrowRight size={14} /></Link></td></tr>)}{!visibleInvoices.length && <tr><td colSpan={6} style={{ padding: 18, color: "var(--muted)", textAlign: "center" }}>Nuk ka fatura ende. Krijo shitjen e parë nga POS.</td></tr>}</tbody></table></div></section>
    <style jsx>{`
      .pos-layout { grid-template-columns: minmax(0,1.55fr) minmax(340px,.85fr); gap:18px !important; }
      .pos-layout > section, .pos-layout > aside { border-radius:18px !important; box-shadow:0 5px 22px rgba(21,48,33,.045); }
      .pos-categories { display:flex; gap:8px; overflow-x:auto; padding:3px 0 16px; scrollbar-width:thin; }
      .pos-category { flex:0 0 auto; min-height:42px; border:1px solid var(--line); border-radius:999px; padding:9px 16px; background:#fff; color:var(--muted); font-size:13px; font-weight:750; cursor:pointer; transition:background .15s ease,color .15s ease,border-color .15s ease,transform .15s ease; }
      .pos-category:hover { border-color:#a8cbb7; color:var(--brand-dark); background:#f7fbf8; }
      .pos-category.active { background:var(--brand); color:#fff; border-color:var(--brand); box-shadow:0 4px 10px rgba(19,122,85,.16); }
      .pos-product-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(155px,1fr)); gap:13px; }
      .pos-product-card { overflow:hidden; border:1px solid var(--line); border-radius:16px; padding:0 0 13px; background:#fff; color:var(--ink); text-align:left; display:flex; flex-direction:column; gap:7px; cursor:pointer; min-width:0; transition:transform .16s ease,border-color .16s ease,box-shadow .16s ease; }
      .pos-product-card:hover { transform:translateY(-2px); border-color:#b8d4c3; box-shadow:0 9px 22px rgba(21,48,33,.09); }
      .pos-product-card:active { transform:scale(.985); }
      .pos-product-card:focus-visible { outline:3px solid rgba(19,122,85,.28); outline-offset:3px; }
      .pos-product-image { width:100%; aspect-ratio:1.45 / 1; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:4px; background:linear-gradient(145deg,#f5f8f5,#edf3ef); color:#527b64; }
      .pos-product-placeholder { font-size:48px; line-height:1; font-weight:800; }
      .pos-product-category-code { color:#698273; font-size:10px; font-weight:800; letter-spacing:1px; }
      .pos-product-name { font-size:13px; line-height:1.35; font-weight:780; padding:0 12px; min-height:35px; }
      .pos-product-price { color:var(--brand-dark); font-size:17px; letter-spacing:-.3px; font-weight:900; padding:0 12px; font-variant-numeric:tabular-nums; }
      .pos-product-card small { color:var(--muted); padding:0 12px; font-size:11px; }
      .pos-quantity-stepper { display:flex; align-items:center; gap:8px; margin-top:8px; }
      .pos-quantity-stepper button { min-width:40px; min-height:40px; font-size:18px; padding:6px 10px; border-radius:11px !important; }
      .pos-quantity-stepper strong { min-width:24px; text-align:center; font-variant-numeric:tabular-nums; }
      .pos-layout aside h2 { letter-spacing:-.45px; }
      .pos-layout aside select { min-height:44px; border-radius:11px !important; }
      .pos-layout aside button[disabled] { cursor:not-allowed; }
      .fiskalo-pos input, .fiskalo-pos select { transition:border-color .15s ease,box-shadow .15s ease; }
      .fiskalo-pos input:focus, .fiskalo-pos select:focus { border-color:#8bbba0 !important; box-shadow:0 0 0 3px rgba(19,122,85,.09); outline:none; }
      @media (max-width:760px) {
        .pos-layout { grid-template-columns:minmax(0,1fr) !important; gap:12px !important; }
        .pos-layout > section, .pos-layout > aside { padding:14px !important; }
        .pos-layout aside { position:static !important; }
        .pos-product-grid { grid-template-columns:repeat(2,minmax(0,1fr)); gap:10px; }
        .pos-product-card { border-radius:14px; }
        .pos-product-name { font-size:12px; min-height:32px; }
        .pos-product-price { font-size:16px; }
        .pos-category { min-height:40px; padding:8px 13px; }
      }
      @media (min-width:761px) and (max-width:1050px) {
        .pos-layout { grid-template-columns:minmax(0,1.2fr) minmax(300px,.9fr) !important; }
        .pos-product-grid { grid-template-columns:repeat(2,minmax(0,1fr)); }
      }
      @media (prefers-reduced-motion:reduce) {
        .pos-product-card,.pos-category,.fiskalo-pos input,.fiskalo-pos select { transition:none !important; }
        .pos-product-card:hover { transform:none; }
      }

      /* Full-screen quick-service POS: split menu + persistent order rail */
      .fiskalo-pos.hybrid-pos {
        --pos-yellow:#ffc928; --pos-red:#c91525; --pos-ink:#171717;
        max-width:none !important; min-height:100vh; padding:18px clamp(14px,2.5vw,36px) 28px !important;
        background:#fff !important; color:var(--pos-ink) !important;
      }
      .fiskalo-pos .pos-layout {
        display:grid !important; grid-template-columns:minmax(0,1fr) minmax(320px,370px) !important;
        gap:clamp(18px,2.5vw,36px) !important; align-items:stretch !important;
        min-height:calc(100vh - 170px);
      }
      .fiskalo-pos .pos-layout > .pos-catalog-panel {
        border:0 !important; border-radius:0 !important; box-shadow:none !important;
        padding:clamp(10px,2vw,28px) !important; background:#fff !important; min-width:0;
      }
      .fiskalo-pos .pos-catalog-heading { display:flex; justify-content:space-between; align-items:end; gap:16px; margin:8px 0 24px; }
      .fiskalo-pos .pos-catalog-heading h2 { font-size:clamp(30px,4vw,48px) !important; line-height:1.05; letter-spacing:-1.8px; color:#111; margin:12px 0 8px; }
      .fiskalo-pos .pos-catalog-heading p { color:#777; font-size:15px; margin:0; }
      .fiskalo-pos .pos-kicker { color:#9a7614 !important; font-size:11px; letter-spacing:1.7px; font-weight:900; }
      .fiskalo-pos .pos-search-input { max-width:560px; min-height:50px; border-radius:999px !important; padding:0 20px !important; background:#f6f6f6 !important; border:1px solid #ededed !important; }
      .fiskalo-pos .pos-categories { gap:10px; padding:12px 0 20px; }
      .fiskalo-pos .pos-category { min-height:44px; border:0 !important; border-radius:14px !important; background:#f4f4f4 !important; color:#252525 !important; padding:11px 18px !important; font-weight:800; }
      .fiskalo-pos .pos-category.active { background:var(--pos-red) !important; color:#fff !important; box-shadow:none !important; }
      .fiskalo-pos .pos-product-grid { grid-template-columns:repeat(auto-fill,minmax(165px,1fr)) !important; gap:16px !important; }
      .fiskalo-pos .pos-product-card { border:0 !important; border-radius:18px !important; padding:0 0 15px !important; background:#f7f7f7 !important; text-align:center !important; align-items:center; gap:7px !important; }
      .fiskalo-pos .pos-product-card:hover { background:#fff8e5 !important; border:0 !important; box-shadow:0 8px 24px #00000012 !important; transform:translateY(-3px); }
      .fiskalo-pos .pos-product-image { aspect-ratio:1.55/1; width:100%; background:transparent !important; color:#d6a900 !important; position:relative; }
      .fiskalo-pos .pos-product-image img { width:100%; height:100%; object-fit:contain; padding:12px; }
      .fiskalo-pos .pos-product-add { display:none; }
      .fiskalo-pos .pos-product-category-code { display:none; }
      .fiskalo-pos .pos-product-name { font-size:15px !important; min-height:unset !important; padding:0 10px !important; color:#151515; font-weight:850 !important; }
      .fiskalo-pos .pos-product-price { color:#b38a00 !important; font-size:18px !important; padding:0 !important; }
      .fiskalo-pos .pos-product-stock { padding:0 8px !important; }
      .fiskalo-pos .pos-layout > .pos-cart-panel {
        position:sticky !important; top:12px !important; align-self:stretch; min-height:calc(100vh - 190px);
        border:0 !important; border-left:1px solid #ededed !important; border-radius:0 !important;
        box-shadow:none !important; padding:24px 20px !important; background:#fbfbfb !important;
        display:flex; flex-direction:column;
      }
      .fiskalo-pos .pos-cart-heading { padding-bottom:20px; border-bottom:1px solid #e9e9e9; }
      .fiskalo-pos .pos-cart-heading h2 { font-size:25px !important; color:#111; margin:8px 0 0; }
      .fiskalo-pos .pos-cart-count { background:#fff0bd; color:#5e4700; border-radius:999px; padding:6px 10px; font-weight:800; }
      .fiskalo-pos .pos-layout aside > div:nth-child(2) { flex:1; max-height:none !important; overflow:auto; padding:14px 0; }
      .fiskalo-pos .pos-quantity-stepper { justify-content:center; }
      .fiskalo-pos .pos-quantity-stepper button { border:1px solid #e5e5e5 !important; border-radius:999px !important; background:#fff !important; color:#222 !important; min-width:38px; min-height:36px; }
      .fiskalo-pos .pos-quantity-stepper button:nth-of-type(2) { background:var(--pos-yellow) !important; border-color:var(--pos-yellow) !important; }
      .fiskalo-pos .pos-cart-summary { margin-top:auto !important; padding-top:18px !important; }
      .fiskalo-pos .pos-cart-summary > div:nth-last-of-type(1) { font-size:24px !important; padding:12px 0; }
      .fiskalo-pos .pos-cart-summary label { margin-top:7px; }
      .fiskalo-pos .pos-cart-summary input,.fiskalo-pos .pos-cart-summary select { min-height:44px; border-radius:12px !important; }
      .fiskalo-pos .pos-checkout-button { min-height:72px; border-radius:22px !important; background:var(--pos-yellow) !important; color:#151515 !important; font-size:20px !important; font-weight:900 !important; box-shadow:none !important; }
      .fiskalo-pos .pos-mode-tabs { border:0 !important; }
      .fiskalo-pos .pos-mode-tabs button { border-radius:999px !important; }
      @media(max-width:760px) {
        .fiskalo-pos.hybrid-pos { padding:10px 10px 20px !important; }
        .fiskalo-pos .pos-layout { grid-template-columns:minmax(0,1fr) !important; min-height:0; }
        .fiskalo-pos .pos-layout > .pos-cart-panel { position:relative !important; top:auto !important; min-height:0; border:1px solid #eee !important; border-radius:20px !important; padding:18px !important; }
        .fiskalo-pos .pos-catalog-heading { margin:8px 0 16px; }
        .fiskalo-pos .pos-catalog-heading h2 { font-size:32px !important; }
        .fiskalo-pos .pos-product-grid { grid-template-columns:repeat(2,minmax(0,1fr)) !important; gap:10px !important; }
        .fiskalo-pos .pos-product-card { border-radius:15px !important; }
        .fiskalo-pos .pos-product-image { aspect-ratio:1.3/1; }
      }
    `}</style>
  </main>;
}

