/* Records everything the DEMO mode shows while a fixed script clicks through it, as JSON.
 *
 * Used to prove the demo still behaves exactly as before a change: run it against the old page
 * and the new page and compare the two files.
 *   node tests/e2e/demo_transcript.cjs http://127.0.0.1:8101/team/index.html > before.json
 *   node tests/e2e/demo_transcript.cjs http://127.0.0.1:8100/team/index.html > after.json
 *   diff before.json after.json
 * The clock is frozen so timers and dates are identical between runs.
 */
const { chromium } = require('playwright');
let last = 'start';
(async () => {
  const url = process.argv[2];
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.setDefaultTimeout(8000);
  const out = [], errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.clock.setFixedTime(new Date('2026-11-18T11:30:00'));
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#side .nav');
  const snap = async label => {
    await page.waitForTimeout(60); last = label;
    out.push({ label, side: await page.locator('#side').innerText(), top: await page.locator('#top').innerText(), main: await page.locator('#main').innerText(),
      drawer: await page.locator('#overlay').innerText(), toast: await page.locator('#toast').innerText() });
  };
  const as = async id => { await page.selectOption('#who', id); };
  const nav = async id => { await page.click(`#side .nav[data-id="${id}"]`); };

  // 1. Every screen, as four different roles.
  for (const who of ['viraj', 'sumit', 'aarya', 'bharat']) {
    await as(who);
    for (const id of await page.$$eval('#side .nav', els => els.map(e => e.dataset.id))) { await nav(id); await snap(who + ' / ' + id); }
    if (await page.locator('[data-act="rtab"][data-id="team"]').count()) { await nav('reports'); await page.click('[data-act="rtab"][data-id="team"]'); await snap(who + ' / reports team'); }
  }

  // 2. Timers and completion.
  await as('sumit'); await nav('time');
  await page.click('#main [data-act="start"]'); await snap('sumit starts a timer');
  await page.click('[data-act="stop"]'); await snap('sumit pauses');
  await as('savitri'); await nav('time');
  await page.click('#main [data-act="done"]'); await snap('savitri marks done (unblocks others)');
  await nav('tasks'); await snap('board after completion');

  // 3. Task drawer: priority, due date, reassign, dependencies.
  await as('sumit'); await nav('tasks');
  await page.click('.tcard:has-text("Partner pitch deck")'); await snap('drawer open');
  await page.selectOption('#prioSel', 'urgent'); await snap('priority changed');
  await page.fill('#dueSel', '2026-11-27'); await page.dispatchEvent('#dueSel', 'change'); await snap('due date changed');
  await page.selectOption('#assign', 'akshat'); await snap('reassigned');
  await page.click('[data-act="rmdep"]'); await snap('dependency removed');
  await page.selectOption('#depSel', { index: 2 }); await page.click('[data-act="adddep"]'); await snap('dependency added');
  await page.keyboard.press('Escape');

  // 4. New task, sheet import, new project.
  await page.click('[data-act="newtask"]'); await snap('new task form');
  await page.fill('#nt', 'Transcript task'); await page.selectOption('#np', 'ally'); await page.selectOption('#nw', 'aarya'); await page.selectOption('#npr', 'high'); await page.fill('#nd', '2026-11-30');
  await page.click('#newform button[type=submit]'); await snap('task created');
  await page.keyboard.press('Escape');
  await page.click('[data-act="sheet"]'); await page.click('[data-act="sheetexample"]'); await page.click('[data-act="sheetparse"]'); await snap('sheet checked');
  await page.click('[data-act="sheetimport"]'); await snap('sheet imported');
  await nav('projects'); await page.click('[data-act="newproject"]'); await page.fill('#npName', 'Client portal'); await page.fill('#npDesc', 'One line');
  await page.click('[data-act="createproject"]'); await snap('project created');

  // 5. Project lead: suggest, then approve.
  await page.selectOption('#lead-site', 'akshat'); await page.click('[data-act="leadsuggest"][data-id="site"]'); await snap('lead suggested');
  await as('viraj'); await nav('projects'); await page.click('[data-act="leadok"] >> nth=0'); await snap('lead approved');

  // 6. Admin: role, status, access, permission, invite.
  await nav('admin');
  await page.selectOption('select[data-role="aarya"]', 'pm'); await snap('role changed');
  await page.click('[data-act="toggleon"][data-id="bharat"]'); await snap('person deactivated');
  await page.click('input[data-acc="akshat:clarityos"]'); await snap('access granted');
  await page.click('input[data-perm="member:addTask"]'); await snap('permission changed');
  await page.fill('#inName', 'New Person'); await page.fill('#inJob', 'QA engineer'); await page.click('[data-act="invite"]'); await snap('person invited');

  // 7. Chat, documents, daily log, founder summary, sign-out.
  await nav('chat'); await page.click('.chans button >> nth=1'); await page.fill('#msgIn', 'Transcript message'); await page.click('[data-act="send"]'); await snap('message sent');
  await nav('docs'); await page.click('.docrow >> nth=2'); await snap('doc selected');
  await page.setInputFiles('#upload', { name: 'notes.md', mimeType: 'text/markdown', buffer: Buffer.from('Hello\n\n- one\n- two') }); await snap('doc uploaded');
  await as('aarya'); await nav('log'); await page.click('[data-act="logfill"]'); await snap('log filled from timer');
  await page.click('[data-act="logsubmit"]'); await snap('log submitted');
  await as('viraj'); await nav('founder'); await page.selectOption('#frange', 'today'); await page.click('[data-act="execsum"]'); await snap('executive summary');
  await nav('reports'); await snap('reports after all changes');
  await page.click('[data-act="signout"]'); await snap('signed out');
  await page.click('[data-act="login"][data-id="sumit"]'); await snap('signed in as sumit');

  out.push({ label: 'page errors', errors });
  console.log(JSON.stringify(out, null, 1));
  await browser.close();
})().catch(e => { console.error('TRANSCRIPT FAILED after step "' + last + '": ' + e.message.split('\n').slice(0, 3).join(' ')); process.exit(1); });
