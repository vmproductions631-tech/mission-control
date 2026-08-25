/* VMP Mission Control — frontend. Vanilla JS, no build step. */
'use strict';

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const money = (n) => '$' + Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });

let CONFIG = { groups: [], skills: [] };
const runningBySkill = new Map(); // skillId -> runId
let currentStream = null;         // active EventSource in the drawer
let currentRunId = null;

// ------------------------------------------------------------------- tabs
$$('#tabs .tab').forEach((b) => b.addEventListener('click', () => {
  $$('#tabs .tab').forEach((x) => x.classList.toggle('active', x === b));
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + b.dataset.tab));
  if (b.dataset.tab === 'log') renderLog();
  if (b.dataset.tab === 'dashboard') loadDashboard();
}));

// ------------------------------------------------------------- transcript
// Renders one stream-json event into a container. Used live + in the log.
function renderEvent(container, raw) {
  let e;
  try { e = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return; }
  const div = document.createElement('div');

  if (e.type === 'system' && e.subtype === 'init') {
    div.className = 'tr-sys';
    div.textContent = `session started · model ${e.model || '?'} · ${(e.tools || []).length} tools`;
  } else if (e.type === 'assistant' && e.message && Array.isArray(e.message.content)) {
    for (const block of e.message.content) {
      if (block.type === 'text' && block.text && block.text.trim()) {
        const t = document.createElement('div');
        t.className = 'tr-text';
        t.textContent = block.text;
        div.appendChild(t);
      } else if (block.type === 'tool_use') {
        const t = document.createElement('div');
        t.className = 'tr-tool';
        let inp = '';
        try { inp = JSON.stringify(block.input); } catch {}
        if (inp.length > 140) inp = inp.slice(0, 140) + '…';
        t.textContent = `▸ ${block.name}  ${inp}`;
        div.appendChild(t);
      }
    }
    if (!div.childNodes.length) return;
  } else if (e.type === 'user' && e.message && Array.isArray(e.message.content)) {
    for (const block of e.message.content) {
      if (block.type === 'tool_result') {
        let txt = '';
        if (typeof block.content === 'string') txt = block.content;
        else if (Array.isArray(block.content)) {
          txt = block.content.map((c) => (c && c.type === 'text' ? c.text : '')).join('\n');
        }
        const det = document.createElement('details');
        det.className = 'tr-result-toggle';
        const sum = document.createElement('summary');
        sum.textContent = (block.is_error ? '✗ tool error' : '✓ tool result') + ` (${txt.length} chars)`;
        det.appendChild(sum);
        const pre = document.createElement('pre');
        pre.textContent = txt.slice(0, 4000) + (txt.length > 4000 ? '\n… (truncated)' : '');
        det.appendChild(pre);
        div.appendChild(det);
      }
    }
    if (!div.childNodes.length) return;
  } else if (e.type === 'result') {
    div.className = 'tr-done';
    const cost = e.total_cost_usd != null ? ` · $${e.total_cost_usd.toFixed(2)}` : '';
    const dur = e.duration_ms != null ? ` · ${(e.duration_ms / 1000).toFixed(0)}s` : '';
    div.textContent = (e.is_error ? 'FAILED' : 'Done') + ` · ${e.num_turns || '?'} turns${dur}${cost}`;
  } else if (e.type === 'app_error') {
    div.className = 'tr-err';
    div.textContent = 'App error: ' + (e.error || 'unknown');
  } else {
    return; // ignore other event types
  }
  container.appendChild(div);
}

