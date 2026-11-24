# AI assistant: audit and integration plan

Status: **approved in principle; Phase 0 complete, Phase 1 not started.** Confirmed decisions and added requirements are recorded in `docs/PHASE0_RESULTS.md`.

Goal: every signed-in person gets a personal assistant that can read what they are allowed to read, act where they are allowed to act, and never exceed that.

---

## 1. Audit of what exists

Based on reading `supabase/schema.sql`, `team/index.html` and `docs/`. The schema has not been run against a live project in this review; findings come from the code.

### 1.1 What helps

- **Security already lives in the database.** Row Level Security plus `has_perm()`, `can_see_project()` and the RPCs all key off `auth.uid()`. If the assistant calls the database with the user's own session token, every existing rule applies to it with no extra code. This is the foundation of the whole design.
- **Multi-step actions are already RPCs** (`start_timer`, `stop_timer`, `complete_task`, `suggest_project_lead`, `decide_lead_suggestion`, `admin_set_*`). Each maps one-to-one to an assistant tool.
- **An approval pattern already exists** in `lead_suggestions` (suggest, then a Founder or Super Admin decides). The assistant's approval workflow generalises it.
- **A schema test suite exists** (49 checks) and can be extended for every new table and RPC.

### 1.2 Blockers and gaps

| # | Finding | Why it matters for the assistant |
|---|---|---|
| A1 | **Front-end is demo-only.** Identity is a picker, data lives in the `S` object, and every permission check is client-side. | There is no real user, session or data for an assistant to work with. Wiring the front-end to Supabase is a hard prerequisite. |
| A2 | **`tasks_update` is too wide.** An assignee, or anyone with `setPriority` or `reassign`, can update any column. `tasks_guard` only protects priority, due date and assignee. So `status` can be set to `done` directly (skipping `complete_task`, leaving timers running and `done_at` empty), a blocked task can be set to `doing`, and a task can be moved to another project. | An assistant makes this kind of shortcut far more likely to be taken. Status changes should be possible only through RPCs, and direct updates limited to named columns. |
| A3 | **Assignees are not validated.** `assignee_id` can be any profile, including someone inactive or without access to the project, who then cannot see their own task. | The assistant will assign tasks by name; the database must refuse invalid assignees. |
| A4 | **`project_access` is readable only by the person themselves, Founders and Super Admins.** | A PM's assistant cannot find out who is on a project, so it cannot suggest valid assignees or mention the right people. |
| A5 | **`audit_log` is free text and only covers admin RPCs** (and `admin_set_capacity` writes nothing). Task, project, doc and timer changes leave no trail. | "Action logs" need structured records: who, via what, which row, before and after. |
| A6 | **No notifications and no mentions.** `messages` has a body and a channel only. | Two requested capabilities have no data model yet. |
| A7 | **Knowledge is thin.** `docs.preview_text` holds the first 8,000 characters of text files only. PDFs and Office files have no extracted text. Every doc belongs to a project; there is no company-wide space. | Answering from company and project knowledge needs full-text extraction, chunking and a company-level home. |
| A8 | **Time can only be recorded by a live timer.** There are no manual or corrected entries. | "Log two hours on X yesterday" has nowhere to go. Needs a decision (see section 8). |
| A9 | **`daily_logs.payload` is unvalidated JSON** and `log_date` can be any date. | The assistant will write these; shape and date range should be checked in the database. |
| A10 | **Roles are global, not per project.** `projects.lead_id` grants nothing by itself; a `project_lead` has manager permissions on every project they can see. | Acceptable for now, but the assistant will reflect it: a lead of one project can manage tasks in any project they can see. |
| A11 | **Front-end rendering.** Everything is built with `innerHTML` and an `esc()` helper that does not escape single quotes. `vercel.json` sets no Content-Security-Policy. | Assistant output is untrusted text. It must be rendered as text or through a strict Markdown sanitiser, and a CSP should be added. |
| A12 | **Bootstrap.** The first sign-up becomes Super Admin. | Unchanged by this plan, but sign up immediately after applying the schema to any reachable project. |
| A13 | **No activity history on tasks** (`updated_at`, comments, status history). | Insights such as "what slipped this week" are limited to what `time_entries`, `done_at` and daily logs can show. |

A2 and A3 are worth fixing regardless of the assistant.

---

## 2. Proposed architecture

