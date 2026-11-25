-- Hosted Supabase projects created with "expose new tables" turned off give the
-- authenticated role no table privileges, so every read fails with "permission denied".
-- Grant them explicitly (Row Level Security still decides which rows each person sees),
-- then re-apply the column-level limits from the schema and earlier migrations.

grant usage on schema public to authenticated, service_role;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant all on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to authenticated, service_role;

-- profiles: only these columns are writable directly
revoke update on public.profiles from authenticated, anon;
grant update (full_name, job_title) on public.profiles to authenticated;

-- projects
revoke update on public.projects from authenticated, anon;
grant update (name, description, color_index) on public.projects to authenticated;

-- tasks
revoke insert, update on public.tasks from authenticated, anon;
grant insert (project_id, title, description, assignee_id, priority, est_hours, due_date, created_by)
  on public.tasks to authenticated;
grant update (title, description, est_hours, priority, due_date, assignee_id)
  on public.tasks to authenticated;

-- invitations: read only; changes go through admin_invite / admin_cancel_invite
revoke all on public.invitations from anon, authenticated;
grant select on public.invitations to authenticated;