// ---------------------------------------------------------------- drawer
function openDrawer(title, runId) {
  currentRunId = runId;
  $('#drawer-title').textContent = title;
  setDrawerStatus('running');
  $('#drawer-body').innerHTML = '';
  $('#drawer').classList.remove('hidden');
  $('#drawer-stop').classList.remove('hidden');

  if (currentStream) currentStream.close();
  const es = new EventSource('/api/stream/' + runId);
  currentStream = es;
  const body = $('#drawer-body');
  es.onmessage = (msg) => {
    let e = null;
    try { e = JSON.parse(msg.data); } catch {}
    if (e && e.type === 'app_done') {
      setDrawerStatus(e.meta.status);
      $('#drawer-stop').classList.add('hidden');
      finishSkillRun(e.meta);
      es.close();
      return;
    }
    const stick = body.scrollHeight - body.scrollTop - body.clientHeight < 60;
    renderEvent(body, msg.data);
    if (stick) body.scrollTop = body.scrollHeight;
  };
  es.onerror = () => { /* server closes stream at run end; ignore */ };
}
function setDrawerStatus(s) {
  const el = $('#drawer-status');
  el.textContent = s;
  el.className = 'pill ' + s;
}
$('#drawer-close').addEventListener('click', () => {
  $('#drawer').classList.add('hidden');
  if (currentStream) { currentStream.close(); currentStream = null; }
});
$('#drawer-stop').addEventListener('click', async () => {
  if (!currentRunId) return;
  await fetch('/api/stop/' + currentRunId, { method: 'POST' });
});

// ---------------------------------------------------------------- skills
async function loadConfig() {
  CONFIG = await (await fetch('/api/config')).json();
  renderSkills();
}

function renderSkills() {
  const root = $('#skills-root');
  root.innerHTML = '';
  for (const group of CONFIG.groups) {
    const skills = CONFIG.skills.filter((s) => s.group === group);
    if (!skills.length) continue;
    const sec = document.createElement('div');
    sec.className = 'skill-group';
    sec.innerHTML = `<h2>${esc(group)}</h2>`;
    const grid = document.createElement('div');
    grid.className = 'skill-grid';
    for (const s of skills) grid.appendChild(skillCard(s));
    sec.appendChild(grid);
    root.appendChild(sec);
  }
}

function skillCard(s) {
  const card = document.createElement('div');
  card.className = 'skill-card';
  card.dataset.skill = s.id;
  card.innerHTML = `
    <div class="top"><h4>${esc(s.label)}</h4><span class="pill hidden" data-role="status"></span></div>
    <p>${esc(s.description || '')}</p>
    ${s.input ? `<input type="text" placeholder="${esc(s.input.placeholder || '')}" aria-label="${esc(s.input.label || 'Input')}">` : ''}
    <div class="skill-actions">
      <button class="btn gold" data-role="run">Run</button>
      <button class="btn small hidden" data-role="view">View output</button>
    </div>`;
  const runBtn = $('[data-role=run]', card);
  runBtn.addEventListener('click', () => startSkill(s, card));
  $('[data-role=view]', card).addEventListener('click', () => {
    const runId = runningBySkill.get(s.id) || card.dataset.lastRun;
    if (runId) openDrawer(s.label, runId);
  });
  return card;
}

async function startSkill(s, card) {
  const inputEl = $('input', card);
  const input = inputEl ? inputEl.value.trim() : '';
  if (s.input && s.input.required && !input) {
    inputEl.focus();
    inputEl.style.borderColor = 'var(--error)';
    setTimeout(() => (inputEl.style.borderColor = ''), 1500);
    return;
  }
  const runBtn = $('[data-role=run]', card);
  runBtn.disabled = true;
  const r = await fetch('/api/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: s.id, input }),
  });
  const data = await r.json();
  if (!r.ok) {
    runBtn.disabled = false;
    alert(data.error || 'Failed to start');
    return;
  }
  runningBySkill.set(s.id, data.runId);
  card.dataset.lastRun = data.runId;
  setCardStatus(card, 'running');
  $('[data-role=view]', card).classList.remove('hidden');
  openDrawer(s.label, data.runId);
}

function setCardStatus(card, status) {
  const pill = $('[data-role=status]', card);
  pill.textContent = status;
  pill.className = 'pill ' + status;
  pill.classList.remove('hidden');
  $('[data-role=run]', card).disabled = status === 'running';
}

function finishSkillRun(meta) {
  runningBySkill.delete(meta.skillId);
  const card = $(`.skill-card[data-skill="${meta.skillId}"]`);
  if (card) setCardStatus(card, meta.status);
  // report runs refresh the dashboard
  if (meta.skillId === 'daily-report' && meta.status === 'succeeded') loadDashboard();
  const refreshBtn = $('#btn-refresh-report');
  if (meta.skillId === 'daily-report') { refreshBtn.disabled = false; refreshBtn.textContent = 'Refresh Report'; }
}

