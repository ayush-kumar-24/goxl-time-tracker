# Phase 0 results

Scope agreed: fix the database security findings, integrate real authentication, verify with several roles. No AI work, no production deployment, no destructive database change, no hosted Supabase project created or modified.

Everything below was run on a local stack: PostgreSQL 16 plus the real Supabase auth server (GoTrue v2.198.0), data API (PostgREST v16.6) and storage server (storage-api v1.98.7). It has **not** been run on a hosted Supabase project, because GoXL's own organisation does not exist yet.

## What changed

| Area | Change | File |
|---|---|---|
| Database | Task writes limited to named columns; status changes only through `start_timer`, `complete_task` and the new `reopen_task` (finding A2) | `supabase/migrations/20261124130000_phase0_hardening.sql` |
| Database | Assignee must be active and able to see the project (A3) | same |
| Database | People who may reassign can read membership of projects they already see (A4) | same |
| Database | `admin_set_capacity` writes to the audit log; `tasks.updated_at` added | same |
| Front-end | Real mode: email and password sign-in, approval gate, data loaded from the database, every action is a database call | `team/backend.js`, `team/config.js` |
| Front-end | `index.html`: inline changes moved into named functions so real mode can replace them; week labels follow the real week when signed in | `team/index.html` |
| Front-end | Supabase client library stored in the repo (v2.119.2, MIT), so the page does not depend on a third-party CDN | `team/vendor/` |
| Tooling | Local stack, database test runner, browser tests | `supabase/local/`, `supabase/tests/`, `tests/e2e/` |

The migration is additive: no table, column or row is removed, and it can be applied twice without error. `supabase/schema.sql` is unchanged.

The demo is unchanged. With `team/config.js` left empty the page behaves as before, with sample data.

## Test results

| Suite | What it proves | Result |
|---|---|---|
| Baseline, migration **not** applied | The three findings are real: each attack succeeds on the original schema | 16 of 16 |
| Original schema checks, migration applied | Nothing that worked before is broken | 49 of 49 |
| Hardening checks, migration applied | Every attack is refused; legitimate edits still work | 34 of 34 |
| Migration applied twice | Re-runnable | pass |
| Browser, real sign-in, five accounts | Roles see and can do only what they should, through the real page and through hand-made requests | 66 of 66 |
| Demo comparison, old page against new page | 64 recorded screens and 31 messages are identical, no script errors | 0 differences |

### What the browser test covers

Five people sign up on the sign-in screen and each works in their own browser session.

- **Approval:** the first account becomes Super Admin; later accounts see "Waiting for approval" and can read nothing, even with a hand-made request; a pending account cannot promote itself.
- **Super Admin:** approves accounts, sets roles, grants project access, sees the founder dashboard and the audit log, deactivates an account, cannot deactivate their own.
- **Project Manager:** creates a project, tasks and a dependency; has no Admin or Founder screens; is offered only people on the project as assignees; a hand-made request to assign someone outside the project, or to change a role, is refused.
- **Member:** has no New task button, cannot change priority or reassign; cannot start a blocked task; hand-made requests to mark a task done, change priority, create a task or insert time are all refused and the task is unchanged.
- **Project Lead:** starts a timer, completes a task, and the dependent task unblocks for the member.
- **Member, continued:** timer, project chat, document upload with preview, opening the stored file, daily log filled from tracked time, session kept after reload.
- **Active account with no project:** sees no projects, tasks, project channels, documents or other people's logs, cannot download a project file even with its exact path, cannot post into a project channel.
- **Sign-in:** wrong password refused with a clear message; sign out and sign in again work.

## Added after Phase 0 review

- **Typography:** smaller, lighter text in Montserrat; sentence case instead of wide uppercase. Layout unchanged.
- **Sample data:** "Aria" renamed to "Aarya".
- **Invitations:** a Super Admin can add a person by email with a role and projects (`supabase/migrations/20261125090000_invitations.sql`, Admin screen). 25 database checks and 10 browser checks cover it; the browser suite is now 76 of 76.

## Not verified

- **Hosted Supabase.** Run `docs/STAGING_SETUP.md` once GoXL's organisation exists. Differences between a local stack and a hosted project are possible.
- **Live updates over websocket.** The local stack has no realtime server, so the test used the 20-second refresh. The websocket path in `team/backend.js` is written but has never run.
- **Email confirmation.** Locally, new accounts are confirmed automatically. The "check your email" path is written but untested.
- **Larger data.** Loading reads the latest 1,000 time entries and 500 messages. Fine for the current team size; needs paging later.

## Not built in Phase 0

- Password reset ("forgot password").
- A Reopen button. `reopen_task` exists in the database; the screens have no button for it yet.
- Editing weekly capacity or job title from the Admin screen (the database functions exist).
- A Content-Security-Policy header in `vercel.json`. It needs the final Supabase address, so it belongs with deployment.

## Run it yourself

Needs PostgreSQL 15+, Python with `psycopg2`, Docker and Node 18+ with Playwright.

```
PGPORT=5432 supabase/tests/run_all.sh          # database suites
PGPORT=5432 supabase/local/start.sh            # local stack at http://127.0.0.1:8000/team
node tests/e2e/roles.cjs                       # browser test; needs a freshly started stack
```

## Decisions recorded for later phases

Confirmed on review of `docs/AI_ASSISTANT_PLAN.md`:

1. Agent loop: Claude Messages API inside Supabase Edge Functions.
2. Models: an economical model for routine work and a more capable one for complex reasoning, with per-user daily limits and cost tracking. Current availability and prices are to be checked at the start of Phase 1.
3. Conversations are private. Super Admin sees action logs only.
4. Manual time entries allowed, marked as manual and kept apart from timer entries.
5. Knowledge: project documents and a company-wide space, with separate permissions for confidential HR, finance and management material.
6. Unattended runs read, notify and draft only.
7. Staging lives in a dedicated GoXL Supabase organisation, provisioned separately.

Added requirements: idempotency keys on every assistant action; structured history with before and after values; awareness of the person's current work and the conversation; search for an existing task before creating one; next-task recommendations from priority, deadline and dependencies; the model never bypasses database permissions; the dashboard keeps working beside the chat.

Phase 1 has not started.
