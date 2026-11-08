# Fiskalo Basic ATK MVP

## Goal
Deliver the smallest maintainable product that can complete ATK's required onboarding and fiscal coupon test scenarios, while retaining mandatory record integrity and offline protections.

## Included
- One responsive web application and one primary local POS runtime for the first certification track.
- Owner/Cashier access; one business workspace.
- Minimal product catalogue: name, price, stock and ATK unit/category/VAT mappings.
- POS sale, payment capture and receipt.
- ATK onboarding per POS: identifiers, local key generation, CSR, certificate matching.
- Signed ATK Sale, Cancel and Return documents linked to original sales.
- Durable encrypted offline fiscal journal, safe automatic recovery and ambiguous-submission reconciliation.
- Restricted authority-request CSV/PDF export of untransmitted fiscal records.
- Basic sales, VAT and fiscal transmission status.

## Explicitly deferred
- Advanced inventory valuation and supplier payment reconciliation.
- Supplier purchases, basic stock movements and operating expenses are now included in the owner workspace (migrations 0016–0017); they remain gated until those migrations are applied and tested.
- Subscription plans, billing and product limits.
- ARBK registry lookup.
- Advanced shift/cash reconciliation and internal X/Z reporting.
- Multi-client feature parity (independent Web, Android and Windows fiscal engines).
- Advanced audit exports beyond the required fiscal journal and authority workflow.

## Non-negotiable safeguards
- Private keys never leave the POS device and are never stored in Supabase or Cloudflare secrets.
- Each POS has its own key/certificate and stable identifiers.
- Original fiscal records are immutable; corrections append linked documents.
- An uncertain submission is reconciled before retry; no blind duplicate submission.
- A coupon is marked fiscalized only after ATK returns a valid accepted transaction ID and the response is durably saved.
- Production submission remains disabled until the provider and software solution receive formal ATK authorization/certification and production credentials.

## Acceptance sequence
1. ATK TEST taxpayer/application/POS verification.
2. CSR and certificate issuance on the selected physical POS; public key must match local private key.
3. One accepted Sale with saved transaction ID.
4. Accepted Cancel and Return referencing original accepted Sale as required by ATK.
5. Offline sale retention, reconnection recovery and duplicate/timeout reconciliation.
6. Receipt comparison against current official ATK format.
7. Authority-request export access-control test.
8. ATK portal verification and formal certification application evidence.

## 2026 ATK legal requirements cross-check

Baseline reviewed: Administrative Instruction MF No. 01/2026 published by ATK. This is a software implementation checklist, not an ATK certification decision.

| Legal requirement | Current Basic MVP evidence | Status |
|---|---|---|
| Article 7: receipt contains taxpayer identity, address, operator identity, item/quantity/unit price, VAT, payment allocations, issue date/time, POS identity, daily receipt number, QR, NUIKF, RKS logo and document type | The Basic TEST receipt renders these identity, line, VAT, daily-number, NUIKF, QR and RKS/MFPT elements. It remains a TEST printout; its exact layout/content has not yet been validated against the current official ATK specimen, and split-tender allocations are not supported. | Partial — format validation outstanding |
| Article 32(1)-(2): electronic register, digital signature per coupon, certificate identity, secure HTTPS exchange, QR generation, printer support, upgrade path and official ATK messages | Windows Agent has local key/certificate validation, Protobuf signing, HTTPS TEST submission, signed CitizenCoupon QR generation and thermal-printing primitives. Production protocol, ATK-issued production credentials and physical printer evidence remain outstanding. | Partial |
| Article 32(3) and Article 44: issue and securely retain coupons offline, automatically transmit on reconnection, meet the 48-hour deadline | Encrypted local queue and recovery worker exist. Ambiguous submissions are deliberately locked for reconciliation; offline coupon issuance with a scannable signed QR and full 48-hour acceptance evidence are not yet demonstrated. | Partial |
| Article 34: separate certificate and protected private key for each SEF/POS, including taxpayer, branch, POS, software solution code and fiscalization number | Local DPAPI key/certificate binding and TEST onboarding exist. ATK production-issued credentials and the certified software solution code are unavailable. | Partial |
| Article 35(8)-(12): developer and software registration/certification; unique SEF code and developer NUI included in each fiscalization | Not implemented in the Basic payload and cannot be completed until ATK issues the developer/software registration. | Blocked |
| Article 39: QR code on every fiscal coupon, including coupons issued while offline; unique identifier in ATK format | Agent generates the signed CitizenCoupon QR/NUIKF and retains it in the encrypted local queue; the web receipt renders the saved QR. Offline/online physical coupon scans and exact ATK-format validation have not yet been evidenced. | Partial — physical and format validation outstanding |
| Article 43: corrective coupon must reference the original coupon | Protobuf model supports correction types, but the Basic product has no tested end-to-end Cancel/Return workflow. | Not complete |

