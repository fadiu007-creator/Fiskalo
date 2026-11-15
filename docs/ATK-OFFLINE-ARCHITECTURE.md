# Fiskalo offline-first fiscalization architecture

## Scope and compliance boundary

This is the target architecture and implementation checklist for full-connectivity-loss POS operation. It is not an ATK certification or legal opinion. Production fiscalization remains disabled until ATK has approved the software solution, protocol, certificates, offline workflow, and production credentials.

The Windows POS Agent is a device-side signing and encrypted-queue component. The Cloudflare-hosted application is not a substitute for a local device runtime: a Cloudflare Worker cannot access a POS private key while the device is disconnected, and browser IndexedDB is not a secure replacement for an OS-protected signing key.

## Target topology

1. **POS PWA (Cloudflare):** online application shell, cached static assets, online/offline state.
2. **Local checkout journal (IndexedDB):** immutable sale snapshots committed before network requests. UUID idempotency keys, integer minor-unit money, product/VAT/ATK mappings. Never store card PAN/CVV, passwords, access tokens, or private keys.
3. **Device fiscal runtime:** Windows POS Agent initially; future Android/iOS runtimes. Owns POS signing key, ATK certificate, local daily-number allocation, signed POS/CitizenCoupon construction, encrypted journal, printer access, and ATK transport.
4. **Cloudflare Worker:** authenticated API, checkout synchronization, server-side validation, tenant authorization. It is not the offline queue and must not hold POS private keys.
5. **Supabase:** central sale ledger, stock reconciliation, fiscal-document ledger, immutable accepted ATK response. Server RPCs remain the cross-device idempotency boundary.
6. **ATK:** sole authority for fiscal acceptance and official transaction identifiers.

## Separate state machines

Cloud synchronization and fiscal acceptance are independent: a sale may be fiscally accepted while cloud sync is pending.

- Cloud: `pending -> synced` or `pending -> conflict`.
- Fiscal: `not_prepared -> queued -> accepted`, `queued -> rejected`, or `queued -> needs_reconciliation`.
- `needs_reconciliation` is a hard stop. A timeout, connection reset after request transmission, or agent restart during submission is ambiguous and must never trigger blind resubmission.
- Mark a document accepted only with a positive uint64 transaction ID and trusted ATK response. Browser-supplied JSON is not proof of acceptance.

## Offline checkout protocol

1. Cache a versioned business/POS/operator/product/tax-profile snapshot while online, including prices, VAT rates, and ATK unit/category/VAT codes.
2. Validate the cart against that snapshot; persist integer-cent totals and line-level rounding.
3. Commit the sale snapshot to IndexedDB before showing checkout success. Reuse one UUID idempotency key across retries and restarts.
4. The local fiscal runtime validates its enrolled business/branch/POS/application identity and certificate/key binding. It allocates a unique daily receipt number from a durable per-POS counter under ATK-approved numbering rules, constructs/signs the POS coupon and CitizenCoupon, and atomically persists the signed document in its encrypted local journal before returning a fiscal receipt.
5. If ATK is reachable, submit. If definitely unreachable before request delivery, retain and retry with bounded backoff. If outcome is uncertain, lock for reconciliation.
6. On reconnection, synchronize sales in creation order using the same idempotency keys. Identical duplicate requests return the existing sale; a reused key with different content is rejected.
7. Synchronize accepted fiscal response/transaction ID separately. Reconcile stock conflicts explicitly; never rewrite the immutable offline snapshot.
8. Display pending-cloud, queued-for-ATK, accepted, rejected, overdue, and needs-reconciliation states.

## Network-loss cases

| Failure | Required behavior |
| --- | --- |
| ATK unavailable, cloud reachable | Local runtime signs and journals; submit later |
| Internet unavailable, local runtime available | Local sale and fiscal journals operate without cloud |
| Cloudflare/Supabase unavailable, ATK reachable | Local runtime can submit; cloud sync waits |
| Connection refused before request delivery | Queue and retry |
| Request may have been committed by ATK | Reconcile; no automatic retry |
| Device power loss | Recover encrypted journal; in-flight submissions require reconciliation |
| Local storage unavailable/full | Fail closed; do not claim a durable sale |
| Stock changed while offline | Preserve original snapshot; controlled conflict reconciliation |

## Security requirements

- Per-POS private key/certificate in OS-protected storage; never upload private key to Cloudflare/Supabase.
- IndexedDB is a durability buffer, not tamper-proof storage. It can be cleared or evicted.
- Pairing tokens are short-lived, revocable, POS-scoped, and protected against CSRF, origin spoofing, replay, and local-network/host-header abuse.
- Cloud sync authenticates operator and validates tenant membership, POS ownership, product mappings, and idempotency server-side.
- Never accept client-asserted ATK transaction IDs as fiscal acceptance evidence.
- Retain encrypted signed fiscal documents until authoritative acceptance/reconciliation; never discard overdue records.
- Do not store card sensitive authentication data in the offline journal.

