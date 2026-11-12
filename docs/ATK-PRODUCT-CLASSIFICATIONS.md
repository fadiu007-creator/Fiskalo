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

## Measurement units and goods/services categories

ATK's SEF portal lists the document **“Njësitë Matëse dhe Kategoritë e mallrave dhe shërbimeve”**, published 29 September 2026:

[Open the official ATK DOCX catalogue](https://apps.atk-ks.org/sefaplikimi/uploads/documents/1d551126-ea39-49eb-8b89-6e0deb6e117f.docx)

The complete tables have not yet been imported into this repository. Until they are extracted and checked against the document, the product form accepts the unit and item-category codes as text and explicitly warns that those values are **not automatically validated**. Do not treat a non-empty value as proof that ATK recognizes the code.

A future catalogue import must preserve the source's exact code and label, record the document/version date, and include regression tests for every imported row. No guessed unit or category codes belong in the production catalogue.