```
Browser (team/index.html)
  └─ assistant panel ── HTTPS + user's Supabase session token, streamed reply
        │
        ▼
Supabase Edge Function  `assistant`
  1. verify the token, load profile; refuse if not active
  2. build context: platform guide + the user's role, permissions, projects
  3. call the Claude API with the tool list this user is allowed to have
  4. for each tool call:
        read  ─────────► run now, as the user
        write ─────────► record in ai_actions, then
                           low risk   → run now, as the user
                           sensitive  → stop and ask the user to confirm
                           restricted → route to an approver
  5. store messages, token usage and results
        │
        ▼
Postgres (existing RLS and RPCs, unchanged in spirit)
```

Principles:

1. **The assistant is the user.** Every database call from a tool uses a Supabase client created with the caller's token. The service-role key is never used to execute a tool. The assistant cannot see or do anything the person could not do by hand.
2. **The model proposes; the server decides.** Risk tier, permission check and approval state are enforced in the Edge Function and the database, never by instructions in the prompt.
3. **Tools are narrow and typed.** No free-form SQL, no generic "update row" tool. Each tool wraps one query or one RPC, with a strict input schema.
4. **The Claude API key lives only in Edge Function secrets.** This matches the existing rule in `docs/ARCHITECTURE.md`.
5. **Existing screens keep working unchanged.** The assistant is an additional way to do what the UI already does.

### Where the agent loop runs

Recommended: the Claude Messages API with tool use, with the loop hosted in the Edge Function. Reasons: every tool is a database call that must run under the user's token inside our backend, no code sandbox is needed, conversation data stays in Supabase, and approvals are rows in our own tables.

Alternative: Claude Managed Agents (beta), where Anthropic hosts the loop and session state. It adds built-in "always ask" tool permissions and scheduled runs, and bills session runtime on top of tokens. It becomes more attractive in phase 5 for scheduled, user-less runs. This is decision 1 in section 8.

### Model

Default `claude-opus-5-5` with adaptive thinking, streaming, strict tool schemas, and prompt caching on the stable prefix (tool list and platform guide). List price is $4 per million input tokens and $20 per million output tokens. A cheaper tier (`claude-sonnet-5-5` at $2 / $10, or `claude-haiku-5-5`) is a cost decision for you; see decision 2.

### Knowledge retrieval

Start with Postgres full-text search over extracted document text, filtered by RLS so results never include a project the user cannot see. Add `pgvector` embeddings later only if search quality proves insufficient; for a team of eight and a modest document set, full-text is likely enough and has no extra moving parts. Answers cite the document and section they came from.

Platform knowledge ("how do dependencies work", "who can approve a lead") is a short guide written from `docs/` and placed in the system prompt, plus a `get_my_context` tool for the user's own role and permissions.

---

## 3. Database changes (proposed, not applied)

### 3.1 New tables

| Table | Purpose | Who can read |
|---|---|---|
| `ai_conversations` | One row per chat thread: `user_id`, title, timestamps | Owner only |
| `ai_messages` | Messages in a thread, stored as the API content blocks (text, tool calls, tool results) | Owner only |
| `ai_actions` | Every tool call that writes: requester, tool, arguments, risk tier, status, approver, result or error, timestamps | Requester, the designated approver, Super Admin |
| `ai_tool_policy` | Per tool: risk tier, required permission, enabled flag. Editable by Super Admin | All active users (read) |
| `ai_usage` | Tokens and cost per user per day, for caps and reporting | Owner, Super Admin |
| `notifications` | `user_id`, kind, title, body, link, `read_at`, source (`ui`, `assistant`, `system`) | Recipient only |
| `message_mentions` | `message_id`, `mentioned_user_id`; a trigger creates the notification | Follows channel visibility |
| `knowledge_chunks` | `doc_id`, `project_id`, chunk text, `tsvector` (later an embedding column) | Follows `can_see_project` |
| `activity_log` | Structured trail: actor, `via` (`ui` or `assistant`), action, entity type and id, before and after, `ai_action_id` | Project members for their projects; Super Admin for all |

`ai_actions.status` values: `proposed`, `awaiting_confirmation`, `awaiting_approval`, `approved`, `rejected`, `executed`, `failed`, `expired`. Transitions happen only through RPCs that check `auth.uid()`; there are no direct write policies.

### 3.2 Changes to existing tables

