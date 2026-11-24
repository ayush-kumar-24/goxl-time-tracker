# Data model

| Table | Purpose |
|---|---|
| profiles | One row per auth user: name, role, status (pending/active/inactive), weekly capacity |
| role_permissions | role x permission matrix |
| app_settings | internal flags (`bootstrap_open`); no browser access |
| projects | name, description, `lead_id` |
| project_access | who can see which project |
| lead_suggestions | pending/approved/rejected lead nominations |
| tasks | title, assignee, priority, status (todo/doing/done), estimate, due date |
| task_dependencies | task -> depends_on; cycle trigger |
| time_entries | start/end per task per person; unique index allows one running timer per person |
| docs | document metadata + `storage_path` + text preview |
| messages | chat; channel is `general` or a project id |
| daily_logs | Work Intelligence Engine logs, one per person per day |
| audit_log | admin actions (Super Admin read only) |

"Blocked" is not stored: a task is blocked when it is `todo` and has any dependency that is not `done` (`open_dependency_count`).

## daily_logs.payload shape
Same as the demo's log object: the day's tasks (project, title, hours, status, blockers) plus a free-text summary and mood/energy fields. Keep the shape stable; the founder dashboard reads it directly. See `LOG` seeds in `team/index.html`.
