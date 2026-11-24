# Architecture

- **Front-end:** one static `index.html` (vanilla JS). No build. Served from Vercel at `/team`.
- **Backend:** Supabase (Postgres, Auth, Storage, Realtime). The browser holds only the publishable key.
- **Security lives in the database.** Row Level Security decides who can read or write each row. Multi-step actions (start timer, complete task, approve lead, change role) are server-side functions, so a hand-made request cannot skip the rules.
- **Realtime:** chat, tasks, timers and lead suggestions are published so boards update live.
- **Files:** private Storage bucket `project-docs`, path `<project_id>/<uuid>-<file name>`. Access follows project access. Previews of text files use `docs.preview_text`.
- **Work Intelligence Engine:** daily logs stored as JSON in `daily_logs.payload`. Analytics are computed in the browser from logs + tasks. The executive summary is rule-based in the demo; the original reference called the Claude API. If you want that, call it from a Supabase Edge Function, never from the browser.

## Decisions already made
- Hosting: Vercel (Netlify also works with the same folder).
- Project-lead suggestions: Project Admin, PM (and Super Admin) suggest; **Founder or Super Admin approve**.
- Task dependencies are open to everyone who can see the task; loops are refused by a database trigger.