- `role_permissions`: new permissions `useAssistant` and `assistantActions` (lets Super Admin give a role a read-only assistant).
- `tasks`: add `updated_at`; restrict direct updates to `title`, `description`, `est_hours`, `priority`, `due_date`, `assignee_id`; status changes only through RPCs (fixes A2). New trigger refuses an assignee who is inactive or lacks project access (A3).
- `project_access`: allow people with `reassign` to read membership of projects they can see (A4).
- `docs`: allow a company-wide space (decision 5), and add `extracted_at` for the extraction pipeline.
- `daily_logs`: a check on payload shape and on `log_date` being within a few days of today (A9).
- `time_entries`: `source` (`timer`, `manual`) and `note`, plus a `log_time` RPC, if manual entries are approved (decision 4).
- `audit_log`: kept as is; new structured records go to `activity_log`. `admin_set_capacity` starts logging.
- Realtime publication: add `notifications` and `ai_actions`.

### 3.3 New RPCs

`reopen_task`, `set_task_status` (replaces direct status edits), `post_message_with_mentions`, `mark_notifications_read`, `search_knowledge`, `ai_record_action`, `ai_confirm_action`, `ai_decide_action` (approver), `ai_mark_executed`, and optionally `log_time`.

Each ships with tests in `supabase/tests`, and as a migration file rather than an edit to the one-shot `schema.sql`.

---

## 4. Assistant tools

Every tool runs as the calling user. "Tier" is explained in section 5.

### Read (tier 0, run immediately, logged in `ai_messages` only)

| Tool | Backed by |
|---|---|
| `get_my_context` | own profile, role, permissions, projects, running timer |
| `list_tasks`, `get_task` | `tasks` with filters (mine, project, status, priority, due, blocked) and dependencies |
| `list_projects`, `get_project_overview` | `projects`, lead, open and blocked counts, hours |
| `list_people` | `profiles` (and project membership where allowed) |
| `get_time_summary` | `time_entries` by person, project, range |
| `read_channel` | recent `messages` in a channel the user can see |
| `search_knowledge` | `knowledge_chunks`, returns passages with doc references |
| `get_daily_log`, `get_team_logs` | own log; team logs only with `founderDash` |
| `list_notifications`, `list_pending_approvals` | `notifications`, `ai_actions`, `lead_suggestions` |

### Write

| Tool | Backed by | Existing permission | Tier |
|---|---|---|---|
| `start_timer`, `stop_timer` | RPCs | active account | 1 |
| `complete_task` | RPC | assignee or `reassign` | 1 |
| `create_task` | insert | `addTask` | 1 |
| `update_task` (title, description, estimate) | update | per RLS | 1 |
| `set_priority_or_due` | update | `setPriority` | 1 |
| `add_dependency` | insert | can see both tasks | 1 |
| `mark_notifications_read` | RPC | own | 1 |
| `post_message` (with mentions) | RPC | can see channel | 2 |
| `assign_task` to someone else | update | `reassign` | 2 |
| `remove_dependency` | delete | can see task | 2 |
| `create_tasks_bulk` (more than 3) | insert | `addTask` / `uploadSheet` | 2 |
| `create_project` | insert | `addProject` | 2 |
| `submit_daily_log` | upsert | own | 2 |
| `log_time` (manual) | RPC | own | 2 |
| `suggest_project_lead` | RPC | `suggestLead` | 2 |
| `decide_lead_suggestion` | RPC | `approveLead` | 3 |
| `delete_task`, `delete_doc`, `delete_project` | delete | per RLS | 3 |
| `set_role`, `set_status`, `set_permission`, `set_project_access`, `set_capacity` | `admin_*` RPCs | Super Admin | 3 |

Not offered as tools at all: inviting or creating accounts, anything using the service-role key, changing `ai_tool_policy`, approving the assistant's own requests, raw SQL.

Tools the user's role cannot use are left out of the tool list sent to the model, so it does not offer what it cannot do. The database still enforces the rule if that filter is ever wrong.

### Insights

Produced from the read tools, with no new write path: workload against capacity, blocked chains and who they wait on, tasks at risk against due date and estimate, time by project, missing daily logs, and a Founder summary replacing the rule-based `localSummary`. Suggestions are text; acting on one goes through the write tools above.

---

## 5. Security model

### Risk tiers

| Tier | Meaning | What happens |
|---|---|---|
| 0 | Read | Runs. Subject to RLS. |
| 1 | Low-risk write, easy to undo, affects mainly the user's own work | Runs, recorded in `ai_actions` and `activity_log`, shown in the chat with an undo where possible |
| 2 | Affects other people or is visible to them | The assistant shows exactly what it will do; the user must click Confirm |
| 3 | Destructive, or changes who can do what | Confirm by the user if they hold the permission; otherwise it becomes a request to someone who does, who approves from their own session |

Tiers live in `ai_tool_policy` so a Super Admin can make a tool stricter without a deploy.

