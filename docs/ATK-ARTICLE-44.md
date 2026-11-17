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

Fiskalo now:
- calculates the deadline using the Europe/Belgrade (Kosovo) time zone;
- exports server-synchronized offline documents whose ATK state is not accepted, including rejected documents;
- combines those records with the unaccepted local POS Agent queue for the selected POS;
- includes the signed payloads, signatures, NUIKF, daily number, CouponId and submission state;
- requires the owner to archive the export and evidence of actual submission.

The export is scoped to one POS and requires that POS's paired Agent on the device holding its local queue. If an interruption affects multiple POS devices, the owner must record and export each affected POS from its corresponding Agent. It fails closed if that local queue cannot be read. A database-only export is not represented as a complete export of offline coupons.

## Important limitations

- The POS now records a server-signed heartbeat for the authenticated business/POS. When a later heartbeat arrives after a gap, the server evidence ledger records the previous and current server timestamps and measured gap. The browser verifies and stores the signed time in encrypted IndexedDB; a paired Windows Agent independently verifies it and persists it in the DPAPI-protected journal. New cloud-synchronized offline documents are linked to a server heartbeat interval (with a two-minute clock-skew tolerance), and the database derives the 48-hour recovery deadline from the trusted interval start. This proves an absence of POS heartbeat and bounds the local issue timestamp; it does not independently prove that the ISP was unavailable or the exact device issue second. The taxpayer must still retain provider/repair/force-majeure evidence required by Article 44.
- Local Agent timestamps and server records are separate evidence sources; the export preserves both.
- Fiskalo does not automatically email, upload or submit the notice/export to ATK. No official public Article 44 notice endpoint has been verified.
- A generated export or a stored notification reference is not proof that ATK accepted the documents.
- Actual ATK TEST acceptance, physical POS tests and legal/provider certification remain separate release gates.

## Server-signed heartbeat evidence

The Cloudflare-hosted `/api/pos/heartbeat` endpoint requires a valid Supabase access token and membership in the business, checks the POS belongs to that business, and signs a fresh server timestamp with a pinned P-256 key. The browser verifies the signature before storing the heartbeat in encrypted IndexedDB; a paired Windows Agent also verifies it and persists the timestamp with DPAPI. The service-role-only database RPC stores the original nonce and its hash, actor, POS identity, signature, server timestamp and gap in an append-only table so the signature can be independently verified later. The database trigger links new offline fiscal documents to the matching heartbeat interval, rejects issue timestamps outside its two-minute tolerance, and overwrites the client-supplied recovery deadline with the server-anchored 48-hour deadline. It does not discard or block synchronization after that deadline; overdue documents remain available for recovery and Article 44 escalation.

Configure the matching private key as a Cloudflare Worker secret:

```bash
npx wrangler secret put ATK_HEARTBEAT_PRIVATE_KEY_PEM --name fiskalo
```

The public key is pinned in the server/browser code. Its SHA-256 SPKI fingerprint is `f2d0ca6c8f7aa480d9bbbaf766212f2043c296b791bccc16a41f69f9c1a0ff87`. A missing or mismatched private key fails closed; the endpoint never accepts a browser timestamp as trusted time. Keep the PKCS#8 private key out of Git and out of all `NEXT_PUBLIC_` variables.

## Database implementation

Migrations:
- `0026_fiskalo_basic_article44_incident_register.sql`
- `0027_fiskalo_basic_article44_monthly_untransmitted_submission.sql`
- `0028_fiskalo_basic_article44_unfiscalized_export.sql`
- `0030_fiskalo_article44_scope_and_offline_payment_integrity.sql`
- `0031_fiskalo_article44_deadline_boundary.sql`
- `0032_fiskalo_article44_monthly_export_proof_guard.sql`

The owner UI is available at `/article-44`.


## Local clock rollback handling

The POS Agent preserves the last successful local probe timestamp as a high-water mark. If the Windows wall clock moves backwards, a healthy probe cannot overwrite that anchor or close an active outage with a restoration time earlier than the outage start. The operational ATK probe outage remains open until the clock catches up. This prevents internally inconsistent local deadlines; it does not make device time trustworthy or prove an ISP interruption. Server-signed heartbeat evidence is stored separately from the ATK probe state.