## 48-hour recovery controls

Persist the first observed connectivity interruption and each offline issue timestamp. Each document retains its own recovery deadline. Retry only when transport evidence proves the request was not delivered; alert before/at deadline and retain overdue records. The deadline is not permission to delete a record or retry an ambiguous submission. Confirm the exact legal clock and outage evidence against the current ATK specification and written ATK guidance.

## Current repository gap assessment

Existing:
- Windows DPAPI-protected signing key, certificate matching, encrypted fiscal queue.
- Signed ATK TEST POS/CitizenCoupon generation and QR material.
- Retry classification distinguishing definitely-not-sent from ambiguous outcomes.
- Queue reconciliation endpoint and 48-hour deadline metadata.
- Cloud checkout idempotency and offline fiscal-document persistence RPCs.

Still required for true full-offline operation:
- Checkout now writes an immutable IndexedDB snapshot before its first network-dependent operation. It preserves the same checkout idempotency key after network failure and can restore the most recent pending snapshot after a browser restart.
- When cloud checkout succeeds, the local journal records the server sale/coupon linkage. Fiscal queue state is tracked separately and is updated from the local agent's ATK submission outcome.
- **Still not full offline fiscal checkout:** the current POS flow still needs a cloud-created sale/coupon ID and database-assigned daily number before it can construct the signed ATK coupon. When internet is unavailable, Fiskalo preserves the checkout intent locally but does not yet issue a signed fiscal receipt. The UI must not present this as a completed or ATK-fiscalized sale.
- The browser bridge calls `http://127.0.0.1:17843`; this is a device-local signing bridge, not a Cloudflare endpoint. It must be treated as an explicit local-runtime integration, not replaced with a cloud API.
- Durable local daily coupon-number allocation/reservation under ATK's exact numbering rules.
- Device-side, ATK-approved daily coupon-number and coupon-ID reservation that is collision-safe against cloud-issued numbers.
- Link and persist a signed offline document to its local sale before reporting fiscal completion.
- Reconnection workflow to upload the original sale and signed document idempotently; current browser journal only restores the checkout for an operator retry and does not yet auto-create the cloud sale.
- Android/iOS secure keystore/runtime; current agent targets Windows.
- Explicit handling/tests for IndexedDB eviction/quota, clock manipulation, concurrent tabs, and device loss.
- Official ATK TEST verification and formal certification for offline workflow.

## Acceptance test matrix

1. Sale survives Wi-Fi loss, page reload, browser restart, and Windows Agent restart.
2. Exactly one local daily number per POS/business day, including concurrent attempts.
3. Signed POS/CitizenCoupon VerificationNo/NUIKF match; QR verifies with official ATK test verifier.
4. Restore connectivity and verify automatic delivery inside applicable 48-hour window.
5. Connection refusal before request delivery safely retries.
6. Timeout after transmission locks for reconciliation; no duplicate submit.
7. Same checkout key/body produces one sale and one stock deduction.
8. Same key with altered lines/payment/totals is rejected.
9. Stock changes during outage produce explicit conflict without rewriting receipt.
10. Full/denied local storage fails closed.
11. Tenant isolation, POS identity binding, revocation, and no private key/token/card-data upload.
12. Physical printer/QR tests and ATK formal acceptance of offline workflow.

## Release gate

Do not describe Fiskalo as production ATK-compliant based on unit tests or one accepted TEST coupon. Release requires current protocol conformance, official offline acceptance sequence, 48-hour evidence, physical POS tests, provider/software registration, and formal authorization for production credentials.

### Number reservation foundation (migration 0018)

Implemented on the offline branch:
- Authenticated, POS-scoped RPC reserves individual CouponIds from the same PostgreSQL sequence used by online checkout. Individual IDs are returned rather than assuming a contiguous block, because multiple online/offline POS devices may interleave sequence allocation.
- Coupon reservation rows are immutable to authenticated clients; a separate RPC consumes a reserved ID once and binds it to a UUID idempotency key. Repeating the same consume request is idempotent; a different checkout cannot reuse it.
- Business-owner-authorized, POS-scoped RPC reserves a contiguous daily-number interval by atomically advancing the existing per-POS/per-Kosovo-business-date counter. The online sale trigger and offline reservation RPC therefore share the same counter.
- Reservations require a business member and a POS belonging to that business with a verified/issued certificate. Counts are capped at 500 per request. Daily reservations are restricted to the current Europe/Belgrade business date.

This is a database reservation primitive, not yet end-to-end offline issuance. The POS Agent still needs durable local storage/consumption of these IDs and daily numbers, the offline coupon construction/signing path must be connected to them, and the signed local receipt must be reconciled to the cloud sale ledger. A browser-only client must not be allowed to claim the ID or daily number without the POS Agent's authenticated device identity. No formal ATK approval of this numbering workflow has been established; validate it against the current technical specification and ATK TEST before enabling it for sales.
