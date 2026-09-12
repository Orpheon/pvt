// Headless-Chrome test for the PVT app. Usage: node test/run.mjs [outdir]
// Serves the app folder, runs a shortened test with simulated taps, seeds edge-case histories,
// asserts on rendered charts/deltas, and writes screenshots to outdir.
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.argv[2] || join(ROOT, 'test', 'out');
mkdirSync(OUT, { recursive: true });
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };
const server = createServer(async (req, res) => {
  const p = req.url.split('?')[0] === '/' ? '/index.html' : req.url.split('?')[0];
  try { res.writeHead(200, { 'content-type': MIME[extname(p)] || 'application/octet-stream' }); res.end(await readFile(join(ROOT, p))); }
  catch { res.writeHead(404); res.end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const URL_ = `http://127.0.0.1:${server.address().port}/index.html`;
const profile = join(OUT, 'chrome-profile');
const PORT = 9400 + Math.floor(Math.random() * 500);
import { rmSync } from 'node:fs';
for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) { try { rmSync(join(profile, f), { force: true }); } catch {} }
const chrome = spawn(process.env.CHROME || 'google-chrome', ['--headless=new', '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`, '--window-size=412,915', '--force-dark-mode', 'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let ws, id = 0; const pending = new Map(); const errors = [];
for (let i = 0; i < 120; i++) { try { const l = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); ws = new WebSocket(l[0].webSocketDebuggerUrl); break; } catch { await sleep(250); } }
if (!ws) { chrome.kill(); throw new Error('could not connect to Chrome on port ' + PORT); }
await new Promise(r => ws.onopen = r);
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || 'exception');
  if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') errors.push(m.params.entry.text); };
const send = (method, params = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const js = async expr => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'eval error'); return r.result.result.value; };
const shot = async (name, h = 1300) => { const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: 412, height: h, scale: 1 } }); writeFileSync(join(OUT, name + '.png'), Buffer.from(r.result.data, 'base64')); };
let failures = 0; const check = (ok, msg) => { console.log((ok ? '  ok   ' : '  FAIL ') + msg); if (!ok) failures++; };

await send('Emulation.setDeviceMetricsOverride', { width: 412, height: 915, deviceScaleFactor: 2, mobile: true });
await send('Emulation.setTouchEmulationEnabled', { enabled: true });
await send('Network.enable'); await send('Network.setBypassServiceWorker', { bypass: true });
await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable');
const load = async () => { await send('Page.navigate', { url: URL_ }); for (let i = 0; i < 100; i++) { await sleep(100); if (await js('document.readyState') === 'complete' && await js('typeof settings') === 'object') return; } console.log('load debug:', await js('document.readyState'), await js('typeof settings'), await js('document.title'), JSON.stringify(errors)); throw new Error('page did not load'); };
await load();
await js(`localStorage.clear(); location.reload()`); await sleep(300); await load();

// ---------- 1. functional run ----------
console.log('1. shortened test run');
await js(`settings.duration = 30; startTest(); 'ok'`); await sleep(200);
const tap = () => js(`testEl.dispatchEvent(new PointerEvent('pointerdown', {bubbles:true, pointerType:'touch', isPrimary:true, clientX:200, clientY:500})); 1`);
await tap(); await sleep(1700);
let fsDone = false; const t0 = Date.now();
while (Date.now() - t0 < 40000) {
  const s = JSON.parse(await js(`JSON.stringify({state: test.state, onset: test.onset !== null, armed: test.armed})`));
  if (s.state !== 'running') break;
  if (s.onset) { await sleep(150 + Math.random() * 300); await tap(); } else if (s.armed && !fsDone) { fsDone = true; await tap(); }
  await sleep(40);
}
await sleep(400);
const run = JSON.parse(await js(`JSON.stringify(sessions.map(s => ({trials:s.trials, fs:s.falseStarts, lapses:s.lapses, speed:s.speed, score:scoreOf(s), raw:s.raw.length})))`));
check(run.length === 1 && run[0].trials >= 3, `session saved with ${run[0]?.trials} trials`);
check(run[0]?.fs === 1, 'deliberate false start recorded');
check(run[0]?.raw === run[0]?.trials + run[0]?.fs, 'raw trial count = trials + false starts');
check(Math.abs(run[0].score - 100 * (1 - (run[0].lapses + run[0].fs) / (run[0].trials + run[0].fs))) < 1e-9, 'score formula');
check(await js(`document.querySelector('.screen.active').id`) === 'result', 'result screen shown');
await shot('1-result', 915);

