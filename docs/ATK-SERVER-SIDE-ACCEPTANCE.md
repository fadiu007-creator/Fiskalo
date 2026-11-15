# Server-side ATK correction acceptance (TEST only)

## Authoritative integration contract

The [ATK SEF portal](https://apps.atk-ks.org/sefaplikimi/) links to the official
[fiskalizimi/pos-csharp integration repository](https://github.com/fiskalizimi/pos-csharp).
That sample documents POS coupon submission to the ATK `/pos/coupon` endpoint
using a Base64 Protobuf `details` value and an ECDSA signature. Its documented
successful response is ordinary JSON containing `message` and a uint64
`transaction_id`; it does not document a signed response envelope or a separate
transaction-status lookup endpoint.

Accordingly, Fiskalo must not claim that a browser-supplied response or transaction
ID is cryptographically verified. The implementation in this branch uses a
server-to-server HTTPS request to the fixed ATK TEST endpoint. The HTTPS client
validates the remote TLS certificate using the runtime trust store. ATK still
validates the POS coupon signature. This is stronger than trusting the browser,
but it is not a signed ATK response and it is not production certification.

## Edge Function behavior

`supabase/functions/fiskalo-basic-atk-correction`:

1. Requires a valid Supabase user session and owner membership for the business.
2. Requires the original sale to have an accepted ATK fiscal document and a
   fiscalized sale record.
3. Requires the original POS to have an issued TEST certificate and complete
   branch/POS/application/verification identity.
4. Decodes the signed POS Protobuf and checks the business, correction coupon,
   branch, POS, application, verification number, document type and original
   coupon reference against the database reservation.
5. Reserves the correction document with state `submitted` before making the
   external request. The unique idempotency key and active-cancellation index
   prevent concurrent duplicate submissions.
6. Sends only `details` and `signature` to the fixed ATK TEST HTTPS endpoint.
7. Stores the response it actually received. HTTP 400 is recorded as rejected;
   timeouts, HTTP 5xx, unreadable success responses and persistence failures
   remain unresolved and require manual ATK reconciliation. The endpoint never
   blindly resubmits an ambiguous request.

The browser cannot supply `atkResponse`, `transactionId`, `accepted` or an
environment marker as proof. A successful API result is returned only after the
server has persisted the ATK response and transaction ID.

## Deployment and integration limits

- This is TEST-only. No production ATK endpoint is enabled.
- The migration is additive and must be applied only after the existing
  migrations in order, in a disposable/staging database first.
- The Edge Function is not yet wired into the correction UI. The current
  Windows POS Agent correction workflow still submits directly to ATK and its
  existing persistence path must be migrated to this server-side boundary before
  applying migration 0022 to a live application.
- The normal-sale acceptance RPC is also a separate outstanding trust-boundary
  issue. This correction change does not claim to secure normal-sale acceptance.
- No ATK TEST request was sent by CI. CI validates source, Protobuf parsing,
  transaction-ID handling and PostgreSQL migration/privilege contracts only.
- Do not deploy this function or apply migration 0022 to the shared Supabase
  project until the UI/Agent integration and an approved staging test are complete.
