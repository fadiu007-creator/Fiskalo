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

The export requires the paired POS Agent on the device holding the local queue. It fails closed if that local queue cannot be read. A database-only export is not represented as a complete export of offline coupons.

## Important limitations

- The incident start time is currently entered by the owner. It is not yet independently established by a server-signed connectivity heartbeat.
- Local Agent timestamps and server records are separate evidence sources; the export preserves both.
- Fiskalo does not automatically email, upload or submit the notice/export to ATK. No official public Article 44 notice endpoint has been verified.
- A generated export or a stored notification reference is not proof that ATK accepted the documents.
- Actual ATK TEST acceptance, physical POS tests and legal/provider certification remain separate release gates.

## Database implementation

Migrations:
- `0026_fiskalo_basic_article44_incident_register.sql`
- `0027_fiskalo_basic_article44_monthly_untransmitted_submission.sql`
- `0028_fiskalo_basic_article44_unfiscalized_export.sql`
- `0030_fiskalo_article44_scope_and_offline_payment_integrity.sql`
- `0031_fiskalo_article44_deadline_boundary.sql`
- `0032_fiskalo_article44_monthly_export_proof_guard.sql`

The owner UI is available at `/article-44`.
