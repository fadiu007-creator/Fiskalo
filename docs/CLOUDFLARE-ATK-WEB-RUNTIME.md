# Cloudflare ATK TEST web runtime

This branch replaces the Fiskalo web checkout's localhost dependency with a same-origin Cloudflare API gateway and a separate Cloudflare scheduled recovery Worker. It is ATK TEST only; production submission remains disabled.

## Implemented

- The web application calls `/api/atk/test` on the same Cloudflare origin. It no longer needs `http://127.0.0.1:17843` for web POS onboarding or coupon submission.
- POS identity is read from the authenticated user's business/POS records. Browser-supplied NUI, branch, POS and application IDs are checked against the saved configuration.
- Each POS gets a P-256 ECDSA key generated in the browser. The private `CryptoKey` is non-exportable and stored in IndexedDB. Only the CSR, public certificate, signed payloads and signatures leave the browser.
- The browser creates PKCS#10 CSRs and checks that the ATK-issued certificate SPKI matches the locally stored public key before installation.
- POS and CitizenCoupon protobuf payloads are signed in the browser. The per-coupon 16-character NUIKF is embedded as VerificationNo in both payloads.
- The Cloudflare gateway verifies both signatures against the public certificate, parses the protobuf identity fields, and checks the business, POS, application, coupon number, sale timestamp, daily number and totals against the saved paid sale.
- Direct online submission calls the fixed ATK TEST endpoint. A positive ATK `transaction_id` is required before the trusted server-side fiscal ledger marks the document accepted.
- A response known to be not delivered can be placed into the durable Supabase queue. An ambiguous timeout is never blindly retried.
- A browser-local IndexedDB outbox preserves signed documents if connectivity drops after the paid sale is committed. On reconnect it uploads only never-sent documents to the trusted server queue.
- `workers/atk-recovery.ts` is a separate Cloudflare Worker scheduled every five minutes. It processes `queued` Sale, Cancel and full Return documents, only before their 48-hour deadline, and retries only network failures positively classified as not delivered. Ambiguous results move to `needs_reconciliation`; HTTP 4xx moves to `rejected`; ATK acceptance is recorded using the service-role-only RPC.
- The old browser-callable acceptance and correction RPCs are revoked. Accepted status is written only through trusted server-side functions after ATK returns a valid uint64 transaction ID.
- Full Cancel and full Return flows reserve unique correction coupon/daily numbers, reference the accepted original coupon using ATK \`ReferenceNo\`, and persist correction documents in the trusted fiscal journal. Partial returns are not yet supported.

## Cloudflare configuration

The main Fiskalo application needs `SUPABASE_SERVICE_ROLE_KEY` configured as a Cloudflare Worker secret. It must never use a `NEXT_PUBLIC_` name.

The recovery Worker is separate from the Next.js app Worker. Deploy it from the repository root:

```bash
npm install
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY --config wrangler.atk-recovery.jsonc
npm run deploy:atk-recovery
```

Set the same secret on the main `fiskalo` Worker using its `wrangler.jsonc` configuration or the Cloudflare dashboard:

```bash
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY --config wrangler.jsonc
```

The recovery Worker also issues P-256 ECDSA-signed POS heartbeats. Configure its signing key as a Worker secret (never a committed file or a `vars` entry):

```bash
npx wrangler secret put ATK_HEARTBEAT_PRIVATE_KEY_PEM --config wrangler.atk-recovery.jsonc
```

Paste the PKCS#8 PEM value generated for the public key pinned in `ServerHeartbeatVerifier.cs` and `browser-outbox.ts`. Keep that private key exclusively in Cloudflare Secrets. Configure `NEXT_PUBLIC_ATK_RECOVERY_WORKER_URL` on the main Fiskalo application with the deployed recovery Worker's HTTPS origin (for example, the Worker URL shown by Wrangler; do not guess the account subdomain). The Worker authorizes heartbeat requests against the authenticated user's active ATK TEST POS membership. The browser verifies the signature before persisting the heartbeat in encrypted IndexedDB. A missing signing secret returns HTTP 503 and never falls back to a browser timestamp.

Apply Supabase migrations `0037_fiskalo_atk_pos_heartbeat_evidence.sql` and `0038_fiskalo_basic_offline_heartbeat_binding.sql` before enabling offline recovery. Migration 0038 adds a database trigger that refuses newly queued offline receipts or corrections unless their outage timestamp matches a server-signed prior heartbeat for the same POS, and stores the evidence-row reference on the fiscal document.

The heartbeat Worker must persist each nonce hash, authenticated actor, POS identity, server timestamp, previous heartbeat and measured gap through the atomic SQL RPC before returning a signature. The append-only evidence ledger is not readable or writable by browser roles. The SQL contract is included in `scripts/test-supabase-sql.sh`. The SQL contract is included in `scripts/test-supabase-sql.sh`.

The recovery Worker reads the existing `zikos` Supabase project configured in `wrangler.atk-recovery.jsonc`. Its cron trigger is `*/5 * * * *`. Check the Worker `/health` endpoint and Cloudflare Worker logs after deployment. The service-role key must not be committed to GitHub or placed in Worker vars.

CI validates the recovery Worker with `npm run cf-build:atk-recovery` and tests its safe-retry, ambiguous-delivery and 48-hour deadline behavior with `npm run test:atk-recovery`.

## Delivery and offline safety

- The app currently commits the paid sale to Supabase before fiscalization. If the ATK endpoint is unreachable but Supabase remains reachable, the signed coupon is stored in the server queue and Cloudflare can recover it.
- If the browser loses connectivity after the sale commit, the signed coupon is held in IndexedDB and uploaded to the server queue when the app reconnects.
- A sale cannot currently be created while the browser has no connectivity at all, because checkout and coupon allocation still require the existing Supabase transaction. This is not yet a full store-and-forward POS with offline sales, stock reservation and preallocated coupon-number blocks.
- A transport failure is retried only when the runtime can prove the request was not delivered. A timeout, connection reset after sending, malformed response, or worker crash after claiming a document is treated as ambiguous and requires reconciliation. No duplicate-prone blind retry is performed.
- If the 48-hour deadline passes, the Worker stops and moves the document to `needs_reconciliation`.

## Not yet proven

A successful CI build is not ATK acceptance. The following still require deployment and a real configured ATK TEST installation:

1. Deploy the main app changes and the scheduled recovery Worker to Cloudflare.
2. Run real ATK TEST onboarding on a browser/POS, verify the issued certificate and public-key match.
3. Submit real Sale, Cancel and full Return documents and confirm ATK responses, transaction IDs, ReferenceNo values and fiscal journal records.
4. Exercise the 48-hour queue against real ATK TEST transport failures and inspect Cloudflare cron logs plus Supabase fiscal journal rows.
5. Confirm that the official ATK test environment accepts the exact CSR subject and signature/protobuf format produced by the browser implementation.

This branch does not claim production certification or completed ATK TEST acceptance until those checks pass.
