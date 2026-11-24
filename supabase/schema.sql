-- =====================================================================
-- GoXL Team Hub: database schema for Supabase (Postgres 15+)
-- Run once in the Supabase SQL editor (or `supabase db push`).
-- Everything is protected by Row Level Security (RLS). The browser only
-- ever holds the publishable key; what a person can read or change is
-- decided here, not in the front-end.
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- Settings and roles
-- ---------------------------------------------------------------------
create table public.app_settings (
  key   text primary key,
  value text not null
);
-- The first person to sign up becomes Super Admin while this is 'true',
-- then it closes itself. Sign up as Super Admin FIRST after deploying.
insert into public.app_settings(key, value) values ('bootstrap_open', 'true');

create table public.profiles (
  id                    uuid primary key references auth.users(id) on delete cascade,
  email                 text not null,
  full_name             text not null default '',
  job_title             text not null default '',
  role                  text not null default 'member'
    check (role in ('super_admin','founder','project_admin','project_lead','pm','member','advisor')),
  status                text not null default 'pending'
    check (status in ('pending','active','inactive')),
  weekly_capacity_hours numeric not null default 40 check (weekly_capacity_hours >= 0),
  color_index           int not null default 1,
  created_at            timestamptz not null default now()
);

create table public.role_permissions (
  role    text not null,
  perm    text not null,
  allowed boolean not null default false,
  primary key (role, perm)
);

-- Defaults match the Admin screen. Super Admin is always allowed in code.
insert into public.role_permissions(role, perm, allowed)
select r.role, p.perm,
  case
    when r.role = 'super_admin' then true
    when r.role = 'founder'       then p.perm in ('addProject','addTask','uploadSheet','setPriority','reassign','uploadDoc','viewReports','founderDash','approveLead')
    when r.role = 'project_admin' then p.perm in ('addProject','addTask','uploadSheet','setPriority','reassign','uploadDoc','viewReports','suggestLead')
    when r.role = 'project_lead'  then p.perm in ('addProject','addTask','uploadSheet','setPriority','reassign','uploadDoc','viewReports')
    when r.role = 'pm'            then p.perm in ('addProject','addTask','uploadSheet','setPriority','reassign','uploadDoc','viewReports','suggestLead')
    when r.role = 'member'        then p.perm in ('uploadDoc','viewReports')
    when r.role = 'advisor'       then p.perm in ('uploadDoc')
  end
from (values ('super_admin'),('founder'),('project_admin'),('project_lead'),('pm'),('member'),('advisor')) as r(role)
cross join (values ('addProject'),('suggestLead'),('approveLead'),('addTask'),('uploadSheet'),('setPriority'),
                   ('reassign'),('uploadDoc'),('viewReports'),('founderDash'),('manageAccess')) as p(perm);

-- ---------------------------------------------------------------------
-- Projects, access and project-lead suggestions
-- ---------------------------------------------------------------------
create table public.projects (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique check (length(btrim(name)) > 0),
  description text not null default '',
  color_index int not null default 1,
  lead_id     uuid references public.profiles(id) on delete set null,
  created_by  uuid references public.profiles(id) on delete set null default auth.uid(),
  created_at  timestamptz not null default now()
);