// -------------------------------------------------------------- dashboard
$('#btn-refresh-report').addEventListener('click', async () => {
  const btn = $('#btn-refresh-report');
  btn.disabled = true;
  btn.textContent = 'Refreshing…';
  const r = await fetch('/api/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'daily-report', input: '' }),
  });
  const data = await r.json();
  if (!r.ok) { btn.disabled = false; btn.textContent = 'Refresh Report'; alert(data.error || 'failed'); return; }
  openDrawer('Refresh Daily Report', data.runId);
});

async function loadDashboard() {
  const [report, sessions, autos, runsData] = await Promise.all([
    fetch('/api/report').then((r) => r.json()),
    fetch('/api/sessions').then((r) => r.json()),
    fetch('/api/automations').then((r) => r.json()),
    fetch('/api/runs').then((r) => r.json()),
  ]);
  renderReport(report);
  renderSessions(sessions);
  renderOvernight(runsData.runs || []);
  renderAutomations(autos.automations || []);
}

function renderReport(rpt) {
  const emptyCard = $('#report-empty');
  const grid = $('#report-grid');
  if (rpt.empty) {
    emptyCard.classList.remove('hidden');
    grid.classList.add('hidden');
    $('#report-updated').textContent = '';
    return;
  }
  emptyCard.classList.add('hidden');
  grid.classList.remove('hidden');
  $('#report-updated').textContent = rpt.generatedAt
    ? 'Updated ' + new Date(rpt.generatedAt).toLocaleString() : '';

  const set = (id, html) => { $(`#${id} .card-body`).innerHTML = html; };

  const cal = (rpt.todayCalendar || []);
  set('card-today', cal.length
    ? `<ul>${cal.map((c) => `<li><span class="money">${esc(c.time)}</span> — ${esc(c.title)}</li>`).join('')}</ul>`
    : '<span class="muted">No shoots on the Production Days calendar today.</span>');

  const t = rpt.openTasks || {};
  set('card-tasks', `
    <div class="stat-row">
      <div class="stat"><span class="big bad">${t.high ?? '–'}</span><span class="muted">high</span></div>
      <div class="stat"><span class="big">${t.medium ?? '–'}</span><span class="muted">medium</span></div>
      <div class="stat"><span class="big">${t.low ?? '–'}</span><span class="muted">low</span></div>
    </div>
    <ul>${(t.top || []).map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`);

  const yc = rpt.yesterdayCompleted || [];
  set('card-yesterday', yc.length
    ? `<ul>${yc.map((x) => `<li>✓ ${esc(x)}</li>`).join('')}</ul>`
    : '<span class="muted">Nothing marked complete in the last 2 days.</span>');

  const pl = rpt.pipeline || {};
  set('card-pipeline', `
    <div class="stat-row">
      <div class="stat"><span class="big money">${money(pl.openValue)}</span><span class="muted">open</span></div>
      <div class="stat"><span class="big good">${money(pl.wonThisMonth)}</span><span class="muted">won this month</span></div>
    </div>
    <ul>${(pl.stages || []).filter((s) => s.count).map((s) =>
      `<li>${esc(s.name)} — ${s.count} · ${money(s.value)}</li>`).join('')}</ul>`);

  const inv = rpt.invoices || {};
  set('card-invoices', `
    <div class="stat-row">
      <div class="stat"><span class="big ${inv.overdueCount ? 'bad' : 'good'}">${inv.overdueCount ?? '–'}</span><span class="muted">overdue</span></div>
      <div class="stat"><span class="big">${money(inv.overdueTotal)}</span><span class="muted">outstanding</span></div>
    </div>
    <ul>${(inv.items || []).map((i) =>
      `<li>${esc(i.who)} — <span class="money">${money(i.amount)}</span> · ${i.daysOverdue}d overdue</li>`).join('')}</ul>`);

  const so = rpt.social || {};
  set('card-social', so && so.igFollowers != null ? `
    <div class="stat-row">
      <div class="stat"><span class="big">${Number(so.igFollowers).toLocaleString()}</span><span class="muted">followers</span></div>
      <div class="stat"><span class="big">${so.posts30d ?? '–'}</span><span class="muted">posts / 30d</span></div>
    </div>
    ${so.top ? `<div class="muted">Top: “${esc(so.top.caption)}” — ${esc(so.top.stat)}</div>` : ''}`
    : '<span class="muted">No Instagram data in this report.</span>');

  const notes = rpt.notes || [];
  set('card-notes', notes.length
    ? `<ul>${notes.map((n) => `<li>⚑ ${esc(n)}</li>`).join('')}</ul>`
    : '<span class="muted">No flags.</span>');
}

