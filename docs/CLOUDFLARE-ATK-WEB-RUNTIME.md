# Cloudflare ATK TEST web runtime

This branch introduces the first server-side part of the web-only ATK runtime.

## Implemented in this slice

- `POST /api/atk/test` is served by the Next.js application on Cloudflare.
- The gateway accepts only the fixed ATK TEST origin; callers cannot supply an arbitrary upstream URL.
- Every request requires a current Supabase access token.
- The gateway resolves the authenticated user and checks that the requested business is in that user's Fiskalo membership list.
- POS verification and certificate requests are scoped to a POS row belonging to that business.
- ATK verification, CSR issuance and signed-coupon submission are sent server-to-server to the ATK TEST API.
- A coupon is returned as accepted only when the upstream ATK response contains a positive `transaction_id`. A client-provided status or transaction ID is ignored.
- Responses are marked `no-store`; request size is bounded; upstream requests have a timeout.
- `src/lib/pos/cloud-atk.ts` provides typed browser calls and sends the current Supabase access token.

## Required next implementation steps

This gateway is not, by itself, the completed web-only fiscal runtime. Do not enable it as the sole checkout path until all items below are implemented and tested:

1. Browser POS key lifecycle: generate a per-POS P-256 key, create a PKCS#10 CSR, persist a non-exportable private CryptoKey in IndexedDB, install the ATK certificate, and prove that its public key matches the private key. Private key material must never be sent to Cloudflare or Supabase.
2. Port the exact ATK protobuf signing format from the existing .NET signer, including DER ECDSA signature encoding, and add cross-runtime golden-vector tests against the existing C# implementation.
3. Replace the local-agent pairing/status/certificate/submit calls in the POS UI with the browser runtime and this gateway. The existing local-agent path remains in the app until this is completed; do not assume this branch removes the Windows dependency.
4. Persist signed envelopes and idempotency state in the existing Supabase fiscal journal before submission. The browser must also maintain an IndexedDB outbox so a fully disconnected device can retain signed documents until connectivity returns.
5. Add a Cloudflare scheduled recovery worker for cloud-persisted signed envelopes. It may resend only when ATK's documented reconciliation result proves the earlier request was not accepted. Ambiguous timeouts must remain in reconciliation, never blind retry.
6. Move accepted-document recording behind a trusted server-side operation. The browser must not be able to set `submission_state=accepted` or submit a fabricated `atk_response`. The server must verify the ATK response and bind it to the same idempotency key, signed payload, sale and business.
7. Add integration tests for Sale, Cancel, Return, certificate/key matching, duplicate submission, ATK rejection, network ambiguity, offline queue persistence, reconnect recovery, and the 48-hour deadline.
8. Run CI, deploy through the repository's existing Cloudflare workflow, and verify the live Worker. Real ATK TEST acceptance still requires the configured test installation and a live transaction.

## Safety boundary

This implementation calls ATK TEST only. It does not enable production fiscalization, and it is not a claim of ATK certification or verified 48-hour recovery.
