# Fiskalo — Basic + Full Kosovo fiscalization platform

Fiskalo is the Kosovo fiscalization application in this repository (not Fiskalo1). The existing Basic Agent and Basic Cloud implementations remain intact. The Full business workspace is restored as a separate authenticated application, with explicit navigation between editions.

## Product routes

- `/` — **Basic Agent**: the existing Windows POS Agent runtime and local fiscal queue.
- `/basic` — **Basic Cloud**: the existing browser-based Basic POS and ATK TEST gateway.
- `/app` — **Fiskalo Full** workspace picker.
- `/app/[organizationId]` — Full business dashboard and modules: invoices, customers, products, POS, cashier shifts, purchases, expenses, inventory, team, and reports.
- `/login`, `/register`, `/onboarding`, `/account` — Full edition authentication and account workflows.

The Full and Basic editions use separate data models: `fiskalo_*` for Full and `fiskalo_basic_*` for Basic. They share the existing Supabase project only as isolated tables/functions; there is no implicit cross-edition record synchronization. Links in both Basic headers and the Full workspace navigation make the editions selectable without replacing the existing Basic routes.

## Full edition security and release boundaries

- Full ATK routes under `/api/atk/test/*` target the ATK TEST service only. A successful local build or TEST response is not certification or production acceptance.
- Full sale and adjustment routes authenticate the caller, check organization membership/role and taxpayer NUI, validate the signed payload against the registered POS certificate, and write fiscal acceptance through the server-only service-role client.
- Configure `SUPABASE_SERVICE_ROLE_KEY` only as a server-side secret. Never expose it through a `NEXT_PUBLIC_*` variable. The routes fail closed when it is missing.
- Full POS keys are non-exportable browser CryptoKeys persisted in IndexedDB. This is not equivalent to an OS/hardware-backed keystore and remains a certification/security review item.
- Full checkout does **not** issue fiscal receipts while disconnected. It can retain an order draft, but the UI blocks treating an offline payment as an accepted fiscal sale. The Basic edition has its own offline implementation.
- The connected `zikos` project already contains the Full schema and the server-trusted fiscal-write, invoice-line snapshot, certificate-binding, CitizenCoupon QR and correction migrations. This repository still does not contain the complete historical Full schema baseline; a clean, empty-project Full installation is not yet reproducible from this repository alone.
- The Full ATK category-constraint expansion to the current catalogue is included in this change set but must be applied through the reviewed additive migration before using newly added category codes in the connected Full database. Existing data is preserved.
- Provider/developer registration, ATK software certification, the unique SEF code, production credentials, and real ATK TEST acceptance remain external release gates. Production fiscalization is not enabled by this source change.

## Implemented in source

- Owner and cashier access, business and POS setup.
- Basic product catalogue, checkout, stock deduction and sale history.
- Official ATK unit, VAT and item-category dropdowns; all 53 published category rows (52 unique codes, with the duplicated PM code labels combined) and a matching database category constraint.
- Online and local-first offline checkout using the paired Windows POS Agent.
- Mixed-tender payments: cash, card, bank transfer, voucher, cheque and cryptocurrency, with integer-cent reconciliation and idempotent online/offline writes.
- ATK TEST Sale submission when the POS, certificate and local Agent are correctly paired.
- ATK coupon signing, NUIKF, QR payload and receipt generation.
- RKS MF receipt mark, OFFLINE marking, business/operator identity, SEF identifier, daily number and transaction details.
- DPAPI-protected local private key and encrypted local fiscal queue.
- Pre-reserved CouponIds and Kosovo-local daily-number ranges for offline issuance.
- Background delivery, safe retry, ambiguous-result reconciliation and cloud synchronization.
- Article 44 owner workflow: outage register, 48-hour notice tracking, private evidence storage, 10th-of-following-month un-fiscalized coupon export and manual submission record.
- Server-side verification of POS Agent attestations before offline queue/ATK acceptance records are written.
- Basic inventory, supplier purchases and expense source.

## Verified against the live Supabase project

The existing Supabase project `zikos` was inspected directly. Its migration ledger contains the earlier Fiskalo Basic/Full feature migrations and the offline fiscalization migrations.

The following new migrations have also been applied to the live project and their SQL regression scripts executed:

- `0025_fiskalo_revoke_trigger_function_api_execute.sql` — removes direct API execution from trigger-only helper functions.
- `0026_fiskalo_basic_article44_incident_register.sql` — owner-only Article 44 incident and private evidence register.
- `0027_fiskalo_basic_article44_monthly_untransmitted_submission.sql` — 48-hour restoration rule and monthly submission evidence.
- `0028_fiskalo_basic_article44_unfiscalized_export.sql` — export of every unaccepted offline document, including rejected documents.
- `0029_fiskalo_basic_split_payment_allocations.sql` — validated split-tender online/offline checkout and synchronization.
- `0030_fiskalo_article44_scope_and_offline_payment_integrity.sql` — limits Article 44 exports to eligible internet interruptions and hardens offline payment retry checks.
- `0031_fiskalo_article44_deadline_boundary.sql` — fixes the exact midnight boundary after the 10th day.
- `0032_fiskalo_article44_monthly_export_proof_guard.sql` — enforces both the JSON/CSV export and actual ATK filing proof at the database boundary.
- `0033_fiskalo_basic_complete_atk_item_categories.sql` — enforces all 52 unique codes from the 53-row 2026 ATK category annex.
- `0033_fiskalo_basic_complete_atk_item_categories.sql` — expands the product category constraint to all 52 unique 2026 ATK codes.

Temporary, rolled-back Supabase integration checks exercised online and offline split tender, idempotent retries, rejection of changed payment allocations, Article 44 incident creation, export authorization, deadline enforcement and evidence requirements. No test business or sale records were retained.

The repository's older numbered migration files do not all share the timestamp/version identifiers in the live Supabase migration ledger. For a fresh installation, migration-history reconciliation and a clean-database replay are still required; do not assume that copying only the latest migrations creates the full existing `zikos` schema.

## Remaining release gates

- Confirm the unit, VAT and category catalogues against every subsequent ATK publication and run representative product/coupon scenarios in the official ATK TEST environment.
- Cancellation and return POS screens, with end-to-end ATK TEST correction/return scenarios.
- Full application UI restoration and a safe selectable Full/Basic launcher.
- Server-signed connectivity heartbeat so outage start and the 48-hour clock are independently verifiable; the Article 44 page currently records the owner-reported start time.
- Actual ATK TEST acceptance using ATK-issued certificates and registered POS devices, including QR scan/verification and exactly-once transaction confirmation.
- Certificate-chain trust anchor, expiry, renewal and revocation validation against ATK's current process.
- Physical printer testing across supported thermal widths, offline receipt verification and restart/recovery tests.
- Cloudflare production deployment and live smoke tests for the exact latest commit.
- Clean-database migration replay, authenticated owner/cashier RLS tests and tenant-isolation tests.
- Provider/software certification and production authorization.

## Compliance boundary

A passing build, internal signature test or single accepted TEST coupon is not ATK certification. Production fiscalization remains disabled until ATK has approved the provider and software and production credentials are issued.

See:
- [Article 44 implementation and limits](docs/ATK-ARTICLE-44.md)
- [Offline fiscalization architecture](docs/ATK-OFFLINE-ARCHITECTURE.md)
- [Basic MVP scope](docs/ATK-MVP-SCOPE.md)
- [Official ATK C# POS sample](https://github.com/fiskalizimi/pos-csharp)
