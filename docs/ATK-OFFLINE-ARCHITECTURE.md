# Fiskalo offline-first fiscalization

## Scope and release boundary

The repository now contains a connected local-first offline fiscalization path for the Windows POS Agent and ATK TEST environment. This is an implementation milestone, not proof of ATK certification or legal approval. Production fiscalization remains disabled until ATK has approved the SEF, the exact offline numbering/receipt protocol, certificate handling, and production credentials.

The POS Agent is the device-side fiscal runtime. Cloudflare hosts the web application and cloud APIs; it does not hold POS private keys. Supabase stores the synchronized sale and fiscal-document ledgers.

## Implemented flow

1. While online, the business owner selects a verified POS with an ATK TEST certificate and uses **Përgatit kapacitetin offline**. The Agent calls authenticated Supabase RPCs over HTTPS and reserves business-wide CouponIds from the same sequence used by online sales, plus per-POS daily-number ranges for the current Kosovo date and the following seven days.
2. The Agent validates that the selected business NUI, POS UUID, branch, POS number, application ID, certificate thumbprint and local private key match its protected ATK TEST installation.
3. The Agent imports the reserved IDs and daily ranges into an atomic, DPAPI-protected local store. A checkout idempotency key claims one CouponId and one daily number exactly once. The claim survives Agent restart and cannot be returned to the available pool.
4. The PWA commits an immutable checkout snapshot to IndexedDB before network-dependent work. If local fiscal capacity is prepared, checkout uses the local-first path even while online; otherwise it uses the regular online path. This allows a sale to be signed locally if Cloudflare/Supabase is unavailable while the local Agent can still operate.
5. The Agent constructs and signs the POSCoupon and CitizenCoupon with the POS private key, creates the signed CitizenCoupon QR, and persists the exact signed payload, signature, NUIKF, daily number, certificate thumbprint, checkout key and immutable snapshot fingerprint in its encrypted queue before returning a receipt.
6. If ATK accepts immediately, the Agent records the returned TransactionNo. If the transport proves the request was not sent, the signed document remains queued and the delivery worker retries it. A timeout or other ambiguous result is locked for reconciliation; the Agent never blindly resubmits it.
7. When cloud connectivity returns, the PWA calls `fiskalo_basic_sync_offline_sale_with_allocations`, preserving the same payment allocations used by the locally signed coupon. The server checks the reserved CouponId and daily-number ranges, one-time consumption, operator membership, business date, immutable line/tax snapshot and stock state. It preserves the original coupon identity and timestamp. If inventory changed while offline, the sale is retained with an explicit stock-reconciliation flag rather than rewriting the fiscal document.
8. The PWA requests a signed attestation from the local Agent's protected queue. The Supabase Edge Function verifies the attestation signature, the registered POS certificate key, POSCoupon and CitizenCoupon signatures, the coupon snapshot fingerprint, business/POS identity, daily number and sale snapshot. It then calls server-only RPCs to persist either the offline queued receipt or the ATK-accepted response. Browser-supplied ATK response JSON is not accepted as proof of acceptance.
9. The Agent's background worker continues automatic delivery after the browser is closed. When it accepts the document, the PWA synchronizes the signed accepted attestation and TransactionNo on reconnection.

## Durable state and idempotency

Cloud synchronization and fiscal acceptance are independent state machines.

- Cloud: `pending -> synced` or `pending -> conflict`.
- Fiscal: `not_prepared -> queued -> accepted`, `queued -> rejected`, or `queued -> needs_reconciliation`.
- A timeout after possible transmission, an interrupted in-flight request, or a certificate/identity mismatch requires reconciliation or operator action.
- The same checkout key returns the same local claim and same signed document. ECDSA signatures are not regenerated on retry; the exact persisted signed bytes are reused.
- Claimed CouponIds and daily numbers are never reused, even if checkout is abandoned or the machine restarts.
- No PAN, CVV, passwords, access tokens or private keys are stored in the offline sale journal.
- Split tender is stored as canonical integer-cent allocations. The server validates the sum against the sale total and rejects a retry that changes the payment allocation.

## Database and device components

- Migration 0018: CouponId and daily-number reservation tables/RPCs.
- Migration 0019: daily-number trigger compatibility, daily-number consumption ledger and offline sale synchronization RPC. Migrations 0022-0023: atomic CouponId/daily-range capacity reservation with an invoker-only public wrapper. Migration 0024: owner-only daily-number reservations from today through seven days ahead in Kosovo time.
- Existing Supabase migrations: server-only Basic POS certificate registry and trusted queue/accepted receipt RPCs.
- Migration 0020: hardens the existing server-only queue/accepted writers with active-certificate binding and keeps signed receipts synchronizable after the 48-hour escalation deadline.
- Migrations `20261117160000` and `20261117160100`: add append-only signed POS heartbeat evidence and bind new offline fiscal documents to the server-measured outage interval and 48-hour recovery window.
- Migrations 0025–0033: remove public execution from trigger-only helpers; add Article 44 incident/evidence tracking and the tenth-of-following-month un-fiscalized export; add split-tender online/offline checkout; harden deadline/evidence/idempotency boundaries; and enforce the complete 2026 ATK item-category catalogue.
- Windows POS Agent: DPAPI-protected private key, certificate, reservation store and fiscal queue; local ATK TEST signing and automatic delivery.
- PWA: cached business/POS/product workspace, IndexedDB sale journal, local-first checkout and reconnect synchronization.
- Supabase Edge Function `fiskalo-basic-atk-receipts`: verifies local Agent attestations and signature/snapshot bindings before database persistence.

