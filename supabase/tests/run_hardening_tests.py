"""Phase 0 hardening tests (audit findings A2, A3, A4).

Run on a scratch Postgres with stubs.sql + schema.sql applied, and EITHER:
  --expect fixed       the Phase 0 migration is applied (default): every attack must be refused
  --expect vulnerable  the migration is NOT applied: proves the findings are real on the baseline

Usage: python3 run_hardening_tests.py "host=127.0.0.1 port=5499 user=postgres dbname=t" [--expect fixed|vulnerable]
"""
import sys, uuid, psycopg2

mode = 'fixed'
if '--expect' in sys.argv:
    mode = sys.argv[sys.argv.index('--expect') + 1]
conn = psycopg2.connect(sys.argv[1]); conn.autocommit = True
cur = conn.cursor()
fails = 0

def as_user(uid):
    cur.execute("reset role"); cur.execute("select set_config('request.jwt.claim.sub', %s, false)", (str(uid),)); cur.execute("set role authenticated")
def admin():
    cur.execute("reset role")
def q(sql, args=None):
    cur.execute(sql, args); return cur.fetchall() if cur.description else None
def ok(name, fn):
    """fn must succeed."""
    global fails
    try:
        r = fn(); print(f"PASS {name}"); return r
    except psycopg2.Error as e:
        print(f"FAIL {name}: {(e.pgerror or str(e)).strip()[:160]}"); fails += 1
def refused(name, fn, expect):
    """fn must be refused with `expect` in the message."""
    global fails
    try:
        fn(); print(f"FAIL {name}: expected refusal '{expect}' but it succeeded"); fails += 1
    except psycopg2.Error as e:
        msg = e.pgerror or str(e)
        if expect.lower() in msg.lower(): print(f"PASS {name} (refused: {expect})")
        else: print(f"FAIL {name}: refused, but with: {msg.strip()[:160]}"); fails += 1
def eq(name, got, want):
    global fails
    if got == want: print(f"PASS {name}")
    else: print(f"FAIL {name}: got {got!r} want {want!r}"); fails += 1
def attack(name, fn, expect):
    """An action that must be refused once fixed. On the baseline it must succeed, proving the finding."""
    global fails
    if mode == 'fixed':
        return refused(name, fn, expect)
    try:
        fn(); print(f"PASS [baseline is vulnerable] {name}: succeeded without the fix")
    except psycopg2.Error as e:
        print(f"FAIL [baseline] {name}: expected the unfixed schema to allow this, got: {(e.pgerror or str(e)).strip()[:120]}"); fails += 1

def signup(email, name):
    admin(); u = uuid.uuid4()
    cur.execute("insert into auth.users(id,email,raw_user_meta_data) values (%s,%s,%s::jsonb)", (str(u), email, '{"full_name":"%s"}' % name)); return u

# ---- People: one of each relevant role -------------------------------------------------
boss = signup('boss@x.test', 'Boss')            # first sign-up: Super Admin
pm = signup('pm@x.test', 'Pm'); member = signup('member@x.test', 'Member'); outsider = signup('outsider@x.test', 'Outsider')
gone = signup('gone@x.test', 'Gone'); founder = signup('founder@x.test', 'Founder'); pending = signup('pending@x.test', 'Pending')
as_user(boss)
for u, r in [(pm, 'pm'), (member, 'member'), (outsider, 'member'), (gone, 'member'), (founder, 'founder')]:
    q("select admin_set_status(%s,'active')", (str(u),)); q("select admin_set_role(%s,%s)", (str(u), r))

as_user(pm)
p1 = q("insert into projects(name,created_by) values ('Alpha',%s) returning id", (str(pm),))[0][0]
p2 = q("insert into projects(name,created_by) values ('Beta',%s) returning id", (str(pm),))[0][0]
as_user(boss)
for u in (member, gone):
    q("select admin_set_project_access(%s,%s,true)", (str(p1), str(u)))
q("select admin_set_project_access(%s,%s,true)", (str(p2), str(member)))
q("select admin_set_status(%s,'inactive')", (str(gone),))      # has access to Alpha but is deactivated

