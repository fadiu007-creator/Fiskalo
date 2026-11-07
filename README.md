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
- [x] Apply and verify the isolated `fiskalo_basic_*` migrations in Supabase project `zikos` (2026-11-07); RLS is enabled on all seven tables and authenticated RPC grants were verified
- [ ] Implement and test ATK Cancel and Return flows (not just Protobuf model support)
- [ ] Official ATK unit/category dropdown catalogue with source/version evidence
- [ ] Complete ambiguous-submission reconciliation UI and authority-request export
- [ ] Verify physical POS installation, printer, offline recovery and ATK TEST acceptance
- [ ] Cloudflare deployment and live smoke tests

The app currently supports a TEST sale submission path only. Cancel/Return UI, official catalogue dropdowns, authority exports, Android support, live deployment and production submission are not complete. The database migrations are applied to `zikos` under the isolated `fiskalo_basic_*` namespace; this does not alter the existing `fiskalo_*`, `dhuroje_*`, `sjelle_*`, `kafja_*` or `mikrotekos_*` tables. A paid sale is marked fiscalized only after ATK returns an accepted response with a valid transaction ID and the database persists it.

A successful build or TEST coupon is not ATK certification. Production fiscalization stays disabled until the provider and solution are authorized/certified and production credentials are issued.

## Database security migration

Migration `supabase/migrations/0004_fiskalo_basic_security_hardening.sql` has been applied to Supabase project `zikos`; its catalog/privilege regression script passed there. The private helper schema must remain outside the exposed Data API schemas. Full authenticated owner/cashier and cross-tenant RLS integration tests are still required before enabling cashier provisioning.
