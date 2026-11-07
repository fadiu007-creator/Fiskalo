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

## Current status
This repository starts as a clean MVP shell. UI authentication is connected to Supabase when environment variables are supplied. The full checkout, schema, ATK endpoint workflow, device journal and physical test acceptance are not yet implemented. No production compliance claim is made.