as_user(pm)
blocker = q("insert into tasks(project_id,title,assignee_id,created_by) values (%s,'Blocker',%s,%s) returning id", (str(p1), str(pm), str(pm)))[0][0]
t1 = q("insert into tasks(project_id,title,assignee_id,created_by) values (%s,'Work',%s,%s) returning id", (str(p1), str(member), str(pm)))[0][0]
t2 = q("insert into tasks(project_id,title,assignee_id,created_by) values (%s,'Blocked work',%s,%s) returning id", (str(p1), str(member), str(pm)))[0][0]
q("insert into task_dependencies(task_id,depends_on_id) values (%s,%s)", (str(t2), str(blocker)))

print("\n--- A2: task status and project can only change through the proper functions ---")
as_user(member)
q("select start_timer(%s)", (str(t1),))
attack("assignee cannot set status to done directly (skips complete_task)",
       lambda: q("update tasks set status='done' where id=%s", (str(t1),)), "permission denied")
admin()
if mode == 'vulnerable':
    eq("  consequence on baseline: task is 'done' but a timer is still running",
       q("select status, done_at is null, (select count(*) from time_entries where task_id=%s and ended_at is null) from tasks where id=%s", (str(t1), str(t1))), [('done', True, 1)])
    q("update tasks set status='doing' where id=%s", (str(t1),))
as_user(member)
attack("assignee cannot start a blocked task by editing status",
       lambda: q("update tasks set status='doing' where id=%s", (str(t2),)), "permission denied")
admin()
if mode == 'vulnerable': q("update tasks set status='todo' where id=%s", (str(t2),))
as_user(member)
attack("assignee cannot move a task to another project",
       lambda: q("update tasks set project_id=%s where id=%s", (str(p2), str(t1))), "permission denied")
admin()
if mode == 'vulnerable': q("update tasks set project_id=%s where id=%s", (str(p1), str(t1)))
as_user(member)
attack("assignee cannot rewrite who created a task",
       lambda: q("update tasks set created_by=%s where id=%s", (str(member), str(t1))), "permission denied")
attack("assignee cannot backdate done_at",
       lambda: q("update tasks set done_at=now() - interval '30 days' where id=%s", (str(t1),)), "permission denied")
as_user(pm)
attack("manager cannot create a task that is already done",
       lambda: q("insert into tasks(project_id,title,assignee_id,created_by,status) values (%s,'Pre-done',%s,%s,'done')", (str(p1), str(member), str(pm))), "permission denied")

if mode == 'fixed':
    print("\n--- A2: legitimate edits still work ---")
    as_user(member)
    ok("assignee can still edit title, description and estimate",
       lambda: q("update tasks set title='Work (renamed)', description='notes', est_hours=6 where id=%s", (str(t1),)))
    refused("member still cannot change priority", lambda: q("update tasks set priority='urgent' where id=%s", (str(t1),)), "cannot change priority")
    as_user(pm)
    ok("manager can still set priority and due date", lambda: q("update tasks set priority='high', due_date=current_date+7 where id=%s", (str(t1),)))
    admin()
    eq("updated_at moves when a task is edited", q("select updated_at > created_at from tasks where id=%s", (str(t1),)), [(True,)])
    as_user(member)
    ok("complete_task still completes", lambda: q("select complete_task(%s)", (str(t1),)))
    admin()
    eq("completion stopped the timer and set done_at",
       q("select status, done_at is not null, (select count(*) from time_entries where task_id=%s and ended_at is null) from tasks where id=%s", (str(t1), str(t1))), [('done', True, 0)])
    as_user(outsider)
    refused("someone outside the project cannot reopen", lambda: q("select reopen_task(%s)", (str(t1),)), "Task not found")
    as_user(member)
    ok("assignee can reopen a finished task", lambda: q("select reopen_task(%s)", (str(t1),)))
    admin()
    eq("reopened task is todo with no done_at", q("select status, done_at from tasks where id=%s", (str(t1),)), [('todo', None)])
    as_user(member)
    refused("reopening a task that is not done is refused", lambda: q("select reopen_task(%s)", (str(t1),)), "not done")
    cur.execute("reset role"); cur.execute("set role anon")
    refused("anonymous cannot reopen", lambda: q("select reopen_task(%s)", (str(t1),)), "permission denied")

