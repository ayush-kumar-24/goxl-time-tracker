#!/usr/bin/env bash
# Starts a local copy of the Supabase services this app uses, for testing before any
# hosted project exists. Uses the real Supabase auth, data API and storage servers.
#
# Needs: a local PostgreSQL 15+ you may create databases in, Docker, Node 18+.
#   PGHOST=127.0.0.1 PGPORT=5432 PGUSER=postgres supabase/local/start.sh
#
# Recreates the database "goxl_local" from scratch on every run. Touches nothing else.
# Realtime is not part of this stack; the front-end falls back to refreshing on a timer.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${PGHOST:=127.0.0.1}" "${PGPORT:=5432}" "${PGUSER:=postgres}" "${DB:=goxl_local}"
: "${GOTRUE_IMAGE:=supabase/gotrue:v2.198.0}" "${POSTGREST_IMAGE:=postgrest/postgrest:v16.6}" "${STORAGE_IMAGE:=supabase/storage-api:v1.98.7}"
: "${GATEWAY_PORT:=8000}" "${WITH_STORAGE:=1}"
export PGHOST PGPORT PGUSER GATEWAY_PORT
# Local-only signing secret. Not used anywhere else.
JWT_SECRET="local-test-secret-not-for-production-0123456789"
jwt() { node -e '
  const c=require("crypto"),b=o=>Buffer.from(JSON.stringify(o)).toString("base64url");
  const p=b({alg:"HS256",typ:"JWT"})+"."+b({role:process.argv[1],iss:"supabase-local",iat:1700000000,exp:4102444800});
  console.log(p+"."+c.createHmac("sha256",process.argv[2]).update(p).digest("base64url"))' "$1" "$JWT_SECRET"; }
ANON_KEY=$(jwt anon); SERVICE_KEY=$(jwt service_role); export ANON_KEY
wait_http() { for _ in $(seq 1 60); do curl -s -o /dev/null "$1" && return 0; sleep 1; done; echo "Timed out waiting for $1" >&2; return 1; }

docker rm -f goxl-gotrue goxl-postgrest goxl-storage >/dev/null 2>&1 || true
[ -f /tmp/goxl-gateway.pid ] && kill "$(cat /tmp/goxl-gateway.pid)" >/dev/null 2>&1 || true

echo "1. Database $DB"
psql -q -d postgres -c "select pg_terminate_backend(pid) from pg_stat_activity where datname='$DB' and pid<>pg_backend_pid()" >/dev/null
dropdb --if-exists "$DB"; createdb "$DB"
psql -q -v ON_ERROR_STOP=1 -v DBNAME="$DB" -d "$DB" -f local/bootstrap.sql

echo "2. Auth server (creates the auth schema)"
docker run -d --name goxl-gotrue --network host \
  -e GOTRUE_API_HOST=127.0.0.1 -e PORT=9999 -e API_EXTERNAL_URL="http://127.0.0.1:$GATEWAY_PORT/auth/v1" \
  -e GOTRUE_SITE_URL="http://127.0.0.1:$GATEWAY_PORT/team" \
  -e GOTRUE_DB_DRIVER=postgres -e GOTRUE_DB_DATABASE_URL="postgres://supabase_auth_admin@$PGHOST:$PGPORT/$DB?sslmode=disable" \
  -e GOTRUE_JWT_SECRET="$JWT_SECRET" -e GOTRUE_JWT_EXP=3600 -e GOTRUE_JWT_AUD=authenticated \
  -e GOTRUE_JWT_DEFAULT_GROUP_NAME=authenticated -e GOTRUE_JWT_ADMIN_ROLES=service_role \
  -e GOTRUE_DISABLE_SIGNUP=false -e GOTRUE_EXTERNAL_EMAIL_ENABLED=true -e GOTRUE_MAILER_AUTOCONFIRM=true \
  -e GOTRUE_RATE_LIMIT_EMAIL_SENT=10000 "$GOTRUE_IMAGE" >/dev/null
wait_http http://127.0.0.1:9999/health

if [ "$WITH_STORAGE" = 1 ]; then
  echo "3. Storage server (creates the storage schema)"
  mkdir -p /tmp/goxl-storage
  docker run -d --name goxl-storage --network host -v /tmp/goxl-storage:/var/lib/storage \
    -e SERVER_HOST=127.0.0.1 -e SERVER_PORT=5000 -e ANON_KEY="$ANON_KEY" -e SERVICE_KEY="$SERVICE_KEY" \
    -e AUTH_JWT_SECRET="$JWT_SECRET" -e PGRST_JWT_SECRET="$JWT_SECRET" \
    -e DATABASE_URL="postgres://supabase_storage_admin@$PGHOST:$PGPORT/$DB" \
    -e DB_INSTALL_ROLES=false -e STORAGE_BACKEND=file -e FILE_STORAGE_BACKEND_PATH=/var/lib/storage \
    -e STORAGE_FILE_BACKEND_PATH=/var/lib/storage -e FILE_SIZE_LIMIT=52428800 -e TENANT_ID=local -e REGION=local \
    -e GLOBAL_S3_BUCKET=local -e ENABLE_IMAGE_TRANSFORMATION=false "$STORAGE_IMAGE" >/dev/null
  wait_http http://127.0.0.1:5000/status
else
  echo "3. Storage server skipped; using table stand-ins"
  psql -q -v ON_ERROR_STOP=1 -d "$DB" <<'SQL'
create table storage.buckets (id text primary key, name text, public boolean default false);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid);
alter table storage.objects enable row level security;
create function storage.foldername(name text) returns text[] language sql immutable as $$ select string_to_array(name, '/') $$;
SQL
fi

echo "4. Application schema and migrations"
psql -q -v ON_ERROR_STOP=1 -d "$DB" -f schema.sql
for f in migrations/*.sql; do psql -q -v ON_ERROR_STOP=1 -d "$DB" -f "$f"; done

echo "5. Data API"
docker run -d --name goxl-postgrest --network host \
  -e PGRST_DB_URI="postgres://authenticator@$PGHOST:$PGPORT/$DB" -e PGRST_DB_SCHEMAS=public,storage \
  -e PGRST_DB_ANON_ROLE=anon -e PGRST_JWT_SECRET="$JWT_SECRET" -e PGRST_SERVER_HOST=127.0.0.1 -e PGRST_SERVER_PORT=3001 \
  "$POSTGREST_IMAGE" >/dev/null
wait_http http://127.0.0.1:3001/

echo "6. Gateway and front-end"
nohup node local/gateway.mjs >/tmp/goxl-gateway.log 2>&1 &
echo $! > /tmp/goxl-gateway.pid
wait_http "http://127.0.0.1:$GATEWAY_PORT/team"
echo
echo "Ready: http://127.0.0.1:$GATEWAY_PORT/team"
echo "The first account to sign up becomes Super Admin."
