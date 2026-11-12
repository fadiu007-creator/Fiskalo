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

The route requires an authenticated business owner. It calls the read-only `fiskalo_basic_sales_report` RPC, whose private SECURITY DEFINER helper re-checks `auth.uid()`, the business ID, and the `owner` membership role before reading report rows. The private helper is not executable by `anon` or `authenticated`; only the public wrapper is executable by authenticated users. Coupon and ATK transaction identifiers are returned as text so uint64 values are not rounded by JavaScript JSON number parsing.

The report caps a single interval at 20,000 sales and returns a truncation flag when more rows exist; narrow the date range for a complete export of a larger period. The RPC is read-only and does not change sales, stock, or fiscal documents. Existing direct table RLS policies are unchanged by this feature; this RPC does not tighten the broader member-read policy on the sales tables.

CSV exports include the current date range and use a UTF-8 BOM for spreadsheet compatibility. Text cells are quoted and formula-prefixed values are neutralized to reduce spreadsheet formula-injection risk.

## Compliance boundary

This is a management and reconciliation report over Fiskalo's own records. It is **not** an official ATK declaration, Z/X fiscal-device report, sales-book filing, or evidence that ATK accepted any coupon. Official reporting and filing obligations must continue to be completed through the applicable ATK/EDI processes until ATK confirms an approved electronic reporting interface for this software.


**Database release gate:** migration `0021_fiskalo_basic_owner_sales_report.sql` is additive and committed in this branch. It has not been applied to any Supabase project. Run `supabase/tests/0021_fiskalo_basic_owner_sales_report.sql` in an approved staging database after migrations 0001–0021 are applied sequentially. The SQL contract test has not yet been executed against PostgreSQL.
