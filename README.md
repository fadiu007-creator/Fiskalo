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
- [x] Basic business onboarding RPC and isolated schema
- [x] Product catalogue UI and basic ATK mapping fields
- [x] POS checkout UI with atomic stock deduction and payment recording
- [x] ATK Protobuf encoder
- [x] Windows POS Agent source: local DPAPI key storage, encrypted fiscal queue, ATK TEST client and receipt printer support
- [ ] Apply and verify the new `fiskalo_basic_*` migrations in the intended Supabase project
- [ ] Connect paid web checkout to the local agent
- [ ] Complete end-to-end Sale, Cancel and Return coupon workflows
- [ ] Verify physical-device offline recovery, printer and ATK TEST acceptance
- [ ] Authority-request export workflow
- [ ] Cloudflare deployment and live smoke tests

The application currently records paid sales internally but does **not** claim that they have been fiscalized. Do not use for production fiscalization until all release gates are met.
