# ATK product fiscal classifications

## VAT code mapping

Fiskalo uses one canonical ATK VAT classification for each product. The selected ATK code determines the numeric rate sent to checkout and the signed POS coupon:

| ATK code | Rate | Meaning |
|---|---:|---|
| A | 0% | Exempt from VAT |
| C | 0% | Zero-rated supply |
| D | 8% | Reduced VAT rate |
| E | 18% | Standard VAT rate |

**A and C are not interchangeable.** Both calculate zero VAT, but they represent different tax treatments and must remain separate in the product catalogue and fiscal coupon.

The mapping follows the published ATK POS integration model in [fiskalizimi/pos-csharp](https://github.com/fiskalizimi/pos-csharp), which is linked from the [official ATK SEF portal](https://apps.atk-ks.org/sefaplikimi/).

## Measurement-unit catalogue

ATK's SEF portal lists **“Njësitë Matëse dhe Kategoritë e mallrave dhe shërbimeve”**, published 29 September 2026:

[Open the official ATK DOCX catalogue](https://apps.atk-ks.org/sefaplikimi/uploads/documents/1d551126-ea39-49eb-8b89-6e0deb6e117f.docx)

The complete measurement-unit table contains 21 codes. Fiskalo now uses those exact codes in a dropdown and validates the selected code before saving a product.

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

The unit catalogue is versioned in `src/lib/atk/product-units.ts`; its source date, URL, all 21 codes, and normalization/validation behavior have regression tests. Existing product records are not rewritten by this change. A legacy unit value that is not in the current ATK table must be replaced with a valid code before that product can be saved again.

## Goods/services categories — not yet validated

The same official document contains the goods/services category table. The extraction available for this change exposed only rows 45–53; rows 1–44 were not visible. **No partial category list has been presented as complete and no guessed category codes have been imported.**

The product category remains a manually entered code with an explicit warning. A complete, independently checked extraction of every category row is still required before Fiskalo can provide a validated category dropdown.

Do not treat a non-empty category value as proof that ATK recognizes it. Preserve the source's exact code and label, record the document/version date, and add a regression test for every row before enabling category validation.
