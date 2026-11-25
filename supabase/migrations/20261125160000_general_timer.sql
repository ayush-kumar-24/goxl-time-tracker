-- Timers without a task: a person can track time on general work (meetings, support,
-- learning) by giving a short note instead of picking a task.

alter table public.time_entries alter column task_id drop not null;
alter table public.time_entries add column if not exists note text not null default '';
alter table public.time_entries drop constraint if exists time_entries_task_or_note;
alter table public.time_entries add constraint time_entries_task_or_note
  check (task_id is not null or btrim(note) <> '');

-- The task checks only apply to timers that have a task.
create or replace function public.time_entry_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare st text;
begin
  if new.task_id is null then return new; end if;
  select status into st from public.tasks where id = new.task_id;
  if st = 'done' then raise exception 'This task is already done.'; end if;
  if public.open_dependency_count(new.task_id) > 0 then raise exception 'This task is blocked by an unfinished dependency.'; end if;
  return new;
end $$;

-- Starts a timer with no task. Any running timer of this person stops first.
create or replace function public.start_general_timer(p_note text) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_note text := btrim(coalesce(p_note, '')); new_id uuid;
begin
  if not public.is_active() then raise exception 'Your account is not active.'; end if;
  if v_note = '' then raise exception 'Say what you are working on.'; end if;
  if length(v_note) > 200 then raise exception 'Keep the note under 200 characters.'; end if;
  update public.time_entries set ended_at = now() where user_id = auth.uid() and ended_at is null;
  insert into public.time_entries(task_id, user_id, note) values (null, auth.uid(), v_note) returning id into new_id;
  return new_id;
end $$;
revoke all on function public.start_general_timer(text) from public, anon;
grant execute on function public.start_general_timer(text) to authenticated;

-- Timers without a task belong to no project, so every active member can see them,
-- the same way the team timesheet already shows everyone's hours.
drop policy if exists time_entries_read on public.time_entries;
create policy time_entries_read on public.time_entries for select to authenticated
  using (user_id = auth.uid() or public.can_see_task(task_id) or (task_id is null and public.is_active()));