// ---------- helpers for seeding ----------
const seed = async (spec) => js(`(() => { const out = ${JSON.stringify(spec)}.map((o, i) => { const trials = []; for (let k = 0; k < o.n; k++) trials.push({onset: k*3500, rt: o.rt, type: o.rt >= 355 ? 'lapse' : 'ok'}); for (let k = 0; k < o.lapses; k++) trials[k].rt = 420, trials[k].type = 'lapse'; for (let k = 0; k < o.fs; k++) trials.push({onset: 1, rt: null, type: 'fs'});
  const m = computeMetrics(trials); return { id: 'seed' + i, ts: o.ts, duration: 180, isi: [1000,4000], feedback: 1, version: VERSION, ...m, sleepHours: null, note: o.note || '', raw: trials }; });
  sessions = out.sort((a,b) => a.ts - b.ts); saveSessions(sessions); history.replaceState(null, ''); location.reload(); return out.length; })()`);
const inspect = async () => JSON.parse(await js(`JSON.stringify({
  ticks: [...document.querySelectorAll('#charts .chart')].map(c => [...c.querySelectorAll('.grid text')].map(t => t.textContent)),
  titles: [...document.querySelectorAll('#charts .chart .title span:first-child')].map(t => t.textContent),
  xlabels: [...document.querySelectorAll('#charts .chart')].map(c => [...c.querySelectorAll('svg > text')].map(t => t.textContent)),
  deltas: [...document.querySelectorAll('#hero .delta')].map(d => [d.textContent, d.className]),
  hero: [...document.querySelectorAll('#hero .value')].map(d => d.textContent),
  npts: [...document.querySelectorAll('#charts .chart')].map(c => c.querySelectorAll('.pt').length),
  rows: document.querySelectorAll('#table tr').length - 1 })`));
const H = 3600000, D = 86400000, now = Date.now();

// ---------- 2. four sessions in one day, sub-percent differences ----------
console.log('2. four sessions within one day, tiny differences');
await seed([
  { ts: now - 20 * H, n: 45, rt: 262, lapses: 1, fs: 0 },   // 97.78 %
  { ts: now - 14 * H, n: 46, rt: 261, lapses: 1, fs: 0 },   // 97.83 %
  { ts: now - 8 * H,  n: 45, rt: 263, lapses: 1, fs: 0 },   // 97.78 %
  { ts: now - 1 * H,  n: 44, rt: 262, lapses: 1, fs: 0 },   // 97.73 %
]); await sleep(300); await load();
let r = await inspect();
r.ticks.forEach((t, i) => { check(new Set(t).size === t.length && t.length >= 3, `chart ${i + 1} (${r.titles[i].split(',')[0]}) y labels distinct: ${t.join(' ')}`); });
check(r.deltas.every(d => /vs last 3$/.test(d[0])), `delta references 3 prior sessions: ${r.deltas.map(d => d[0]).join(' | ')}`);
check(r.deltas.every(d => !/good|bad/.test(d[1])), 'sub-resolution deltas are not coloured');
const span = t => Math.max(...t.map(Number)) - Math.min(...t.map(Number));
check(span(r.ticks[0]) >= 0.6 && span(r.ticks[1]) >= 10 && span(r.ticks[3]) >= 120, `axes keep minimum span: ${r.ticks.map(span).join(' ')}`);
check(r.npts.every(n => n === 4), 'all four points drawn in every chart');
check(r.xlabels.every(x => new Set(x).size === x.length), `x labels distinct: ${r.xlabels[0].join(' ')}`);
await shot('2-oneday');

