# Fiskalo — Basic ATK MVP

A deliberately small Kosovo fiscalization product focused on ATK POS onboarding, signed fiscal coupons, corrections, offline retention and receipt delivery.

This repository is the clean MVP implementation. It is separate from `Fiskalo1`; no files or deployment settings in `Fiskalo1` are modified.

## Scope

- Owner and cashier access
- Business and POS setup
- Product catalogue with official ATK unit, item-category and VAT mappings
- POS checkout and payment recording
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
- [x] Automatic ATK TEST Sale submission after payment when a verified POS, matching TEST certificate and paired local POS Agent are available
- [x] Accepted ATK TEST response is persisted only when a valid transaction ID is returned
- [x] Windows POS Agent source: local DPAPI key storage, encrypted fiscal queue, ATK TEST client and thermal printer support
- [x] Browser-session restoration for the paired local POS Agent
- [x] Migrations 0004–0006 are documented as applied to the existing Supabase project `zikos`; migrations 0014–0019 are committed but have not been executed against the database. Treat database migration execution and authenticated RLS integration testing as separate release gates.
- [x] Full-cancellation/full-return UI, local-agent signing/submission, encrypted queue and manual reconciliation source (migrations 0015 and 0018–0019 committed but not applied; ATK TEST Cancel/Return acceptance and authenticated database integration evidence remain outstanding; partial returns/refunds are not supported)
- [x] Basic inventory ledger, supplier purchases and expenses source (migrations 0016–0017 committed; not applied; owner/RLS integration tests remain open)
- [ ] Official ATK unit/category dropdown catalogue with source/version evidence
- [ ] Apply and verify migrations 0014–0019 on an approved staging database; run SQL contract tests 0014–0019 and authenticated tenant-isolation tests
- [ ] Complete ambiguous-submission reconciliation UI and authority-request export
- [ ] Verify full Cancel/Return against ATK TEST, including duplicate retries, definitive rejection and ambiguous-response reconciliation
- [ ] Verify physical POS installation, printer, offline recovery and ATK TEST acceptance
- [ ] Cloudflare deployment and live smoke tests

The app supports the ATK TEST Sale path and now contains source for full Cancel/Return submission and reconciliation. The correction migrations are not applied and no ATK TEST Cancel/Return acceptance has been evidenced. Official catalogue dropdowns, authority exports, Android support, live deployment and production submission are not complete. Basic inventory, purchases and expenses are implemented in source but remain unavailable until migrations 0016–0017 are applied and verified. The Basic core migrations are applied to `zikos` under the isolated `fiskalo_basic_*` namespace; migrations 0014–0019 are not applied. The current database catalog check found no direct anon/authenticated table grants on `fiskalo_private.fiskalo_basic_daily_counters`, and the private schema is not exposed through PostgREST; its RLS-disabled advisor warning still requires an explicit policy review. These changes do not alter the existing `fiskalo_*`, `dhuroje_*`, `sjelle_*`, `kafja_*` or `mikrotekos_*` tables. A paid sale is marked fiscalized only after ATK returns an accepted response with a valid transaction ID and the database persists it.

A successful build or TEST coupon is not ATK certification. Production fiscalization stays disabled until the provider and solution are authorized/certified and production credentials are issued.

## Database security migration

Migration `supabase/migrations/0004_fiskalo_basic_security_hardening.sql` has been applied to Supabase project `zikos`; its catalog/privilege regression script passed there. The private helper schema must remain outside the exposed Data API schemas. Full authenticated owner/cashier and cross-tenant RLS integration tests are still required before enabling cashier provisioning.
