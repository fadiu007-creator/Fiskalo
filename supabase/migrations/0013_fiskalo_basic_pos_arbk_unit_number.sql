-- The 2026 ATK receipt identifies an SEF as:
-- [ARBK business-unit number]-[business NUI]-[POS ID].
alter table public.fiskalo_basic_pos
  add column if not exists unit_number text;

alter table public.fiskalo_basic_pos
  add constraint fiskalo_basic_pos_unit_number_format
  check (unit_number is null or
    (char_length(unit_number)=7 and translate(unit_number,'0123456789','')=''));
