# Fiskalo — Basic ATK MVP

Kosovo fiscalization software focused on owner/cashier workflows, ATK TEST coupons, signed receipts, online/offline checkout, reconciliation and reporting.

## Product and repository status

This repository's current `main` application is the **Basic MVP**. It remains separate from `Fiskalo1`; no files or deployment settings in `Fiskalo1` are modified.

The Full application UI is not yet integrated into `main`. A substantial Full/Basic release-candidate branch exists, but it cannot be merged blindly because it removes or replaces the current Windows POS Agent and offline implementation. The Full UI must be reconciled with the current Basic implementation before a selectable Full/Basic launcher can be considered complete.

Current route map:
- `/` — **Basic Agent**: the local Windows POS Agent runtime with DPAPI-protected signing key and local fiscal queue.
- `/basic` — **Basic Cloud**: the browser-based signing runtime using the Cloudflare ATK TEST gateway. It is a second Basic implementation, not the Full edition.
- The Full application UI is still absent from `main`; navigation between these two Basic routes does not complete the Full/Basic release selector.

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

The connected Supabase project (`saavqlbwffrwxingbnri`) was verified to contain the two signed-heartbeat migrations in its migration ledger. The earlier Basic/Full and offline-fiscalization migrations below are historical project documentation; their presence in this connected project's ledger has not been re-verified in this release check. Do not treat this list as proof that a fresh database is fully provisioned.

Migrations documented by the project include:

- `0025_fiskalo_revoke_trigger_function_api_execute.sql` — removes direct API execution from trigger-only helper functions.
- `0026_fiskalo_basic_article44_incident_register.sql` — owner-only Article 44 incident and private evidence register.
- `0027_fiskalo_basic_article44_monthly_untransmitted_submission.sql` — 48-hour restoration rule and monthly submission evidence.
- `0028_fiskalo_basic_article44_unfiscalized_export.sql` — export of every unaccepted offline document, including rejected documents.
- `0029_fiskalo_basic_split_payment_allocations.sql` — validated split-tender online/offline checkout and synchronization.
- `0030_fiskalo_article44_scope_and_offline_payment_integrity.sql` — limits Article 44 exports to eligible internet interruptions and hardens offline payment retry checks.
- `0031_fiskalo_article44_deadline_boundary.sql` — fixes the exact midnight boundary after the 10th day.
- `0032_fiskalo_article44_monthly_export_proof_guard.sql` — enforces both the JSON/CSV export and actual ATK filing proof at the database boundary.
- `0033_fiskalo_basic_complete_atk_item_categories.sql` — expands the product category constraint to all 52 unique 2026 ATK codes.
- `20261117160000_fiskalo_atk_pos_heartbeat_evidence.sql` — verified in the connected project's migration ledger; creates the append-only server heartbeat evidence ledger and service-role-only recording RPC.
- `20261117160100_fiskalo_basic_offline_heartbeat_binding.sql` — verified in the connected project's migration ledger; binds offline fiscal document timestamps and recovery deadlines to trusted server heartbeat intervals.

Temporary, rolled-back Supabase integration checks exercised online and offline split tender, idempotent retries, rejection of changed payment allocations, Article 44 incident creation, export authorization, deadline enforcement and evidence requirements. No test business or sale records were retained.

The repository's older numbered migration files do not all share the timestamp/version identifiers in the live Supabase migration ledger. For a fresh installation, migration-history reconciliation and a clean-database replay are still required; do not assume that copying only the latest migrations creates the full existing `zikos` schema.

## Remaining release gates

- Confirm the unit, VAT and category catalogues against every subsequent ATK publication and run representative product/coupon scenarios in the official ATK TEST environment.
- Cancellation and return POS screens, with end-to-end ATK TEST correction/return scenarios.
- Full application UI restoration and a safe selectable Full/Basic launcher.
- Server-signed POS heartbeat implementation is merged to `main` (merge commit `35f5fa9448ba1cf20f4fe7734939e893caa5ec33`). The P-256 public key is pinned in the browser, server and Windows Agent; the private signing key must remain a Cloudflare secret. CI and Windows Agent checks passed on this commit. Live Cloudflare deployment and authenticated heartbeat/evidence verification remain unverified. A heartbeat gap proves missing POS check-ins, not by itself an ISP outage or an Article 44-qualifying cause.
- Actual ATK TEST acceptance using ATK-issued certificates and registered POS devices, including QR scan/verification and exactly-once transaction confirmation.
- Certificate-chain trust anchor, expiry, renewal and revocation validation against ATK's current process.
- Physical printer testing across supported thermal widths, offline receipt verification and restart/recovery tests.
- Cloudflare production deployment and live smoke tests for the exact latest commit. The repository CI builds the Cloudflare Worker but does not deploy it.
- Clean-database migration replay, authenticated owner/cashier RLS tests and tenant-isolation tests.
- Provider/software certification and production authorization.

## Compliance boundary

A passing build, internal signature test or single accepted TEST coupon is not ATK certification. Production fiscalization remains disabled until ATK has approved the provider and software and production credentials are issued.

See:
- [Article 44 implementation and limits](docs/ATK-ARTICLE-44.md)
- [Offline fiscalization architecture](docs/ATK-OFFLINE-ARCHITECTURE.md)
- [Basic MVP scope](docs/ATK-MVP-SCOPE.md)
- [Official ATK C# POS sample](https://github.com/fiskalizimi/pos-csharp)
