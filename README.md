# Fiskalo — Basic ATK MVP

A deliberately small Kosovo fiscalization product focused on ATK POS onboarding, signed fiscal coupons, corrections, offline retention and receipt delivery.

This repository is the clean MVP implementation. It is separate from `Fiskalo1`; no files or deployment settings in `Fiskalo1` are modified.

## Scope

- Owner and cashier access
- Business and POS setup
- Product catalogue with official ATK unit, item-category and VAT mappings
- POS checkout with payment allocation capture and receipt delivery
- ATK Sale, Cancel and Return workflows
- Device-held private keys and ATK certificates
- Encrypted offline fiscal journal, safe recovery and reconciliation
- Basic receipts and sales/fiscal status reporting

Supplier purchasing, advanced inventory, subscriptions, advanced cash management, ARBK lookup and multi-client parity are intentionally out of scope.

## Compliance boundary

A successful build or TEST coupon is not ATK certification. Production fiscalization stays disabled until the provider and solution are authorized/certified and production credentials are issued. See `docs/ATK-MVP-SCOPE.md`.


## Current implementation state

- [x] Clean Next.js/Cloudflare application foundation
- [x] Supabase email/password login UI
- [x] Isolated `fiskalo_basic_*` schema and owner onboarding / atomic paid-sale RPCs
- [x] Basic product catalogue and ATK field storage (official dropdown catalogue still needs a verified ATK source)
- [x] POS checkout with stock deduction and payment recording
- [x] Split-tender payment entry for cash, card, bank transfer/other, voucher, cheque and cryptocurrency; exact-cent validation and ATK PaymentType mapping are implemented in source, pending migration 0020
- [x] Automatic ATK TEST Sale submission after payment when a verified POS, matching TEST certificate and paired local POS Agent are available
- [x] Accepted ATK TEST response is persisted only when a valid transaction ID is returned
- [x] Windows POS Agent source: local DPAPI key storage, encrypted fiscal queue, ATK TEST client and thermal printer support
- [x] Browser-session restoration for the paired local POS Agent
- [x] Split-tender amounts are included in the signed ATK POS coupon, receipt, sales history and CSV export; the payment-allocation unit tests are included in CI
- [x] Migrations 0004–0006 are documented as applied to the existing Supabase project `zikos`. Migrations 0014–0017 are on `main`; migrations 0018–0019 are in open PR #6; migration 0020 is in the split-tender branch. None of migrations 0014–0020 has been executed against the database. Migration 0020 explicitly refuses to run until 0018 and 0019 are recorded. Apply the approved migrations in version order on staging and run their SQL contract tests plus authenticated tenant-isolation tests before release.
- [x] Correction coupon factory and durable accepted-correction journal/RPC source (migration 0015 committed; not applied; cancellation/return UI and end-to-end submission tests remain open)
- [x] Basic inventory ledger, supplier purchases and expenses source (migrations 0016–0017 committed; not applied; owner/RLS integration tests remain open)
- [ ] Official ATK unit/category dropdown catalogue with source/version evidence
- [ ] After review of PR #6, apply and verify migrations 0014–0020 in version order on an approved staging project; run SQL contract tests 0014–0020 plus authenticated tenant-isolation tests
- [ ] Complete ambiguous-submission reconciliation UI and authority-request export
- [ ] Complete cancellation/return POS workflow using the existing correction-document factory
- [ ] Verify physical POS installation, printer, offline recovery and ATK TEST acceptance
- [ ] Cloudflare deployment and live smoke tests

The app currently supports a TEST sale submission path only. Cancel/Return UI, official catalogue dropdowns, authority exports, Android support, live deployment and production submission are not complete. Basic inventory, purchases and expenses are implemented in source but remain unavailable until migrations 0016–0017 are applied and verified. The database migrations are applied to `zikos` under the isolated `fiskalo_basic_*` namespace; this does not alter the existing `fiskalo_*`, `dhuroje_*`, `sjelle_*`, `kafja_*` or `mikrotekos_*` tables. A paid sale is marked fiscalized only after ATK returns an accepted response with a valid transaction ID and the database persists it.

A successful build or TEST coupon is not ATK certification. Production fiscalization stays disabled until the provider and solution are authorized/certified and production credentials are issued.

## Version boundary

The current `main` application in this repository is the Basic MVP. The full application source was not found in `main` or the inspected correction/worker branches, so there is no genuine Full app to expose through a version selector yet. No placeholder Full tab is shown and no code is imported from another repository. Restore the Full source into this repository before adding the separate Full/Basic selector.

## Database security migration

Migration `supabase/migrations/0004_fiskalo_basic_security_hardening.sql` has been applied to Supabase project `zikos`; its catalog/privilege regression script passed there. The private helper schema must remain outside the exposed Data API schemas. Full authenticated owner/cashier and cross-tenant RLS integration tests are still required before enabling cashier provisioning.
