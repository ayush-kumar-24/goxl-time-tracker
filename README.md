# GoXL Team Hub

Internal team platform for GoXL Tech: tasks with dependencies, automatic start/end timers, project documents, project-lead suggestions, weekly and team reports, team chat, a Super Admin panel, and the Work Intelligence Engine (daily log + founder dashboard).

**Target address:** https://www.goxl.in/team

## Current state (read this first)

| Part | Status |
|---|---|
| Front-end (`team/index.html`) | Runs as the **demo** while `team/config.js` is empty. With a Supabase project filled in, it uses real sign-in and the real database (`team/backend.js`). |
| Database (`supabase/schema.sql` + `supabase/migrations/`) | Complete and tested locally. Not yet applied to a hosted project. |
| Wiring front-end to database | Done and tested on a local stack with five roles. See `docs/PHASE0_RESULTS.md`. |
| Hosting, staging | **Not done.** `docs/STAGING_SETUP.md` and `docs/DEPLOY_VERCEL.md` have the steps. |
| AI assistant | **Not started.** Plan in `docs/AI_ASSISTANT_PLAN.md`. |

## Repo layout

```
team/index.html          the screens (single file, no build step)
team/backend.js          real mode: sign-in, loading, database calls
team/config.js           Supabase address and publishable key (empty = demo)
team/vendor/             Supabase client library
supabase/schema.sql      baseline schema, run once
supabase/migrations/     changes applied after the baseline, in name order
supabase/tests/          database test suites (plain Postgres)
supabase/local/          local stack with the real Supabase auth, API and storage servers
tests/e2e/               browser tests
vercel.json              serves the app at /team
docs/                    architecture, roles, data model, plan, results, setup
```

## Quick start for the team

1. Create a Supabase project, run `supabase/schema.sql`, then every file in `supabase/migrations/`.
2. **Sign up first as Viraj**: the first account becomes Super Admin automatically, then the door closes. Everyone else waits as "pending" until approved in the Admin panel.
3. Put the project URL and publishable key in `team/config.js`.
4. Deploy to Vercel and attach `www.goxl.in` (`docs/DEPLOY_VERCEL.md`).

Full steps: `docs/STAGING_SETUP.md`.

## Run the tests

Database suites need PostgreSQL 15+ and Python with `psycopg2`. They create and drop scratch databases named `goxl_test_*`.

```
PGPORT=5432 supabase/tests/run_all.sh
```

Browser tests also need Docker and Node 18+ with Playwright.

```
PGPORT=5432 supabase/local/start.sh
node tests/e2e/roles.cjs
```
