/* GoXL Team Hub: real mode.
 *
 * Loaded after the main script in index.html. Does nothing unless team/config.js names a
 * Supabase project (LIVE). When it does, this file:
 *   1. signs the person in with Supabase Auth (email and password),
 *   2. loads what they are allowed to see into the same in-memory shape the demo uses
 *      (people, projects, S.tasks, ...), so every screen in index.html works unchanged,
 *   3. replaces each action function (startTimer, markDone, createTask, ...) with a
 *      database call, then reloads.
 *
 * Nothing here decides who may do what. The database does (Row Level Security and the
 * RPCs in supabase/schema.sql). A refused action comes back as a message and is shown.
 */
(function () {
  'use strict';
  if (!LIVE) return;
  const CFG = window.GOXL_CONFIG;
  const overlay = () => document.getElementById('overlay');
  if (!window.supabase) {
    overlay().innerHTML = '<div class="signin"><div class="card"><h2>GoXL Team Hub could not start</h2><p class="muted" style="margin:0">A required file did not load. Reload the page, and if this continues tell your Super Admin.</p></div></div>';
    return;
  }
  const sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey);
  const must = r => { if (r.error) throw r.error; return r.data; };
  const rpc = async (fn, args) => must(await sb.rpc(fn, args || {}));

  // Database and auth messages are already written for people. A few generic ones are reworded.
  function say(e) {
    const m = (e && (e.message || e.error_description || e.msg)) || String(e);
    if (/row-level security|permission denied/i.test(m)) return 'Your role does not allow that.';
    if (/projects_name_key|duplicate key.*projects/i.test(m)) return 'A project with that name already exists.';
    if (/task_dependencies_pkey/i.test(m)) return 'That dependency already exists.';
    if (/JWT expired|invalid JWT/i.test(m)) return 'Your session has expired. Sign in again.';
    if (/Invalid login credentials/i.test(m)) return 'That email and password do not match an account.';
    if (/already registered|already been registered/i.test(m)) return 'An account with that email already exists. Sign in instead.';
    if (/Failed to fetch|NetworkError|Load failed/i.test(m)) return 'Could not reach the server. Check your connection and try again.';
    return m;
  }

  /* ---------- Loading: database rows -> the shapes index.html already renders ---------- */
  let lastSig = '', dirty = false, poll = null, channel = null;
  const stamp = iso => { const d = new Date(iso), t = tm(d.getTime()); return isoDay(d.getTime()) === today() ? t : dMon(d.getTime()) + ' ' + t; };

  async function loadAll() {
    const rs = (await Promise.all([
      sb.from('profiles').select('id,email,full_name,job_title,role,status,weekly_capacity_hours').order('created_at'),
      sb.from('role_permissions').select('role,perm,allowed'),
      sb.from('projects').select('id,name,description,lead_id').order('created_at'),
      sb.from('project_access').select('project_id,user_id'),
      sb.from('tasks').select('id,project_id,title,assignee_id,priority,status,est_hours,due_date').order('created_at'),
      sb.from('task_dependencies').select('task_id,depends_on_id'),
      sb.from('time_entries').select('id,task_id,user_id,started_at,ended_at').order('started_at', { ascending: false }).limit(1000),
      sb.from('docs').select('id,project_id,name,file_type,owner_id,storage_path,preview_text,created_at').order('created_at', { ascending: false }),
      sb.from('messages').select('id,channel,user_id,body,created_at').order('id', { ascending: false }).limit(500),
      sb.from('lead_suggestions').select('id,project_id,nominee_id,suggested_by,status,decided_by,created_at'),
      sb.from('daily_logs').select('id,user_id,log_date,payload,submitted_at').gte('log_date', ago(45)),
      sb.from('audit_log').select('id,actor_id,action,created_at').order('id', { ascending: false }).limit(30)
    ])).map(must);
    const [prof, perms, projs, acc, tasks, deps, ents, docs, msgs, leads, logs, aud] = rs;
    const sig = JSON.stringify(rs);
    const changed = sig !== lastSig; lastSig = sig;

    people.length = 0;
    prof.forEach((p, i) => people.push({
      id: p.id, name: p.full_name || p.email, email: p.email, role: p.job_title || ROLES[p.role] || '',
      cap: Number(p.weekly_capacity_hours), member: Number(p.weekly_capacity_hours) > 0, c: 'var(--c' + ((i % 7) + 1) + ')',
      rk: p.role, on: p.status === 'active', status: p.status,
      acc: acc.filter(a => a.user_id === p.id).map(a => a.project_id)
    }));
    projects.length = 0;
    projs.forEach((p, i) => projects.push({ id: p.id, name: p.name, desc: p.description || '', lead: p.lead_id, c: 'var(--c' + ((i % 7) + 1) + ')' }));
    S.channels = [['general', 'general', null]].concat(projects.map(p => [p.id, p.name, p.id]));

    S.perms = {};
    Object.keys(ROLES).forEach(r => { S.perms[r] = {}; PERMS.forEach(([k]) => { S.perms[r][k] = r === 'super_admin'; }); });
    perms.forEach(x => { if (S.perms[x.role] && x.role !== 'super_admin') S.perms[x.role][x.perm] = !!x.allowed; });

    const seen = new Set(tasks.map(t => t.id));
    S.tasks = tasks.map(t => ({
      id: t.id, title: t.title, project: t.project_id, who: t.assignee_id || '', est: Number(t.est_hours), status: t.status,
      priority: t.priority, due: t.due_date || '',
      deps: deps.filter(d => d.task_id === t.id && seen.has(d.depends_on_id)).map(d => d.depends_on_id)
    }));
    S.entries = []; S.active = {};
    ents.filter(e => seen.has(e.task_id)).forEach(e => {
      const start = Date.parse(e.started_at);
      if (e.ended_at) S.entries.push({ id: e.id, person: e.user_id, task: e.task_id, start, end: Date.parse(e.ended_at) });
      else S.active[e.user_id] = { task: e.task_id, start };
    });
    S.docs = docs.map(d => ({
      id: d.id, name: d.name, type: d.file_type || 'file', project: d.project_id, owner: d.owner_id || '', upd: stamp(d.created_at), path: d.storage_path,
      body: d.preview_text || 'No text preview for this file type. Use Open file to view it.'
    }));
    S.msgs = msgs.slice().reverse().map(m => ({ ch: m.channel, who: m.user_id, t: stamp(m.created_at), x: m.body }));
    S.leadReqs = leads.map(l => ({ id: l.id, project: l.project_id, nominee: l.nominee_id, by: l.suggested_by, status: l.status, decidedBy: l.decided_by, at: Date.parse(l.created_at) }));
    // The name and date shown for a log always come from the database row, never from the stored text.
    S.logs = logs.map(l => { const p = P(l.user_id), b = l.payload || {};
      return Object.assign({ tasks: [], newTasksForOthers: [], wins: '', challenges: {}, learnings: {}, tomorrowPlan: '' }, b,
        { id: l.id, submittedAt: Date.parse(l.submitted_at), employee: Object.assign({}, b.employee, { name: p.name, role: p.role, date: l.log_date }) }); });
    S.audit = aud.map(a => ({ t: Date.parse(a.created_at), who: a.actor_id || '', x: a.action }));

    // Drop selections that point at things this person can no longer see.
    if (S.open && !['new', 'sheet', 'newproject'].includes(S.open) && !seen.has(S.open)) S.open = null;
    if (!S.docs.some(d => d.id === S.docSel)) S.docSel = S.docs.length ? S.docs[0].id : '';
    if (S.fPerson !== 'all' && !people.some(p => p.id === S.fPerson)) S.fPerson = 'all';
    if (S.fProject !== 'all' && !projects.some(p => p.id === S.fProject)) S.fProject = 'all';
    if (S.docProj !== 'all' && !projects.some(p => p.id === S.docProj)) S.docProj = 'all';
    return changed;
  }

  const typing = () => { const a = document.activeElement; return !!a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName); };
  // Background refresh. Never redraws the screen while someone is typing; it waits until they stop.
  async function refresh() {
    let changed;
    try { changed = await loadAll(); } catch (e) { return; }
    if (!changed && !dirty) return;
    if (typing()) {
      dirty = true;
      const b = document.getElementById('msgs');
      if (S.view === 'chat' && b) { const atEnd = b.scrollHeight - b.scrollTop - b.clientHeight < 40; b.innerHTML = msgList(); if (atEnd) b.scrollTop = b.scrollHeight; }
      return;
    }
    dirty = false; render();
  }
  document.addEventListener('focusout', () => { if (dirty) setTimeout(() => { if (dirty && !typing()) { dirty = false; render(); } }, 150); });

  // Runs one change, then reloads and redraws. Shows the database's own message if it is refused.
  async function run(fn, okMsg) {
    try {
      const r = await fn();
      await loadAll(); dirty = false; render();
      if (okMsg) toast(typeof okMsg === 'function' ? okMsg(r) : okMsg);
      return r;
    } catch (e) {
      toast(say(e));
      try { await loadAll(); dirty = false; render(); } catch (_) { /* keep the current screen */ }
      return null;
    }
  }

  /* ---------- Actions: each replaces the demo function of the same name ---------- */
  audit = function () {};            // the database writes its own audit log
  sysMsg = function (pid, text) { sb.from('messages').insert({ channel: pid, user_id: S.user, body: text }).then(() => {}); };
  invite = function () { toast('New people create their own account on the sign-in screen.'); };

  startTimer = function (pid, tid) {
    if (S.active[pid] && S.active[pid].task === tid) return;
    return run(() => rpc('start_timer', { p_task: tid }), () => 'Timer started at ' + tm(Date.now()) + '. Your previous timer, if any, was stopped.');
  };
  pauseTimer = () => run(() => rpc('stop_timer'), 'Timer paused. Time saved.');
  markDone = tid => run(() => rpc('complete_task', { p_task: tid }), ids => {
    const freed = (ids || []).map(i => T(i)).filter(Boolean);
    return freed.length ? 'Done. Unblocked: ' + freed.map(x => x.title).join(', ') : 'Done. Timer stopped and end time saved.';
  });
  addDep = function (tid, did) {
    if (!did) return;
    const wasDoing = T(tid) && T(tid).status === 'doing', dep = T(did);
    return run(async () => must(await sb.from('task_dependencies').insert({ task_id: tid, depends_on_id: did, created_by: S.user })),
      () => wasDoing && T(tid) && T(tid).status === 'todo' ? 'Dependency added. Task paused until ' + (dep ? dep.title : 'it') + ' is done.' : 'Dependency added.');
  };
  removeDep = (tid, did) => run(async () => must(await sb.from('task_dependencies').delete().eq('task_id', tid).eq('depends_on_id', did)), 'Dependency removed.');
  setPriority = (tid, v) => run(async () => must(await sb.from('tasks').update({ priority: v }).eq('id', tid)), 'Priority set to ' + PRIO[v].n + '.');
  setDue = (tid, v) => run(async () => must(await sb.from('tasks').update({ due_date: v || null }).eq('id', tid)), v ? 'Due date saved.' : 'Due date cleared.');
  assignTask = (tid, pid) => run(async () => must(await sb.from('tasks').update({ assignee_id: pid || null }).eq('id', tid)), () => pid ? 'Reassigned to ' + P(pid).name + '.' : 'Task is now unassigned.');
  createTask = f => run(async () => {
    const t = must(await sb.from('tasks').insert({ project_id: f.project, title: f.title, assignee_id: f.who || null, est_hours: f.est, priority: f.priority, due_date: f.due || null, created_by: S.user }).select('id').single());
    S.open = t.id;
  }, 'Task created.');

  importSheet = function () {
    const R = S.sheetRows; if (!R || !R.rows) return;
    if (!can('uploadSheet')) return toast('Your role cannot upload task sheets.');
    const ok = R.rows.filter(r => !r.errs.length); if (!ok.length) return;
    let skipped = 0;
    return run(async () => {
      const made = must(await sb.from('tasks').insert(ok.map(r => ({ project_id: r.proj.id, title: r.title, assignee_id: r.m.id, est_hours: r.est, priority: r.pr, due_date: r.due || null, created_by: S.user }))).select('id,title'));
      const byTitle = {}; S.tasks.forEach(t => { byTitle[t.title.toLowerCase()] = t.id; }); made.forEach(t => { byTitle[t.title.toLowerCase()] = t.id; });
      for (let i = 0; i < ok.length; i++) for (const dt of ok[i].depTitles) {
        const dep = byTitle[dt.toLowerCase()], me = made[i] && made[i].id;
        if (!dep || !me || dep === me) { skipped++; continue; }
        const r = await sb.from('task_dependencies').insert({ task_id: me, depends_on_id: dep, created_by: S.user });
        if (r.error) skipped++;
      }
      S.sheetRows = null; S.sheetText = ''; S.open = null;
    }, () => 'Imported ' + ok.length + ' task' + (ok.length === 1 ? '' : 's') + (skipped ? '. ' + skipped + ' dependency link(s) skipped.' : '.'));
  };

  setRole = (pid, rk) => run(() => rpc('admin_set_role', { p_user: pid, p_role: rk }), () => P(pid).name + ' is now ' + ROLES[rk] + '.');
  toggleOn = function (pid) {
    const p = P(pid), next = p.on ? 'inactive' : 'active';
    return run(() => rpc('admin_set_status', { p_user: pid, p_status: next }),
      () => next === 'active' ? P(pid).name + ' can sign in now.' : P(pid).name + ' can no longer sign in. Their timer was stopped.');
  };
  setAccess = (pid, pr, on) => run(() => rpc('admin_set_project_access', { p_project: pr, p_user: pid, p_allowed: !!on }), () => 'Access updated for ' + P(pid).name + '.');
  setPerm = (r, k, on) => run(() => rpc('admin_set_permission', { p_role: r, p_perm: k, p_allowed: !!on }), 'Permission updated for ' + ROLES[r] + '.');

  addDocFile = function (f, pid) {
    return run(async () => {
      if (!pid) throw new Error('Choose a project for this document first.');
      const safe = f.name.replace(/[^\w.\-]+/g, '_').slice(-120), path = pid + '/' + crypto.randomUUID() + '-' + safe;
      must(await sb.storage.from('project-docs').upload(path, f, { contentType: f.type || 'application/octet-stream' }));
      let preview = '';
      if (/\.(txt|md|csv)$/i.test(f.name)) { try { preview = (await f.text()).slice(0, 8000); } catch (_) { preview = ''; } }
      const r = await sb.from('docs').insert({ project_id: pid, name: f.name, file_type: (f.name.split('.').pop() || 'file').toLowerCase().slice(0, 12), owner_id: S.user, storage_path: path, preview_text: preview }).select('id').single();
      if (r.error) { await sb.storage.from('project-docs').remove([path]); throw r.error; }   // do not leave a file without its record
      S.docSel = r.data.id;
    }, 'Uploaded ' + f.name + '.');
  };
  openDoc = async function (id) {
    const d = S.docs.find(x => x.id === id); if (!d || !d.path) return;
    const w = window.open('about:blank', '_blank');   // opened now, while the click still counts, so it is not blocked as a pop-up
    try {
      const r = must(await sb.storage.from('project-docs').createSignedUrl(d.path, 120));
      if (w) { w.opener = null; w.location = r.signedUrl; } else window.location = r.signedUrl;
    } catch (e) { if (w) w.close(); toast(say(e)); }
  };
  createProject = async function () {
    if (!can('addProject')) return toast('Your role cannot create projects.');
    const name = $('#npName').value.trim(), desc = $('#npDesc').value.trim();
    if (!name) return toast('Give the project a name.');
    const files = S.npFiles || []; S.npFiles = [];
    let pid = null;
    await run(async () => {
      pid = must(await sb.from('projects').insert({ name, description: desc, created_by: S.user }).select('id').single()).id;
      S.open = null; S.view = 'projects';
    }, 'Project "' + name + '" created' + (files.length ? '. Uploading ' + files.length + ' document(s).' : '.'));
    if (pid) for (const f of files) await addDocFile(f, pid);
  };

  suggestLead = (pid, nid) => run(async () => {
    await rpc('suggest_project_lead', { p_project: pid, p_nominee: nid });
    sysMsg(pid, 'Suggested ' + P(nid).name + ' as project lead. Waiting for a Founder or Super Admin to approve.');
  }, 'Suggestion sent. A Founder or Super Admin needs to approve it.');
  decideLead = function (rid, ok) {
    const r = S.leadReqs.find(x => x.id === rid); if (!r) return;
    const n = P(r.nominee), p = PR(r.project);
    return run(async () => {
      await rpc('decide_lead_suggestion', { p_id: rid, p_approve: !!ok });
      sysMsg(r.project, ok ? n.name + ' is now the project lead.' : 'The suggestion of ' + n.name + ' as project lead was not approved.');
    }, ok ? n.name + ' is now lead of ' + (p ? p.name : 'the project') + '.' : 'Suggestion rejected.');
  };

  sendMsg = async function () {
    const i = $('#msgIn'), x = i.value.trim(); if (!x) return;
    i.value = '';
    const r = await sb.from('messages').insert({ channel: S.channel, user_id: S.user, body: x.slice(0, 4000) });
    if (r.error) { i.value = x; return toast(say(r.error)); }
    try { await loadAll(); } catch (_) { return; }
    const b = $('#msgs'); if (b) { b.innerHTML = msgList(); b.scrollTop = b.scrollHeight; }
  };

  saveLog = async function (log) {
    const existed = !!myLog(log.employee.date);
    const payload = JSON.parse(JSON.stringify(log)); delete payload.id;
    const r = await sb.from('daily_logs').upsert({ user_id: S.user, log_date: log.employee.date, payload, submitted_at: new Date().toISOString() }, { onConflict: 'user_id,log_date' });
    if (r.error) { toast(say(r.error)); return null; }
    try { await loadAll(); } catch (_) { /* the caller redraws with what we have */ }
    return existed;
  };

  signOut = async function () {
    stopLive();
    try { await sb.auth.signOut(); } catch (_) { /* signing out locally is enough */ }
    location.reload();
  };

  /* ---------- Live updates ---------- */
  function startLive() {
    stopLive();
    poll = setInterval(refresh, 20000);
    window.addEventListener('focus', refresh);
    if (CFG.realtime !== false) {
      let t = null; const soon = () => { clearTimeout(t); t = setTimeout(refresh, 400); };
      try { channel = sb.channel('goxl-hub').on('postgres_changes', { event: '*', schema: 'public' }, soon).subscribe(); } catch (_) { channel = null; }
    }
  }
  function stopLive() {
    if (poll) clearInterval(poll); poll = null;
    window.removeEventListener('focus', refresh);
    if (channel) { try { sb.removeChannel(channel); } catch (_) {} channel = null; }
  }

  /* ---------- Sign-in ---------- */
  let mode = 'in', note = '', busy = false;
  function showAuth() {
    const up = mode === 'up';
    overlay().innerHTML = `<div class="signin"><form class="card" id="authform" novalidate>
      <h2>${up ? 'Create your GoXL Team Hub account' : 'Sign in to GoXL Team Hub'}</h2>
      <p class="muted" style="margin:0">${up ? 'A Super Admin approves new accounts before they can see anything.' : 'Use your work email. You stay signed in on this device until you sign out.'}</p>
      ${up ? '<label class="field">Full name<input type="text" id="auName" autocomplete="name" required></label>' : ''}
      <label class="field">Email<input type="email" id="auEmail" autocomplete="email" required></label>
      <label class="field">Password<input type="password" id="auPass" autocomplete="${up ? 'new-password' : 'current-password'}" required minlength="8"></label>
      ${note ? `<div class="chip ${/^(Check|Account created)/.test(note) ? 'good' : 'bad'}" role="alert" style="align-self:flex-start;white-space:normal;height:auto;padding:6px 10px">${esc(note)}</div>` : ''}
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><button class="btn pri" type="submit" ${busy ? 'disabled' : ''}>${busy ? 'Please wait…' : up ? 'Create account' : 'Sign in'}</button>
      <button class="btn" type="button" data-auth="${up ? 'in' : 'up'}">${up ? 'I already have an account' : 'Create an account'}</button></div>
    </form></div>`;
    const f = $(up ? '#auName' : '#auEmail'); if (f) f.focus();
  }
  function showGate(title, text) {
    overlay().innerHTML = `<div class="signin"><div class="card"><h2>${esc(title)}</h2><p class="muted" style="margin:0">${esc(text)}</p>
      <div style="display:flex;gap:8px"><button class="btn pri" data-auth="recheck">Check again</button><button class="btn" data-auth="out">Sign out</button></div></div></div>`;
  }
  document.addEventListener('click', e => {
    const el = e.target.closest('[data-auth]'); if (!el) return;
    const a = el.dataset.auth;
    if (a === 'in' || a === 'up') { mode = a; note = ''; showAuth(); }
    else if (a === 'out') signOut();
    else if (a === 'recheck') start();
  });
  document.addEventListener('submit', async e => {
    if (e.target.id !== 'authform') return;
    e.preventDefault(); if (busy) return;
    const email = $('#auEmail').value.trim(), pass = $('#auPass').value, name = mode === 'up' ? $('#auName').value.trim() : '';
    const again = msg => { note = msg; busy = false; showAuth(); $('#auEmail').value = email; if ($('#auName')) $('#auName').value = name; };
    if (mode === 'up' && !name) return again('Enter your full name.');
    if (!/^\S+@\S+\.\S+$/.test(email)) return again('Enter your email address.');
    if (pass.length < 8) return again('Use a password of at least 8 characters.');
    busy = true; note = ''; showAuth(); $('#auEmail').value = email;
    try {
      if (mode === 'up') {
        const r = await sb.auth.signUp({ email, password: pass, options: { data: { full_name: name } } });
        if (r.error) throw r.error;
        if (!r.data.session) { mode = 'in'; return again('Check your email to confirm your address, then sign in.'); }
      } else {
        const r = await sb.auth.signInWithPassword({ email, password: pass });
        if (r.error) throw r.error;
      }
      busy = false; note = ''; await start();
    } catch (err) { again(say(err)); }
  });

  async function start() {
    let user = null;
    try { user = (await sb.auth.getSession()).data.session; user = user && user.user; } catch (_) { user = null; }
    if (!user) { stopLive(); return showAuth(); }
    const r = await sb.from('profiles').select('id,status').eq('id', user.id).maybeSingle();
    if (r.error) { note = say(r.error); return showAuth(); }
    if (!r.data) return showGate('Your account is not set up yet', 'We could not find your profile. Ask a Super Admin to check your account.');
    if (r.data.status === 'pending') return showGate('Waiting for approval', 'Your account was created. A Super Admin needs to approve it before you can see projects, tasks or chat.');
    if (r.data.status !== 'active') return showGate('Account deactivated', 'This account can no longer sign in to the Team Hub. Ask a Super Admin if this is a mistake.');
    S.user = user.id;
    const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); WEEK0 = d.getTime();
    S.drafts = {}; S.exec = null; S.open = null; S.view = 'dashboard'; S.channel = 'general';
    try { await loadAll(); } catch (e) { return showGate('Could not load your workspace', say(e)); }
    overlay().innerHTML = ''; render(); startLive();
  }
  // Another tab signed out, or the session ended: return to the sign-in screen.
  sb.auth.onAuthStateChange(ev => { if (ev === 'SIGNED_OUT' && S.user && people.length) setTimeout(() => location.reload(), 0); });

  start();
})();