The ATK legal instruction states that the SEF must save transactions securely when communication is interrupted and transmit them automatically when service returns; Article 44 sets a 48-hour deadline. The software must generate QR codes even when fiscalization cannot complete immediately. These requirements are not satisfied merely by storing a paid sale or printing a TEST copy.

## Fiscal receipt and offline queue work delivered in migrations 0005-0006

- The POS Agent creates a cryptographically random 16-character uppercase alphanumeric NUIKF for each coupon and signs a separate ATK `CitizenCoupon` with the same locally protected ECDSA key used for the POS coupon.
- The QR payload is `Base64(CitizenCoupon protobuf)|Base64(ECDSA signature)`, matching the official `fiskalizimi/pos-csharp` implementation. The Agent renders that exact payload as an SVG QR before attempting ATK submission and stores the CitizenCoupon bytes, signature, NUIKF and daily number in its encrypted local queue.
- The Basic receipt view now includes taxpayer name/NUI, POS location, optional VAT number, operator name and identifier, SEF identifier, item quantity/unit price/value and ATK VAT letter, VAT group breakdown, totals, payment method, date/time, daily number, NUIKF, QR, document type, RKS/MFPT fiscal mark and `e-kuponi`. TEST receipts are explicitly labelled as test-only and cannot be mistaken for production coupons.
- Migration 0005 adds a per-POS daily counter using the Kosovo local timezone, a unique NUIKF constraint, signed CitizenCoupon receipt fields and owner/member-checked RPCs to persist an offline receipt and later promote it to ATK-accepted status. Migration 0006 adds owner-only VAT-number maintenance.
- The POS Agent retries only transport failures that prove the request was not delivered (DNS resolution failure, refused connection, network unreachable, etc.). It uses exponential backoff and one shared 48-hour deadline for all outstanding coupons in the same confirmed outage. A timeout, reset or ambiguous ATK response is moved to reconciliation rather than risk duplicate fiscalization.
- When the Agent later receives a valid ATK TEST transaction ID, the browser polls the local queue and persists the accepted response into the cloud fiscal ledger.

**Deployment verification (2026-11-07):** migrations 0005 and 0006 are applied to Supabase project `zikos`. The catalog/privilege regression script for migration 0005 passed. The daily counter function is configured for `Europe/Belgrade` (Kosovo local time). The test receipt UI and Agent changes are committed, but the current GitHub Actions run must pass before this batch is considered build-verified.

- Migrations 0007-0008 add an owner-visible, self-managed operator display name and snapshot it into every new sale. The POS requires a named operator before checkout, while retaining the authenticated user ID internally as the stable operator key; the ATK PosCoupon OperatorId field carries the registered operator name. Owner access to the business operator roster is mediated through a private SECURITY DEFINER helper to avoid recursive RLS policies.

**Receipt scope caveat:** the current Basic checkout records one payment method per sale and does not yet support split-tender payments or item-level discounts/markups. The receipt prints the full amount against the selected method and VAT breakdown; split allocations and discount/markup rows remain unimplemented if a business needs them.

**Important remaining boundary:** the current hosted checkout still creates the paid sale in Supabase before asking the local Agent to sign/queue the ATK coupon. Therefore this handles an ATK-system outage while the Fiskalo/Supabase connection remains available; it does not yet provide a fully disconnected POS sale when the store loses all internet connectivity. A local-first sales cache and post-reconnection sale sync are still required for that broader offline case. The current offline queue is Windows POS Agent-only; Android does not yet have an equivalent local signing/queue agent. A continuous ATK endpoint connectivity probe runs every 15 seconds while the Windows POS Agent is running and persists the first detected interruption; new offline coupons inherit that outage timestamp and the 48-hour deadline. If the monitor cannot record the outage, the first confirmed no-connect submission failure is the fallback. The deadline is therefore bounded by the probe interval while the Agent is running.

## Security hardening delivered in migration 0004

