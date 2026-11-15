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
- Basic receipts, owner-only sales/VAT reports and authority-requested untransmitted-coupon export (CSV/PDF)

The Full app contains the broader business-operation modules. Formal ATK certification, production submission, Android-native fiscal signing, and complete local-first offline checkout remain release gates.

## Compliance boundary

A successful build or TEST coupon is not ATK certification. Production fiscalization stays disabled until the provider and solution are authorized/certified and production credentials are issued. See `docs/ATK-MVP-SCOPE.md`.


## Current implementation state

**Full app**
- [x] Full business workspace restored at `/app/[organizationId]`: invoices, customers, products, suppliers/purchases, expenses, inventory, team, cashier shifts, reports, provider and platform administration, Web POS and printer settings.
- [x] Full POS setup uses browser-held P-256 keys and same-origin Cloudflare ATK TEST routes; no localhost POS agent is part of the supported runtime.
- [x] Full product editor uses the 21-code ATK unit catalogue (29.09.2026) and the 35-code May 2026 category annex; Full coupon validation rejects invalid unit/category/VAT mappings.
- [x] Full invoice payment ledger and POS support Cash, CreditCard, Voucher, Cheque, CryptoCurrency and Other (bank transfer); repeated installments are aggregated by ATK PaymentType.
- [x] Full ATK server routes now use a server-only Supabase client for verification and fiscal journal writes; CSR-to-certificate SPKI matching and per-POS certificate signature verification are implemented in source.
- [ ] Apply the Full server-trusted fiscal-write migration in `supabase/full-migrations/`; until applied, the existing Full RLS policies still allow authenticated direct writes to fiscal status/event tables.
- [ ] Deploy and live-test Full ATK TEST verification, certificate issuance, Sale, Cancel and Return.

**Basic app**
- [x] Separate `fiskalo_basic_*` business/POS schema, owner/cashier roles and Cloudflare ATK TEST gateway.
- [x] Browser-generated non-exportable P-256 POS keys, certificate/SPKI matching, Protobuf signing and trusted ATK acceptance journal.
- [x] AES-256-GCM encryption at rest for the Basic signed fiscal outbox and POS outage metadata, with a non-exportable browser-held storage key and migration of legacy plaintext outbox rows.
- [x] Official ATK unit/category/VAT validation in the Basic product editor and coupon pipeline.
- [x] Sale, Cancel and full Return recovery worker source with idempotency, signature checks and ambiguity/reconciliation handling.
- [x] Exact-cent split-tender allocation helper and checkout UI.
- [x] Owner-only sales/VAT reports with Kosovo timezone/DST-safe date filters and CSV export; read-only report RPC is migration 0032.
- [x] Article 26(4) authority-requested untransmitted-coupon export: owner-only, request-reference gated, audited, with signed POS/CitizenCoupon evidence in CSV and print-to-PDF; migration 0033.
- [x] POS-wide connectivity outage clock persisted in IndexedDB; subsequent queued coupons share the first observed outage timestamp and 48-hour deadline.
- [ ] Apply and verify Basic catalogue constraints (migration 0030) and split-tender RPC (migration 0031).
- [ ] Complete genuinely local-first disconnected checkout. The current outbox/recovery source does not yet prove a sale can be completed while Supabase and the internet are unavailable.
- [ ] Complete genuinely local-first disconnected checkout. The current checkout still calls Supabase before the offline branch, so it cannot create a new sale when internet/Supabase is unavailable.
- [ ] Implement the Article 44 notification/evidence path and operational deadline escalation; the outage clock is implemented, but full offline sale issuance and ATK recovery evidence are not.
- [x] Document Article 45 approved pre-numbered paper-booklet fallback; operational workflow remains to be built.

**Shared Supabase project**
- The existing `zikos` project already contains the Fiskalo Full schema and the Basic core, checkout, ATK acceptance, offline receipt, business operations and atomic purchase migrations. It also contains the PR #12 server acceptance, recovery queue, POS certificate and correction migrations.
- This repository is not the complete migration history for the shared `zikos` project, which also hosts other applications. Do not run a generic `supabase db push` from this partial repository. Apply only reviewed additive Fiskalo migrations through the connected Supabase project and record the returned migration version in this repository.
- Pending database work: Basic migrations 0030–0033 and the Full migration draft under `supabase/full-migrations/`. CI applies migrations 0001–0034 to a disposable PostgreSQL instance and runs SQL security contracts; this does not mean they have been applied to the shared `zikos` project. Migration 0034 (trigger-only RPC hardening) was separately applied and verified on the shared project on 15 November 2026.

A successful build or ATK TEST coupon is not ATK certification. Production fiscalization remains disabled until the developer/software solution is registered and certified, the unique SEF code is integrated as ATK specifies, and production credentials are issued. Real ATK TEST acceptance and a Cloudflare deployment are still required release gates.

