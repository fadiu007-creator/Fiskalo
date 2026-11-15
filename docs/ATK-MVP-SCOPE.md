# Fiskalo Basic ATK TEST MVP — Web Runtime

## Scope

The current Basic MVP is a browser-based Fiskalo web application hosted on Cloudflare. It does not require a Windows POS Agent or a localhost service. The runtime is ATK TEST only; production fiscalization remains disabled.

## Web-only architecture

- **Browser POS:** generates a separate P-256 ECDSA key per business/branch/POS. The private CryptoKey is non-exportable and stored in IndexedDB. The browser builds PKCS#10 CSR requests, signs POS Coupon and CitizenCoupon protobuf payloads, and checks the ATK certificate public key against its local key.
- **Cloudflare application Worker:** authenticates the Supabase user, checks business membership and saved POS configuration, handles ATK TEST verification/CSR/coupon requests, validates the POS and CitizenCoupon signatures, and records acceptance only after a genuine ATK TEST response contains a valid uint64 transaction ID.
- **Supabase project `zikos`:** stores the business/POS records, paid sales, fiscal journal, public ATK certificate registry and durable offline queue. The service-role-only functions prevent browser callers from marking a document accepted or inserting server recovery records.
- **Cloudflare scheduled recovery Worker:** runs every five minutes. It reads queued signed documents, validates their identity and signatures against the server-registered POS certificate, and submits only documents within their 48-hour recovery window. It retries only failures positively classified as occurring before delivery. Ambiguous timeouts, resets, malformed responses and stale worker claims move to reconciliation rather than blind retry.

## Implemented web flows

- ATK TEST POS verification and certificate issuance through the Cloudflare gateway.
- Browser-generated non-exportable P-256 POS key, CSR generation, certificate SPKI matching and local key storage.
- ATK POS Coupon and CitizenCoupon protobuf encoding and DER ECDSA signatures.
- Per-coupon 16-character NUIKF used as the coupon VerificationNo in both signed payloads.
- Server-side verification of both signatures, POS/coupon identifiers, daily number, sale timestamp and financial totals.
- Cloudflare-generated QR SVG from the signed CitizenCoupon payload.
- Trusted server-side fiscal acceptance ledger; browser execution of the old acceptance RPC is revoked.
- Durable browser IndexedDB outbox for signed coupons that have not been sent.
- Authenticated queue upload and Supabase recovery queue for confirmed pre-delivery failures or outbox documents uploaded after reconnect.
- Cloudflare cron recovery with exponential backoff for known pre-delivery transport failures, a strict 48-hour deadline and stop-on-ambiguity behavior.
- ATK TEST-only response labels and no production submission path.

## Remaining ATK acceptance work

| Scenario | Implementation | Evidence still required |
|---|---|---|
| POS verification | Cloudflare gateway uses saved business/POS values | Live ATK TEST verification using the configured taxpayer and POS |
| CSR and certificate | Browser CSR, server-stored public certificate and local SPKI match | ATK TEST certificate issuance and live key-match evidence |
| Sale | Browser signs; Cloudflare validates; ATK response controls accepted status | Real ATK TEST Sale and saved transaction ID |
| Cancel | Browser signing, trusted correction journal, ATK submission and 48-hour recovery path implemented | Live ATK TEST acceptance against an accepted Sale is still required |
| Return | Full Return is implemented with browser signing, trusted correction journal and 48-hour recovery; partial returns are not yet supported | Live ATK TEST acceptance against an accepted Sale is still required |
| Offline queue | Browser outbox, Supabase queue RPC and scheduled Cloudflare worker | Deploy Worker, simulate confirmed pre-delivery failure, reconnect and prove automatic ATK acceptance before 48 hours |
| Duplicate/ambiguous response | Idempotency checks and stop-on-ambiguity states | Live duplicate and timeout/reconciliation tests |
| Receipt | Server-generated CitizenCoupon QR and stored fiscal journal data | Compare printed TEST receipt against current official ATK specimen, including RKS mark, NUIKF and all mandatory fields |
| Production | Explicitly disabled | Formal provider/software registration and ATK production authorization |

A passing build or a successful local unit test is not ATK acceptance. The application must be deployed to Cloudflare and tested against the live ATK TEST installation using the configured taxpayer/application/POS credentials.

## Offline boundary

The hosted checkout creates the paid sale in Supabase before ATK submission. It can therefore queue a signed coupon when the ATK endpoint is unavailable while Fiskalo/Supabase connectivity remains available. If the browser loses connectivity after the paid sale has committed, the signed coupon is retained in IndexedDB and uploaded when the browser reconnects.

A sale cannot currently be created from a completely disconnected browser because sale creation, stock checks, daily numbering and coupon allocation still require the Supabase transaction. This is not yet a fully local-first POS with offline sales and preallocated coupon-number blocks.

## Cloudflare configuration required

Set `SUPABASE_SERVICE_ROLE_KEY` as a secret (never a `NEXT_PUBLIC_` variable) on the main `fiskalo` Worker and the separate `fiskalo-atk-recovery` Worker. The repository workflow can configure both when the GitHub Actions secrets `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` and `SUPABASE_SERVICE_ROLE_KEY` are present.

Deploy the recovery Worker with:

```bash
npm install
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY --config wrangler.atk-recovery.jsonc
npm run deploy:atk-recovery
```

The recovery Worker uses the existing `zikos` project. Do not create a second Supabase project and do not expose the service-role key to browser code.

## Release gate

Do not mark Fiskalo ATK TEST compliant until all of the following are evidenced:

1. CI passes, including browser cryptography, protobuf and recovery tests.
2. The main web app is deployed to the existing Cloudflare Worker.
3. The scheduled recovery Worker is deployed and its cron runs successfully.
4. ATK TEST onboarding issues a certificate that matches the browser-held POS key.
5. ATK TEST accepts Sale, Cancel and full Return, each with the correct ReferenceNo, transaction ID and immutable fiscal journal entry.
6. A confirmed pre-delivery failure is queued, automatically recovered by Cloudflare, and accepted by ATK before 48 hours.
7. Ambiguous timeouts and duplicate attempts are held for reconciliation, not resubmitted.
8. The receipt is checked against the current official ATK TEST specimen.

This is a technical implementation checklist, not a declaration of formal ATK certification.