print("\n--- A3: the assignee must be active and able to see the project ---")
as_user(pm)
attack("cannot reassign to someone without access to the project",
       lambda: q("update tasks set assignee_id=%s where id=%s", (str(outsider), str(t2))), "assignee must be an active team member")
admin(); q("update tasks set assignee_id=%s where id=%s", (str(member), str(t2)))
as_user(pm)
attack("cannot reassign to a deactivated person",
       lambda: q("update tasks set assignee_id=%s where id=%s", (str(gone), str(t2))), "assignee must be an active team member")
admin(); q("update tasks set assignee_id=%s where id=%s", (str(member), str(t2)))
as_user(pm)
attack("cannot create a task assigned to someone without access",
       lambda: q("insert into tasks(project_id,title,assignee_id,created_by) values (%s,'For outsider',%s,%s)", (str(p1), str(outsider), str(pm))), "assignee must be an active team member")
attack("cannot assign to an account still waiting for approval",
       lambda: q("insert into tasks(project_id,title,assignee_id,created_by) values (%s,'For pending',%s,%s)", (str(p1), str(pending), str(pm))), "assignee must be an active team member")
if mode == 'fixed':
    ok("can assign to a project member", lambda: q("update tasks set assignee_id=%s where id=%s", (str(pm), str(t2))))
    ok("can assign to a Founder (sees every project)", lambda: q("update tasks set assignee_id=%s where id=%s", (str(founder), str(t2))))
    ok("can create an unassigned task", lambda: q("insert into tasks(project_id,title,created_by) values (%s,'Unassigned',%s)", (str(p1), str(pm))))
    ok("editing other fields of a task whose assignee later lost access still works",
       lambda: (admin(), q("update tasks set assignee_id=%s where id=%s", (str(member), str(t2))),
                as_user(boss), q("select admin_set_project_access(%s,%s,false)", (str(p1), str(member))),
                as_user(pm), q("update tasks set title='Blocked work (edited)' where id=%s", (str(t2),)),
                as_user(boss), q("select admin_set_project_access(%s,%s,true)", (str(p1), str(member)))))

print("\n--- A4: managers can see who is on their projects, and nothing more ---")
as_user(pm)
got = sorted(str(r[0]) for r in q("select user_id from project_access where project_id=%s", (str(p1),)))
want_fixed = sorted(str(u) for u in (pm, member, gone))
if mode == 'fixed':
    eq("PM sees the full membership of a project they manage", got, want_fixed)
else:
    eq("[baseline is vulnerable] PM sees only their own membership row", got, [str(pm)])
as_user(member)
eq("a member still sees only their own access rows", sorted(set(str(r[0]) for r in q("select user_id from project_access"))), [str(member)])
as_user(outsider)
eq("someone outside the project sees no membership", q("select count(*) from project_access"), [(0,)])
as_user(pending)
eq("a pending account sees no membership", q("select count(*) from project_access"), [(0,)])
as_user(pm)
refused("reading membership does not allow changing it",
        lambda: q("insert into project_access(project_id,user_id) values (%s,%s)", (str(p1), str(outsider))), "row-level security")

if mode == 'fixed':
    print("\n--- Audit log ---")
    as_user(boss)
    ok("Super Admin changes capacity", lambda: q("select admin_set_capacity(%s, 30)", (str(member),)))
    eq("capacity change is in the audit log", q("select count(*) from audit_log where action like 'Set weekly capacity%%'"), [(1,)])
    as_user(pm)
    refused("non-admin cannot change capacity", lambda: q("select admin_set_capacity(%s, 1)", (str(member),)), "Only a Super Admin")
    refused("internal helper is not callable by users", lambda: q("select user_can_see_project(%s,%s)", (str(member), str(p1))), "permission denied")

print("\nFAILED: %d" % fails); sys.exit(1 if fails else 0)
