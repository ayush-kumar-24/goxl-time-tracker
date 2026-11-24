/* End-to-end check of real sign-in and role behaviour, driven through the real page in a browser.
 *
 * Needs the local stack from supabase/local/start.sh, freshly started (empty database):
 *   supabase/local/start.sh && node tests/e2e/roles.cjs
 *
 * Five people sign up through the sign-in screen. Each then uses the app in their own browser
 * session. Checks cover what each role sees, what each role can do, and what the server refuses
 * when a signed-in person sends a hand-made request that the screen would never send.
 */
const { chromium } = require('playwright');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8000';
const PASS = 'Test-pass-1234';
let fails = 0, passes = 0;
const ok = (name, cond, detail) => { if (cond) { passes++; console.log('PASS ' + name); } else { fails++; console.log('FAIL ' + name + (detail ? ': ' + detail : '')); } };
const section = t => console.log('\n--- ' + t + ' ---');

(async () => {
  const browser = await chromium.launch();
  const pageErrors = [];
  const U = {};

  async function open(key) {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: process.env.SHOTS ? 2 : 1 });
    const page = await ctx.newPage();
    page.on('pageerror', e => pageErrors.push(key + ': ' + e.message));
    await page.goto(BASE + '/team', { waitUntil: 'domcontentloaded' });
    U[key] = { ctx, page };
    return page;
  }
  async function signUp(key, name, email) {
    const page = await open(key);
    await page.waitForSelector('#authform');
    await page.click('[data-auth="up"]');
    await page.fill('#auName', name); await page.fill('#auEmail', email); await page.fill('#auPass', PASS);
    await page.click('#authform button[type=submit]');
    await page.waitForFunction(() => document.querySelector('#side .nav') || /Waiting for approval/i.test(document.querySelector('#overlay').innerText), null, { timeout: 15000 });
    return page;
  }
  const nav = async (page, id) => { await page.click(`#side .nav[data-id="${id}"]`); await page.waitForTimeout(150); };
  const navIds = page => page.$$eval('#side .nav', els => els.map(e => e.dataset.id));
  const toast = async page => { try { await page.waitForSelector('#toast .toast', { timeout: 8000 }); return await page.locator('#toast .toast').innerText(); } catch (e) { return ''; } };
  const clearToast = page => page.evaluate(() => { document.getElementById('toast').innerHTML = ''; });
  const act = async (page, fn) => { await clearToast(page); await fn(); return toast(page); };
  const reload = async page => { await page.reload({ waitUntil: 'domcontentloaded' }); await page.waitForFunction(() => document.querySelector('#side .nav') || document.querySelector('#overlay .card'), null, { timeout: 15000 }); await page.waitForTimeout(300); };
  const main = page => page.locator('#main').innerText();
  // A hand-made request with the person's own session, bypassing the screen entirely.
  const raw = (page, method, path, body) => page.evaluate(async ({ method, path, body }) => {
    const cfg = window.GOXL_CONFIG, k = Object.keys(localStorage).find(x => /auth-token$/.test(x));
    const tok = JSON.parse(localStorage.getItem(k)).access_token;
    const r = await fetch(cfg.supabaseUrl + path, { method, headers: { apikey: cfg.supabaseKey, authorization: 'Bearer ' + tok, 'content-type': 'application/json', prefer: 'return=representation' }, body: body ? JSON.stringify(body) : undefined });
    let j = null; try { j = await r.json(); } catch (e) {}
    return { status: r.status, body: j };
  }, { method, path, body });

  try {
    section('Sign-up and approval');
    const viraj = await signUp('viraj', 'Viraj', 'viraj@goxl.test');
    ok('first account lands in the app, not on an approval screen', await viraj.locator('#side .nav').count() > 0);
    ok('first account is Super Admin', /Super Admin/.test(await viraj.locator('#side .me').innerText()));
    ok('Super Admin sees Admin and Founder dashboard', (await navIds(viraj)).includes('admin') && (await navIds(viraj)).includes('founder'));
    ok('no "Viewing as" switcher in real mode', await viraj.locator('#who').count() === 0);

    const sumit = await signUp('sumit', 'Sumit Suman', 'sumit@goxl.test');
    const aarya = await signUp('aarya', 'Aarya', 'aarya@goxl.test');
    const ayush = await signUp('ayush', 'Ayush Kumar', 'ayush@goxl.test');
    const omar = await signUp('omar', 'Omar', 'omar@goxl.test');
    ok('second account waits for approval', /Waiting for approval/i.test(await sumit.locator('#overlay').innerText()));
    ok('a pending account sees no app screens', await sumit.locator('#side .nav').count() === 0);
    const pend = await raw(sumit, 'GET', '/rest/v1/tasks?select=id');
    const pendPeople = await raw(sumit, 'GET', '/rest/v1/profiles?select=email');
    ok('pending account: hand-made request reads no tasks', pend.status === 200 && pend.body.length === 0);
    ok('pending account: hand-made request reads only its own profile', pendPeople.body.length === 1 && pendPeople.body[0].email === 'sumit@goxl.test');
    const selfPromote = await raw(sumit, 'PATCH', '/rest/v1/profiles?email=eq.sumit@goxl.test', { role: 'super_admin', status: 'active' });
    ok('pending account cannot approve or promote itself', selfPromote.status >= 400, JSON.stringify(selfPromote));

    await reload(viraj); await nav(viraj, 'admin');
    ok('Super Admin sees four pending accounts', await viraj.locator('button[data-act="toggleon"]:has-text("Pending: approve")').count() === 4);
    for (const n of ['Sumit Suman', 'Aarya', 'Ayush Kumar', 'Omar']) {
      const row = viraj.locator('#main tbody tr', { has: viraj.locator(`b:text-is("${n}")`) }).first();
      await act(viraj, () => row.locator('button[data-act="toggleon"]').click());
    }
    ok('all accounts approved', await viraj.locator('button[data-act="toggleon"]:has-text("Active")').count() === 5);
    const setRole = async (n, role) => { const row = viraj.locator('#main tbody tr', { has: viraj.locator(`b:text-is("${n}")`) }).first(); return act(viraj, () => row.locator('select[data-role]').selectOption(role)); };
    ok('Super Admin makes Sumit a Project Manager', /is now Project Manager/.test(await setRole('Sumit Suman', 'pm')));
    ok('Super Admin makes Ayush a Project Lead', /is now Project Lead/.test(await setRole('Ayush Kumar', 'project_lead')));

    section('Project Manager');
    await sumit.click('[data-auth="recheck"]'); await sumit.waitForSelector('#side .nav');
    const sumitNav = await navIds(sumit);
    ok('PM is let in after approval', sumitNav.includes('dashboard'));
    ok('PM does not see Admin or Founder dashboard', !sumitNav.includes('admin') && !sumitNav.includes('founder'));
    await nav(sumit, 'projects');
    await sumit.click('[data-act="newproject"]'); await sumit.fill('#npName', 'ClarityOS'); await sumit.fill('#npDesc', 'Founder diagnosis product');
    ok('PM creates a project', /created/.test(await act(sumit, () => sumit.click('[data-act="createproject"]'))));
    { const m = await main(sumit); ok('PM sees the new project', /ClarityOS/i.test(m), m.slice(0, 120)); }

    await reload(viraj); await nav(viraj, 'admin');
    for (const n of ['Aarya', 'Ayush Kumar']) {
      const row = viraj.locator('#main tbody tr', { has: viraj.locator(`b:text-is("${n}")`) }).first();
      await act(viraj, () => row.locator('input[data-acc]').first().check());
    }
    ok('Super Admin grants Aarya and Ayush access to ClarityOS', await viraj.locator('input[data-acc]:checked').count() >= 2);

    await reload(sumit); await nav(sumit, 'tasks');
    await sumit.click('[data-act="newtask"]');
    const assignees = await sumit.$$eval('#nw option', o => o.map(x => x.textContent));
    ok('assignee list offers only people who can see the project', assignees.includes('Aarya') && assignees.includes('Ayush Kumar') && !assignees.includes('Omar'), assignees.join(', '));
    const mk = async (title, who, prio) => { if (await sumit.locator('#newform').count() === 0) await sumit.click('[data-act="newtask"]'); await sumit.fill('#nt', title); await sumit.selectOption('#nw', { label: who }); await sumit.selectOption('#npr', prio);
      const t = await act(sumit, () => sumit.click('#newform button[type=submit]')); await sumit.keyboard.press('Escape'); return t; };
    ok('PM creates a task for Ayush', /Task created/.test(await mk('Finalize PID scoring schema', 'Ayush Kumar', 'high')));
    ok('PM creates a task for Aarya', /Task created/.test(await mk('Diagnosis API endpoints', 'Aarya', 'urgent')));
    await sumit.click('.tcard:has-text("Diagnosis API endpoints")');
    await sumit.selectOption('#depSel', { index: 1 });
    ok('PM adds a dependency', /Dependency added/.test(await act(sumit, () => sumit.click('[data-act="adddep"]'))));
    await sumit.keyboard.press('Escape');
    { const c = (await sumit.locator('.board .col').first().innerText()).replace(/\n/g, ' '); ok('dependent task shows as Blocked on the board', /Blocked\s*1\b.*Diagnosis API endpoints/i.test(c), c.slice(0, 120)); }
    const ids = await raw(sumit, 'GET', '/rest/v1/tasks?select=id,title,project_id&order=created_at');
    const T1 = ids.body.find(t => /PID/.test(t.title)), T2 = ids.body.find(t => /Diagnosis/.test(t.title));
    const omarId = (await raw(viraj, 'GET', '/rest/v1/profiles?select=id&email=eq.omar@goxl.test')).body[0].id;
    const badAssign = await raw(sumit, 'PATCH', '/rest/v1/tasks?id=eq.' + T2.id, { assignee_id: omarId });
    ok('PM: hand-made request cannot assign a task to someone outside the project', badAssign.status >= 400 && /assignee must be an active team member/.test(JSON.stringify(badAssign.body)), JSON.stringify(badAssign.body));
    const pmAdmin = await raw(sumit, 'POST', '/rest/v1/rpc/admin_set_role', { p_user: omarId, p_role: 'founder' });
    ok('PM: hand-made request cannot change roles', pmAdmin.status >= 400 && /Only a Super Admin/.test(JSON.stringify(pmAdmin.body)));

    section('Member (Aarya)');
    await aarya.click('[data-auth="recheck"]'); await aarya.waitForSelector('#side .nav');
    const aaryaNav = await navIds(aarya);
    ok('member sees no Admin or Founder dashboard', !aaryaNav.includes('admin') && !aaryaNav.includes('founder'));
    await nav(aarya, 'tasks');
    ok('member sees the project tasks', /Diagnosis API endpoints/.test(await main(aarya)));
    ok('member has no New task button', await aarya.locator('[data-act="newtask"]').count() === 0);
    await aarya.click('.tcard:has-text("Diagnosis API endpoints")');
    ok('member cannot change priority in the drawer', await aarya.locator('#prioSel').count() === 0);
    ok('member cannot reassign in the drawer', await aarya.locator('#assign').isDisabled());
    const blockedStart = await act(aarya, () => aarya.click('.drawer [data-act="start"]'));
    ok('member cannot start a timer on a blocked task', /blocked/i.test(blockedStart), blockedStart);
    await aarya.keyboard.press('Escape');
    const forgeDone = await raw(aarya, 'PATCH', '/rest/v1/tasks?id=eq.' + T2.id, { status: 'done' });
    ok('member: hand-made request cannot mark a task done directly', forgeDone.status >= 400, JSON.stringify(forgeDone));
    const forgeMove = await raw(aarya, 'PATCH', '/rest/v1/tasks?id=eq.' + T2.id, { priority: 'low' });
    ok('member: hand-made request cannot change priority', forgeMove.status >= 400 && /cannot change priority/.test(JSON.stringify(forgeMove.body)));
    const forgeTask = await raw(aarya, 'POST', '/rest/v1/tasks', { project_id: T2.project_id, title: 'Sneaky', created_by: omarId });
    ok('member: hand-made request cannot create a task', forgeTask.status >= 400);
    const forgeTime = await raw(aarya, 'POST', '/rest/v1/time_entries', { task_id: T2.id });
    ok('member: hand-made request cannot insert time entries', forgeTime.status >= 400);
    const stillTodo = await raw(aarya, 'GET', '/rest/v1/tasks?select=status,priority&id=eq.' + T2.id);
    ok('the task is unchanged after those attempts', stillTodo.body[0].status === 'todo' && stillTodo.body[0].priority === 'urgent');

    section('Project Lead (Ayush) and the timer flow');
    await ayush.click('[data-auth="recheck"]'); await ayush.waitForSelector('#side .nav');
    await nav(ayush, 'time');
    ok('lead starts a timer on his task', /Timer started/.test(await act(ayush, () => ayush.click('[data-act="start"]'))));
    ok('running timer shows in the top bar', await ayush.locator('#top .pill.run').count() === 1);
    await reload(aarya); await nav(aarya, 'dashboard');
    ok('another person sees Ayush working now', /Ayush Kumar[\s\S]*Finalize PID scoring schema/.test(await main(aarya)));
    await ayush.waitForTimeout(1200);
    const doneMsg = await act(ayush, () => ayush.click('#main [data-act="done"]'));
    ok('completing a task reports what it unblocked', /Unblocked: Diagnosis API endpoints/.test(doneMsg), doneMsg);
    const t1row = await raw(ayush, 'GET', '/rest/v1/tasks?select=status,done_at&id=eq.' + T1.id);
    const running = await raw(ayush, 'GET', '/rest/v1/time_entries?select=id&ended_at=is.null');
    ok('server recorded completion and stopped the timer', t1row.body[0].status === 'done' && !!t1row.body[0].done_at && running.body.length === 0);

    section('Member continues: timer, chat, document, daily log');
    await reload(aarya); await nav(aarya, 'time');
    ok('unblocked task can now be started', /Timer started/.test(await act(aarya, () => aarya.click('#main [data-act="start"]'))));
    await nav(aarya, 'chat');
    await aarya.click('.chans button:has-text("ClarityOS")');
    await aarya.fill('#msgIn', 'Picked up the diagnosis endpoints.'); await aarya.click('[data-act="send"]');
    await aarya.waitForFunction(() => /Picked up the diagnosis endpoints/.test(document.querySelector('#msgs').innerText), null, { timeout: 8000 });
    ok('member posts in the project channel', true);
    await nav(aarya, 'projects');
    const up = await act(aarya, async () => { await aarya.setInputFiles('input[data-up]', { name: 'api-notes.md', mimeType: 'text/markdown', buffer: Buffer.from('Diagnosis API notes\n\n- intake endpoint\n- scoring endpoint') }); });
    ok('member uploads a document', /Uploaded api-notes\.md/.test(up), up);
    await nav(aarya, 'docs');
    ok('document preview shows the text', /intake endpoint/.test(await aarya.locator('#docprev').innerText()));
    const docRow = (await raw(aarya, 'GET', '/rest/v1/docs?select=storage_path')).body[0];
    const signed = await aarya.evaluate(async path => { const cfg = window.GOXL_CONFIG, k = Object.keys(localStorage).find(x => /auth-token$/.test(x)), tok = JSON.parse(localStorage.getItem(k)).access_token;
      const r = await fetch(cfg.supabaseUrl + '/storage/v1/object/sign/project-docs/' + path, { method: 'POST', headers: { apikey: cfg.supabaseKey, authorization: 'Bearer ' + tok, 'content-type': 'application/json' }, body: JSON.stringify({ expiresIn: 60 }) });
      const j = await r.json(); if (!j.signedURL) return { status: r.status, text: JSON.stringify(j) };
      const f = await fetch(cfg.supabaseUrl + '/storage/v1' + j.signedURL); return { status: f.status, text: await f.text() }; }, docRow.storage_path);
    ok('the stored file can be opened by a project member', signed.status === 200 && /scoring endpoint/.test(signed.text), JSON.stringify(signed).slice(0, 160));
    await nav(aarya, 'log');
    await aarya.selectOption('#f-employee-department', 'Engineering / AI');
    await aarya.click('[data-act="logfill"]'); await aarya.waitForTimeout(200);
    ok('daily log fills from tracked time', (await aarya.inputValue('#f-tasks-0-taskName')) === 'Diagnosis API endpoints');
    await aarya.fill('#f-wins', '✔ Intake endpoint returns real data');
    ok('member submits a daily log', /Saved\. 1 task/.test(await act(aarya, () => aarya.click('[data-act="logsubmit"]'))));
    await reload(aarya);
    ok('session survives a page reload (stays signed in)', await aarya.locator('#side .nav').count() > 0 && await aarya.locator('#authform').count() === 0);
    await nav(aarya, 'log');
    ok('saved log is loaded back from the database', /is saved/.test(await main(aarya)));

    section('Active account with no project access (Omar)');
    await omar.click('[data-auth="recheck"]'); await omar.waitForSelector('#side .nav');
    await nav(omar, 'projects');
    ok('sees no projects', /do not have access to any project/.test(await main(omar)));
    await nav(omar, 'tasks');
    ok('sees no tasks', !/Diagnosis API endpoints/.test(await main(omar)));
    await nav(omar, 'chat');
    ok('sees only the general channel', (await omar.locator('.chans button').allInnerTexts()).join('|') === '# general');
    const peek = await raw(omar, 'GET', '/rest/v1/messages?select=body');
    const peekDocs = await raw(omar, 'GET', '/rest/v1/docs?select=name');
    const peekLogs = await raw(omar, 'GET', '/rest/v1/daily_logs?select=id');
    ok('hand-made requests read no project messages, documents or other people\'s logs', peek.body.length === 0 && peekDocs.body.length === 0 && peekLogs.body.length === 0);
    const peekFile = await omar.evaluate(async path => { const cfg = window.GOXL_CONFIG, k = Object.keys(localStorage).find(x => /auth-token$/.test(x)), tok = JSON.parse(localStorage.getItem(k)).access_token;
      const r = await fetch(cfg.supabaseUrl + '/storage/v1/object/authenticated/project-docs/' + path, { headers: { apikey: cfg.supabaseKey, authorization: 'Bearer ' + tok } }); return { status: r.status, text: (await r.text()).slice(0, 120) }; }, docRow.storage_path);
    ok('cannot download the project file even with its exact path', peekFile.status >= 400 && !/scoring endpoint/.test(peekFile.text), JSON.stringify(peekFile));
    const sneakPost = await raw(omar, 'POST', '/rest/v1/messages', { channel: T2.project_id, body: 'hello' });
    ok('cannot post into a project channel he is not in', sneakPost.status >= 400);

    section('Super Admin: oversight and deactivation');
    await reload(viraj); await nav(viraj, 'founder');
    ok('founder dashboard shows the submitted log', /Aarya/.test(await main(viraj)) && /1 log\(s\)/.test(await main(viraj)));
    await nav(viraj, 'admin');
    const log = await viraj.locator('#main .grid.g2 .card').nth(1).innerText();
    ok('activity log lists the admin changes', /Changed role of/.test(log) && /Project access/.test(log), log.slice(0, 120));
    const omarRow = viraj.locator('#main tbody tr', { has: viraj.locator('b:text-is("Omar")') }).first();
    ok('Super Admin deactivates Omar', /can no longer sign in/.test(await act(viraj, () => omarRow.locator('button[data-act="toggleon"]').click())));
    await reload(omar);
    ok('deactivated account is locked out on next load', /Account deactivated/i.test(await omar.locator('#overlay').innerText()));
    const after = await raw(omar, 'GET', '/rest/v1/profiles?select=email');
    ok('deactivated account: hand-made request reads only its own profile', after.body.length === 1);
    const selfRow = viraj.locator('#main tbody tr', { has: viraj.locator('b:text-is("Viraj")') }).first();
    const selfOff = await act(viraj, () => selfRow.locator('button[data-act="toggleon"]').click());
    ok('Super Admin cannot deactivate their own account', /cannot change your own status/.test(selfOff), selfOff);

    section('Inviting a new person');
    await nav(viraj, 'admin');
    await viraj.fill('#inEmail', 'Neha@goxl.test'); await viraj.fill('#inName', 'Neha Rao'); await viraj.fill('#inJob', 'QA engineer');
    await viraj.selectOption('#inRole', 'member'); await viraj.check('[data-invproj] >> nth=0');
    const invMsg = await act(viraj, () => viraj.click('#invform button[type=submit]'));
    ok('Super Admin invites a person with a role and a project', /Neha Rao is invited/.test(invMsg), invMsg);
    ok('the invitation is listed as waiting', /Waiting to sign up \(1\)[\s\S]*neha@goxl\.test/i.test(await main(viraj)));
    const dupInv = await act(viraj, async () => { await viraj.fill('#inEmail', 'aarya@goxl.test'); await viraj.fill('#inName', 'Aarya'); await viraj.click('#invform button[type=submit]'); });
    ok('inviting someone who already has an account is refused', /already has an account/.test(dupInv), dupInv);
    const pmInvite = await raw(sumit, 'POST', '/rest/v1/rpc/admin_invite', { p_email: 'friend@goxl.test', p_full_name: 'Friend', p_job_title: '', p_role: 'founder', p_projects: [] });
    ok('PM: hand-made request cannot invite anyone', pmInvite.status >= 400 && /Only a Super Admin/.test(JSON.stringify(pmInvite.body)));
    const pmPeek = await raw(sumit, 'GET', '/rest/v1/invitations?select=email');
    ok('PM: hand-made request cannot read invitations', pmPeek.status === 200 && pmPeek.body.length === 0);
    const neha = await signUp('neha', 'Neha Rao', 'neha@goxl.test');
    ok('invited person gets straight in, with no approval wait', await neha.locator('#side .nav').count() > 0);
    ok('invited person has the invited role', /Member/.test(await neha.locator('#side .me').innerText()) && !(await navIds(neha)).includes('admin'));
    await nav(neha, 'projects');
    ok('invited person sees the invited project', /ClarityOS/i.test(await main(neha)));
    await reload(viraj); await nav(viraj, 'admin');
    ok('the invitation leaves the waiting list once used', !/Waiting to sign up/i.test(await main(viraj)));
    const walkIn = await signUp('walkin', 'Walk In', 'walkin@goxl.test');
    ok('someone who was not invited still waits for approval', /Waiting for approval/i.test(await walkIn.locator('#overlay').innerText()));

    section('Sign-out and sign-in');
    await aarya.click('[data-act="signout"]'); await aarya.waitForSelector('#authform', { timeout: 15000 });
    ok('sign out returns to the sign-in screen', true);
    await aarya.fill('#auEmail', 'aarya@goxl.test'); await aarya.fill('#auPass', 'wrong-password'); await aarya.click('#authform button[type=submit]');
    await aarya.waitForSelector('#authform [role=alert]');
    ok('wrong password is refused with a clear message', /do not match/.test(await aarya.locator('#authform [role=alert]').innerText()));
    await aarya.fill('#auEmail', 'aarya@goxl.test'); await aarya.fill('#auPass', PASS); await aarya.click('#authform button[type=submit]');
    await aarya.waitForSelector('#side .nav', { timeout: 15000 });
    ok('correct password signs back in', /Aarya/.test(await aarya.locator('#side .me').innerText()));

    section('Page health');
    ok('no script errors on any page during the run', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
    if (process.env.SHOTS) for (const k of ['viraj', 'sumit', 'aarya']) { await nav(U[k].page, k === 'viraj' ? 'admin' : 'tasks'); await U[k].page.screenshot({ path: process.env.SHOTS + '/' + k + '.png' }); }
  } catch (e) {
    fails++; console.log('FAIL test run stopped early: ' + (e.stack || e.message).split('\n').slice(0, 4).join(' / '));
    if (pageErrors.length) console.log('  page errors: ' + pageErrors.slice(0, 3).join(' | '));
  }
  await browser.close();
  console.log(`\nPASSED: ${passes}  FAILED: ${fails}`);
  process.exit(fails ? 1 : 0);
})();