function renderSessions(s) {
  const max = Math.max(1, ...s.days.map((d) => d.count));
  const bars = s.days.map((d) => {
    const isToday = d.date === new Date().toISOString().slice(0, 10);
    return `<div class="bar${isToday ? ' today' : ''}" style="height:${Math.round((d.count / max) * 100)}%"><span>${d.count || ''}</span></div>`;
  }).join('');
  const labels = s.days.map((d) =>
    `<div>${new Date(d.date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short' })}</div>`).join('');
  $('#card-sessions .card-body').innerHTML = `
    <div class="stat-row"><div class="stat"><span class="big">${s.total}</span><span class="muted">Claude Code sessions</span></div></div>
    <div class="bars">${bars}</div><div class="bar-labels">${labels}</div>`;
}

function renderOvernight(runs) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 1);
  cutoff.setHours(20, 0, 0, 0); // 8 PM yesterday
  const overnight = runs.filter((r) => new Date(r.startedAt) >= cutoff);
  $('#card-overnight .card-body').innerHTML = overnight.length
    ? `<ul>${overnight.slice(0, 8).map((r) => `
        <li><span class="pill ${r.status}">${r.status}</span> ${esc(r.label)}
        <span class="muted">${new Date(r.startedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span></li>`).join('')}</ul>`
    : '<span class="muted">No Mission Control runs since 8 PM yesterday.</span>';
}

function renderAutomations(autos) {
  $('#card-automations .card-body').innerHTML = `
    <table class="plain"><tr><th>Automation</th><th>Schedule</th><th>Where</th><th>What it does</th></tr>
    ${autos.map((a) => `<tr><td><strong>${esc(a.name)}</strong></td><td>${esc(a.schedule)}</td><td>${esc(a.where)}</td><td class="muted">${esc(a.what)}</td></tr>`).join('')}
    </table>`;
}

// -------------------------------------------------------------------- log
async function renderLog() {
  const { runs } = await (await fetch('/api/runs')).json();
  const root = $('#log-root');
  root.innerHTML = runs.length ? '' : '<div class="card empty">No runs yet.</div>';
  for (const r of runs) {
    const row = document.createElement('div');
    row.className = 'run-row';
    const dur = r.durationMs ? `${Math.round(r.durationMs / 1000)}s` : '';
    const cost = r.costUsd != null ? `$${r.costUsd.toFixed(2)}` : '';
    row.innerHTML = `
      <div class="run-head">
        <span class="when">${new Date(r.startedAt).toLocaleString()}</span>
        <span class="label">${esc(r.label)}</span>
        <span class="pill ${r.status}">${r.status}</span>
        <span class="cost">${dur}${dur && cost ? ' · ' : ''}${cost}</span>
      </div>
      ${r.input ? `<div class="run-summary">Input: ${esc(r.input)}</div>` : ''}
      ${r.summary ? `<div class="run-summary">${esc(r.summary)}</div>` : ''}
      ${r.error ? `<div class="run-summary tr-err">${esc(r.error)}</div>` : ''}
      <div class="run-detail"></div>`;
    $('.run-head', row).addEventListener('click', async () => {
      const open = row.classList.toggle('open');
      const det = $('.run-detail', row);
      if (open && !det.dataset.loaded) {
        det.dataset.loaded = '1';
        det.innerHTML = '<span class="muted">Loading transcript…</span>';
        const full = await (await fetch('/api/runs/' + r.runId)).json();
        det.innerHTML = '';
        for (const line of full.events || []) renderEvent(det, line);
        if (!det.childNodes.length) det.innerHTML = '<span class="muted">No transcript.</span>';
      }
    });
    root.appendChild(row);
  }
}

// -------------------------------------------------------------------- init
loadConfig();
loadDashboard();
