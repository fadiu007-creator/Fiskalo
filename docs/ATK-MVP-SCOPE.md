# Fiskalo Basic ATK MVP — current scope and acceptance status

## Goal

Deliver a complete, small-business Kosovo fiscalization workspace with a secure Windows POS runtime, online and local-first offline checkout, ATK TEST onboarding, signed coupons, receipts, sales records and the legally required outage evidence workflow.

The Basic MVP is the smaller product edition, not a POS-only demo. The Full application UI is not yet integrated into `main`; see the repository README for that separate release gate.

## Included in current source

- Owner and cashier access, business workspace, POS registration and local Agent pairing.
- Product catalogue with official ATK measurement-unit, VAT and item-category dropdowns.
- The 2026 item-category annex is preserved as 53 published rows / 52 unique codes; the duplicate PM code is displayed with both labels. The Basic products table enforces all 52 unique codes.
- POS checkout, stock deduction, sales history and fiscal status.
- Split tender across cash, card, bank transfer, voucher, cheque and cryptocurrency. Payment allocations use integer cents and must reconcile to the full sale total.
- Online ATK TEST Sale submission through the paired local POS Agent.
- Owner-only full cancellation and full return workflows for previously accepted Basic sales in ATK TEST, including original-coupon references, server-reserved correction identifiers, signed correction/CitizenCoupon payloads, trusted server finalization and correction receipt history.
- Local-first offline checkout: immutable sale snapshot persisted to IndexedDB before network-dependent operations; when offline capacity has been reserved, the Windows Agent signs and queues the coupon locally.
- POS-specific protected signing keys and certificates, DPAPI protection, encrypted durable fiscal queue, CouponId/daily-number reservations and signed CitizenCoupon QR generation.
- Automatic background delivery when ATK connectivity returns, safe retries only when transport proves the request was not delivered, and reconciliation lock for ambiguous outcomes.
- Receipt preview with taxpayer/operator/POS identity, item lines, VAT groups, payment allocations, coupon and daily numbers, NUIKF, signed QR, RKS MF mark, `e-Kuponi`, `TEST I LIRË` and explicit ATK TEST/offline markings.
- Basic inventory, supplier purchase and expense source.
- Article 44 outage register, 48-hour notice tracking, private evidence storage, monthly un-fiscalized coupon export and recording of actual manual submission.

## Explicitly deferred or incomplete

- Partial returns, partial-quantity allocation and proportional refund calculations. Basic currently supports only full cancellation or full return; the actual ATK TEST acceptance path still requires taxpayer/POS test evidence.
- Item/order discounts and markups. Do not infer discount treatment from the current coupon schema until the exact ATK 2026 rules and sample calculations have been reconciled.
- Advanced inventory valuation, supplier payment reconciliation, advanced cash/shift reconciliation and internal X/Z reports.
- Subscription plans, billing and product limits.
- ARBK registry lookup.
- Android signing/queue runtime and multi-client parity.
- Full application UI and a selectable Full/Basic launcher on `main`.
- Server-signed connectivity heartbeat/time anchor for independent outage-start evidence.
- Formal ATK provider/software certification and production authorization.

## 2026 ATK legal and technical cross-check

Baseline: ATK's current specific technical/functional requirements (29 May 2026), the 2026 administrative instruction, the ATK EDI/SEF onboarding guidance and the official `fiskalizimi/pos-csharp` sample.

| Requirement | Current implementation evidence | Remaining acceptance |
|---|---|---|
| Article 7: taxpayer identity, business address, operator identity, item/quantity/unit price, VAT, payment allocations, issue date/time, POS identity, daily number, QR, NUIKF, RKS logo and document type | Receipt source renders these fields, split-tender allocations, daily number, NUIKF, QR, RKS MF mark and test/offline markings. | Compare exact layout and every field against the current official receipt specimen on supported physical printers. Discount/markup rows remain incomplete. |
| Article 32: electronic records, digital signature per coupon, certificate identity, HTTPS exchange, QR and printer support | Windows Agent uses a protected per-POS key, certificate matching, Protobuf signing, ATK TEST HTTPS submission, CitizenCoupon QR and thermal printing primitives. | ATK-issued certificate-chain trust anchor, certificate lifecycle, current official messages and physical output need acceptance evidence. |
| Article 32/44: offline retention and automatic delivery after connectivity returns | PWA IndexedDB snapshot, pre-reserved identifiers, local Agent signing/queue, background delivery and cloud synchronization are implemented. Ambiguous requests are quarantined, not blindly resent. | Real ATK TEST offline issue/reconnect acceptance and exact once-only ATK portal confirmation remain unverified. |
| Article 34: separate protected certificate/private key per POS | POS Agent DPAPI key protection and certificate/public-key binding; TEST onboarding flow exists. | ATK production certificate and certified solution identity are not issued. |
| Article 35(8)-(12): provider/software registration, developer NUI and unique SEF code | The software cannot invent ATK-issued provider/developer identifiers. | Blocked until ATK completes provider/software registration and issues the required values. |
| Article 39: QR on every fiscal coupon, including offline coupons, with unique NUIKF | Agent signs CitizenCoupon, generates QR before delivery and persists it with NUIKF in the encrypted queue. | Scan with the official ATK verifier in real online and offline TEST scenarios; confirm the exact QR payload is accepted. |
| Article 43: corrective coupon references original coupon | Basic exposes owner-only full cancellation and full return for an ATK-accepted sale. The workflow reserves unique correction identifiers server-side, signs the correction and CitizenCoupon, references the original CouponId/Transaction ID, finalizes through the trusted server route and retains the correction receipt/journal. | Partial returns and proportional refund allocation are not implemented. ATK TEST end-to-end acceptance, physical receipt verification and production certification remain external release gates. |
| Article 44(5)-(6): notice after specified 48-hour internet interruption and submit un-fiscalized coupons by the tenth of the following month | Owner incident register, private evidence, deadline logic, combined server/local queue export and filing evidence record are implemented. | Owner-entered outage time is not independently server-signed. Fiskalo does not send the notice/export to ATK automatically; taxpayer must use the official channel and record the actual filing. |