// ---------- 3. two sessions, identical ----------
console.log('3. two identical sessions');
await seed([{ ts: now - D, n: 45, rt: 260, lapses: 0, fs: 0 }, { ts: now - H, n: 45, rt: 260, lapses: 0, fs: 0 }]); await sleep(300); await load();
r = await inspect();
check(r.deltas.every(d => d[0].startsWith('±') && d[0].endsWith('vs previous') && !/good|bad/.test(d[1])), `zero delta neutral: ${r.deltas.map(d => d[0]).join(' | ')}`);
check(r.hero[1] === '100.0%', `score pinned at 100 renders: ${r.hero[1]}`);
r.ticks.forEach((t, i) => check(new Set(t).size === t.length && t.length >= 2, `chart ${i + 1} y labels: ${t.join(' ')}`));
check(r.ticks[1].every(v => +v <= 100), 'score axis capped at 100');
await shot('3-identical');

// ---------- 4. thirty days, near-identical values ----------
console.log('4. thirty days, near-identical values');
await seed(Array.from({ length: 30 }, (_, i) => ({ ts: now - (30 - i) * D + 7 * H, n: 45 + (i % 3), rt: 258 + (i % 5), lapses: i % 4 === 0 ? 1 : 0, fs: i % 7 === 0 ? 1 : 0 }))); await sleep(300); await load();
r = await inspect();
r.ticks.forEach((t, i) => check(new Set(t).size === t.length && t.length >= 3, `chart ${i + 1} y labels: ${t.join(' ')}`));
check(r.deltas.every(d => /vs last 7$/.test(d[0])), `delta references last 7: ${r.deltas.map(d => d[0]).join(' | ')}`);
check(r.rows === 30, `table rows: ${r.rows}`);
await shot('4-month');

// ---------- 5. single session ----------
console.log('5. single session');
await seed([{ ts: now - H, n: 45, rt: 260, lapses: 2, fs: 1 }]); await sleep(300); await load();
r = await inspect();
check(r.deltas.length === 0, 'no delta with a single session');
check(r.npts.every(n => n === 1), 'one point per chart');
await shot('5-single');

// ---------- 6. gaps: positioned by time, trend line broken across long gaps ----------
console.log('6. missing days: x by time, trend broken across a long gap');
await seed([
  { ts: now - 40 * D, n: 45, rt: 260, lapses: 0, fs: 0 }, { ts: now - 39 * D, n: 45, rt: 262, lapses: 0, fs: 0 },
  { ts: now - 20 * D, n: 45, rt: 265, lapses: 1, fs: 0 },
  { ts: now - 3 * D, n: 45, rt: 258, lapses: 0, fs: 0 }, { ts: now - 2 * D, n: 45, rt: 259, lapses: 0, fs: 1 }, { ts: now - 1 * D, n: 45, rt: 261, lapses: 0, fs: 0 },
]); await sleep(300); await load();
{
  const cx = JSON.parse(await js(`JSON.stringify([...document.querySelectorAll('#charts .chart:first-child .pt')].map(c => +c.getAttribute('cx')))`));
  const ratio = (cx[2] - cx[0]) / (cx[5] - cx[0]);
  check(Math.abs(ratio - 20 / 39) < 0.01, `x position proportional to time (day 20 of 39 -> ${ratio.toFixed(3)})`);
  check(cx[1] - cx[0] > 0 && (cx[1] - cx[0]) < (cx[2] - cx[1]) / 5, 'adjacent days sit close, the 19-day gap is wide');
  const d = await js(`document.querySelector('#charts .chart:first-child .roll').getAttribute('d')`);
  check((d.match(/M/g) || []).length === 3, `trend line broken into 3 segments across gaps > 14 d (${(d.match(/M/g) || []).length})`);
  const roll = JSON.parse(await js(`JSON.stringify(rollingByTime(sessions, sessions.map(s => s.speed)))`));
  const sp = JSON.parse(await js(`JSON.stringify(sessions.map(s => s.speed))`));
  check(Math.abs(roll[2] - sp[2]) < 1e-9, 'isolated session\'s 7-day mean is itself');
  check(Math.abs(roll[5] - (sp[3] + sp[4] + sp[5]) / 3) < 1e-9, 'latest 7-day mean covers only the last three days');
}
await shot('6-gaps');

