# Fiskalo Full + Basic application layout

## Application entry points

- `/` — public landing page.
- `/app` — authenticated Full business/provider workspace picker.
- `/app/[organizationId]` — Fiskalo Full business dashboard.
- `/basic` — Fiskalo Basic POS/business application.
- `/app/[organizationId]/basic` — compatibility redirect to `/basic`.

The Full workspace navigation and Basic workspace header link to the other application. The landing page exposes both entry points.

## Data isolation

- Full uses the existing `fiskalo_*` organization/invoice/customer/supplier/purchase/expense/inventory/team/reporting schema.
- Basic uses the isolated `fiskalo_basic_*` schema and its own fiscal sale/document journal.
- Both continue using the existing Supabase project `zikos`; no new Supabase project is created.
- Full and Basic records are not implicitly merged. A business owner must configure the relevant business identity in each app. A later tenant-mapping migration must explicitly map the same legal taxpayer identity before any cross-app synchronization is allowed.

## Full modules restored

The Full route tree restores the business dashboard, invoices and invoice adjustments, customers, expenses, inventory and stock adjustments, supplier purchases, team management, cashier shifts and shift reports, daily and audit reports, Web POS, POS setup, provider workspace, platform administration, account/auth pages, thermal-printer settings and fiscal QR components.

The browser key vault and Full ATK TEST routes are restored and hardened in the current feature branch. Verification and fiscal-state writes use the server-only Supabase service role; the CSR route binds the returned certificate to the submitted CSR and stores its public certificate in a server-only POS registry; Sale and adjustment routes verify the signature against that exact registered POS certificate before contacting ATK. The companion SQL migration is drafted under `supabase/full-migrations/` but has not yet been applied to `zikos` or deployed. Production remains disabled.

## Runtime constraints

- Cloudflare Workers is the only supported web deployment target.
- Full ATK verification, CSR issuance, coupon submission and adjustment submission use same-origin server routes that call ATK TEST; no browser request to `127.0.0.1:17843` is supported.
- The legacy Windows POS agent is not part of the supported architecture and must not be reintroduced as a runtime dependency.
- Browser-local private keys are non-exportable but browser-profile storage is not equivalent to a hardware-backed keystore. The certification dossier must describe the limitation and the approved key-management model.

## Remaining integration work

1. Apply and verify the server-trusted Full fiscal-write migration, then test certificate registration, signature verification, immutable submission journal, idempotency and ambiguous-outcome reconciliation against ATK TEST.
2. Validate Full invoice-to-coupon mapping for item discounts, invoice-level discounts, partial payments, mixed tenders, returns and exchanges against the current ATK 2026 contract.
3. Validate the 21-unit catalogue (29.09.2026) and 35-category technical annex in Full product forms and database triggers; server coupon validation rejects legacy invalid codes.
4. Reconcile the two business profiles by taxpayer NUI only through an explicit owner-authorized mapping workflow; never infer a match from business name.
5. Complete local-first offline checkout and pre-reserved coupon numbering for both apps, including the Article 44 outage-start deadline and Article 45 paper-booklet fallback.
6. Verify provider/developer registration, software certification and unique SEF code before enabling production.
