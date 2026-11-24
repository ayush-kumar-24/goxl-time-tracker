-- =====================================================================
-- Phase 0 hardening. Apply AFTER supabase/schema.sql.
-- Additive and non-destructive: no table, column or row is removed.
-- Fixes audit findings A2, A3, A4 (docs/AI_ASSISTANT_PLAN.md) and makes
-- admin_set_capacity write to the audit log.
-- =====================================================================
begin;

-- ---------------------------------------------------------------------
-- A2. Task writes were too wide.
-- Before: anyone allowed to update a task could change ANY column, so
-- status could be set to 'done' without complete_task() (timers kept
-- running, done_at stayed empty), a blocked task could be set to 'doing',
-- and a task could be moved to another project.
-- Now: direct writes are limited to named columns. Status changes go
-- through start_timer(), complete_task() and reopen_task() only.
-- ---------------------------------------------------------------------
alter table public.tasks add column if not exists updated_at timestamptz not null default now();

create or replace function public.tasks_touch() returns trigger
language plpgsql set search_path = public as $$
begin
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists tasks_touch_trg on public.tasks;
create trigger tasks_touch_trg before update on public.tasks
  for each row execute function public.tasks_touch();

revoke insert, update on public.tasks from authenticated, anon;
grant insert (project_id, title, description, assignee_id, priority, est_hours, due_date, created_by)
  on public.tasks to authenticated;
grant update (title, description, est_hours, priority, due_date, assignee_id)
  on public.tasks to authenticated;

-- A finished task can be reopened by its assignee or a manager. It returns
-- to 'todo'; if it has unfinished dependencies it shows as blocked again.
create or replace function public.reopen_task(p_task uuid) returns void
language plpgsql security definer set search_path = public as $$
declare t public.tasks;
begin
  select * into t from public.tasks where id = p_task;
  if not found or not public.can_see_project(t.project_id) then raise exception 'Task not found.'; end if;
  if not (t.assignee_id = auth.uid() or public.has_perm('reassign')) then
    raise exception 'Only the assignee or a manager can reopen this task.';
  end if;
  if t.status <> 'done' then raise exception 'This task is not done.'; end if;
  update public.tasks set status = 'todo', done_at = null where id = p_task;
end $$;

-- ---------------------------------------------------------------------
-- A3. Assignees were not validated.
-- Before: a task could be assigned to someone inactive, or to someone
-- with no access to the project, who then could not see their own task.
-- Now: the assignee must be active and able to see the project.
-- Existing rows are not touched; the rule applies to new assignments.
-- ---------------------------------------------------------------------
create or replace function public.user_can_see_project(p_user uuid, p_project uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles pr
    where pr.id = p_user and pr.status = 'active'
      and (pr.role in ('super_admin','founder')
           or exists (select 1 from public.project_access pa where pa.project_id = p_project and pa.user_id = pr.id)));
$$;

create or replace function public.tasks_assignee_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.assignee_id is not null
     and (tg_op = 'INSERT' or new.assignee_id is distinct from old.assignee_id)
     and not public.user_can_see_project(new.assignee_id, new.project_id) then
    raise exception 'The assignee must be an active team member with access to this project.';
  end if;
  return new;
end $$;
drop trigger if exists tasks_assignee_guard_trg on public.tasks;
create trigger tasks_assignee_guard_trg before insert or update on public.tasks
  for each row execute function public.tasks_assignee_guard();

-- ---------------------------------------------------------------------
-- A4. Project membership was hidden from managers.
-- Before: only the person themselves, Founders and Super Admins could
-- read project_access, so a PM could not see who is on their project.
-- Now: people who may reassign tasks can read membership of projects
-- they can already see. Nobody gains access to a project by this.
-- ---------------------------------------------------------------------
alter policy project_access_read on public.project_access
  using (user_id = auth.uid() or public.is_super() or public.my_role() = 'founder'
         or (public.has_perm('reassign') and public.can_see_project(project_id)));

-- ---------------------------------------------------------------------
-- Capacity changes were the only admin action missing from the audit log.
-- ---------------------------------------------------------------------
create or replace function public.admin_set_capacity(p_user uuid, p_hours numeric) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_super() then raise exception 'Only a Super Admin can change capacity.'; end if;
  update public.profiles set weekly_capacity_hours = greatest(0, p_hours) where id = p_user;
  perform public.log_audit('Set weekly capacity of ' || p_user || ' to ' || greatest(0, p_hours));
end $$;

-- ---------------------------------------------------------------------
-- Function privileges: signed-in users only; helpers are internal.
-- ---------------------------------------------------------------------
revoke all on function public.reopen_task(uuid), public.user_can_see_project(uuid, uuid),
  public.admin_set_capacity(uuid, numeric) from public, anon;
revoke all on function public.user_can_see_project(uuid, uuid) from authenticated;
grant execute on function public.reopen_task(uuid), public.admin_set_capacity(uuid, numeric) to authenticated;

commit;
