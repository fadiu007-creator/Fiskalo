# Fiskalo Full restoration notes

## Application boundary

The Full workspace is mounted at `/app` and uses the existing `fiskalo_*` schema. Basic remains available at `/` (Basic Agent) and `/basic` (Basic Cloud), backed by `fiskalo_basic_*`. The route tree is separate; Full navigation links back to Basic and Basic headers link to Full.

## Fiscal transaction path

1. The owner configures a Full organization and a TEST POS installation.
2. The browser creates a non-exportable P-256 key and CSR in IndexedDB.
3. The authenticated server route checks organization membership and the taxpayer NUI before requesting an ATK TEST certificate.
4. The POS signs the POS Coupon and CitizenCoupon payloads locally.
5. The server validates the registered certificate/SPKI, signature, fiscal fields, and source invoice/adjustment before sending the request to the ATK TEST endpoint.
6. A fiscal document is marked accepted only when the ATK response contains a valid transaction identifier; ambiguous or malformed outcomes remain unresolved for reconciliation rather than being shown as successful.

The server routes use a server-only Supabase service-role client for verification and fiscal-journal writes. Browser roles cannot write server-trusted fiscal acceptance rows under the existing Full migration contract.

## Current limitations

- This integration restores the Full web UI and route tree; it does not establish ATK certification.
- The Full edition does not issue fiscal receipts offline. Offline order drafts are not fiscal documents or proof of payment.
- Browser IndexedDB key persistence is not a hardware-backed keystore.
- The repository still lacks the complete historical Full schema baseline. The connected `zikos` project has the Full schema and additive fiscal migrations already applied; do not run a generic `supabase db push` against the shared project.
- The current Full category-constraint expansion is additive and must be applied before using the expanded catalogue in the connected Full schema.
- `SUPABASE_SERVICE_ROLE_KEY` must be configured only as a server-side runtime secret. No credential is committed here.
- ATK TEST credentials/access and an actual TEST acceptance remain unverified in this change set. Production submission stays disabled until the official provider/certification process and unique SEF code are complete.

## Safe deployment sequence

1. Review and merge the Full/Basic route restoration and catalogue migration through the repository's normal review process.
2. Apply only the reviewed additive Full category migration to the intended Supabase project; verify the constraint and existing records afterward.
3. Configure the server-only service-role secret in the runtime without exposing it to client bundles.
4. Deploy to a non-production environment and test owner/cashier access, certificate registration, Sale, Cancel, Return, receipts, and reconciliation against ATK TEST.
5. Verify the ATK portal's testing/certification evidence before considering any production configuration.
