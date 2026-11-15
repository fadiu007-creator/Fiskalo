# Fiskalo — ATK 2026 compliance rebuild

**Baseline:** ATK's currently published May 2026 *Specific Technical and Functional Requirements for PEF/SF/SEF* (88-page official PDF), Administrative Instruction (MF) No. 01/2026 (27 April 2026), and the currently published EFS certification/application process. This matrix is an engineering control document, not an ATK approval or legal opinion.

**Official source documents**
- ATK SEF portal and official implementation GitHub link: https://apps.atk-ks.org/sefaplikimi/
- May 2026 technical and functional requirements (official portal PDF): https://apps.atk-ks.org/sefaplikimi/uploads/documents/150ab6cc-084f-490d-b5fc-d8639d0287dc.pdf
- May 2026 EFS certification and maintenance procedure (official portal PDF): https://apps.atk-ks.org/sefaplikimi/uploads/documents/0d8c2056-98ad-403a-a685-57e8cf33d1cc.pdf
- ATK test and certification application user guide (official portal PDF): https://apps.atk-ks.org/sefaplikimi/uploads/documents/1e869fe5-02a2-4471-95a8-0ec6844d6f12.pdf
- Administrative Instruction (MF) No. 01/2026 (official 40-page PDF): https://apps.atk-ks.org/sefaplikimi/uploads/documents/87a43adf-6ee2-42e5-a5af-043c031f514f.pdf
- Administrative-instruction portal: https://www.atk-ks.org/en/legislation/administrative-instructions/
- ATK EDI notice: Unique Fiscalization Code is a prerequisite for SEF use: https://www.atk-ks.org/en/notice-to-taxpayers-new-version-of-the-edi-electronic-system-published/

The May 2026 requirements are supplemented by the ATK amendment signed 22 June 2026. The amendment requires SEF to support installation/use on at least one suitable device class (PC, laptop, tablet, mobile phone or other suitable electronic device); protected transaction storage; automatic sending of locally stored transactions when the connection returns; and export of untransmitted data in CSV/PDF only on ATK or other competent authority request.

## Non-negotiable release policy

1. A passing build, a generated QR, or a successful isolated test is not evidence of ATK acceptance or certification.
2. TEST and production environments must be isolated. Production transmission stays disabled until the developer/software is registered and certified, the developer UIN and SEF unique code are issued, and production credentials/configuration are approved.
3. Every fiscal status is server-derived from a verified ATK response and durably persisted. A browser cannot mark a coupon accepted, cancelled, returned or transmitted.
4. Original fiscal documents are immutable. Cancellation and returns are linked correction documents; no fiscal record is deleted or silently rewritten.
5. Never retry an ambiguous delivery result. Reconcile it with ATK before another transmission.
6. Every offline coupon has a signed QR, explicit OFFLINE marking, monotonic numbering and a durable encrypted local record. Automatic transmission begins when connectivity returns and must satisfy the current legal deadline.
7. No guessed ATK unit, category, tax, payment or document-type codes. Every controlled value must be sourced from the current official catalogue/specification and carry source/version metadata. Current units are sourced from the ATK 29.09.2026 DOCX; current item categories are transcribed from the May 2026 official technical annex pending a direct comparison with the September catalogue.

## Product-wide compliance matrix

