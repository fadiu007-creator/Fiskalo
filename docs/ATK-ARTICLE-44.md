# Article 44 — Internet interruption workflow

Fiskalo's Article 44 workflow is based on the official [Administrative Instruction MFPT No. 01/2026 and ATK SEF documentation](https://apps.atk-ks.org/sefaplikimi/uploads/documents/150ab6cc-084f-490d-b5fc-d8639d0287dc.pdf).

## Paragraph 5 — 48-hour notification

Where the internet connection cannot be restored within 48 hours for the specified reasons (equipment replacement, the internet provider's inability to establish the connection, or force majeure), the taxpayer must notify ATK and provide supporting evidence.

Fiskalo now:
- records the POS, outage start, cause and description;
- calculates the 48-hour point;
- requires the incident to have lasted at least 48 hours before recording a paragraph 5 notification;
- stores evidence in a private Supabase Storage bucket;
- records whether the taxpayer notified electronically or in person, with any authority reference.

The application does **not** submit the notice to ATK. The taxpayer must first use the official ATK channel or present it in person, then record the actual submission and evidence in Fiskalo.

## Paragraph 6 — 10th day of the following month

If the internet interruption has not been resolved by the 10th day of the following month, the taxpayer must submit all un-fiscalized coupons to ATK.

Fiskalo:
- calculates the deadline using the Europe/Belgrade (Kosovo) time zone;
- records a taxpayer-prepared CSV/JSON submission package, the submission channel/reference and evidence of actual delivery after the owner uploads them;
- does not claim that recording a package submits it to ATK or that the uploaded file contains every required coupon.

The separate technical export is scoped to one POS and requires that POS's paired Agent on the device holding its local queue. If an interruption affects multiple POS devices, the owner must use each corresponding Agent. The technical export fails closed if that local queue cannot be read. A database-only export is not represented as a complete export of offline coupons.

## ATK technical-specification amendment — 22 June 2026

The ATK amendment to the specific technical and functional requirements (approved 22 June 2026) updates the SEF data-storage and export rules. It requires transaction data to remain protected and intact during failures/interruption, and states that untransmitted data must be exportable in suitable formats such as CSV/PDF **only upon request by ATK or another state authority**.

Fiskalo's controlled Article 44 export now:
- requires a real authority-request reference and an uploaded copy of the request (PDF/JPG/PNG/TXT);
- downloads each private evidence object on the server, recomputes SHA-256 over the actual stored bytes, and rejects mismatches before invoking the service-role-only export RPC;
- records the verified evidence manifest against the exact incident;
- disables the old RPC signature that accepted an arbitrary reference without request evidence;
- produces CSV, not an unrestricted JSON dump, and safely quotes spreadsheet cells to prevent formula injection;
- refuses incomplete server exports and reads the browser-local queue before creating the server audit record.

This controlled export is not an automatic submission to ATK and is not evidence that ATK accepted any coupon. Article 44(6) filing obligations and the authority-requested technical export are separate workflows. If no ATK/state-authority request has been received, the taxpayer must confirm the approved filing channel and format directly with ATK rather than fabricating a request reference.

The Article 44(5) notice and Article 44(6) monthly filing records also use server-verified evidence. The browser uploads files to the private bucket, but cannot call the recording RPCs directly. The server downloads the stored bytes, checks their actual size, MIME type and SHA-256 digest, and only then invokes service-role-only RPCs that re-check owner membership, incident eligibility, filing deadlines and Storage ownership. This prevents a client from recording a fabricated digest or bypassing the evidence check with a direct PostgREST call.

Official documents:
- [Administrative Instruction (MF) No. 01/2026](https://apps.atk-ks.org/sefaplikimi/uploads/documents/87a43adf-6ee2-42e5-a5af-043c031f514f.pdf)
- [Specific technical and functional requirements for PEF/SF/SEF](https://apps.atk-ks.org/sefaplikimi/uploads/documents/150ab6cc-084f-490d-b5fc-d8639d0287dc.pdf)
- [ATK amendment dated 22 June 2026](https://apps.atk-ks.org/sefaplikimi/uploads/documents/4994a4cd-75c8-46fd-bb7c-d541e4aa0e40.pdf)

## Important limitations

- The POS now records a server-signed heartbeat for the authenticated business/POS. When a later heartbeat arrives after a gap, the server evidence ledger records the previous and current server timestamps and measured gap. The browser verifies and stores the signed time in encrypted IndexedDB; a paired Windows Agent independently verifies it and persists it in the DPAPI-protected journal. New cloud-synchronized offline documents are linked to a server heartbeat interval (with a two-minute clock-skew tolerance), and the database derives the 48-hour recovery deadline from the trusted interval start. This proves an absence of POS heartbeat and bounds the local issue timestamp; it does not independently prove that the ISP was unavailable or the exact device issue second. The taxpayer must still retain provider/repair/force-majeure evidence required by Article 44.
- Local Agent timestamps and server records are separate evidence sources; the export preserves both.
- Fiskalo does not automatically email, upload or submit the notice/export to ATK. No official public Article 44 notice endpoint has been verified.
- A generated export or a stored notification reference is not proof that ATK accepted the documents.
- Actual ATK TEST acceptance, physical POS tests and legal/provider certification remain separate release gates.

## Server-signed heartbeat evidence

The Cloudflare-hosted `/api/pos/heartbeat` endpoint requires a valid Supabase access token and membership in the business, checks the POS belongs to that business, and signs a fresh server timestamp with a pinned P-256 key. The browser verifies the signature before storing the heartbeat in encrypted IndexedDB; a paired Windows Agent also verifies it and persists the timestamp with DPAPI. The service-role-only database RPC stores the original nonce and its hash, actor, POS identity, signature, server timestamp and gap in an append-only table so the signature can be independently verified later. The database trigger links new offline fiscal documents to the matching heartbeat interval, rejects issue timestamps outside its two-minute tolerance, and overwrites the client-supplied recovery deadline with the server-anchored 48-hour deadline. It does not discard or block synchronization after that deadline; overdue documents remain available for recovery and Article 44 escalation.

Provision the signing pair from the repository root:

```bash
node scripts/provision-atk-heartbeat-key.mjs
```

The script generates a fresh P-256 PKCS#8 key pair, cryptographically self-tests it, updates the pinned public key in the server, browser and Windows Agent, updates this document's SPKI fingerprint, and writes the private key to `.secrets/atk-heartbeat-private-key.pem`. The `.secrets/` directory is git-ignored. Review and commit only the public-key source/documentation changes; never add the private-key file.

Upload the generated private key as a Cloudflare Worker secret named `ATK_HEARTBEAT_PRIVATE_KEY_PEM` for Worker `fiskalo`. On macOS/Linux, run `npx wrangler secret put ATK_HEARTBEAT_PRIVATE_KEY_PEM --name fiskalo < .secrets/atk-heartbeat-private-key.pem`. In PowerShell, run `Get-Content -Raw .secrets/atk-heartbeat-private-key.pem | npx wrangler secret put ATK_HEARTBEAT_PRIVATE_KEY_PEM --name fiskalo`. Also provision `SUPABASE_SERVICE_ROLE_KEY` as a separate Worker secret with `npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY --name fiskalo`; never place it in browser code or a `NEXT_PUBLIC_` variable. Confirm the Worker has `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` configured as runtime variables. Deploy the commit containing the matching public key and then verify the live endpoint returns a valid signature. The endpoint fails closed if any required server setting is missing or the signing key is mismatched. Never commit or share either private key/secret.

The current source pin is a bootstrap key only. Run the provisioning script in a trusted checkout before enabling the endpoint in a deployed environment; it deliberately refuses to overwrite an existing local private-key file.

## Database implementation

Migrations:
- `0026_fiskalo_basic_article44_incident_register.sql`
- `0027_fiskalo_basic_article44_monthly_untransmitted_submission.sql`
- `0028_fiskalo_basic_article44_unfiscalized_export.sql`
- `0030_fiskalo_article44_scope_and_offline_payment_integrity.sql`
- `0031_fiskalo_article44_deadline_boundary.sql`
- `0032_fiskalo_article44_monthly_export_proof_guard.sql`
- `0034_fiskalo_basic_article44_authority_request_export.sql`

The owner UI is available at `/article-44`.


## Local clock rollback handling

The POS Agent preserves the last successful local probe timestamp as a high-water mark. If the Windows wall clock moves backwards, a healthy probe cannot overwrite that anchor or close an active outage with a restoration time earlier than the outage start. The operational ATK probe outage remains open until the clock catches up. This prevents internally inconsistent local deadlines; it does not make device time trustworthy or prove an ISP interruption. Server-signed heartbeat evidence is stored separately from the ATK probe state.

Bootstrap public-key SHA-256 SPKI fingerprint is `86da5bb521b4c6660f942385b79d2b53243038df33b0b43399e57c7646504cd9`.
