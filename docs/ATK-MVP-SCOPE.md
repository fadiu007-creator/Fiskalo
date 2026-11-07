# Fiskalo Basic ATK MVP

## Goal
Deliver the smallest maintainable product that can complete ATK's required onboarding and fiscal coupon test scenarios, while retaining mandatory record integrity and offline protections.

## Included
- One responsive web application and one primary local POS runtime for the first certification track.
- Owner/Cashier access; one business workspace.
- Minimal product catalogue: name, price, stock and ATK unit/category/VAT mappings.
- POS sale, payment capture and receipt.
- ATK onboarding per POS: identifiers, local key generation, CSR, certificate matching.
- Signed ATK Sale, Cancel and Return documents linked to original sales.
- Durable encrypted offline fiscal journal, safe automatic recovery and ambiguous-submission reconciliation.
- Restricted authority-request CSV/PDF export of untransmitted fiscal records.
- Basic sales, VAT and fiscal transmission status.

## Explicitly deferred
- Supplier/purchase management and supplier payment ledger.
- Advanced stock movement workflows.
- Subscription plans, billing and product limits.
- ARBK registry lookup.
- Advanced shift/cash reconciliation and internal X/Z reporting.
- Multi-client feature parity (independent Web, Android and Windows fiscal engines).
- Advanced audit exports beyond the required fiscal journal and authority workflow.

## Non-negotiable safeguards
- Private keys never leave the POS device and are never stored in Supabase or Cloudflare secrets.
- Each POS has its own key/certificate and stable identifiers.
- Original fiscal records are immutable; corrections append linked documents.
- An uncertain submission is reconciled before retry; no blind duplicate submission.
- A coupon is marked fiscalized only after ATK returns a valid accepted transaction ID and the response is durably saved.
- Production submission remains disabled until the provider and software solution receive formal ATK authorization/certification and production credentials.

## Acceptance sequence
1. ATK TEST taxpayer/application/POS verification.
2. CSR and certificate issuance on the selected physical POS; public key must match local private key.
3. One accepted Sale with saved transaction ID.
4. Accepted Cancel and Return referencing original accepted Sale as required by ATK.
5. Offline sale retention, reconnection recovery and duplicate/timeout reconciliation.
6. Receipt comparison against current official ATK format.
7. Authority-request export access-control test.
8. ATK portal verification and formal certification application evidence.

## Security hardening delivered in migration 0004

Migration `0004_fiskalo_basic_security_hardening.sql` narrows the database trust boundary:
- Owners alone can create or change POS configuration and product catalogue rows; cashiers retain read access for checkout.
- Authenticated clients cannot directly insert/update/delete sales, sale lines or fiscal documents. Paid checkout and accepted ATK response persistence remain routed through validated RPCs.
- Privileged database implementations are moved into the non-exposed `fiskalo_private` schema. Public RPC entry points are SECURITY INVOKER wrappers; private helpers require `auth.uid()` and are executable only by authenticated users.
- The old column-level direct permission to update a sale's fiscal status is explicitly revoked.
- `supabase/tests/0004_fiskalo_basic_security_hardening.sql` checks the resulting grants and function placement.

**Deployment status (2026-11-07):** migration 0004 is applied to the existing Supabase project `zikos`. The privilege regression SQL completed successfully against that database. The `fiskalo_private` schema is not in the configured exposed-schema override (the setting is unset, leaving the Supabase default exposed schemas); keep it out of any future exposed-schema list. This catalog test does not replace authenticated owner/cashier and cross-tenant RLS integration tests. The current UI still does not provide a complete owner-managed cashier invitation workflow; role provisioning needs its own secure implementation and tests.

## Current status

Implemented in the clean repository:
- Web owner login and business onboarding against isolated Supabase tables.
- Minimal product and POS configuration.
- Atomic paid checkout with stock deduction and sale-line snapshots.
- Windows local POS Agent with DPAPI-protected signing key, matching-certificate validation, encrypted fiscal queue, idempotency and ATK TEST submission.
- Web ATK TEST onboarding: one-time local-agent pairing, ATK POS verification, CSR/certificate request and certificate status persistence.
- Web paid-sale path: builds the ATK Sale coupon, submits through the local agent and stores the accepted response only when a valid transaction ID is returned.

Not yet complete:
- ATK Cancel and Return workflows and their end-to-end acceptance tests.
- Verified official unit/category catalogue and dropdowns. The sample integration repository demonstrates payload values but is not itself a complete current ATK catalogue.
- Complete browser/operator reconciliation and authority-request export.
- Apply migration 0004 and run its privilege regression test; then execute authenticated owner/cashier cross-tenant RLS integration tests.
- Physical POS tests for Windows installation, printer output, offline recovery and duplicate/timeout scenarios.
- ATK provider/software certification and production credentials.

The app must not be described as fully ATK-compliant or certified until the required ATK tests pass and formal authorization is granted. Production submission remains disabled.
