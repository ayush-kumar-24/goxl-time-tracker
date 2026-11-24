# GoXL Team Hub

Internal team platform for GoXL Tech: tasks with dependencies, automatic start/end timers, project documents, project-lead suggestions, weekly and team reports, team chat, a Super Admin panel, and the Work Intelligence Engine (daily log + founder dashboard).

**Target address:** https://www.goxl.in/team

## Current state (read this first)

| Part | Status |
|---|---|
| Front-end (`team/index.html`) | Complete and clickable, but runs in **demo mode**: data is in memory and resets on reload. |
| Database (`supabase/schema.sql`) | Complete. Tables, security rules, server-side functions, file storage. **Tested** (49 checks, `supabase/tests`). Not yet applied to a live project. |
| Wiring front-end to database | **Not done.** `docs/BACKEND_INTEGRATION.md` maps every screen action to a database call. |
| Hosting | **Not done.** `docs/DEPLOY_VERCEL.md` has the steps. |

## Repo layout

```
team/index.html          the whole front-end (single file, no build step)
supabase/schema.sql      run once in a Supabase project
supabase/tests/          local test suite for the schema (plain Postgres)
vercel.json              serves the app at /team
docs/                    architecture, roles, data model, integration, deploy
```

## Quick start for the team

1. Create a Supabase project, run `supabase/schema.sql` in the SQL editor.
2. **Sign up first as Viraj**: the first account becomes Super Admin automatically, then the door closes. Everyone else waits as "pending" until approved in the Admin panel.
3. Wire the front-end (`docs/BACKEND_INTEGRATION.md`).
4. Deploy to Vercel and attach `www.goxl.in` (`docs/DEPLOY_VERCEL.md`).

## Run the schema tests

Needs PostgreSQL 15+ and Python with `psycopg2`.

```
createdb t
psql -d t -f supabase/tests/stubs.sql    # stand-ins for Supabase's auth/storage
psql -d t -f supabase/schema.sql
python3 supabase/tests/run_tests.py "dbname=t"
```
Use a fresh database each run (the first sign-up closes the bootstrap).
