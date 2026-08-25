/*
 * Mission Control — zero-dependency local server.
 * Serves the UI, runs Claude Code headless, streams output via SSE,
 * and persists every run to runs/<id>/.
 *
 * Node built-ins only. Start:  node server.js [--open]
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const os = require('os');

const ROOT = __dirname;

/*
 * Config resolution, most specific first:
 *   environment variable  ->  config.json  ->  config.example.json  ->  built-in default
 *
 * config.json is gitignored so a clone gets working defaults without carrying
 * anyone's machine paths. Every value has a cross-platform fallback: the Claude
 * Code binary is looked up on PATH, the working directory defaults to the repo
 * itself, and the transcript directory defaults to ~/.claude/projects.
 */
function readJsonIfPresent(file) {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));
  } catch {
    return {};
  }
}

const FILE_CONFIG = { ...readJsonIfPresent('config.example.json'), ...readJsonIfPresent('config.json') };

const CONFIG = {
  ...FILE_CONFIG,
  port: Number(process.env.MC_PORT) || FILE_CONFIG.port || 4173,
  // 'claude' resolves via PATH on macOS/Linux and via PATHEXT on Windows.
  claudeExe: process.env.MC_CLAUDE_EXE || FILE_CONFIG.claudeExe || 'claude',
  defaultCwd: process.env.MC_DEFAULT_CWD || FILE_CONFIG.defaultCwd || ROOT,
  claudeProjectsDir:
    process.env.MC_CLAUDE_PROJECTS_DIR ||
    FILE_CONFIG.claudeProjectsDir ||
    path.join(os.homedir(), '.claude', 'projects'),
};
const RUNS_DIR = path.join(ROOT, 'runs');
const DATA_DIR = path.join(ROOT, 'data');
const PUBLIC_DIR = path.join(ROOT, 'public');
for (const d of [RUNS_DIR, DATA_DIR]) fs.mkdirSync(d, { recursive: true });

// skills.json is re-read on every request so edits go live without a restart.
function loadSkills() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'skills.json'), 'utf8'));
}

// ---------------------------------------------------------------- run engine

/** runId -> { events: string[], listeners: Set<res>, child, meta, dir, stderr, finished } */
const active = new Map();

function newRunId(skillId) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `${stamp}_${skillId}_${Math.random().toString(36).slice(2, 6)}`;
}

function skillIsRunning(skillId) {
  for (const rec of active.values()) {
    if (rec.meta.skillId === skillId && !rec.finished) return true;
  }
  return false;
}

function startRun(skill, input) {
  const runId = newRunId(skill.id);
  const dir = path.join(RUNS_DIR, runId);
  fs.mkdirSync(dir, { recursive: true });

  const prompt = String(skill.prompt || '').split('{input}').join(input || '');
  const allowed = [...new Set([...(CONFIG.defaultAllowedTools || []), ...(skill.allowedTools || [])])];
  const denied = CONFIG.disallowedTools || [];

  const args = ['-p', '--output-format', 'stream-json', '--verbose'];
  if (allowed.length) args.push('--allowedTools', ...allowed);
  if (denied.length) args.push('--disallowedTools', ...denied);
  if (skill.model) args.push('--model', skill.model);
  args.push('--max-turns', String(skill.maxTurns || CONFIG.defaultMaxTurns || 40));

  const meta = {
    runId,
    skillId: skill.id,
    label: skill.label,
    input: input || '',
    startedAt: new Date().toISOString(),
    status: 'running',
    cwd: skill.cwd || CONFIG.defaultCwd,
  };
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));

  const child = spawn(CONFIG.claudeExe, args, {
    cwd: meta.cwd,
    env: process.env,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const rec = { events: [], listeners: new Set(), child, meta, dir, stderr: '', finished: false };
  active.set(runId, rec);

  child.stdin.write(prompt);
  child.stdin.end();

  let buf = '';
  child.stdout.setEncoding('utf8'); // StringDecoder handles multibyte chars split across chunks
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) pushEvent(rec, line);
    }
  });
  child.stderr.on('data', (d) => { rec.stderr += d; });
  child.on('error', (err) => {
    pushEvent(rec, JSON.stringify({ type: 'app_error', error: String(err) }));
    finishRun(rec, -1);
  });
  child.on('close', (code) => finishRun(rec, code));

  return meta;
}

