-- Store only the public ATK-issued POS certificate in the Fiskalo POS registry.
-- The private ECDSA key remains non-exportable in the browser's IndexedDB key store.
alter table public.fiskalo_basic_pos
  add column if not exists atk_certificate_pem text;