| Area | ATK 2026 requirement / expected behaviour | Existing evidence on web-runtime branch | Rebuild / acceptance work |
|---|---|---|---|
| Developer and SEF identity | Articles 35(1–12) require the developer and software solution to be registered/certified before customer use; the assigned developer NUI and unique SEF code must be integrated in the solution and identified for each fiscalization | TEST Application ID and POS identifiers exist; Fiskalo developer registration, developer NUI, unique SEF code and certification are not evidenced | Add provider/SEF registration configuration once ATK issues the identifiers; implement the exact ATK-defined transport mapping (do not invent Protobuf fields); hard-block production issuance until registration/certification is evidenced |
| Tenant and operator identity | Taxpayer, business, branch, POS, operator and SEF identities must be bound to each fiscal event | Owner/member checks and per-POS certificates exist | Verify all roles, operator identifiers, business/branch/POS ownership and snapshots across every fiscal RPC and correction |
| Onboarding and certificates | EDI fiscalization code prerequisite; per-POS key/certificate, CSR and certificate/public-key binding | Browser P-256 non-exportable key, CSR and SPKI matching exist | Reconcile exact 2026 test portal fields, certificate lifecycle/revocation/expiry, reissue and device migration; prove live onboarding |
| Fiscal transaction journal | Every transaction uniquely identified, time-stamped, immutable, and fully auditable; corrections append new records | Paid-sale RPC, fiscal document ledger and correction reservations exist | Add tamper-evident audit trail for login, sale, cancel, return, edits/configuration and all fiscal transmission outcomes; define retention and export |
| Sales and payment | Fiscalize each relevant retail sale; preserve item quantity, unit, unit price, discount, VAT and totals; support all payment methods and mixed allocations | Split-tender helper, exact-cent validation, ATK enum mapping and repeated Payments payload are now integrated into the Cloudflare checkout; migration 0031 and SQL contract test are committed but not applied | Apply migration 0031; verify every ATK payment type and bank-transfer-to-Other mapping in live TEST; ensure all tender allocations sum exactly to the paid total and correction coupons preserve the original split |
| VAT and catalogues | Support at least A/C/D/E tax classes and official product categories/measurement units as specified | VAT A/C/D/E validation, 21 official measurement-unit codes (29.09.2026 catalogue), and 35 May 2026 category codes are now represented in dropdowns and tests | Confirm the September catalogue's category annex is identical/current; apply migration 0030 and add server-side compatibility checks for each category/unit/VAT combination |
| Discounts and price changes | Item- and receipt-level discounts and surcharges are represented with correct signed amounts and VAT recalculation | Partial/branch-level work only | Implement line and basket discount, percentage/value, permission/approval, rounding and receipt/ATK payload reconciliation tests |
| Receipts | Article 7 of AI 01/2026 requires taxpayer NUI/NF, VAT number if registered, business name/address, operator name and ID, items, item/basket discounts or surcharges, payment split, tax groups, net total, timestamp, SEF identifier, daily number, QR, NUIKF, RKS logo and document type | Basic receipt renders RKS coat of arms, taxpayer/operator fields, item/tax/payment totals, NUIKF, daily number, QR and TEST watermark. The displayed `pos_identifier` is currently a derived string, not yet proven to be the ATK-assigned unique SEF code. Basic checkout currently hardcodes total discount to zero and has no discount/surcharge controls | Confirm the exact ATK-issued SEF identifier field and print it (do not use a derived identifier as a substitute); implement item and basket discount/surcharge workflows and reconciliation; compare receipts against the latest Annex F; verify 58–100 mm printer widths, electronic delivery, duplicate-copy marking and all mandatory fields |
| QR / NUIKF | QR on every coupon, including offline; signed CitizenCoupon payload; NUIKF unique alphanumeric, max 16 characters | Browser CitizenCoupon signing and QR generation exist | Verify exact 2026 payload and QR semantics against official implementation/test portal; uniqueness across POS/day/tenant and scannability tests |
| Sale / cancel / return / exchange | Regular sale; cancellation with reason and original link; return with original link; exchange represented as return plus new sale | Sale and full return/cancel code exists in PR branch; partial returns/exchange need review | Build end-to-end workflows, partial item/quantity return if permitted by current specification, refund/payment adjustments, duplicate correction locks and original accepted transaction references |
| Offline mode | Articles 32(3) and 44 require secure local coupon generation/storage, visible OFFLINE state and automatic transmission when communications return; Article 44's 48-hour clock starts when the connection is interrupted, not separately for each coupon. If restoration is impossible, the taxpayer must notify ATK with evidence; if still offline by the 10th of the following month, submit all outstanding coupons | Basic browser outbox and scheduled recovery Worker exist. Signed POS/CitizenCoupon payloads, signatures, certificate material and outage metadata are now AES-256-GCM encrypted at rest in IndexedDB using a persisted non-exportable browser key; legacy plaintext outbox rows are migrated on read. A durable per-business/POS outage clock records the first observed loss of connectivity and applies the same 48-hour deadline to subsequent queued coupons. Basic and Full checkout now fail closed when the browser reports offline, preventing the app from marking an unpersisted sale as paid. Basic can preserve and queue a signed coupon if connectivity drops after its cloud sale record has been created, but neither Basic nor Full can yet create a new sale fully offline | Implement a local-first sale journal and pre-reserved unique coupon/daily-number ranges per POS; persist one outage session timestamp per POS; reconcile/submit every coupon in order; implement evidence/exception workflow and deadline monitoring; test browser close/restart and reconnect |
| Delivery/reconciliation | Real-time transmission; explicit success/failure; automatic retries only when definitely not delivered; ambiguous result requires reconciliation | Cloudflare gateway and stop-on-ambiguity states exist | Add ATK status/reconciliation path, operator resolution with evidence, exact response archive and race/idempotency tests |
| Audit and authority export | Immutable audit traces; June 2026 amendment requires untransmitted fiscal data exportable as CSV/PDF only upon ATK or other competent-authority request | Basic app now has an owner-only export RPC requiring a user-entered authority request reference; it returns cloud-queued/submitted/reconciliation documents with signed POS and CitizenCoupon payloads, signatures, NUIKF, daily number, outage/deadline and ATK response. Export requests are logged in a private audit table; CSV and print-to-PDF are available from the Basic reports page. The request reference is an auditable user attestation, not independently verified against ATK, and local-only IndexedDB documents cannot yet be exported while disconnected | Complete tamper-evident audit history across all full-app fiscal events; verify the authority export against an actual ATK request and required format; add retention/integrity manifest and operational tests |
| Reports | Accurate sales, VAT, payment, return/cancel, daily and periodic fiscal views; required report formats as applicable | Basic sales/VAT report work exists in another open PR | Consolidate reporting; reconcile every report against immutable ledger and ATK accepted/rejected status; confirm applicable X/Z or SEF-specific reports from current 2026 rules rather than assuming legacy EFD reports |
| Security and continuity | HTTPS, encrypted local fiscal data, role controls, protected source/data, auditability, backup and automatic recovery | Cloudflare/Supabase server boundary and private key in browser exist | Threat model, RLS tests for every table/RPC, key-loss/revocation recovery, backup/restore drill, no service-role exposure, rate limits and security review |
| Device support | Responsive desktop, laptop, tablet and mobile; receipt print preview; thermal printer 58–100 mm | Cloudflare web runtime is responsive by design; printer evidence not complete | Test Chrome/Android/iOS and desktop browsers, camera/barcode scanner, USB/network/Bluetooth printer compatibility, paper widths and offline persistence |
| Multilingual | Albanian/Serbian/English support as applicable, correct Latin characters and locale | Not fully verified | Complete translations, number/date formatting, Unicode/receipt tests |
| Certification and maintenance | Technical test before production; application pack includes architecture, integration, offline storage/recovery, user/install manual, audit module manual, demo, source/technology docs, compliance declaration | Documentation incomplete; certification not submitted | Produce a certification dossier and reproducible demo; track ATK testing, fixes, versioning and maintenance evidence |

