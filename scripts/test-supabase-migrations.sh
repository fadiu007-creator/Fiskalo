#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL must point to a disposable PostgreSQL database}"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PSQL=(psql "${DATABASE_URL}" --no-psqlrc --set=ON_ERROR_STOP=1)

echo "Bootstrapping disposable Supabase Auth compatibility objects"
"${PSQL[@]}" --file "$ROOT_DIR/supabase/tests/bootstrap.sql"

while IFS= read -r migration; do
  echo "Applying ${migration#"$ROOT_DIR/"}"
  "${PSQL[@]}" --file "$migration"
done < <(find "$ROOT_DIR/supabase/migrations" -maxdepth 1 -type f -name '*.sql' -print | sort)

while IFS= read -r contract; do
  echo "Running SQL contract ${contract#"$ROOT_DIR/"}"
  "${PSQL[@]}" --file "$contract"
done < <(find "$ROOT_DIR/supabase/tests" -maxdepth 1 -type f -name '*.sql' ! -name 'bootstrap.sql' -print | sort)

echo "All Fiskalo migrations and SQL contracts passed."
