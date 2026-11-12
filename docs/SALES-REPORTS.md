# Basic sales reports

The owner-only `/reports` screen reads the existing Basic sales ledger through the authenticated Supabase client. It does not create, mutate, or delete sales, fiscal documents, stock, or customer data.

## Included calculations

- Gross sales, net sales, VAT, average sale value, and sale count for an inclusive local-date range.
- Payment-method totals from the payment method persisted on each Basic sale.
- VAT bases and VAT amounts grouped by the stored ATK VAT letter and VAT rate from immutable sale-line snapshots.
- Daily totals grouped in the `Europe/Belgrade` timezone used for Kosovo local dates.
- Fiscalization states separated from payment states.

A sale is counted as ATK-accepted only when its original Sale fiscal document has `submission_state = accepted` and a positive uint64 `atk_transaction_id`. An accepted-looking record without a valid transaction ID is reported as unconfirmed. Correction documents are excluded from the Sale status calculation.

## Access and data scope

The route requires an authenticated business owner. It first resolves the caller's membership, then filters sales by that business ID. Sale lines and fiscal documents are queried only for those sale IDs and remain subject to their existing RLS policies. Cashiers cannot access the financial report route.

Sales are paginated in batches of 500. The report caps a single interval at 20,000 sales and displays a warning when the cap is reached; narrow the date range for a complete export of a larger period. Child rows are also paginated.

CSV exports include the current date range and use a UTF-8 BOM for spreadsheet compatibility. Text cells are quoted and formula-prefixed values are neutralized to reduce spreadsheet formula-injection risk.

## Compliance boundary

This is a management and reconciliation report over Fiskalo's own records. It is **not** an official ATK declaration, Z/X fiscal-device report, sales-book filing, or evidence that ATK accepted any coupon. Official reporting and filing obligations must continue to be completed through the applicable ATK/EDI processes until ATK confirms an approved electronic reporting interface for this software.