## Required product modules to rebuild and verify

- Provider administration: provider identity, SEF/software registration, business/tenant provisioning, plan controls, POS issuance/revocation and support/audit access.
- Business owner: business profile, Unique Fiscalization Code, branch/POS registration, certificates, operators/workers, catalogue, inventory, purchases/expenses, cash management, reports, exports and settings.
- Cashier/worker: assigned POS only, shift/session, full-screen checkout, split payments, discounts within permissions, fiscal receipt, returns/cancellations within permissions and offline status.
- Fiscal engine: current ATK schemas, official catalogues, cryptographic signing, QR/NUIKF, online transmission, correction links, immutable journal, offline local-first queue, recovery and reconciliation.
- Customer receipt delivery: thermal print, print preview, electronic delivery with customer consent, duplicate copy labelling and QR verification.
- Basic and Full applications: both must be complete selectable applications; Basic may expose only the legally necessary/basic business modules, but it must not omit mandatory fiscal controls. Full adds advanced business operations without changing fiscal invariants.

## Acceptance test suite — must be automated

- Official protobuf payloads/signatures match ATK's published reference implementation byte-for-byte.
- Invalid/missing developer UIN, SEF code, taxpayer fiscalization code, branch/POS/operator, certificate or key binding blocks issue.
- Each supported VAT code, item category, unit and payment type passes/blocks against the versioned official catalogue.
- Sale totals, item discounts, basket discounts, VAT groups and split tender reconcile to the cent.
- ATK acceptance requires a valid response and valid transaction identifier; forged browser responses cannot alter status.
- Cancel, return and exchange preserve the original record and enforce correction uniqueness/reference rules.
- Offline coupon remains signed and scannable after browser restart; OFFLINE marking and chronological sequence are preserved; reconnect transmits automatically; recovery finishes inside 48 hours.
- Network timeout after request delivery is reconciled, never blindly retried.
- Tenant isolation, owner/cashier/provider RBAC, server-only credentials and audit log tamper resistance pass integration tests.
- Receipt rendering is snapshot-compared against May 2026 Annex F at supported thermal widths.
- Reports and CSV/PDF exports reconcile exactly with ledger and fiscal statuses.
- Cloudflare production-like deployment smoke tests pass with secrets injected only as Worker secrets.
- Real ATK TEST portal evidence is captured for onboarding, certificate issuance, sale, cancel, return, offline recovery and QR verification.

## ATK certification dossier and technical test

The official 2026 certification procedure requires the signed standard application, applicant identity/business-registration evidence as applicable, a general solution description (functions, ATK integration and technologies), user manual/basic operating instructions, and a signed software-compliance declaration. ATK technical testing explicitly evaluates security/integrity, fiscal receipt accuracy, correct real-time reporting, secure local storage and automatic transmission after communications recover. Non-critical gaps may receive a seven-working-day correction window and retest. Certification decision is due within 15 working days; the issued certificate and SEF identifier are recorded in ATK's official registry. A functional/technical change affecting fiscal data generation, storage or transmission must be notified to ATK in advance.

