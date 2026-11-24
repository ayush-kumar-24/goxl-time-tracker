"""Invitation tests. Run on a scratch Postgres with stubs.sql + schema.sql + all migrations applied.
Usage: python3 run_invite_tests.py "host=127.0.0.1 port=5499 user=postgres dbname=t" """
import sys, uuid, psycopg2
conn = psycopg2.connect(sys.argv[1]); conn.autocommit = True
cur = conn.cursor(); fails = 0
def as_user(uid):
    cur.execute("reset role"); cur.execute("select set_config('request.jwt.claim.sub', %s, false)", (str(uid),)); cur.execute("set role authenticated")
def admin(): cur.execute("reset role")
def q(sql, args=None):
    cur.execute(sql, args); return cur.fetchall() if cur.description else None
def ok(name, fn):
    global fails
    try: r = fn(); print(f"PASS {name}"); return r
    except psycopg2.Error as e: print(f"FAIL {name}: {(e.pgerror or str(e)).strip()[:160]}"); fails += 1
def refused(name, fn, expect):
    global fails
    try: fn(); print(f"FAIL {name}: expected refusal '{expect}' but it succeeded"); fails += 1
    except psycopg2.Error as e:
        msg = e.pgerror or str(e)
        if expect.lower() in msg.lower(): print(f"PASS {name} (refused: {expect})")
        else: print(f"FAIL {name}: refused, but with: {msg.strip()[:160]}"); fails += 1
def eq(name, got, want):
    global fails
    if got == want: print(f"PASS {name}")
    else: print(f"FAIL {name}: got {got!r} want {want!r}"); fails += 1
def signup(email, name=''):
    admin(); u = uuid.uuid4()
    cur.execute("insert into auth.users(id,email,raw_user_meta_data) values (%s,%s,%s::jsonb)", (str(u), email, '{"full_name":"%s"}' % name)); return u

boss = signup('boss@x.test', 'Boss'); pm = signup('pm@x.test', 'Pm')
as_user(boss); q("select admin_set_status(%s,'active')", (str(pm),)); q("select admin_set_role(%s,'pm')", (str(pm),))
as_user(pm)
p1 = q("insert into projects(name,created_by) values ('Alpha',%s) returning id", (str(pm),))[0][0]
p2 = q("insert into projects(name,created_by) values ('Beta',%s) returning id", (str(pm),))[0][0]

print("\n--- Who may invite ---")
refused("a PM cannot invite", lambda: q("select admin_invite('x@x.test','X','', 'member', '{}')"), "Only a Super Admin")
refused("a PM cannot write the invitations table directly", lambda: q("insert into invitations(email) values ('y@x.test')"), "permission denied")
eq("a PM cannot read invitations", q("select count(*) from invitations"), [(0,)])
cur.execute("reset role"); cur.execute("set role anon")
refused("anonymous cannot invite", lambda: q("select admin_invite('x@x.test','X','', 'member', '{}')"), "permission denied")

print("\n--- Inviting ---")
as_user(boss)
refused("a bad email is refused", lambda: q("select admin_invite('not-an-email','X','','member','{}')"), "valid email")
refused("cannot invite straight to Super Admin", lambda: q("select admin_invite('x@x.test','X','','super_admin','{}')"), "another role")
refused("unknown role is refused", lambda: q("select admin_invite('x@x.test','X','','owner','{}')"), "Unknown role")
refused("cannot invite someone who already has an account", lambda: q("select admin_invite('PM@x.test','X','','member','{}')"), "already has an account")
refused("a project that does not exist is refused", lambda: q("select admin_invite('x@x.test','X','','member',%s::uuid[])", ([str(uuid.uuid4())],)), "no longer exists")
ok("Super Admin invites a member with one project", lambda: q("select admin_invite('  Neha@X.test ','Neha Rao','QA engineer','member',%s::uuid[])", ([str(p1)],)))
eq("email is stored trimmed and lower-case", q("select email, role, full_name from invitations"), [('neha@x.test', 'member', 'Neha Rao')])
ok("inviting the same email again replaces the invitation", lambda: q("select admin_invite('neha@x.test','Neha Rao','QA engineer','pm',%s::uuid[])", ([str(p1), str(p2)],)))
eq("still one invitation, with the new role", q("select count(*), max(role) from invitations"), [(1, 'pm')])
ok("Super Admin invites a second person", lambda: q("select admin_invite('temp@x.test','Temp','','advisor','{}')"))
ok("Super Admin cancels an invitation", lambda: q("select admin_cancel_invite('TEMP@x.test')"))
refused("cancelling twice is refused", lambda: q("select admin_cancel_invite('temp@x.test')"), "no open invitation")

print("\n--- Signing up ---")
neha = signup('Neha@x.test', '')
admin()
eq("invited person is active with the invited role, name and job title",
   q("select role, status, full_name, job_title from profiles where id=%s", (str(neha),)), [('pm', 'active', 'Neha Rao', 'QA engineer')])
eq("invited person has the chosen projects", sorted(str(r[0]) for r in q("select project_id from project_access where user_id=%s", (str(neha),))), sorted([str(p1), str(p2)]))
eq("invitation is marked accepted", q("select accepted_at is not null, accepted_by from invitations where email='neha@x.test'"), [(True, str(neha))])
as_user(neha)
eq("invited person sees their projects straight away", q("select count(*) from projects"), [(2,)])
refused("invited PM still cannot do admin things", lambda: q("select admin_invite('z@x.test','Z','','member','{}')"), "Only a Super Admin")
stranger = signup('stranger@x.test', 'Stranger'); temp = signup('temp@x.test', 'Temp')
admin()
eq("someone not invited still waits as pending", q("select role, status from profiles where id=%s", (str(stranger),)), [('member', 'pending')])
eq("a cancelled invitation gives nothing", q("select role, status from profiles where id=%s", (str(temp),)), [('member', 'pending')])
as_user(boss)
refused("an accepted invitation cannot be cancelled", lambda: q("select admin_cancel_invite('neha@x.test')"), "no open invitation")
eq("invitations appear in the audit log", q("select count(*) from audit_log where action like 'Invited %%' or action like 'Joined by invitation%%' or action like 'Cancelled the invitation%%'"), [(5,)])
print("\nFAILED: %d" % fails); sys.exit(1 if fails else 0)