function pushEvent(rec, line) {
  rec.events.push(line);
  try { fs.appendFileSync(path.join(rec.dir, 'transcript.ndjson'), line + '\n'); } catch {}
  for (const res of rec.listeners) res.write(`data: ${line}\n\n`);
}

function finishRun(rec, exitCode) {
  if (rec.finished) return;
  rec.finished = true;

  let result = null;
  for (let i = rec.events.length - 1; i >= 0; i--) {
    try {
      const e = JSON.parse(rec.events[i]);
      if (e.type === 'result') { result = e; break; }
    } catch {}
  }

  const m = rec.meta;
  m.endedAt = new Date().toISOString();
  m.exitCode = exitCode;
  m.status = exitCode === 0 && result && !result.is_error ? 'succeeded' : 'failed';
  if (result) {
    m.costUsd = result.total_cost_usd;
    m.durationMs = result.duration_ms;
    m.numTurns = result.num_turns;
    m.summary = (typeof result.result === 'string' ? result.result : '').slice(0, 500);
  }
  if (m.status === 'failed' && rec.stderr) m.error = rec.stderr.slice(0, 2000);

  // "report" runs: parse the final message as JSON and save it for the dashboard.
  const skill = loadSkills().skills.find((s) => s.id === m.skillId);
  if (skill && skill.kind === 'report' && m.status === 'succeeded' && typeof result.result === 'string') {
    try {
      let txt = result.result.trim();
      const first = txt.indexOf('{');
      const last = txt.lastIndexOf('}');
      if (first < 0 || last <= first) throw new Error('no JSON object in result');
      const rpt = JSON.parse(txt.slice(first, last + 1));
      rpt.generatedAt = new Date().toISOString();
      fs.writeFileSync(path.join(DATA_DIR, 'report.json'), JSON.stringify(rpt, null, 2));
    } catch (e) {
      m.reportError = 'Report JSON parse failed: ' + e.message;
    }
  }

  fs.writeFileSync(path.join(rec.dir, 'meta.json'), JSON.stringify(m, null, 2));
  const done = JSON.stringify({ type: 'app_done', meta: m });
  for (const res of rec.listeners) { res.write(`data: ${done}\n\n`); res.end(); }
  rec.listeners.clear();
  setTimeout(() => active.delete(m.runId), 10 * 60 * 1000).unref();
}

function stopRun(runId) {
  const rec = active.get(runId);
  if (!rec || rec.finished) return false;
  // Kill the whole tree — claude spawns MCP server children.
  spawn('taskkill', ['/pid', String(rec.child.pid), '/t', '/f'], { windowsHide: true });
  return true;
}

// ------------------------------------------------------------ local data APIs

function listRuns(limit = 200) {
  let dirs = [];
  try { dirs = fs.readdirSync(RUNS_DIR); } catch {}
  const runs = [];
  for (const d of dirs) {
    try {
      runs.push(JSON.parse(fs.readFileSync(path.join(RUNS_DIR, d, 'meta.json'), 'utf8')));
    } catch {}
  }
  runs.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
  return runs.slice(0, limit);
}

function getRun(runId) {
  // Guard against path traversal — runId must be a plain directory name.
  if (!/^[\w\-]+$/.test(runId)) return null;
  const dir = path.join(RUNS_DIR, runId);
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
    let events = [];
    try {
      events = fs.readFileSync(path.join(dir, 'transcript.ndjson'), 'utf8')
        .split('\n').filter(Boolean);
    } catch {}
    return { meta, events };
  } catch {
    return null;
  }
}

function sessionsThisWeek() {
  const out = { days: [], recent: [], total: 0 };
  const now = Date.now();
  const weekAgo = now - 7 * 86400e3;
  const byDay = new Map();
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now - i * 86400e3);
    byDay.set(d.toISOString().slice(0, 10), 0);
  }
  let projects = [];
  try { projects = fs.readdirSync(CONFIG.claudeProjectsDir); } catch {}
  for (const p of projects) {
    let files = [];
    const pdir = path.join(CONFIG.claudeProjectsDir, p);
    try { files = fs.readdirSync(pdir).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
    for (const f of files) {
      let st;
      try { st = fs.statSync(path.join(pdir, f)); } catch { continue; }
      if (st.mtimeMs < weekAgo) continue;
      out.total++;
      const day = new Date(st.mtimeMs).toISOString().slice(0, 10);
      if (byDay.has(day)) byDay.set(day, byDay.get(day) + 1);
      out.recent.push({
        project: p.replace(/^C--Users-User-?/, '').replace(/-/g, ' ').trim() || 'home',
        when: st.mtime.toISOString(),
        sizeKb: Math.round(st.size / 1024),
      });
    }
  }
  out.recent.sort((a, b) => (a.when < b.when ? 1 : -1));
  out.recent = out.recent.slice(0, 12);
  out.days = [...byDay.entries()].map(([date, count]) => ({ date, count }));
  return out;
}

