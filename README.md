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