## Server heartbeat configuration

Set the P-256 PKCS#8 private key as a Cloudflare Worker secret on the `fiskalo` Worker:

```bash
npx wrangler secret put ATK_HEARTBEAT_PRIVATE_KEY_PEM --name fiskalo
```

The public key is pinned in the route and browser verifier. The server imports the private key as non-exportable and verifies every signature against the pinned public key before recording evidence. Missing or mismatched keys fail closed. Do not put the private key in source control or any `NEXT_PUBLIC_` variable.

## Important operational limits

- Offline capacity must be provisioned while online. If the POS has no reserved CouponIds or no daily numbers for the current Kosovo business date, the Agent fails closed; it does not invent a number.
- The secure local runtime currently targets Windows. Other operating systems need their own secure-keystore POS Agent.
- The cached operator identity and paired local Agent are required to issue locally during a network outage. Cloud authorization and data refresh resume when connectivity returns.
- The local Agent retries only when transport evidence proves the request was not delivered. An ambiguous ATK result remains locked for reconciliation.
- The Cloudflare-hosted `/api/pos/heartbeat` endpoint issues P-256 ECDSA-signed ATK TEST timestamps after authenticating the member and POS. The browser verifies the pinned public key and stores the signed heartbeat in encrypted IndexedDB. When paired, the Windows Agent obtains its own one-time challenge, verifies the same server signature and persists the monotonic time in its DPAPI-protected connectivity journal. A heartbeat gap greater than 90 seconds re-anchors queued offline documents and their 48-hour recovery deadline to the previous signed server timestamp. The database records an append-only nonce, actor, POS, signature, server timestamp and measured gap; new cloud-synchronized offline fiscal documents are linked to the matching server-measured heartbeat interval. This proves an absence of POS heartbeat, not the cause of the interruption or the exact second a local device generated a document.
- Article 44 paragraph 5 notification is only recorded after the owner has actually notified ATK through an official channel or in person and uploaded evidence. Fiskalo does not submit the notice automatically.
- Article 44 paragraph 6 export combines server-synchronized unaccepted documents with the local POS Agent queue. It fails closed if the paired local queue cannot be read; a server-only export is not described as complete.
- The tenth-of-following-month export includes every non-accepted offline fiscal document, including rejected documents. The export must still be reviewed and submitted by the taxpayer to ATK.
- The existing certificate registry stores the ATK certificate and SPKI fingerprint; the Edge Function verifies local proof of possession and binds the certificate public key to the POS. The exact ATK certificate-chain trust anchor and renewal/revocation procedure still require confirmation against ATK's current technical specification and TEST guidance.

## Receipt and payment conformance

- The receipt renders the RKS MF mark within a 20 mm × 8 mm print area, displays the OFFLINE indicator for offline coupons, and includes NUIKF and the signed CitizenCoupon QR.
- The receipt preview is designed for the ATK 2026 thermal-width range; physical printers and actual paper output still require acceptance testing.
- Online and offline checkout now persist split-tender allocations in integer cents and map each tender to the ATK payment enum. Internal allocation tests do not substitute for ATK TEST acceptance.

## Remaining acceptance and certification work

1. Validate the exact NUIKF/VerificationNo composition, offline CitizenCoupon/ POSCoupon fields, QR encoding and reserved numbering scheme against the current ATK technical specification and the official ATK TEST verifier. Do not treat an internally valid signature as proof that ATK accepts the document.
2. Run full ATK TEST scenarios with real ATK-issued certificates: issue while disconnected, restart browser and Agent, restore ATK connectivity, verify automatic submission and TransactionNo, and confirm the original coupon appears exactly once in ATK.
3. Test outage spanning midnight, seven-day capacity, two POS devices reserving concurrently, two browser tabs, clock skew, local storage exhaustion/tampering, Windows account change, device replacement, certificate expiry/revocation, and 48-hour deadline/exception handling.
4. Validate the certificate chain and renewal/revocation lifecycle against ATK's current CA and certification procedure.
5. Complete formal SEF provider/software certification and obtain production authorization before enabling production fiscalization.

## Release gate

Do not describe Fiskalo as ATK-certified or production-compliant based on repository tests or one accepted TEST coupon. Release requires current protocol conformance, official ATK TEST acceptance of online and offline flows, the required outage evidence and recovery process, physical POS/receipt tests, provider/software certification and production authorization.
