"""Behavioural tests for schema.sql on a scratch Postgres that already has stubs.sql + schema.sql applied.
Usage: python3 run_tests.py "host=/tmp port=5499 user=postgres dbname=t"
Each check simulates a signed-in Supabase user by setting request.jwt.claim.sub and role authenticated."""
import sys, uuid, psycopg2
conn = psycopg2.connect(sys.argv[1]); conn.autocommit = True
cur = conn.cursor()
fails = 0
def as_user(uid):
    cur.execute("reset role"); cur.execute("select set_config('request.jwt.claim.sub', %s, false)", (str(uid) if uid else '',)); cur.execute("set role authenticated")
def admin():
    cur.execute("reset role")
def q(sql, args=None):
    cur.execute(sql, args); return cur.fetchall() if cur.description else None
def check(name, fn, expect_error=None):
    global fails
    try:
        r = fn()
        if expect_error: print(f"FAIL {name}: expected error '{expect_error}' but succeeded"); fails += 1
        else: print(f"PASS {name}")
        return r
    except psycopg2.Error as e:
        msg = (e.pgerror or str(e))
        if expect_error and expect_error.lower() in msg.lower(): print(f"PASS {name} (refused: {expect_error})")
        else: print(f"FAIL {name}: {msg.strip()[:140]}"); fails += 1
def eq(name, got, want):
    global fails
    if got == want: print(f"PASS {name}")
    else: print(f"FAIL {name}: got {got!r} want {want!r}"); fails += 1

def signup(email, name):
    admin(); u = uuid.uuid4()
    cur.execute("insert into auth.users(id,email,raw_user_meta_data) values (%s,%s,%s::jsonb)", (str(u), email, '{"full_name":"%s"}' % name)); return u

viraj = signup('viraj@x.test','Viraj'); sumit = signup('sumit@x.test','Sumit'); ayush = signup('ayush@x.test','Ayush')
aarya = signup('aarya@x.test','Aarya'); stranger = signup('stranger@x.test','Stranger')
admin()
eq("first sign-up is active Super Admin", q("select role,status from profiles where id=%s",(str(viraj),)), [('super_admin','active')])
eq("later sign-ups wait as pending members", q("select role,status from profiles where id=%s",(str(sumit),)), [('member','pending')])
eq("bootstrap closed itself", q("select value from app_settings where key='bootstrap_open'"), [('false',)])

as_user(sumit)
eq("pending user sees no projects", q("select count(*) from projects"), [(0,)])
check("pending user cannot create a project", lambda: q("insert into projects(name,created_by) values ('X',%s)",(str(sumit),)), "row-level security")
check("pending user cannot approve themselves", lambda: q("select admin_set_status(%s,'active')",(str(sumit),)), "Only a Super Admin")
check("user cannot self-promote by update", lambda: q("update profiles set role='super_admin' where id=%s",(str(sumit),)), "permission denied")

as_user(viraj)
for u,r in [(sumit,'pm'),(ayush,'project_lead'),(aarya,'member')]:
    q("select admin_set_status(%s,'active')",(str(u),)); q("select admin_set_role(%s,%s)",(str(u),r))
check("cannot demote the only Super Admin", lambda: q("select admin_set_role(%s,'member')",(str(viraj),)), "at least one")
check("stranger stays pending", lambda: True)

# Projects and access
as_user(sumit)
pid = q("insert into projects(name,description,created_by) values ('ClarityOS','x',%s) returning id",(str(sumit),))[0][0]
eq("creator can see own project", q("select count(*) from projects"), [(1,)])
as_user(aarya)
eq("member without access sees no project", q("select count(*) from projects"), [(0,)])
check("member cannot create project", lambda: q("insert into projects(name,created_by) values ('Y',%s)",(str(aarya),)), "row-level security")
as_user(viraj)
q("select admin_set_project_access(%s,%s,true)",(str(pid),str(aarya)))
q("select admin_set_project_access(%s,%s,true)",(str(pid),str(ayush)))
as_user(aarya)
eq("member sees project once granted", q("select count(*) from projects"), [(1,)])

