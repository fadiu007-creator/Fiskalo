# Full application migrations

These are additive migrations for the existing Full Fiskalo schema (`fiskalo_products`, `fiskalo_invoice_items`, and related tables). They are deliberately kept separate from the Basic MVP migration stream because the repository does not yet contain the complete historical Full-schema baseline.

Do not use this directory as a fresh-install migration sequence. Restore and review the Full-schema baseline before attempting a clean Full database replay.

The category migration expands the legacy 35-code Full database constraint to the complete 2026 ATK category annex (53 published rows, 52 unique codes). It preserves historical NULL invoice-item snapshots and every previously valid code.

CI applies this migration only to a disposable fixture that refuses to run if real Full Fiskalo tables already exist. No connected Supabase project is modified by CI.