The ATK test guide requires test phase completion before the certification application. The web form accepts up to five PDF/DOCX/XLSX files, maximum 5 MB each, and the applicant must respond to requested supplementary information within seven days.

## Statutory operational fallback

Article 45 covers complete failure of the fiscal device (distinct from an internet outage): the taxpayer uses an ATK-approved special pre-numbered fiscal coupon booklet, restores/replaces the device within 48 hours, then registers those coupons in the SEF within five days after that period for automatic ATK transmission. Fiskalo must document this fallback and provide an incident/export workflow; a browser outbox alone does not replace the approved paper booklet.

## Full application implementation gates

The Full application uses the pre-existing `fiskalo_*` schema in the shared `zikos` project. The audit found that authenticated business roles currently have direct INSERT/UPDATE privileges on `fiskalo_atk_fiscal_documents`, INSERT on `fiskalo_atk_fiscal_events`, and write privileges on `fiskalo_atk_pos_verifications` and POS installation status. This permits browser-side spoofing of verification or fiscal acceptance unless the write path is hardened.

The feature branch now:
- moves verification, fiscal journal and event writes to the server-only Supabase service role;
- registers the ATK-issued public certificate against the exact POS after verifying that its SPKI matches the submitted CSR;
- verifies each Sale and correction signature against the active server-registered POS certificate before sending it to ATK;
- removes browser-controlled POS activation;
- restricts Full product creation/fiscal-field edits and invoice-line creation to official unit/category/VAT mappings;
- supports all ATK PaymentType values and mixed/partial invoice payments.

The additive SQL is drafted in `supabase/full-migrations/fiskalo_full_server_trusted_fiscal_writes.sql`. It has **not** yet been applied to `zikos`. Until it is applied and the new Full routes are deployed together, the Full application must not be described as server-trusted ATK compliant. The migration intentionally leaves legacy products in place, allows non-fiscal stock/metadata updates, and blocks new invoice lines from products with invalid ATK codes.

## Protocol mapping requiring ATK confirmation

The official sample integration repository demonstrates the POS `details`/`signature` Protobuf contract and its published `PosCoupon` fields currently end at field 19. Administrative Instruction MF No. 01/2026, Article 35(8)-(12), additionally requires the developer NUI and unique SEF/software code to be integrated and registered as part of each fiscalization. The published Protobuf sample does not show where those identifiers are carried. Do not invent fields or overload `ApplicationId`; this mapping needs explicit ATK confirmation or an updated official schema before production certification.

## Shared Supabase project verification (read-only)

The connected shared Supabase project was inspected without changing it. Its Fiskalo Basic migration history currently ends at the correction-reservation owner-only migration (the 0029 stage); migrations 0030–0033 are not yet applied. All four were dry-run together inside a transaction against the live schema and rolled back successfully; the expected constraints, payment-allocation column, sales-report RPC and authority-export RPC were present inside the transaction. The Basic product table currently has no rows, so the 0030 NOT VALID catalogue constraints have no existing legacy rows to block, but they still must be applied only alongside the matching application release.

The Supabase security advisor also identified three Basic trigger-only functions exposed as direct RPCs to anon/authenticated: `fiskalo_basic_apply_purchase_item()`, `fiskalo_basic_apply_stock_movement()` and `fiskalo_basic_block_audit_mutation()`. Migration 0034 revokes API-role EXECUTE on these trigger functions and fixes the audit trigger's search_path. It is included in the PostgreSQL CI migration chain and has now been applied to the shared Supabase project as migration `fiskalo_basic_restrict_trigger_rpc_surface_20261115`. Post-apply verification confirms anon/authenticated EXECUTE is false for all three functions and the audit trigger has an empty search_path.

The Full fiscal-document and fiscal-event tables currently have authenticated INSERT/UPDATE policies restricted to TEST POS records. This still allows a signed-in browser to write TEST document/event rows directly. The Full server-trusted migration was dry-run inside a transaction and rolled back; it successfully changes these permissions so authenticated users cannot INSERT/UPDATE fiscal documents/events while the service role can. It has deliberately **not** been applied yet because the current main branch does not contain the corresponding Cloudflare API routes. Apply the migration only after the server routes are merged and deployed, otherwise the currently deployed app may lose its TEST submission path.

## Current blockers that cannot be solved by code alone

- ATK must issue/confirm the developer and SEF registration identifiers and grant access to the relevant test/production environment.
- The EDI taxpayer Unique Fiscalization Code must be issued to each business before SEF use.
- ATK TEST credentials, a real test taxpayer/POS and live acceptance results are required for end-to-end evidence.
- Fiskalo's provider/software certification is a formal ATK process. Code cannot self-certify or authorize production use.
- Cloudflare deployment secrets and the existing Supabase project must be available to execute deployment and live integration tests.
