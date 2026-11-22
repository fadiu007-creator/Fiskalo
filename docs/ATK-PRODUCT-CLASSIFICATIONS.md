# ATK product fiscal classifications

This file documents the exact catalogues currently implemented by Fiskalo. Product category and VAT classification are separate fields: **never infer the VAT treatment from the category code alone**.

## VAT code mapping

Fiskalo uses the ATK tax-rate letters in the signed coupon. The official ATK POS integration sample, linked from the ATK SEF portal, documents these values:

| ATK code | Rate | Meaning |
|---|---:|---|
| A | 0% | Exempt from VAT |
| C | 0% | Zero-rated |
| D | 8% | Reduced rate |
| E | 18% | Standard rate |

**A and C are not interchangeable.** Both calculate zero VAT, but they represent different fiscal classifications and must remain distinct in product records and fiscal coupons.

Sources:
- [ATK SEF portal — implementation specifications and official documents](https://apps.atk-ks.org/sefaplikimi/)
- [ATK-linked POS C# integration sample](https://github.com/fiskalizimi/pos-csharp)

The VAT code is selected per product/supply. A category such as food, medicine or fuel does not by itself establish whether A, C, D or E applies; the taxpayer must apply the relevant VAT law and current ATK guidance.

## Measurement-unit catalogue

The current source snapshot in `src/lib/atk/product-units.ts` uses the 21 codes from ATK's later catalogue, **“Njësitë Matëse dhe Kategoritë e mallrave dhe shërbimeve”**, published 29 September 2026:

[Open the official ATK DOCX catalogue](https://apps.atk-ks.org/sefaplikimi/uploads/documents/1d551126-ea39-49eb-8b89-6e0deb6e117f.docx)

| Code | Official label |
|---|---|
| EA | Një (njësi) |
| CP | Copë |
| LTR | Litër |
| SEC | Sekondë |
| MIN | Minutë |
| HUR | Orë |
| DAY | Ditë |
| MON | Muaj |
| ANN | Viti |
| KGB | Kilogram bruto |
| KGN | Kilogram neto |
| TN | Ton |
| GRM | Gram |
| M4 | Vlerë monetare |
| UDH | Udhëtim |
| KMT | km |
| LM | Metër linear |
| MTS | m2 |
| MTV | m3 |
| MSK | m/s2 |
| KWH | KWH |

The May 2026 technical-requirements PDF contains an earlier 31-row measurement-unit table on page 86. Fiskalo's current code snapshot intentionally points to the later 29 September 2026 ATK catalogue; do not reintroduce codes from the older table without checking the latest ATK publication. The UI validates the selected code before saving a product. Existing product records are not silently rewritten.

## Goods and services categories

The complete category annex is in the ATK **Specific Technical and Functional Requirements for PEF/SF/SEF**, published 29 May 2026, pages 87–88:

[Open the official ATK technical-requirements PDF](https://apps.atk-ks.org/sefaplikimi/uploads/documents/150ab6cc-084f-490d-b5fc-d8639d0287dc.pdf)

The annex contains **53 published rows and 52 unique category codes**. The code `PM` appears twice in the source (medical equipment and flour products); Fiskalo preserves both rows and combines their labels in the dropdown.

| Code | Official category name |
|---|---|
| TT | Të tjera |
| UR | Ushqime restoranti |
| AU | Artikuj ushqimorë |
| VM | Veshmbathje |
| KO | Kozmetikë |
| AP | Autopjesë |
| BM | Barna mjekësore |
| PM | Pajisje mjekësore / Produkte të miellit |
| PP | Pemë dhe perime |
| PE | Pajisje elektronike |
| PS | Pajisje shtëpiake |
| PB | Pajisje bujqësore |
| BB | Barna bujqësore |
| KB | Karburante |
| EE | Energji elektrike |
| PSE | Pajisje speciale elektrike |
| SM | Shërbime mjekësore |
| SJ | Shërbime juridike |
| ST | Shërbime të tjera |
| SK | Shërbime të kontabilitetit |
| SMK | Shërbime mekanike |
| STR | Shërbime transporti |
| PI | Pajisje industriale |
| PT | Pajisje transporti |
| SEA | Shërbime edukative dhe arsimore |
| KS | Klube sportive |
| MN | Materiale ndërtimore |
| SHN | Shërbime ndërtimore |
| SDG | Shtyp dhe dizajn grafik |
| HT | Hoteleri dhe turizëm |
| SHB | Shërbime bankare |
| STI | Shërbime të TI-së |
| SHT | Shërbime telekomunikimi |
| PBS | Prodhimi bimor dhe shtazor |
| MPM | Mish dhe produkte të mishit |
| PPD | Produkte të drurit |
| PPH | Produkte të hekurit |
| PPP | Produkte të plastikës |
| PPA | Produkte të aluminit |
| PHN | Pajisje hidraulike dhe të ngrohjes |
| SHH | Shërbime hidraulike |
| SUA | Shërbime udhëtimi dhe akomodimi |
| SHZ | Shërbime të zbukurimit |
| PJA | Pije joalkoolike |
| PAL | Pije alkoolike |
| DUH | Duhan |
| SHM | Shërbime marketingu |
| PRO | Prodhimtari |
| SFV | Shpërndarje filmash, videosh dhe programesh televizive |
| BSH | Blegtori dhe shpezëtari |
| RPK | Riparimi i pajisjeve të komunikimit |
| PTI | Pajisje të teknologjisë informative |

The source annex notes that the listed categories are examples and that additional categories may exist; the SEF must support configuration of categories for the relevant goods or services. Fiskalo validates the 52 unique codes published in this annex but does not claim that this finite dropdown is an exhaustive legal classification of every possible business activity.

Implementation:
- `src/lib/atk/product-categories.ts` preserves all 53 source rows and builds 52 unique dropdown options.
- `supabase/migrations/0033_fiskalo_basic_complete_atk_item_categories.sql` enforces the 52 unique codes in the Basic products table.
- `tests/product-categories.test.mjs` checks the source row count, unique code count, duplicate `PM` label and rejection of arbitrary values.

The 22 June 2026 amendment updates other SEF technical requirements but does not replace the May 2026 category annex. Check the ATK portal for any later catalogue or annex before changing these constants.
