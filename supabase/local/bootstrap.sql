-- Local test stack only. Creates the roles and empty schemas that a hosted Supabase
-- project already has, so the real auth (GoTrue), API (PostgREST) and storage services
-- can run against a plain PostgreSQL. NEVER run this against a Supabase project.
do $$
declare r text;
begin
  foreach r in array array['anon','authenticated','service_role'] loop
    if not exists (select 1 from pg_roles where rolname = r) then execute format('create role %I nologin', r); end if;
  end loop;
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then create role authenticator login noinherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then create role supabase_auth_admin login createrole; end if;
  if not exists (select 1 from pg_roles where rolname = 'supabase_storage_admin') then create role supabase_storage_admin login createrole; end if;
end $$;
alter role service_role bypassrls;
grant anon, authenticated, service_role to authenticator;
grant anon, authenticated, service_role to supabase_storage_admin;

create extension if not exists pgcrypto;
create schema if not exists auth authorization supabase_auth_admin;
create schema if not exists storage authorization supabase_storage_admin;
alter role supabase_auth_admin set search_path = auth;
alter role supabase_storage_admin set search_path = storage;
grant usage on schema public, auth, storage to anon, authenticated, service_role;
grant create on database :"DBNAME" to supabase_auth_admin, supabase_storage_admin;
grant all on schema public to supabase_auth_admin, supabase_storage_admin;

-- Same defaults a hosted project has: new tables in public are reachable by the API roles,
-- and Row Level Security decides what each role may actually do.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;

do $$ begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then create publication supabase_realtime; end if;
end $$;