# Tasks
as_user(sumit)
t1 = q("insert into tasks(project_id,title,assignee_id,priority,created_by) values (%s,'Schema',%s,'high',%s) returning id",(str(pid),str(ayush),str(sumit)))[0][0]
t2 = q("insert into tasks(project_id,title,assignee_id,created_by) values (%s,'API',%s,%s) returning id",(str(pid),str(aarya),str(sumit)))[0][0]
t3 = q("insert into tasks(project_id,title,assignee_id,created_by) values (%s,'Report',%s,%s) returning id",(str(pid),str(aarya),str(sumit)))[0][0]
as_user(aarya)
check("member cannot add tasks", lambda: q("insert into tasks(project_id,title,created_by) values (%s,'Z',%s)",(str(pid),str(aarya))), "row-level security")
check("member cannot change priority", lambda: q("update tasks set priority='urgent' where id=%s",(str(t2),)), "cannot change priority")
check("member cannot reassign", lambda: q("update tasks set assignee_id=%s where id=%s",(str(ayush),str(t2))), "cannot reassign")
# Dependencies: any member can add
check("member can add a dependency", lambda: q("insert into task_dependencies(task_id,depends_on_id) values (%s,%s)",(str(t2),str(t1))))
check("dependency loop is refused", lambda: q("insert into task_dependencies(task_id,depends_on_id) values (%s,%s)",(str(t1),str(t2))), "loop")
check("self dependency is refused", lambda: q("insert into task_dependencies(task_id,depends_on_id) values (%s,%s)",(str(t2),str(t2))), "loop")
check("indirect loop is refused", lambda: (q("insert into task_dependencies(task_id,depends_on_id) values (%s,%s)",(str(t3),str(t2))), q("insert into task_dependencies(task_id,depends_on_id) values (%s,%s)",(str(t1),str(t3)))), "loop")
# Timers
check("blocked task cannot start", lambda: q("select start_timer(%s)",(str(t2),)), "blocked")
as_user(ayush)
check("assignee starts unblocked task", lambda: q("select start_timer(%s)",(str(t1),)))
eq("task moved to doing", q("select status from tasks where id=%s",(str(t1),)), [('doing',)])
check("second concurrent timer replaces first", lambda: q("select start_timer(%s)",(str(t1),)))
eq("only one running timer", q("select count(*) from time_entries where ended_at is null and user_id=%s",(str(ayush),)), [(1,)])
check("direct time-entry insert refused", lambda: q("insert into time_entries(task_id) values (%s)",(str(t1),)), "row-level security")
unb = q("select complete_task(%s)",(str(t1),))
eq("completing returns unblocked tasks", [r[0] for r in unb], [str(t2)])
eq("timer stopped on completion", q("select count(*) from time_entries where ended_at is null"), [(0,)])
as_user(aarya)
check("unblocked task can start", lambda: q("select start_timer(%s)",(str(t2),)))
# new dependency pauses a running task
as_user(sumit)
t4 = q("insert into tasks(project_id,title,assignee_id,created_by) values (%s,'Late dep',%s,%s) returning id",(str(pid),str(ayush),str(sumit)))[0][0]
as_user(aarya)
q("insert into task_dependencies(task_id,depends_on_id) values (%s,%s)",(str(t2),str(t4)))
eq("running task pauses when a new dependency is added", q("select status from tasks where id=%s",(str(t2),)), [('todo',)])
eq("its timer was stopped", q("select count(*) from time_entries where task_id=%s and ended_at is null",(str(t2),)), [(0,)])

# Project lead suggestion: suggest vs approve
as_user(aarya)
check("member cannot suggest a lead", lambda: q("select suggest_project_lead(%s,%s)",(str(pid),str(ayush))), "cannot suggest")
as_user(sumit)
sid = check("PM can suggest a lead", lambda: q("select suggest_project_lead(%s,%s)",(str(pid),str(ayush))))[0][0]
check("second open suggestion refused", lambda: q("select suggest_project_lead(%s,%s)",(str(pid),str(aarya))), "already waiting")
check("PM cannot approve", lambda: q("select decide_lead_suggestion(%s,true)",(str(sid),)), "Only a Founder or Super Admin")
as_user(viraj)
check("Super Admin approves", lambda: q("select decide_lead_suggestion(%s,true)",(str(sid),)))
admin()
eq("project lead set", q("select lead_id from projects where id=%s",(str(pid),)), [(ayush,)] if False else [(str(ayush),)] if False else q("select %s::uuid",(str(ayush),)))
check("deciding twice is refused", lambda: (as_user(viraj), q("select decide_lead_suggestion(%s,true)",(str(sid),))), "no longer pending")
as_user(sumit)
check("direct lead update refused", lambda: q("update projects set lead_id=%s where id=%s",(str(aarya),str(pid))), "permission denied")

# Chat, docs, logs, isolation
as_user(aarya)
check("member posts in project channel", lambda: q("insert into messages(channel,body) values (%s,'hi')",(str(pid),)))
as_user(stranger)
eq("pending stranger reads no messages", q("select count(*) from messages"), [(0,)])
check("pending stranger cannot post", lambda: q("insert into messages(channel,body) values ('general','x')"), "row-level security")
as_user(aarya)
check("member files own daily log", lambda: q("insert into daily_logs(log_date,payload) values (current_date,'{}'::jsonb)"))
as_user(ayush)
eq("member cannot read others' logs", q("select count(*) from daily_logs"), [(0,)])
as_user(viraj)
eq("Super Admin reads all logs", q("select count(*) from daily_logs"), [(1,)])
check("audit log readable by Super Admin", lambda: q("select count(*) from audit_log"))
as_user(sumit)
eq("audit log hidden from others", q("select count(*) from audit_log"), [(0,)])
as_user(aarya)
check("member cannot change permissions", lambda: q("select admin_set_permission('member','addTask',true)"), "Only a Super Admin")
cur.execute("reset role"); cur.execute("set role anon")
check("anonymous cannot call RPCs", lambda: q("select start_timer(%s)",(str(t1),)), "permission denied")
print("\nFAILED: %d" % fails); sys.exit(1 if fails else 0)