create table public.project_access (
  project_id uuid not null references public.projects(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  primary key (project_id, user_id)
);

create table public.lead_suggestions (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references public.projects(id) on delete cascade,
  nominee_id   uuid not null references public.profiles(id) on delete cascade,
  suggested_by uuid not null references public.profiles(id) on delete cascade,
  status       text not null default 'pending' check (status in ('pending','approved','rejected')),
  decided_by   uuid references public.profiles(id) on delete set null,
  decided_at   timestamptz,
  created_at   timestamptz not null default now()
);
-- Only one open suggestion per project.
create unique index lead_suggestions_one_pending on public.lead_suggestions(project_id) where status = 'pending';

-- ---------------------------------------------------------------------
-- Tasks, dependencies, time
-- ---------------------------------------------------------------------
create table public.tasks (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references public.projects(id) on delete cascade,
  title       text not null check (length(btrim(title)) > 0),
  description text not null default '',
  assignee_id uuid references public.profiles(id) on delete set null,
  priority    text not null default 'medium' check (priority in ('urgent','high','medium','low')),
  status      text not null default 'todo' check (status in ('todo','doing','done')),
  est_hours   numeric not null default 4 check (est_hours > 0),
  due_date    date,
  created_by  uuid references public.profiles(id) on delete set null default auth.uid(),
  created_at  timestamptz not null default now(),
  done_at     timestamptz
);
create index tasks_project_idx  on public.tasks(project_id);
create index tasks_assignee_idx on public.tasks(assignee_id);

create table public.task_dependencies (
  task_id       uuid not null references public.tasks(id) on delete cascade,
  depends_on_id uuid not null references public.tasks(id) on delete cascade,
  created_by    uuid references public.profiles(id) on delete set null default auth.uid(),
  primary key (task_id, depends_on_id),
  check (task_id <> depends_on_id)
);
create index task_dependencies_dep_idx on public.task_dependencies(depends_on_id);

create table public.time_entries (
  id         uuid primary key default gen_random_uuid(),
  task_id    uuid not null references public.tasks(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade default auth.uid(),
  started_at timestamptz not null default now(),
  ended_at   timestamptz,
  check (ended_at is null or ended_at >= started_at)
);
create index time_entries_user_idx on public.time_entries(user_id, started_at);
create index time_entries_task_idx on public.time_entries(task_id);
-- A person can have only one running timer.
create unique index time_entries_one_running on public.time_entries(user_id) where ended_at is null;

-- ---------------------------------------------------------------------
-- Documents, chat, daily logs, audit
-- ---------------------------------------------------------------------
create table public.docs (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references public.projects(id) on delete cascade,
  name         text not null,
  file_type    text not null default 'file',
  owner_id     uuid references public.profiles(id) on delete set null default auth.uid(),
  storage_path text,           -- object path in the 'project-docs' bucket: <project_id>/<uuid>-<file name>
  preview_text text not null default '',   -- first ~8,000 characters of text/markdown/csv files
  created_at   timestamptz not null default now()
);
create index docs_project_idx on public.docs(project_id);

create table public.messages (
  id         bigint generated always as identity primary key,
  channel    text not null,   -- 'general' or a project id
  user_id    uuid not null references public.profiles(id) on delete cascade default auth.uid(),
  body       text not null check (length(body) between 1 and 4000),
  created_at timestamptz not null default now()
);
create index messages_channel_idx on public.messages(channel, created_at);

create table public.daily_logs (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.profiles(id) on delete cascade default auth.uid(),
  log_date     date not null,
  payload      jsonb not null,   -- same shape as the Work Intelligence Engine log (see docs/DATA_MODEL.md)
  submitted_at timestamptz not null default now(),
  unique (user_id, log_date)
);

create table public.audit_log (
  id         bigint generated always as identity primary key,
  actor_id   uuid references public.profiles(id) on delete set null,
  action     text not null,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Helper functions (used by RLS policies and RPCs)
-- ---------------------------------------------------------------------
create function public.is_active() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and status = 'active');
$$;

create function public.my_role() returns text
language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid() and status = 'active';
$$;

create function public.is_super() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.my_role() = 'super_admin', false);
$$;

create function public.has_perm(p_perm text) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_super() or coalesce((
    select rp.allowed from public.profiles pr
    join public.role_permissions rp on rp.role = pr.role and rp.perm = p_perm
    where pr.id = auth.uid() and pr.status = 'active'), false);
$$;

create function public.can_see_project(p_project uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles pr
    where pr.id = auth.uid() and pr.status = 'active'
      and (pr.role in ('super_admin','founder')
           or exists (select 1 from public.project_access pa where pa.project_id = p_project and pa.user_id = pr.id)));
$$;

create function public.can_see_task(p_task uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.tasks t where t.id = p_task and public.can_see_project(t.project_id));
$$;

create function public.can_see_channel(p_channel text) returns boolean
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_active() then return false; end if;
  if p_channel = 'general' then return true; end if;
  begin
    return public.can_see_project(p_channel::uuid);
  exception when others then
    return false;
  end;
end $$;

create function public.can_see_project_path(p_name text) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare pid uuid;
begin
  begin
    pid := ((storage.foldername(p_name))[1])::uuid;
  exception when others then
    return false;
  end;
  return public.can_see_project(pid);
end $$;

create function public.open_dependency_count(p_task uuid) returns int
language sql stable security definer set search_path = public as $$
  select count(*)::int from public.task_dependencies d
  join public.tasks t on t.id = d.depends_on_id
  where d.task_id = p_task and t.status <> 'done';
$$;

create function public.log_audit(p_action text) returns void
language sql security definer set search_path = public as $$
  insert into public.audit_log(actor_id, action) values (auth.uid(), p_action);
$$;

-- ---------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------
-- New sign-ups wait as 'pending' until a Super Admin approves them.
-- The very first sign-up becomes Super Admin (bootstrap).
create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare first_user boolean;
begin
  first_user := coalesce((select value from public.app_settings where key = 'bootstrap_open'), 'false') = 'true'
                and not exists (select 1 from public.profiles where role = 'super_admin');
  insert into public.profiles(id, email, full_name, role, status)
  values (new.id, coalesce(new.email, ''), coalesce(new.raw_user_meta_data->>'full_name', ''),
          case when first_user then 'super_admin' else 'member' end,
          case when first_user then 'active' else 'pending' end);
  if first_user then
    update public.app_settings set value = 'false' where key = 'bootstrap_open';
  end if;
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- The creator can always see the project they create.
create function public.project_creator_access() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.created_by is not null then
    insert into public.project_access(project_id, user_id) values (new.id, new.created_by) on conflict do nothing;
  end if;
  return new;
end $$;
create trigger projects_creator_access after insert on public.projects
  for each row execute function public.project_creator_access();

-- Anyone who can see a task can add a dependency, but loops are refused.
create function public.prevent_dependency_cycle() returns trigger
language plpgsql set search_path = public as $$
begin
  if exists (
    with recursive walk(id) as (
      select new.depends_on_id
      union
      select d.depends_on_id from public.task_dependencies d join walk w on d.task_id = w.id
    ) select 1 from walk where id = new.task_id) then
    raise exception 'That dependency would create a loop between tasks.';
  end if;
  return new;
end $$;
create trigger task_dependencies_no_cycle before insert on public.task_dependencies
  for each row execute function public.prevent_dependency_cycle();

-- If a task in progress gains an unfinished dependency, pause it and stop its timers.
create function public.pause_task_on_new_dependency() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from public.tasks where id = new.task_id and status = 'doing')
     and exists (select 1 from public.tasks where id = new.depends_on_id and status <> 'done') then
    update public.time_entries set ended_at = now() where task_id = new.task_id and ended_at is null;
    update public.tasks set status = 'todo' where id = new.task_id;
  end if;
  return new;
