// Official ATK item/service categories from the May 2026 Specific Technical
// and Functional Requirements for PEF/FS/EFS, Annex "Kategoritë e mallrave dhe shërbimeve".
// Codes are fiscal classifications; do not replace them with Fiskalo-internal labels.
export const ATK_ITEM_CATEGORY_SOURCE = {
  title: "Kërkesat specifike teknike dhe funksionale për PEF/SF/SEF",
  publishedOn: "2026-05-29",
  url: "https://apps.atk-ks.org/sefaplikimi/uploads/documents/150ab6cc-084f-490d-b5fc-d8639d0287dc.pdf",
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
  { code: "PI", label: "Pajisje dhe makineri industriale" },
  { code: "PT", label: "Mjete transporti (autobusë, kamionë dhe vetura)" },
  { code: "SEA", label: "Shërbime edukative dhe arsimore" },
  { code: "KS", label: "Klube sportive" },
  { code: "MN", label: "Materiale ndërtimore" },
  { code: "SHN", label: "Shërbime ndërtimore" },
  { code: "SDG", label: "Shtyp dhe dizajn grafik" },
  { code: "HT", label: "Hoteleri dhe turizëm" },
  { code: "SHB", label: "Shërbime bankare" },
  { code: "STI", label: "Shërbime të teknologjisë informative" },
  { code: "SHT", label: "Shërbime telekomunikimit" },
  { code: "PBS", label: "Prodhimi bimor dhe shtazor" },
  { code: "MPM", label: "Mish dhe produkte të mishit" },
] as const;

export type AtkItemCategoryCode = (typeof ATK_ITEM_CATEGORIES)[number]["code"];

export function isAtkItemCategoryCode(value: string): value is AtkItemCategoryCode {
  return ATK_ITEM_CATEGORIES.some((category) => category.code === value);
}

export function getAtkItemCategoryLabel(value: string): string | null {
  return ATK_ITEM_CATEGORIES.find((category) => category.code === value)?.label ?? null;
}
