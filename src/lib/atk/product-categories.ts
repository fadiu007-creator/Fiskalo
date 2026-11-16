// Official ATK item/service categories from the May 2026 Specific Technical
// and Functional Requirements for PEF/FS/EFS, Annex "Kategoritë e mallrave dhe shërbimeve".
// The June 2026 amendment does not replace this annex. Preserve all 53 published rows.
// The ATK PDF repeats code PM for two labels; retain both rows and combine their UI label.
export const ATK_ITEM_CATEGORY_SOURCE = {
  title: "Kërkesat specifike teknike dhe funksionale për PEF/SF/SEF",
  publishedOn: "2026-05-29",
  amendmentPublishedOn: "2026-06-22",
  url: "https://apps.atk-ks.org/sefaplikimi/uploads/documents/150ab6cc-084f-490d-b5fc-d8639d0287dc.pdf",
  amendmentUrl: "https://apps.atk-ks.org/sefaplikimi/uploads/documents/4994a4cd-75c8-46fd-bb7c-d541e4aa0e40.pdf",
} as const;

export const ATK_ITEM_CATEGORIES = [
  { code: "TT", label: "Të tjera" },
  { code: "UR", label: "Ushqime restoranti" },
  { code: "AU", label: "Artikuj ushqimorë" },
  { code: "VM", label: "Veshmbathje" },
  { code: "KO", label: "Kozmetikë" },
  { code: "AP", label: "Autopjesë" },
  { code: "BM", label: "Barna mjekësore" },
  { code: "PM", label: "Pajisje mjekësore" },
  { code: "PP", label: "Pemë dhe perime" },
  { code: "PE", label: "Pajisje elektronike" },
  { code: "PS", label: "Pajisje shtëpiake" },
  { code: "PB", label: "Pajisje bujqësore" },
  { code: "BB", label: "Barna bujqësore" },
  { code: "KB", label: "Karburante" },
  { code: "EE", label: "Energji elektrike" },
  { code: "PSE", label: "Pajisje speciale elektrike" },
  { code: "SM", label: "Shërbime mjekësore" },
  { code: "SJ", label: "Shërbime juridike" },
  { code: "ST", label: "Shërbime të tjera" },
  { code: "SK", label: "Shërbime të kontabilitetit" },
  { code: "SMK", label: "Shërbime mekanike" },
  { code: "STR", label: "Shërbime transporti" },
  { code: "PI", label: "Pajisje industriale" },
  { code: "PT", label: "Pajisje transporti" },
  { code: "SEA", label: "Shërbime edukative dhe arsimore" },
  { code: "KS", label: "Klube sportive" },
  { code: "MN", label: "Materiale ndërtimore" },
  { code: "SHN", label: "Shërbime ndërtimore" },
  { code: "SDG", label: "Shtyp dhe dizajn grafik" },
  { code: "HT", label: "Hoteleri dhe turizëm" },
  { code: "SHB", label: "Shërbime bankare" },
  { code: "STI", label: "Shërbime të TI-së" },
  { code: "SHT", label: "Shërbime telekomunikimi" },
  { code: "PBS", label: "Prodhimi bimor dhe shtazor" },
  { code: "MPM", label: "Mish dhe produkte të mishit" },
  { code: "PM", label: "Produkte të miellit" },
  { code: "PPD", label: "Produkte të drurit" },
  { code: "PPH", label: "Produkte të hekurit" },
  { code: "PPP", label: "Produkte të plastikës" },
  { code: "PPA", label: "Produkte të aluminit" },
  { code: "PHN", label: "Pajisje hidraulike dhe të ngrohjes" },
  { code: "SHH", label: "Shërbime hidraulike" },
  { code: "SUA", label: "Shërbime udhëtimi dhe akomodimi" },
  { code: "SHZ", label: "Shërbime të zbukurimit" },
  { code: "PJA", label: "Pije joalkoolike" },
  { code: "PAL", label: "Pije alkoolike" },
  { code: "DUH", label: "Duhan" },
  { code: "SHM", label: "Shërbime marketingu" },
  { code: "PRO", label: "Prodhimtari" },
  { code: "SFV", label: "Shpërndarje filmash, videosh dhe programesh televizive" },
  { code: "BSH", label: "Blegtori dhe shpezëtari" },
  { code: "RPK", label: "Riparimi i pajisjeve të komunikimit" },
  { code: "PTI", label: "Pajisje të teknologjisë informative" },
] as const;

export type AtkItemCategoryCode = (typeof ATK_ITEM_CATEGORIES)[number]["code"];

const categoryLabels = new Map<string, string[]>();
for (const category of ATK_ITEM_CATEGORIES) {
  const labels = categoryLabels.get(category.code) ?? [];
  if (!labels.includes(category.label)) labels.push(category.label);
  categoryLabels.set(category.code, labels);
}

export const ATK_ITEM_CATEGORY_OPTIONS: Array<{ code: AtkItemCategoryCode; label: string }> =
  Array.from(categoryLabels, ([code, labels]) => ({
    code: code as AtkItemCategoryCode,
    label: labels.join(" / "),
  }));

export function isAtkItemCategoryCode(value: string | null | undefined): value is AtkItemCategoryCode {
  return typeof value === "string" && categoryLabels.has(value);
}

export function getAtkItemCategoryLabel(value: string): string | null {
  return ATK_ITEM_CATEGORY_OPTIONS.find((category) => category.code === value)?.label ?? null;
}