end $$;
create trigger task_dependencies_pause after insert on public.task_dependencies
  for each row execute function public.pause_task_on_new_dependency();

-- Priority, due date and assignee need their own permissions.
create function public.tasks_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if (new.priority is distinct from old.priority or new.due_date is distinct from old.due_date)
     and not public.has_perm('setPriority') then
    raise exception 'Your role cannot change priority or due date.';
  end if;
  if new.assignee_id is distinct from old.assignee_id and not public.has_perm('reassign') then
    raise exception 'Your role cannot reassign tasks.';
  end if;
  return new;
end $$;
create trigger tasks_guard_trg before update on public.tasks
  for each row execute function public.tasks_guard();

-- A timer cannot start on a finished or blocked task, even from a hand-made request.
create function public.time_entry_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare st text;
begin
  select status into st from public.tasks where id = new.task_id;
  if st = 'done' then raise exception 'This task is already done.'; end if;
  if public.open_dependency_count(new.task_id) > 0 then raise exception 'This task is blocked by an unfinished dependency.'; end if;
  return new;
end $$;
create trigger time_entries_guard_trg before insert on public.time_entries
  for each row execute function public.time_entry_guard();

-- ---------------------------------------------------------------------
-- RPCs: the only way to change things that need more than one step
-- ---------------------------------------------------------------------
create function public.start_timer(p_task uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare t public.tasks; new_id uuid;
begin
  if not public.is_active() then raise exception 'Your account is not active.'; end if;
  select * into t from public.tasks where id = p_task;
  if not found or not public.can_see_project(t.project_id) then raise exception 'Task not found.'; end if;
  if t.status = 'done' then raise exception 'This task is already done.'; end if;
  if public.open_dependency_count(p_task) > 0 then raise exception 'This task is blocked by an unfinished dependency.'; end if;
  update public.time_entries set ended_at = now() where user_id = auth.uid() and ended_at is null;
  update public.tasks set status = 'doing' where id = p_task and status = 'todo';
  insert into public.time_entries(task_id, user_id) values (p_task, auth.uid()) returning id into new_id;
  return new_id;
end $$;

create function public.stop_timer() returns void
language sql security definer set search_path = public as $$
  update public.time_entries set ended_at = now() where user_id = auth.uid() and ended_at is null;
$$;

-- Marks a task done, stops its timers, and returns the tasks that just became unblocked.
create function public.complete_task(p_task uuid) returns setof uuid
language plpgsql security definer set search_path = public as $$
declare t public.tasks;
begin
  select * into t from public.tasks where id = p_task;
  if not found or not public.can_see_project(t.project_id) then raise exception 'Task not found.'; end if;
  if not (t.assignee_id = auth.uid() or public.has_perm('reassign')) then
    raise exception 'Only the assignee or a manager can complete this task.';
  end if;
  update public.time_entries set ended_at = now() where task_id = p_task and ended_at is null;
  update public.tasks set status = 'done', done_at = now() where id = p_task;
  return query
    select d.task_id from public.task_dependencies d
    join public.tasks x on x.id = d.task_id
    where d.depends_on_id = p_task and x.status = 'todo' and public.open_dependency_count(d.task_id) = 0;
end $$;

create function public.suggest_project_lead(p_project uuid, p_nominee uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare new_id uuid; nominee_name text;
begin
  if not public.has_perm('suggestLead') then raise exception 'Your role cannot suggest a project lead.'; end if;
  if not public.can_see_project(p_project) then raise exception 'Project not found.'; end if;
  select full_name into nominee_name from public.profiles where id = p_nominee and status = 'active';
  if not found then raise exception 'The nominee must be an active team member.'; end if;
  if exists (select 1 from public.lead_suggestions where project_id = p_project and status = 'pending') then
    raise exception 'A suggestion is already waiting for approval.';
  end if;
  insert into public.lead_suggestions(project_id, nominee_id, suggested_by)
  values (p_project, p_nominee, auth.uid()) returning id into new_id;
  perform public.log_audit('Suggested ' || nominee_name || ' as lead of project ' || p_project);
  return new_id;
end $$;

create function public.decide_lead_suggestion(p_id uuid, p_approve boolean) returns void
language plpgsql security definer set search_path = public as $$
declare s public.lead_suggestions;
begin
  if not public.has_perm('approveLead') then raise exception 'Only a Founder or Super Admin can decide this.'; end if;
  select * into s from public.lead_suggestions where id = p_id and status = 'pending' for update;
  if not found then raise exception 'This suggestion is no longer pending.'; end if;
  update public.lead_suggestions
     set status = case when p_approve then 'approved' else 'rejected' end, decided_by = auth.uid(), decided_at = now()
   where id = p_id;
  if p_approve then
    update public.projects set lead_id = s.nominee_id where id = s.project_id;
    insert into public.project_access(project_id, user_id) values (s.project_id, s.nominee_id) on conflict do nothing;
  end if;
  perform public.log_audit((case when p_approve then 'Approved' else 'Rejected' end) || ' lead suggestion ' || p_id);
end $$;

create function public.admin_set_role(p_user uuid, p_role text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_super() then raise exception 'Only a Super Admin can change roles.'; end if;
  if p_role not in ('super_admin','founder','project_admin','project_lead','pm','member','advisor') then raise exception 'Unknown role.'; end if;
  if (select role from public.profiles where id = p_user) = 'super_admin' and p_role <> 'super_admin'
     and not exists (select 1 from public.profiles where role = 'super_admin' and status = 'active' and id <> p_user) then
    raise exception 'Keep at least one active Super Admin.';
  end if;
  update public.profiles set role = p_role where id = p_user;
  perform public.log_audit('Changed role of ' || p_user || ' to ' || p_role);
end $$;

create function public.admin_set_status(p_user uuid, p_status text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_super() then raise exception 'Only a Super Admin can change account status.'; end if;
  if p_status not in ('pending','active','inactive') then raise exception 'Unknown status.'; end if;
  if p_user = auth.uid() then raise exception 'You cannot change your own status.'; end if;
  if (select role from public.profiles where id = p_user) = 'super_admin' and p_status <> 'active'
     and not exists (select 1 from public.profiles where role = 'super_admin' and status = 'active' and id <> p_user) then
    raise exception 'Keep at least one active Super Admin.';
  end if;
  update public.profiles set status = p_status where id = p_user;
  if p_status <> 'active' then
    update public.time_entries set ended_at = now() where user_id = p_user and ended_at is null;
  end if;
  perform public.log_audit('Set status of ' || p_user || ' to ' || p_status);
end $$;

create function public.admin_set_capacity(p_user uuid, p_hours numeric) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_super() then raise exception 'Only a Super Admin can change capacity.'; end if;
  update public.profiles set weekly_capacity_hours = greatest(0, p_hours) where id = p_user;
end $$;

create function public.admin_set_permission(p_role text, p_perm text, p_allowed boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_super() then raise exception 'Only a Super Admin can change permissions.'; end if;
  if p_role = 'super_admin' then raise exception 'Super Admin permissions are fixed.'; end if;
  insert into public.role_permissions(role, perm, allowed) values (p_role, p_perm, p_allowed)
  on conflict (role, perm) do update set allowed = excluded.allowed;
  perform public.log_audit('Set ' || p_perm || ' for ' || p_role || ' to ' || p_allowed);
end $$;

create function public.admin_set_project_access(p_project uuid, p_user uuid, p_allowed boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_super() then raise exception 'Only a Super Admin can change project access.'; end if;
  if p_allowed then
    insert into public.project_access(project_id, user_id) values (p_project, p_user) on conflict do nothing;
  else
    delete from public.project_access where project_id = p_project and user_id = p_user;
  end if;
  perform public.log_audit('Project access ' || p_project || ' / ' || p_user || ' = ' || p_allowed);
end $$;

-- ---------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------
alter table public.app_settings      enable row level security;
alter table public.profiles          enable row level security;
alter table public.role_permissions  enable row level security;
alter table public.projects          enable row level security;
alter table public.project_access    enable row level security;
alter table public.lead_suggestions  enable row level security;
alter table public.tasks             enable row level security;
alter table public.task_dependencies enable row level security;
alter table public.time_entries      enable row level security;
alter table public.docs              enable row level security;
alter table public.messages          enable row level security;
alter table public.daily_logs        enable row level security;
alter table public.audit_log         enable row level security;

-- app_settings: no policies, so nobody reads or writes it from the browser.

create policy profiles_read on public.profiles for select to authenticated
  using (id = auth.uid() or public.is_active());
create policy profiles_update_self on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());
-- Only these columns are writable directly; role/status/capacity go through admin_* RPCs.
revoke update on public.profiles from authenticated, anon;
grant update (full_name, job_title) on public.profiles to authenticated;

create policy role_permissions_read on public.role_permissions for select to authenticated
  using (public.is_active());

-- created_by is included so `insert ... returning` works for the creator before the access row exists.
create policy projects_read on public.projects for select to authenticated
  using (public.can_see_project(id) or (created_by = auth.uid() and public.is_active()));
create policy projects_insert on public.projects for insert to authenticated
  with check (public.has_perm('addProject') and created_by = auth.uid());
create policy projects_update on public.projects for update to authenticated
  using (public.is_super() or public.my_role() = 'founder' or created_by = auth.uid())
  with check (public.is_super() or public.my_role() = 'founder' or created_by = auth.uid());
create policy projects_delete on public.projects for delete to authenticated
  using (public.is_super());
revoke update on public.projects from authenticated, anon;
grant update (name, description, color_index) on public.projects to authenticated;

create policy project_access_read on public.project_access for select to authenticated
  using (user_id = auth.uid() or public.is_super() or public.my_role() = 'founder');

create policy lead_suggestions_read on public.lead_suggestions for select to authenticated
  using (public.can_see_project(project_id));

create policy tasks_read on public.tasks for select to authenticated
  using (public.can_see_project(project_id));
create policy tasks_insert on public.tasks for insert to authenticated
  with check (public.has_perm('addTask') and public.can_see_project(project_id) and created_by = auth.uid());
create policy tasks_update on public.tasks for update to authenticated
  using (public.can_see_project(project_id)
         and (assignee_id = auth.uid() or public.has_perm('reassign') or public.has_perm('setPriority')))
  with check (public.can_see_project(project_id));
create policy tasks_delete on public.tasks for delete to authenticated
  using (public.is_super() or public.my_role() = 'founder');

create policy task_dependencies_read on public.task_dependencies for select to authenticated
  using (public.can_see_task(task_id));
create policy task_dependencies_insert on public.task_dependencies for insert to authenticated
  with check (public.can_see_task(task_id) and public.can_see_task(depends_on_id));
create policy task_dependencies_delete on public.task_dependencies for delete to authenticated
  using (public.can_see_task(task_id));

create policy time_entries_read on public.time_entries for select to authenticated
  using (user_id = auth.uid() or public.can_see_task(task_id));
-- Timers are started and stopped through start_timer()/stop_timer(); no direct writes.

create policy docs_read on public.docs for select to authenticated
  using (public.can_see_project(project_id));
create policy docs_insert on public.docs for insert to authenticated
  with check (public.has_perm('uploadDoc') and public.can_see_project(project_id) and owner_id = auth.uid());
create policy docs_delete on public.docs for delete to authenticated
  using (owner_id = auth.uid() or public.is_super());

create policy messages_read on public.messages for select to authenticated
  using (public.can_see_channel(channel));
create policy messages_insert on public.messages for insert to authenticated
  with check (user_id = auth.uid() and public.can_see_channel(channel));

create policy daily_logs_read on public.daily_logs for select to authenticated
  using (user_id = auth.uid() or public.has_perm('founderDash'));
create policy daily_logs_insert on public.daily_logs for insert to authenticated
  with check (user_id = auth.uid() and public.is_active());
create policy daily_logs_update on public.daily_logs for update to authenticated
  using (user_id = auth.uid() and public.is_active()) with check (user_id = auth.uid());

create policy audit_log_read on public.audit_log for select to authenticated
  using (public.is_super());

-- ---------------------------------------------------------------------
-- Function privileges: signed-in users only
-- ---------------------------------------------------------------------
revoke all on function
  public.is_active(), public.my_role(), public.is_super(), public.has_perm(text),
  public.can_see_project(uuid), public.can_see_task(uuid), public.can_see_channel(text),
  public.can_see_project_path(text), public.open_dependency_count(uuid), public.log_audit(text),
  public.start_timer(uuid), public.stop_timer(), public.complete_task(uuid),
  public.suggest_project_lead(uuid, uuid), public.decide_lead_suggestion(uuid, boolean),
  public.admin_set_role(uuid, text), public.admin_set_status(uuid, text), public.admin_set_capacity(uuid, numeric),
  public.admin_set_permission(text, text, boolean), public.admin_set_project_access(uuid, uuid, boolean)
from public, anon;

grant execute on function
  public.is_active(), public.my_role(), public.is_super(), public.has_perm(text),
  public.can_see_project(uuid), public.can_see_task(uuid), public.can_see_channel(text),
  public.can_see_project_path(text), public.open_dependency_count(uuid),
  public.start_timer(uuid), public.stop_timer(), public.complete_task(uuid),
  public.suggest_project_lead(uuid, uuid), public.decide_lead_suggestion(uuid, boolean),
  public.admin_set_role(uuid, text), public.admin_set_status(uuid, text), public.admin_set_capacity(uuid, numeric),
  public.admin_set_permission(text, text, boolean), public.admin_set_project_access(uuid, uuid, boolean)
to authenticated;

-- ---------------------------------------------------------------------
-- Storage: private bucket for project documents
-- Object path convention: <project_id>/<uuid>-<file name>
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public) values ('project-docs', 'project-docs', false)
on conflict (id) do nothing;

create policy project_docs_read on storage.objects for select to authenticated
  using (bucket_id = 'project-docs' and public.can_see_project_path(name));
create policy project_docs_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'project-docs' and public.has_perm('uploadDoc') and public.can_see_project_path(name));
create policy project_docs_delete on storage.objects for delete to authenticated
  using (bucket_id = 'project-docs' and (owner = auth.uid() or public.is_super()));

-- ---------------------------------------------------------------------
-- Realtime: live chat and board updates
-- ---------------------------------------------------------------------
alter publication supabase_realtime add table public.messages, public.tasks, public.time_entries, public.lead_suggestions;