// --------------------------------------------------------------- http server

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
};

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  try {
    // ---- API
    if (p === '/api/config') {
      const s = loadSkills();
      return json(res, 200, { groups: s.groups, skills: s.skills, defaultCwd: CONFIG.defaultCwd });
    }
    if (p === '/api/run' && req.method === 'POST') {
      const body = await readBody(req);
      const skill = loadSkills().skills.find((s) => s.id === body.id);
      if (!skill) return json(res, 404, { error: 'unknown skill id' });
      if (skill.input && skill.input.required && !String(body.input || '').trim()) {
        return json(res, 400, { error: 'input required' });
      }
      if (skillIsRunning(skill.id)) return json(res, 409, { error: 'already running' });
      const meta = startRun(skill, String(body.input || '').trim());
      return json(res, 200, { runId: meta.runId });
    }
    if (p.startsWith('/api/stop/') && req.method === 'POST') {
      return json(res, 200, { stopped: stopRun(p.slice('/api/stop/'.length)) });
    }
    if (p.startsWith('/api/stream/')) {
      const runId = p.slice('/api/stream/'.length);
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      const rec = active.get(runId);
      if (rec) {
        for (const line of rec.events) res.write(`data: ${line}\n\n`);
        if (rec.finished) {
          res.write(`data: ${JSON.stringify({ type: 'app_done', meta: rec.meta })}\n\n`);
          return res.end();
        }
        rec.listeners.add(res);
        const ping = setInterval(() => res.write(': ping\n\n'), 15000);
        req.on('close', () => { clearInterval(ping); rec.listeners.delete(res); });
        return;
      }
      // Finished run served from disk.
      const stored = getRun(runId);
      if (stored) {
        for (const line of stored.events) res.write(`data: ${line}\n\n`);
        res.write(`data: ${JSON.stringify({ type: 'app_done', meta: stored.meta })}\n\n`);
      } else {
        res.write(`data: ${JSON.stringify({ type: 'app_error', error: 'run not found' })}\n\n`);
      }
      return res.end();
    }
    if (p === '/api/runs') return json(res, 200, { runs: listRuns() });
    if (p.startsWith('/api/runs/')) {
      const r = getRun(p.slice('/api/runs/'.length));
      return r ? json(res, 200, r) : json(res, 404, { error: 'not found' });
    }
    if (p === '/api/report') {
      // Fall back to the checked-in sample so a fresh clone renders something
      // before the first real report run.
      for (const f of ['report.json', 'report.example.json']) {
        try {
          return json(res, 200, JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8')));
        } catch { /* try the next candidate */ }
      }
      return json(res, 200, { empty: true });
    }
    if (p === '/api/sessions') return json(res, 200, sessionsThisWeek());
    if (p === '/api/automations') {
      try {
        return json(res, 200, JSON.parse(fs.readFileSync(path.join(ROOT, 'automations.json'), 'utf8')));
      } catch {
        return json(res, 200, { automations: [] });
      }
    }

    // ---- static files
    let file = p === '/' ? '/index.html' : p;
    file = path.normalize(file).replace(/^([.][.][\\/])+/, '');
    const full = path.join(PUBLIC_DIR, file);
    if (!full.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
    fs.readFile(full, (err, data) => {
      if (err) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
      res.end(data);
    });
  } catch (e) {
    json(res, 500, { error: String(e && e.message || e) });
  }
});

const PORT = CONFIG.port || 4173;
const wantsOpen = process.argv.includes('--open');

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`Mission Control is already running on port ${PORT}.`);
    if (wantsOpen) spawn('cmd', ['/c', 'start', '', `http://localhost:${PORT}`], { windowsHide: true });
    process.exit(0);
  }
  throw err;
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`VMP Mission Control → http://localhost:${PORT}`);
  if (wantsOpen) spawn('cmd', ['/c', 'start', '', `http://localhost:${PORT}`], { windowsHide: true });
});
