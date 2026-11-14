// Verified against ATK's "Njësitë Matëse dhe Kategoritë e mallrave dhe shërbimeve"
// catalogue published on 29 September 2026. Keep codes exactly as published.
export const ATK_MEASUREMENT_UNIT_SOURCE = {
  title: "Njësitë Matëse dhe Kategoritë e mallrave dhe shërbimeve",
  publishedOn: "2026-09-29",
  url: "https://apps.atk-ks.org/sefaplikimi/uploads/documents/1d551126-ea39-49eb-8b89-6e0deb6e117f.docx",
} as const;

export const ATK_MEASUREMENT_UNITS = [
  { id: 1, code: "EA", label: "Një (njësi)" },
  { id: 2, code: "CP", label: "Copë" },
  { id: 3, code: "LTR", label: "Litër" },
  { id: 4, code: "SEC", label: "Sekondë" },
  { id: 5, code: "MIN", label: "Minutë" },
  { id: 6, code: "HUR", label: "Orë" },
  { id: 7, code: "DAY", label: "Ditë" },
  { id: 8, code: "MON", label: "Muaj" },
  { id: 9, code: "ANN", label: "Viti" },
  { id: 10, code: "KGB", label: "Kilogram bruto" },
  { id: 11, code: "KGN", label: "Kilogram neto" },
  { id: 12, code: "TN", label: "Ton" },
  { id: 13, code: "GRM", label: "Gram" },
  { id: 14, code: "M4", label: "Vlerë monetare" },
  { id: 15, code: "UDH", label: "Udhëtim" },
  { id: 16, code: "KMT", label: "km" },
  { id: 17, code: "LM", label: "Metër linear" },
  { id: 18, code: "MTS", label: "m2" },
  { id: 19, code: "MTV", label: "m3" },
  { id: 20, code: "MSK", label: "m/s2" },
  { id: 21, code: "KWH", label: "KWH" },
] as const;

export type AtkUnitCode = (typeof ATK_MEASUREMENT_UNITS)[number]["code"];

export function isAtkUnitCode(value: string): value is AtkUnitCode {
  return ATK_MEASUREMENT_UNITS.some((unit) => unit.code === value);
}

export function normalizeAtkUnitCode(value: string): AtkUnitCode | null {
  const normalized = value.trim().toUpperCase();
  return isAtkUnitCode(normalized) ? normalized : null;
}

export function getAtkUnitLabel(value: string): string | null {
  return ATK_MEASUREMENT_UNITS.find((unit) => unit.code === value)?.label ?? null;
}
