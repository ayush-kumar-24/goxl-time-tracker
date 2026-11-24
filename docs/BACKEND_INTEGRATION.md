# Wiring the front-end to Supabase

The demo keeps everything in the object `S` and calls `render()`. Replace the in-memory seeds with queries, and each action with the call below. Use `@supabase/supabase-js` (CDN) with the project URL and publishable key. Keep the session persistent (default) for "stay logged in".

| UI action (function in index.html) | Supabase call |
|---|---|
| Sign in / sign up | `auth.signInWithPassword`, `auth.signUp({options:{data:{full_name}}})` |
| Load people, roles | `from('profiles').select()`, `from('role_permissions').select()` |
| Load projects / access | `from('projects').select()`, `from('project_access').select()` (RLS already filters) |
| createProject | `from('projects').insert({name,description,created_by:uid})` |
| Add task, CSV sheet import | `from('tasks').insert([...])` (validate rows in the browser first) |
| Priority / due / reassign | `from('tasks').update({...}).eq('id',id)` |
| addDep / remove dep | `from('task_dependencies').insert/delete` (loop error is returned as a message) |
| startTimer | `rpc('start_timer',{p_task})` |
| stopTimer | `rpc('stop_timer')` |
| markDone | `rpc('complete_task',{p_task})` returns ids of newly unblocked tasks |
| addDocFile | upload to bucket `project-docs` at `<project_id>/<uuid>-<name>`, then `from('docs').insert({project_id,name,file_type,storage_path,preview_text})`; open with `storage.createSignedUrl` |
| Chat send / live | `from('messages').insert`, `channel(...).on('postgres_changes',...)` |
| suggestLead | `rpc('suggest_project_lead',{p_project,p_nominee})` |
| decideLead | `rpc('decide_lead_suggestion',{p_id,p_approve})` |
| Admin: role / status / capacity | `rpc('admin_set_role' / 'admin_set_status' / 'admin_set_capacity')` |
| Admin: permission toggle | `rpc('admin_set_permission',{p_role,p_perm,p_allowed})` |
| Admin: project access | `rpc('admin_set_project_access',{p_project,p_user,p_allowed})` |
| submitLog | `from('daily_logs').upsert({log_date,payload},{onConflict:'user_id,log_date'})` |
| Founder dashboard | read all `daily_logs` (allowed with `founderDash`) |
| Invite | Supabase Auth invite (needs a service-role Edge Function; never ship that key to the browser) |

Notes
- Hours are computed from `time_entries` (sum of `ended_at - started_at`, running entries use now()).
- Show errors from RPCs directly in the toast; messages are written for people.
- The audit log in the demo maps to `audit_log` (read-only, Super Admin).