### Rules that make approvals trustworthy

- **Confirmation is a UI click that calls an RPC**, never something the model can say or call. There is no "confirm" tool.
- **The server executes the stored arguments** from `ai_actions`, not arguments sent again by the model, so what was shown is what runs.
- **Approved actions run under the approver's session**, so the database checks the approver's permissions, and the log records both requester and approver.
- **Pending actions expire** (suggested: 24 hours) and are re-validated at execution time.
- **Nobody approves their own tier 3 request** unless they already hold the permission, in which case it is a confirmation, logged as such.

### Prompt injection

Documents, chat messages, task titles and daily logs are written by other people and reach the model through tool results. They are treated as data. The protection is structural rather than a matter of wording: injected text can at most make the assistant attempt something, and that attempt is still limited to the reader's own permissions and still stops at the confirm step for anything that affects others. Retrieved content is wrapped and labelled, and the assistant is told not to follow instructions found inside it.

### Data separation

- Retrieval and all reads go through RLS, so one person's assistant cannot surface another project's content.
- Conversations are private to their owner. Actions are visible to Super Admin through `ai_actions` and `activity_log` (decision 3).
- Nothing from one user's conversation is placed in another user's context.

### Operational controls

- Per-user daily token cap in `ai_usage`; per-request limits on tool-loop iterations and time.
- `useAssistant` permission and a global kill switch in `app_settings`.
- Inactive or pending accounts are refused before any model call.
- Logs never store the API key or session tokens.
- Team content (tasks, docs, chat excerpts) is sent to the Claude API to produce answers. Worth stating in the team's internal policy before launch.

---

## 6. Phased roadmap

Each phase ends with something usable and a clear check. No phase starts before the previous one is reviewed.

**Phase 0. Foundation (no AI).**
Get the repository pushed. Create a staging Supabase project and apply the schema. Wire the front-end to Supabase following `docs/BACKEND_INTEGRATION.md`. Apply the hardening for A2, A3, A4 as migrations with tests.
*Done when:* two real accounts with different roles see different data in the browser, and the test suite passes.

**Phase 1. Read-only assistant.**
`assistant` Edge Function, chat panel, tier 0 tools, conversation storage, usage caps, platform guide.
*Done when:* a Member and a Founder ask the same question and each gets an answer limited to what they can see; a test confirms a Member cannot retrieve another project's tasks through the assistant.

**Phase 2. Actions with confirmation.**
`ai_actions`, `ai_tool_policy`, `activity_log`, tier 1 and 2 tools, notifications and mentions.
*Done when:* every write made through the assistant appears in the action log with before and after values, and no tier 2 tool can run without a click.

**Phase 3. Knowledge.**
Text extraction for uploaded files, `knowledge_chunks`, `search_knowledge`, answers with citations, company-wide space.
*Done when:* answers cite their source document and never cite one the asker cannot open.

**Phase 4. Approvals and admin.**
Tier 3 tools, approver inbox, expiry, Super Admin view of assistant activity and policy.
*Done when:* a Member's request for an admin change reaches a Super Admin, runs only after approval, and both names are in the log.

**Phase 5. Proactive help and insights.**
Daily-log drafts from tracked time, scheduled digests and risk alerts, Founder summary written by the model.
*Done when:* scheduled runs only read, notify and draft. Unattended writes stay off until you decide otherwise (decision 6).

Deployment to `www.goxl.in/team` is deliberately not in this plan; it follows phase 0 when you say so.

---

## 7. What "autonomous" means here

The assistant acts without asking for low-risk work on the user's own tasks, asks before touching other people's work, and routes anything about access or deletion to a person with authority. Widening that is a policy change in `ai_tool_policy`, made by a Super Admin, and visible in the log. Starting narrow and widening with evidence is safer than the reverse.

---

## 8. Decisions needed from you

1. **Where the agent loop runs:** Messages API inside a Supabase Edge Function (recommended) or Claude Managed Agents.
2. **Model and budget:** `claude-opus-5-5` by default, or a cheaper tier; and a daily cap per person.
3. **Privacy of conversations:** private to each person with only actions visible to Super Admin (recommended), or fully visible to Super Admin.
4. **Manual time entries:** allow "log two hours yesterday" (recommended, marked as manual), or keep timers as the only source.
5. **Company knowledge:** which documents count, and whether to add a company-wide space outside projects.
6. **Unattended runs:** read, notify and draft only (recommended), or allow some writes.
7. **Staging database:** approval to create a Supabase project for phase 0.
