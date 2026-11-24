-- =====================================================================
-- Invitations: a Super Admin can add a person before they sign up.
-- Apply AFTER the Phase 0 hardening migration. Additive: nothing is removed.
--
-- How it works: the Super Admin records the person's email, role and
-- projects. When someone signs up with that email, their account is
-- active straight away with that role and those projects, instead of
-- waiting as "pending". No email is sent by the database; tell the person
-- to create their account with the invited address.
--
-- IMPORTANT: keep "Confirm email" switched on in Supabase Auth. An
-- invitation trusts the email address, so the address must be verified
-- before the person can sign in.
-- =====================================================================
begin;

create table if not exists public.invitations (
  email       text primary key check (email = lower(btrim(email)) and position('@' in email) > 1),
  full_name   text not null default '',
  job_title   text not null default '',
  role        text not null default 'member'
    check (role in ('founder','project_admin','project_lead','pm','member','advisor')),
  project_ids uuid[] not null default '{}',
  invited_by  uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now(),
  accepted_at timestamptz,
  accepted_by uuid references public.profiles(id) on delete set null
);
alter table public.invitations enable row level security;
revoke all on public.invitations from anon, authenticated;
grant select on public.invitations to authenticated;
drop policy if exists invitations_read on public.invitations;
create policy invitations_read on public.invitations for select to authenticated
  using (public.is_super());
-- No insert, update or delete policy: changes go through the functions below.

create or replace function public.admin_invite(p_email text, p_full_name text, p_job_title text, p_role text, p_projects uuid[])
returns void
language plpgsql security definer set search_path = public as $$
declare v_email text := lower(btrim(coalesce(p_email, '')));
begin
  if not public.is_super() then raise exception 'Only a Super Admin can invite people.'; end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'Enter a valid email address.'; end if;
  if p_role = 'super_admin' then raise exception 'Invite the person with another role, then promote them in the table above.'; end if;
  if p_role not in ('founder','project_admin','project_lead','pm','member','advisor') then raise exception 'Unknown role.'; end if;
  if exists (select 1 from public.profiles where lower(email) = v_email) then
    raise exception 'That person already has an account. Change their role and projects in the table above.';
  end if;
  if exists (select 1 from unnest(coalesce(p_projects, '{}')) x where not exists (select 1 from public.projects p where p.id = x)) then
    raise exception 'One of the chosen projects no longer exists.';
  end if;
  insert into public.invitations(email, full_name, job_title, role, project_ids, invited_by)
  values (v_email, btrim(coalesce(p_full_name, '')), btrim(coalesce(p_job_title, '')), p_role, coalesce(p_projects, '{}'), auth.uid())
  on conflict (email) do update
    set full_name = excluded.full_name, job_title = excluded.job_title, role = excluded.role,
        project_ids = excluded.project_ids, invited_by = excluded.invited_by, created_at = now(),
        accepted_at = null, accepted_by = null;
  perform public.log_audit('Invited ' || v_email || ' as ' || p_role);
end $$;

create or replace function public.admin_cancel_invite(p_email text) returns void
language plpgsql security definer set search_path = public as $$
declare v_email text := lower(btrim(coalesce(p_email, '')));
begin
  if not public.is_super() then raise exception 'Only a Super Admin can cancel an invitation.'; end if;
  delete from public.invitations where email = v_email and accepted_at is null;
  if not found then raise exception 'There is no open invitation for that email.'; end if;
  perform public.log_audit('Cancelled the invitation for ' || v_email);
end $$;

-- Sign-up: unchanged for everyone else. An invited email becomes active with its role and projects.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare first_user boolean; inv public.invitations; v_name text;
begin
  first_user := coalesce((select value from public.app_settings where key = 'bootstrap_open'), 'false') = 'true'
                and not exists (select 1 from public.profiles where role = 'super_admin');
  if not first_user then
    select * into inv from public.invitations where email = lower(btrim(coalesce(new.email, ''))) and accepted_at is null;
  end if;
  v_name := coalesce(nullif(btrim(new.raw_user_meta_data->>'full_name'), ''), inv.full_name, '');
  insert into public.profiles(id, email, full_name, job_title, role, status)
  values (new.id, coalesce(new.email, ''), v_name, coalesce(inv.job_title, ''),
          case when first_user then 'super_admin' when inv.email is not null then inv.role else 'member' end,
          case when first_user or inv.email is not null then 'active' else 'pending' end);
  if first_user then
    update public.app_settings set value = 'false' where key = 'bootstrap_open';
  elsif inv.email is not null then
    insert into public.project_access(project_id, user_id)
      select p.id, new.id from public.projects p where p.id = any(inv.project_ids)
      on conflict do nothing;
    update public.invitations set accepted_at = now(), accepted_by = new.id where email = inv.email;
    insert into public.audit_log(actor_id, action) values (new.id, 'Joined by invitation as ' || inv.role);
  end if;
  return new;
end $$;

revoke all on function public.admin_invite(text, text, text, text, uuid[]), public.admin_cancel_invite(text) from public, anon;
grant execute on function public.admin_invite(text, text, text, text, uuid[]), public.admin_cancel_invite(text) to authenticated;

commit;