// ---------- 7. pause during a run ----------
console.log('7. pause and resume');
await js(`settings.duration = 30; startTest(); 'ok'`); await sleep(200);
await tap(); await sleep(1700);
check(await js(`test.state`) === 'running' && !(await js(`$('pauseBtn').hidden`)), 'pause button visible while running');
await sleep(600);
await js(`$('pauseBtn').click(); 1`); await sleep(100);
check(await js(`test.state`) === 'paused', 'state paused');
const before = await js(`test.trials.length`);
await tap(); await sleep(200);                      // taps while paused must not count
check(await js(`test.trials.length`) === before, 'tap while paused records nothing');
await shot('7-paused', 915);
const endBefore = await js(`test.end`);
await sleep(1500);
await js(`$('pauseBtn').click(); 1`); await sleep(100);
check(await js(`test.state`) === 'running', 'resumed');
check((await js(`test.end`)) - endBefore >= 1400, 'clock extended by the paused interval');
{
  const t1 = Date.now();
  while (Date.now() - t1 < 40000) {
    const st = JSON.parse(await js(`JSON.stringify({state: test.state, onset: test.onset !== null})`));
    if (st.state !== 'running') break;
    if (st.onset) { await sleep(150 + Math.random() * 200); await tap(); }
    await sleep(40);
  }
}
await sleep(400);
const last = JSON.parse(await js(`JSON.stringify(sessions[sessions.length - 1])`));
check(last.pauses === 1 && last.trials >= 2, `session saved with pauses=${last.pauses}, trials=${last.trials}`);
check(await js(`$('resultWhen').textContent`).then(t => /paused 1×/.test(t)), 'result screen notes the pause');
await js(`$('resultDone').click(); 1`); await sleep(300);

// ---------- 8. edit and delete a past session ----------
console.log('8. edit tags/note on a past session, then delete');
await js(`showResult(sessions[0], true); 1`); await sleep(200);
check(await js(`$('resultTitle').textContent`) === 'Edit session', 'edit screen title');
await js(`[...document.querySelectorAll('#tagChips button')].find(b => b.textContent === 'caffeine before').click(); $('tagIn').value = 'Dentist'; $('tagAdd').click(); $('noteIn').value = 'edited later'; $('sleepH').value = '5.5'; $('resultDone').click(); 1`);
await sleep(400); await load();
const edited = JSON.parse(await js(`JSON.stringify(sessions[0])`));
check(edited.note === 'edited later' && edited.sleepHours === 5.5, 'note and hours persisted after reload');
check(JSON.stringify(edited.tags) === JSON.stringify(['caffeine before', 'dentist']), `tags persisted: ${JSON.stringify(edited.tags)}`);
check(await js(`document.querySelector('#table td .note').textContent`).then(t => /dentist/.test(t)), 'tags shown in table');
check(await js(`summaryCsv()`).then(c => c.includes('caffeine before; dentist') && c.split('\n')[0].includes('pauses')), 'CSV has tags and pauses columns');
const nBefore = await js(`sessions.length`);
await js(`window.confirm = () => true; showResult(sessions[0], true); 1`); await sleep(200);
await js(`$('resultDiscard').click(); 1`); await sleep(400); await load();
check(await js(`sessions.length`) === nBefore - 1 && await js(`sessions[0].note`) !== 'edited later', 'session deleted and gone after reload');
await shot('8-after-edit');

// ---------- exports ----------
const csv = await js(`summaryCsv()`); const lines = csv.trim().split('\n'); const ncol = lines[0].split(',').length;
check(lines.length >= 2 && lines.every(l => l.split(',').length === ncol), `summary CSV: ${lines.length - 1} rows, ${ncol} columns aligned`);
check(lines[0].includes('performance_score_pct') && lines[0].includes('response_speed'), 'summary CSV has score and speed');

console.log(`\nconsole errors: ${errors.length}`); errors.forEach(e => console.log('  ' + e));
if (errors.length) failures++;
console.log(failures ? `\n${failures} FAILED` : '\nall passed');
ws.close(); chrome.kill(); server.close();
process.exit(failures ? 1 : 0);
