# Fiskalo — Full + Basic business and fiscalization platform

Fiskalo now contains two selectable web applications in one Cloudflare-hosted repository:

- **Fiskalo Full** — `/app` and `/app/[organizationId]`: business workspace for invoices, customers, products, suppliers, purchases, expenses, inventory, team roles, cashier shifts, operational reports, audit views, provider administration, Web POS and printer settings. It uses the existing `fiskalo_*` schema in Supabase project `zikos`.
- **Fiskalo Basic** — `/basic`: separate simplified business/POS application using the isolated `fiskalo_basic_*` schema, ATK 2026 catalogue validation, browser-held POS keys, Cloudflare ATK TEST gateway, signed coupons and recovery journal.

The landing page and authenticated workspace provide routes between Full and Basic. The source of the Full workspace was restored into this repository without modifying the separate `Fiskalo1` repository. The Windows localhost POS agent is not part of the supported web runtime; ATK operations must use the Cloudflare-hosted server routes.

## Scope

- Owner and cashier access
- Business and POS setup
- Product catalogue with official ATK unit, item-category and VAT mappings
- POS checkout and payment recording
- ATK Sale, Cancel and Return workflows
- Device-held private keys and ATK certificates
- Encrypted offline fiscal journal, safe recovery and reconciliation
- Basic receipts and sales/fiscal status reporting

The Full app contains the broader business-operation modules. Formal ATK certification, production submission, Android-native fiscal signing, and complete local-first offline checkout remain release gates.

## Compliance boundary

A successful build or TEST coupon is not ATK certification. Production fiscalization stays disabled until the provider and solution are authorized/certified and production credentials are issued. See `docs/ATK-MVP-SCOPE.md`.


## Current implementation state

- [x] Clean Next.js/Cloudflare application foundation
- [x] Supabase email/password login UI
- [x] Owner-only worker invitation and team roster source through a Supabase Edge Function; deployment and live email-delivery verification remain release gates.
- [x] Isolated `fiskalo_basic_*` schema and owner onboarding / atomic paid-sale RPCs
- [x] ATK product unit dropdown from the 29 September 2026 official catalogue; 21 codes are covered by unit tests
- [x] ATK item/service category dropdown with 35 official May 2026 category codes and exact-code validation
- [x] Product VAT classification validation for A/C/D/E, keeping exempt and zero-rated classes distinct
- [x] POS checkout with stock deduction and payment recording
- [x] Automatic ATK TEST Sale submission after payment through the authenticated Cloudflare gateway using the browser-held POS key and matching TEST certificate
- [x] Accepted ATK TEST response is persisted only when a valid transaction ID is returned
- [x] Browser POS runtime: non-exportable per-POS P-256 keys in IndexedDB, CSR creation, certificate/SPKI matching, and POS/CitizenCoupon signing
- [x] Durable browser IndexedDB fiscal outbox with authenticated upload to the Cloudflare/Supabase recovery queue
- [x] Migrations 0004–0006 are documented as applied to the existing Supabase project `zikos`; migrations 0014–0017 are committed but have not been executed against the database. Treat database migration execution and authenticated RLS integration testing as separate release gates.
- [x] Cloudflare scheduled recovery Worker source: certificate/signature validation, Sale/Cancel/full Return handling, 48-hour deadline and stop-on-ambiguity behavior
- [x] Basic inventory ledger, supplier purchases and expenses source (migrations 0016–0017 committed; not applied; owner/RLS integration tests remain open)
- [ ] Reconcile the 29 September 2026 unit/category DOCX and any subsequent ATK catalogue update before certification; current category dropdown is based on the May 2026 official technical annex
- [ ] Apply and verify migrations 0030–0031 (ATK catalogue constraints and split-tender RPC) on an approved staging project; run both SQL contract tests
- [ ] Apply and verify migrations 0014–0017 on an approved staging project; run SQL contract tests 0014–0017 and authenticated tenant-isolation tests
- [ ] Complete ambiguous-submission reconciliation UI and authority-request export
- [ ] Complete cancellation/return POS workflow using the existing correction-document factory
- [ ] Deploy `supabase/functions/fiskalo-basic-workers` to the approved Supabase project and verify owner-only worker invitation/listing with real Auth email delivery
- [ ] Deploy the Cloudflare recovery Worker and verify scheduled recovery with a real pre-delivery failure and reconnection
- [ ] Cloudflare deployment and live smoke tests

The web-only ATK TEST runtime, browser signing, authenticated Cloudflare gateway, trusted acceptance journal, correction reservations and scheduled recovery Worker are implemented in PR #12. CI and live ATK TEST acceptance remain release gates; formal ATK certification and production submission are not claimed. Partial returns are not supported. Basic inventory, purchases, expenses and split-tender payment allocation are implemented in source but remain unavailable until their database migrations are applied and verified. Migrations 0004–0006 are documented as applied to the existing `zikos` project; migrations 0014–0017 and 0030–0031 are committed but not executed there. All Basic objects use the isolated `fiskalo_basic_*` namespace and do not alter the existing `fiskalo_*`, `dhuroje_*`, `sjelle_*`, `kafja_*` or `mikrotekos_*` tables. A paid sale is marked fiscalized only after ATK returns an accepted response with a valid transaction ID and the database persists it.

A successful build or TEST coupon is not ATK certification. Production fiscalization stays disabled until the provider and solution are authorized/certified and production credentials are issued.

## Database security migration

Migration `supabase/migrations/0004_fiskalo_basic_security_hardening.sql` has been applied to Supabase project `zikos`; its catalog/privilege regression script passed there. The private helper schema must remain outside the exposed Data API schemas. Full authenticated owner/cashier and cross-tenant RLS integration tests are still required before enabling cashier provisioning.