## Receipt and signature implementation

- The local Agent creates a cryptographically random 16-character uppercase alphanumeric NUIKF for each coupon and signs a separate ATK CitizenCoupon with the POS key.
- QR content is `Base64(CitizenCoupon protobuf)|Base64(ECDSA signature)`, matching the official [ATK C# POS sample](https://github.com/fiskalizimi/pos-csharp).
- The web receipt displays the saved signed QR, NUIKF, CouponId, daily number, POS/SEF identity, operator, VAT breakdown, payment allocations, RKS MF mark, `e-Kuponi`, `TEST I LIRË` and a clear TEST-only notice.
- The local POS Agent uses Windows DPAPI for the private key and an encrypted local fiscal queue. The browser never receives the private key.
- The Agent retries only when transport evidence proves the request was not delivered. A timeout/reset after possible transmission is marked for reconciliation to avoid duplicate fiscalization.

## Two different 48-hour clocks — do not conflate them

1. **Agent operational retry/escalation timer:** based on the Windows device clock and observed ATK endpoint reachability. It helps surface overdue queued documents and does not stop delivery after 48 hours. It is not a server-signed legal outage timestamp.
2. **Article 44 legal internet-outage clock:** recorded separately by the business owner in `/article-44`, using Kosovo local time. The application checks the 48-hour threshold and the tenth-of-following-month deadline, stores evidence and records actual filing. It does not automatically notify ATK.

The Article 44 monthly export combines server-synchronized non-accepted offline documents (including rejected documents) with the selected POS Agent's local unaccepted queue. If the local queue cannot be read, the UI refuses to describe a server-only export as complete.

## Supabase deployment and migration status

The existing Supabase project `zikos` was inspected directly. Its migration ledger contains the timestamped Basic/Full, purchase, correction, offline and security migrations. New migrations 0025–0033 were applied to that project and their SQL regression scripts were executed.

The live project also passed temporary transaction-scoped integration checks for:
- online split-tender sale creation and persistence;
- offline split-tender sale synchronization;
- idempotent retry returning the same sale;
- rejection of changed payment allocations for the same checkout key;
- Article 44 incident creation, export access, deadline and evidence gates;
- non-eligible Article 44 cause rejection.

All temporary test businesses, sales and incidents were rolled back. No test business records were retained.

The repository's numbered migrations do not all share the timestamp/version identifiers in the live Supabase ledger. A clean database replay and authenticated cross-tenant RLS suite are still required before a fresh installation can be considered reproducible.

## Remaining acceptance sequence

1. Register a real ATK TEST taxpayer/application/POS and use ATK-issued TEST certificates.
2. Verify CSR/certificate public-key match and certificate-chain trust.
3. Submit an online Sale and verify the same TransactionNo and coupon in ATK.
4. Issue while the network is disconnected with pre-reserved capacity; restart browser and Agent; reconnect and verify automatic delivery and exactly one ATK transaction.
5. Scan offline and online CitizenCoupon QR values with the official ATK verifier.
6. Exercise midnight rollover, two POS devices, two tabs, clock skew, local storage tampering/full disk, Windows account change, certificate expiry/revocation and 48-hour recovery.
7. Test Article 44 evidence and monthly export against an actual ATK filing.
8. Complete Cancel/Return, discounts and all remaining receipt fields using official examples.
9. Run physical printer tests, current Cloudflare deployment smoke tests and clean-database migration replay.
10. Submit provider/software certification evidence and obtain production authorization.

## Official sources

- [ATK SEF application and current documents](https://apps.atk-ks.org/sefaplikimi/)
- [ATK 2026 technical and functional requirements](https://apps.atk-ks.org/sefaplikimi/uploads/documents/150ab6cc-084f-490d-b5fc-d8639d0287dc.pdf)
- [ATK measurement-unit catalogue (29 September 2026)](https://apps.atk-ks.org/sefaplikimi/uploads/documents/1d551126-ea39-49eb-8b89-6e0deb6e117f.docx)
- [ATK official C# POS sample](https://github.com/fiskalizimi/pos-csharp)

This checklist is implementation evidence, not an ATK certification decision. Production fiscalization remains disabled until formal approval and production credentials are issued.