Migration `0004_fiskalo_basic_security_hardening.sql` narrows the database trust boundary:
- Owners alone can create or change POS configuration and product catalogue rows; cashiers retain read access for checkout.
- Authenticated clients cannot directly insert/update/delete sales, sale lines or fiscal documents. Paid checkout and accepted ATK response persistence remain routed through validated RPCs.
- Privileged database implementations are moved into the non-exposed `fiskalo_private` schema. Public RPC entry points are SECURITY INVOKER wrappers; private helpers require `auth.uid()` and are executable only by authenticated users.
- The old column-level direct permission to update a sale's fiscal status is explicitly revoked.
- `supabase/tests/0004_fiskalo_basic_security_hardening.sql` checks the resulting grants and function placement.

**Deployment status (2026-11-07):** migration 0004 is applied to the existing Supabase project `zikos`. The privilege regression SQL completed successfully against that database. The `fiskalo_private` schema is not in the configured exposed-schema override (the setting is unset, leaving the Supabase default exposed schemas); keep it out of any future exposed-schema list. This catalog test does not replace authenticated owner/cashier and cross-tenant RLS integration tests. The current UI still does not provide a complete owner-managed cashier invitation workflow; role provisioning needs its own secure implementation and tests.


## Current ATK 2026 onboarding and technical source references

The live ATK SEF portal currently publishes the Administrative Instruction (MFPT) No. 01/2026, the current specific technical/functional requirements for PEF/SF/SEF, certification and maintenance procedures, and the test/application user guide. The EDI service "Kërkesë për Fiskalizim" is the route through which a taxpayer obtains the Unique Fiscalization Code; ATK describes this code as a prerequisite for using SEF.

Official sources (re-check these before each certification submission because ATK may revise documents):
- ATK SEF application and document portal: https://apps.atk-ks.org/sefaplikimi/
- ATK EDI announcement for the 2026 "Kërkesë për Fiskalizim" service: https://www.atk-ks.org/njoftim-per-tatimpagues-publikohet-versioni-i-ri-i-sistemit-elektronik-edi/
- ATK legislation index, including the 29 May 2026 technical requirements and 27 April 2026 Administrative Instruction: https://www.atk-ks.org/portfolio/legjislacioni-perkates/
- ATK published technical requirements document (portal download): https://apps.atk-ks.org/sefaplikimi/

Do not populate production ATK unit/category dropdowns from guessed values, legacy EFD category numbers, or sample repository constants. Extract and version the current official catalogue/specification and retain the source document/version/date alongside the data. The existing free-text product fields are not evidence of an official validated catalogue.

## Current status

Implemented in the clean repository:
- Web owner login and business onboarding against isolated Supabase tables.
- Minimal product and POS configuration.
- Atomic paid checkout with stock deduction and sale-line snapshots.
- Windows local POS Agent with DPAPI-protected signing key, matching-certificate validation, encrypted fiscal queue, idempotency and ATK TEST submission.
- Web ATK TEST onboarding: one-time local-agent pairing, ATK POS verification, CSR/certificate request and certificate status persistence.
- Web paid-sale path: builds the ATK Sale coupon, submits through the local agent and stores the accepted response only when a valid transaction ID is returned.

Not yet complete:
- A POS Agent correction-coupon factory creates immutable full-cancellation and full-return protobuf documents with a distinct coupon ID, original-sale `ReferenceNo`, new verification number and UTC issue time. It preserves the original sale's fiscal values and clears the ATK response transaction number on the new request. Migration 0015 adds a durable correction journal linked to the original accepted Sale document and a server-side RPC that requires an accepted original and a matching accepted ATK TEST response before recording the correction. Migration 0015 is committed but has not been applied. Partial item returns, refund/payment calculation, signed-correction submission integration, web UI actions and end-to-end ATK acceptance tests remain unimplemented; do not expose this as a completed user-facing correction workflow.
- Verified official unit/category catalogue and dropdowns. The sample integration repository demonstrates payload values but is not itself a complete current ATK catalogue.
- Complete browser/operator reconciliation and authority-request export.
- Add a tested POS cancellation/return UI and local-agent correction submission endpoint; the current code has a protobuf factory and persistence RPC only.
- Run authenticated owner/cashier and cross-tenant RLS integration tests with real test JWTs. Migrations 0014–0017 are committed but have not been executed against the database; apply them only to an approved staging database after confirming the correct Supabase project, reviewing each migration and its backup/rollback procedure. Run SQL contract scripts 0004 and 0014–0016 against that staging schema, plus authenticated owner/cashier and cross-tenant RLS integration tests. PR #2 adds the 0016–0017 business-operations schema contract test.
- Physical POS tests for Windows installation, printer output, offline recovery and duplicate/timeout scenarios.
- ATK provider/software certification and production credentials.

The app must not be described as fully ATK-compliant or certified until the required ATK tests pass and formal authorization is granted. Production submission remains disabled.
