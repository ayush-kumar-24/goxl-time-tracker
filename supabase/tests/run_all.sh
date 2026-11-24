#!/usr/bin/env bash
# Runs every schema test on scratch databases. Needs PostgreSQL 15+ and python3 with psycopg2.
#   PGHOST=127.0.0.1 PGPORT=5432 PGUSER=postgres supabase/tests/run_all.sh
# Creates and drops scratch databases named goxl_test_*. Touches nothing else.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${PGHOST:=127.0.0.1}" "${PGPORT:=5432}" "${PGUSER:=postgres}"
export PGHOST PGPORT PGUSER
dsn() { echo "host=$PGHOST port=$PGPORT user=$PGUSER dbname=$1"; }
fresh() {
  dropdb --if-exists "$1"; createdb "$1"
  psql -q -v ON_ERROR_STOP=1 -d "$1" -f tests/stubs.sql -f schema.sql >/dev/null
}
migrate() { for f in migrations/*.sql; do psql -q -v ON_ERROR_STOP=1 -d "$1" -f "$f" >/dev/null; done; }
rc=0

echo "== 1/3 Baseline WITHOUT the migration: the audit findings must reproduce =="
fresh goxl_test_baseline
python3 tests/run_hardening_tests.py "$(dsn goxl_test_baseline)" --expect vulnerable || rc=1

echo; echo "== 2/3 Original 49 checks WITH the migration: nothing existing may break =="
fresh goxl_test_regress; migrate goxl_test_regress
python3 tests/run_tests.py "$(dsn goxl_test_regress)" || rc=1

echo; echo "== 3/3 Hardening checks WITH the migration: every attack must be refused =="
fresh goxl_test_fixed; migrate goxl_test_fixed
python3 tests/run_hardening_tests.py "$(dsn goxl_test_fixed)" --expect fixed || rc=1

echo; echo "== Invitations =="
fresh goxl_test_invite; migrate goxl_test_invite
python3 tests/run_invite_tests.py "$(dsn goxl_test_invite)" || rc=1
dropdb --if-exists goxl_test_invite

echo; echo "== Migrations can be applied twice without error =="
migrate goxl_test_fixed && echo "PASS migration is re-runnable" || { echo "FAIL migration is not re-runnable"; rc=1; }

dropdb --if-exists goxl_test_baseline; dropdb --if-exists goxl_test_regress; dropdb --if-exists goxl_test_fixed
echo; [ $rc -eq 0 ] && echo "ALL SUITES PASSED" || echo "SOME SUITES FAILED"
exit $rc
