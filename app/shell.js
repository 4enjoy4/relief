/* FauxCode — shell.js: the interactive terminal, ambient build noise, the hidden
   ambient overlay and the quiet achievement layer. Loaded after workbench.js and
   overrides its session/command functions with richer versions. Everything is
   simulated inside the page: no command ever leaves the browser. */
'use strict';

/* ================= session model ================= */

let jobLock = null;            // { session, epoch, ambient } while an animated JOBLIB job runs
const extraDirs = new Set();   // directories created with mkdir (relative paths)
let commandsRun = 0;
const gitStash = [];

function shellInfo() { return (TOPIC && TOPIC.shell) || { user: 'dev', host: 'workstation', pkg: 'npm' }; }

function sessionName(kind) {
  if (kind === 'watch') return (TOPIC && TOPIC.termproc) || 'bash';
  const n = sessions.filter(s => s.kind === 'bash').length + 1;
  return n === 1 ? 'bash' : 'bash (' + n + ')';
}

makeSession = function (name, kind) {
  if (sessions.length >= 8) { showToast('Close a terminal before opening another (8 active).', 'Terminal'); return currentSession; }
  kind = kind || (sessions.length ? 'bash' : 'watch');
  const s = {
    id: ++terminalSequence, name: name || sessionName(kind), kind, cwd: '', rows: [], history: [], historyIndex: 0,
    epoch: 0, busy: false, draft: '', exitCode: 0, lastExitCode: 0, env: {}, lastActive: 0, aborted: false,
  };
  sessions.push(s);
  selectSession(s.id);
  return s;
};

appendHtml = function (session, html) {
  if (!session || !sessions.includes(session)) return document.createElement('div');
  const row = document.createElement('div');
  row.className = 'tl';
  row.innerHTML = html;
  session.rows.push(row);
  if (session.rows.length > 900) session.rows.shift().remove();
  if (session === currentSession) {
    const atBottom = termEl.scrollHeight - termEl.scrollTop - termEl.clientHeight < 80;
    termEl.appendChild(row);
    if (atBottom) termEl.scrollTop = termEl.scrollHeight;
  }
  return row;
};

append = function (session, text, style) {
  return appendHtml(session, style ? '<span class="' + style + '">' + esc(String(text)) + '</span>' : esc(String(text)));
};

/* engine helpers (JOBLIB, termSaveSequence, progressBar) write through tline: route them to the
   session that owns the running job, otherwise to the dev-server terminal */
tline = function (html) {
  const target = jobLock ? jobLock.session : (sessions[0] || currentSession);
  const row = appendHtml(target, html);
  return row;
};

gs = async function (ms, gen) {
  await sleep(ms);
  if (gen !== topicGen) throw new Error('topic switched');
  if (jobLock && jobLock.session.epoch !== jobLock.epoch) throw new Error('cancelled');
};

selectSession = function (id) {
  if (currentSession) currentSession.draft = $('terminput').value;
  const next = sessions.find(s => s.id === Number(id));
  if (!next) return;
  currentSession = next;
  termEl.replaceChildren(...next.rows);
  $('terminput').value = next.draft || '';
  termEl.scrollTop = termEl.scrollHeight;
  renderTerminalTools();
  updatePrompt();
};

closeSession = function () {
  if (!currentSession) return;
  const dying = currentSession;
  dying.epoch++; dying.busy = false; dying.aborted = true;
  if (jobLock && jobLock.session === dying) jobLock = null;
  sessions = sessions.filter(s => s !== dying);
  currentSession = null;
  if (!sessions.length) makeSession();
  else selectSession(sessions[sessions.length - 1].id);
};

renderTerminalTools = function () {
  $('termlabel').innerHTML =
    '<select id="terminal-select" aria-label="Terminal session">' +
    sessions.map(s => '<option value="' + s.id + '"' + (s === currentSession ? ' selected' : '') + '>' + (s.busy ? '● ' : '') + esc(s.name) + '</option>').join('') +
    '</select>' +
    '<button id="terminal-new" title="New Terminal (Ctrl+Shift+`)" aria-label="New terminal">＋</button>' +
    '<button id="terminal-split" title="Split Terminal" aria-label="Split terminal">⫿</button>' +
    '<button id="terminal-stop" title="Kill running task (Ctrl+C)" aria-label="Stop task">■</button>' +
    '<button id="terminal-close" title="Kill Terminal" aria-label="Close terminal">🗑</button>' +
    '<button id="panel-expand" title="Maximize Panel Size" aria-label="Expand panel">⌃</button>' +
    '<button id="panel-hide" title="Hide Panel (Ctrl+J)" aria-label="Hide panel">✕</button>';
  $('terminal-select').onchange = e => selectSession(e.target.value);
  $('terminal-new').onclick = () => { makeSession(); setPanel('TERMINAL'); $('terminput').focus(); };
  $('terminal-split').onclick = () => { const s = makeSession(); if (s) { append(s, 'split from ' + (sessions[0] ? sessions[0].name : 'bash'), 'dim'); } setPanel('TERMINAL'); $('terminput').focus(); };
  $('terminal-close').onclick = closeSession;
  $('terminal-stop').onclick = cancelCommand;
  $('panel-hide').onclick = () => $('panel').classList.add('hidden');
  $('panel-expand').onclick = () => { $('panel').style.height = $('panel').offsetHeight > innerHeight * .45 ? '230px' : '62vh'; };
};

function promptHtml(session) {
  const sh = shellInfo();
  const cwd = '~/' + TOPIC.project + (session.cwd ? '/' + session.cwd : '');
  return '<span class="ok">' + esc(sh.user + '@' + sh.host) + '</span>:<span class="info">' + esc(cwd) + '</span> <span class="warn">(' + esc(TOPIC.branch) + ')</span>$';
}

updatePrompt = function () {
  if (!currentSession || !TOPIC) return;
  $('termprompt').innerHTML = promptHtml(currentSession);
  $('termbusy').classList.toggle('hidden', !currentSession.busy);
  $('terminput').placeholder = currentSession.busy ? '' : '';
};

cancelCommand = function () {
  const s = currentSession;
  if (!s) return;
  s.epoch++;
  if (jobLock && jobLock.session === s) jobLock = null;
  const wasBusy = s.busy;
  s.busy = false; s.exitCode = 130; s.lastExitCode = 130;
  append(s, '^C', 'dim');
  if (wasBusy && s.kind === 'watch') append(s, 'process terminated. the file watcher will restart on the next change.', 'dim');
  renderTerminalTools();
  updatePrompt();
};

/* ================= virtual file system ================= */

function vpath(input, session) {
  input = (input || '.').replace(/^~(\/|$)/, '/');
  const parts = input.startsWith('/') ? [] : session.cwd.split('/').filter(Boolean);
  for (const part of input.split('/')) {
    if (part === '..') parts.pop();
    else if (part && part !== '.') parts.push(part);
  }
  if (parts[0] === TOPIC.project) parts.shift();
  return parts.join('/');
}

function vfsDirs() {
  const dirs = new Set(['']);
  for (const p of Object.keys(REG)) {
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  (function walk(nodes, prefix) {
    for (const n of nodes || []) {
      if (n.dir) { const path = prefix ? prefix + '/' + n.name : n.name; dirs.add(path); walk(n.children, path); }
    }
  })(TREE, '');
  for (const d of extraDirs) dirs.add(d);
  return dirs;
}

function isDir(path) { return path === '' || vfsDirs().has(path); }

function vfsEntries(dir) {
  const prefix = dir ? dir + '/' : '';
  const map = new Map();
  for (const p of Object.keys(REG)) {
    if (!p.startsWith(prefix)) continue;
    const rest = p.slice(prefix.length);
    const name = rest.split('/')[0];
    if (rest.includes('/')) { if (!map.has(name)) map.set(name, { name, dir: true }); }
    else map.set(name, { name, dir: false, file: REG[p] });
  }
  for (const d of vfsDirs()) {
    if (!d || !d.startsWith(prefix)) continue;
    const name = d.slice(prefix.length).split('/')[0];
    if (name && !map.has(name)) map.set(name, { name, dir: true });
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function pathHash(path) { let h = 7; for (const ch of path) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h; }
function fakeMtime(path) { return new Date(Date.now() - (pathHash(path) % (30 * 86400000))); }
function fmtDate(d) {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return months[d.getMonth()] + ' ' + String(d.getDate()).padStart(2, ' ') + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}
function fmtSize(n, human) {
  if (!human) return String(n);
  if (n < 1024) return n + 'B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + 'K';
  return (n / 1024 / 1024).toFixed(1) + 'M';
}
function dirSize(dir) {
  const prefix = dir ? dir + '/' : '';
  return Object.keys(REG).filter(p => p.startsWith(prefix)).reduce((n, p) => n + REG[p].content.length, 0);
}

function createFile(path, content) {
  const meta = EXTMETA[extOf(path)] || EXTMETA.txt;
  const f = REG[path] || (REG[path] = { path, name: path.split('/').pop(), typed: false, st: null });
  Object.assign(f, meta, { content, lines: content.split('\n'), cache: null });
  TREE = projectTree(Object.keys(REG));
  renderTree();
  scmAdd(path);
  return f;
}

function removeFile(path) {
  if (!REG[path]) return false;
  delete REG[path];
  if (openTabs.includes(path)) closeTab(path);
  rotation = Object.values(REG).filter(f => f.typed).map(f => f.path);
  TREE = projectTree(Object.keys(REG));
  renderTree();
  renderScm();
  return true;
}

/* ================= parsing ================= */

function splitChain(line) {
  const out = [];
  let cur = '', quote = null, op = ';';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i], two = line.slice(i, i + 2);
    if (quote) { cur += ch; if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (two === '&&' || two === '||') { out.push({ op, cmd: cur.trim() }); op = two; cur = ''; i++; continue; }
    if (ch === ';') { out.push({ op, cmd: cur.trim() }); op = ';'; cur = ''; continue; }
    cur += ch;
  }
  out.push({ op, cmd: cur.trim() });
  return out.filter(x => x.cmd);
}

function splitPipes(cmd) {
  const out = [];
  let cur = '', quote = null;
  for (const ch of cmd) {
    if (quote) { cur += ch; if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === '|') { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur.trim());
  return out.filter(Boolean);
}

function parseRedirect(stage) {
  let redirect = null;
  stage = stage.replace(/\s2>&1/g, '').replace(/\s2>\s*\/dev\/null/g, '');
  const m = stage.match(/\s(>>?)\s*(\S+)\s*$/);
  if (m) { redirect = { mode: m[1], target: m[2] }; stage = stage.slice(0, m.index); }
  return { stage: stage.trim(), redirect };
}

function argv(cmd, session) {
  const matches = cmd.match(/"(?:[^"\\]|\\.)*"|'[^']*'|[^\s]+/g) || [];
  return matches.map(s => {
    if (/^'/.test(s)) return s.slice(1, -1);
    if (/^"/.test(s)) s = s.slice(1, -1);
    return s.replace(/\$\{?([A-Za-z_]\w*)\}?/g, (m, name) => envValue(name, session));
  });
}

function flags(args) {
  const opts = new Set(), params = [];
  for (const a of args) {
    if (a === '-') params.push(a);
    else if (a.startsWith('--')) opts.add(a.slice(2));
    else if (a.startsWith('-') && a.length > 1 && !/^-\d/.test(a)) for (const ch of a.slice(1)) opts.add(ch);
    else params.push(a);
  }
  return { opts, params };
}

function envValue(name, session) {
  const sh = shellInfo();
  const base = {
    USER: sh.user, HOME: '/home/' + sh.user, PWD: '/home/' + sh.user + '/' + TOPIC.project + (session.cwd ? '/' + session.cwd : ''),
    SHELL: '/bin/bash', PATH: '/home/' + sh.user + '/.local/bin:/usr/local/bin:/usr/bin:/bin', HOSTNAME: sh.host, LANG: 'en_US.UTF-8',
    TERM: 'xterm-256color', EDITOR: 'code --wait', NODE_ENV: 'development', GIT_BRANCH: TOPIC.branch, PROJECT: TOPIC.project,
  };
  if (name === '?') return String(session.lastExitCode || 0);
  return session.env[name] !== undefined ? session.env[name] : (base[name] !== undefined ? base[name] : '');
}

/* ================= output helpers ================= */

const T = (text, style) => [text, style || ''];
const _textScratch = document.createElement('div');
function htmlToText(html) { _textScratch.innerHTML = html; const t = _textScratch.textContent; _textScratch.textContent = ''; return t; }
function lineText(row) { return typeof row[0] === 'string' ? row[0] : htmlToText(row[0].html || ''); }
function table(rows, styles) {
  const widths = [];
  rows.forEach(r => r.forEach((c, i) => { widths[i] = Math.max(widths[i] || 0, String(c).length); }));
  return rows.map((r, ri) => T(r.map((c, i) => String(c).padEnd(widths[i] + 2)).join('').trimEnd(), styles ? styles(ri) : ''));
}
function emit(session, lines) {
  for (const [text, style] of lines) {
    if (typeof text === 'object' && text.html) appendHtml(session, text.html);
    else append(session, text, style);
  }
}
function H(html) { return [{ html }, '']; }

/* ================= builtins ================= */
/* each builtin: (ctx) => lines | Promise<lines> | { code, lines } ; ctx = { session, topic, args, raw, input } */

const BUILTINS = {};
const CMD_HELP = {};
function def(names, help, fn) { for (const n of names.split(' ')) { BUILTINS[n] = fn; CMD_HELP[n] = help; } }

def('help', 'list the commands this shell understands', () => [
  T('FauxCode workspace shell (bash 5.2 compatible enough). Commands run inside the simulation only.', 'dim'),
  T(''),
  T('  files      ls  cd  pwd  cat  head  tail  less  wc  grep  find  tree  touch  mkdir  rm  mv  cp  du  df  stat', ''),
  T('  editor     code <file>  open <file>  vim <file>  nano <file>', ''),
  T('  git        status  log  diff  branch  checkout  switch  add  commit  push  pull  fetch  stash  blame  remote  show', ''),
  T('  build      ' + Object.values(JOB_COMMANDS).filter(c => TOPIC.jobs.some(j => JOB_COMMANDS[j] === c)).map(c => c.split(' ').slice(0, 2).join(' ')).slice(0, 8).join('  ·  '), ''),
  T('  system     echo  env  export  date  uptime  uname  whoami  hostname  ps  top  free  ping  curl  ssh  history  clear  exit', ''),
  T('  pipes      cmd | grep -i x | head -n 5      cmd > file.txt      a && b      a ; b', ''),
  T('  keys       ↑/↓ history · Tab completion · Ctrl+C cancel · Ctrl+L clear · Ctrl+` focus', ''),
  T(''),
  T('Type "man <command>" for a specific command, or use Terminal → Run Task for project tasks.', 'dim'),
]);

def('man', 'show a manual page', ({ args }) => {
  const name = args[1];
  if (!name) return { code: 1, lines: [T('What manual page do you want?', 'err'), T('For example, try "man ls".', 'dim')] };
  if (!CMD_HELP[name]) return { code: 16, lines: [T('No manual entry for ' + name, 'err')] };
  return [T(name.toUpperCase() + '(1)' + ' '.repeat(Math.max(1, 40 - name.length)) + 'User Commands', 'bright'), T(''), T('NAME'), T('       ' + name + ' - ' + CMD_HELP[name]), T(''), T('SYNOPSIS'), T('       ' + name + ' [OPTION]... [FILE]...'), T(''), T('DESCRIPTION'), T('       Behaves like the real thing for the parts you would notice during a demo.'), T('       Everything happens inside this workspace; nothing touches your machine.'), T(''), T('REPORTING BUGS'), T('       Click the wavy underline in the editor. That counts.', 'dim')];
});

def('pwd', 'print the working directory', ({ session }) => [T(envValue('PWD', session))]);
def('whoami', 'print the current user', () => [T(shellInfo().user)]);
def('id', 'print user identity', () => { const u = shellInfo().user; return [T('uid=1000(' + u + ') gid=1000(' + u + ') groups=1000(' + u + '),27(sudo),999(docker)')]; });
def('hostname', 'print the host name', () => [T(shellInfo().host)]);
def('date', 'print the current date', () => [T(new Date().toString().replace(/\(.*\)/, '').trim())]);
def('cal', 'print a calendar', () => {
  const now = new Date(), y = now.getFullYear(), m = now.getMonth();
  const first = new Date(y, m, 1).getDay(), days = new Date(y, m + 1, 0).getDate();
  const title = now.toLocaleString('en-US', { month: 'long' }) + ' ' + y;
  const rows = [T(' '.repeat(Math.max(0, Math.floor((20 - title.length) / 2))) + title), T('Su Mo Tu We Th Fr Sa')];
  let line = '   '.repeat(first);
  for (let d = 1; d <= days; d++) {
    line += String(d).padStart(2, ' ') + ' ';
    if ((first + d) % 7 === 0) { rows.push(T(line.trimEnd())); line = ''; }
  }
  if (line.trim()) rows.push(T(line.trimEnd()));
  return rows;
});
def('uptime', 'show how long the system has been running', () => {
  const up = Math.floor(performance.now() / 1000) + 4 * 3600 + 913;
  return [T(nowStr() + ' up ' + Math.floor(up / 3600) + ':' + String(Math.floor(up % 3600 / 60)).padStart(2, '0') + ', 1 user, load average: ' + (0.4 + Math.random()).toFixed(2) + ', ' + (0.5 + Math.random()).toFixed(2) + ', ' + (0.6 + Math.random()).toFixed(2))];
});
def('uname', 'print system information', ({ args }) => [T(args.includes('-a') ? 'Linux ' + shellInfo().host + ' 6.8.0-45-generic #45-Ubuntu SMP PREEMPT_DYNAMIC x86_64 GNU/Linux' : 'Linux')]);
def('nproc', 'print the number of processors', () => [T('16')]);
def('true', 'do nothing, successfully', () => []);
def('false', 'do nothing, unsuccessfully', () => ({ code: 1, lines: [] }));
def('echo', 'display a line of text', ({ args }) => [T(args.slice(1).filter(a => a !== '-e' && a !== '-n').join(' '))]);
def('printf', 'format and print data', ({ args }) => [T(args.slice(1).join(' ').replace(/\\n/g, ' '))]);
def('seq', 'print a sequence of numbers', ({ args }) => { const a = Number(args[1] || 1), b = Number(args[2] || a); const lo = args[2] ? a : 1, hi = args[2] ? b : a; const out = []; for (let i = lo; i <= Math.min(hi, lo + 200); i++) out.push(T(String(i))); return out; });
def('env printenv', 'print the environment', ({ session }) => ['USER', 'HOME', 'PWD', 'SHELL', 'PATH', 'HOSTNAME', 'LANG', 'TERM', 'EDITOR', 'NODE_ENV', 'GIT_BRANCH', 'PROJECT'].map(k => T(k + '=' + envValue(k, session))).concat(Object.entries(session.env).map(([k, v]) => T(k + '=' + v))));
def('export', 'set an environment variable', ({ session, args }) => { for (const a of args.slice(1)) { const [k, ...v] = a.split('='); if (k) session.env[k] = v.join('='); } return []; });
def('unset', 'unset an environment variable', ({ session, args }) => { for (const a of args.slice(1)) delete session.env[a]; return []; });
def('alias', 'define or display aliases', () => [T("alias ll='ls -alF'"), T("alias la='ls -A'"), T("alias gs='git status'"), T("alias ..='cd ..'"), T("alias please='sudo'")]);
def('which where type', 'locate a command', ({ args }) => { const n = args[1]; if (!n) return { code: 1, lines: [] }; if (BUILTINS[n] || Object.values(JOB_COMMANDS).some(c => c.split(' ')[0] === n)) return [T('/usr/bin/' + n)]; return { code: 1, lines: [T(n + ' not found', 'err')] }; });
def('history', 'show command history', ({ session }) => session.history.map((c, i) => T(String(i + 1).padStart(5) + '  ' + c)));
def('clear cls', 'clear the terminal', ({ session }) => { session.rows = []; if (session === currentSession) termEl.innerHTML = ''; return []; });
def('exit logout', 'close this terminal', ({ session }) => {
  if (session.kind === 'watch') return [T('logout: the dev server is still attached to this terminal. Use the 🗑 button to kill it.', 'dim')];
  setTimeout(closeSession, 60);
  return [T('logout', 'dim')];
});
def('sleep', 'delay for a number of seconds', async ({ args }) => { await sleep(Math.min(5, Number(args[1]) || 1) * 1000); return []; });

def('cd', 'change the working directory', ({ session, args }) => {
  const target = args[1];
  if (!target || target === '~') { session.prev = session.cwd; session.cwd = ''; updatePrompt(); return []; }
  if (target === '-') { const p = session.prev || ''; session.prev = session.cwd; session.cwd = p; updatePrompt(); return [T(envValue('PWD', session))]; }
  const path = vpath(target, session);
  if (REG[path]) return { code: 1, lines: [T('bash: cd: ' + target + ': Not a directory', 'err')] };
  if (!isDir(path)) return { code: 1, lines: [T('bash: cd: ' + target + ': No such file or directory', 'err')] };
  session.prev = session.cwd; session.cwd = path; updatePrompt();
  return [];
});

def('ls dir ll la', 'list directory contents', ({ session, args, raw }) => {
  const { opts, params } = flags(args.slice(1));
  if (args[0] === 'll') { opts.add('l'); opts.add('a'); }
  if (args[0] === 'la') opts.add('a');
  const targets = params.length ? params : ['.'];
  const out = [];
  for (const t of targets) {
    const path = vpath(t, session);
    if (REG[path]) { out.push(T(path.split('/').pop())); continue; }
    if (!isDir(path)) { out.push(T('ls: cannot access \'' + t + '\': No such file or directory', 'err')); continue; }
    let entries = vfsEntries(path);
    if (opts.has('a') || opts.has('A')) entries = [{ name: '.', dir: true }, { name: '..', dir: true }, ...entries];
    else entries = entries.filter(e => !e.name.startsWith('.'));
    if (opts.has('t')) entries.sort((a, b) => fakeMtime(path + '/' + b.name) - fakeMtime(path + '/' + a.name));
    if (opts.has('r')) entries.reverse();
    if (targets.length > 1) out.push(T(t + ':', 'bright'));
    if (opts.has('l')) {
      const sh = shellInfo();
      const rows = entries.map(e => {
        const full = path ? path + '/' + e.name : e.name;
        const size = e.dir ? 4096 : e.file.content.length;
        const perm = e.dir ? 'drwxr-xr-x' : (/\.(sh|py)$/.test(e.name) ? '-rwxr-xr-x' : '-rw-r--r--');
        const links = e.dir ? String(2 + (pathHash(full) % 6)) : '1';
        return [perm, links, sh.user, sh.user, fmtSize(size, opts.has('h')), fmtDate(fakeMtime(full)), e.name, e.dir];
      });
      out.push(T('total ' + rows.length, 'dim'));
      const widths = [];
      rows.forEach(r => r.slice(0, 6).forEach((c, i) => { widths[i] = Math.max(widths[i] || 0, c.length); }));
      for (const r of rows) {
        const prefix = r.slice(0, 6).map((c, i) => i === 4 ? c.padStart(widths[i]) : c.padEnd(widths[i])).join(' ');
        out.push(H(esc(prefix) + ' ' + (r[7] ? '<span class="info">' + esc(r[6]) + '</span>' : /\.(sh|py)$/.test(r[6]) ? '<span class="ok">' + esc(r[6]) + '</span>' : esc(r[6]))));
      }
    } else if (opts.has('1')) {
      for (const e of entries) out.push(H(e.dir ? '<span class="info">' + esc(e.name) + '</span>' : esc(e.name)));
    } else {
      const html = entries.map(e => e.dir ? '<span class="info">' + esc(e.name) + '</span>' : /\.(sh|py)$/.test(e.name) ? '<span class="ok">' + esc(e.name) + '</span>' : esc(e.name)).join('  ');
      out.push(H(html || ''));
    }
  }
  return out;
});

def('tree', 'list contents of directories in a tree-like format', ({ session, args }) => {
  const { opts, params } = flags(args.slice(1));
  const root = vpath(params[0] || '.', session);
  if (!isDir(root)) return { code: 1, lines: [T(params[0] + ' [error opening dir]', 'err')] };
  const out = [H('<span class="info">' + esc(params[0] || '.') + '</span>')];
  let dirs = 0, files = 0, count = 0;
  const maxDepth = opts.has('L') ? Number(params[1] || 2) : 4;
  (function walk(dir, prefix, depth) {
    const entries = vfsEntries(dir).filter(e => opts.has('a') || !e.name.startsWith('.'));
    entries.forEach((e, i) => {
      if (count++ > 120) return;
      const last = i === entries.length - 1;
      const full = dir ? dir + '/' + e.name : e.name;
      out.push(H(esc(prefix + (last ? '└── ' : '├── ')) + (e.dir ? '<span class="info">' + esc(e.name) + '</span>' : esc(e.name))));
      if (e.dir) { dirs++; if (depth < maxDepth) walk(full, prefix + (last ? '    ' : '│   '), depth + 1); } else files++;
    });
  })(root, '', 1);
  if (count > 120) out.push(T('… (output truncated)', 'dim'));
  out.push(T(''), T(dirs + ' directories, ' + files + ' files'));
  return out;
});

function readFileArg(ctx, name) {
  const { session, args, input } = ctx;
  const { opts, params } = flags(args.slice(1));
  if (input && !params.length) return { lines: input.map(lineText), opts, params, path: '(stdin)' };
  if (!params.length) return { error: [T('usage: ' + name + ' [OPTION]... FILE', 'err')], opts };
  const path = vpath(params[0], session);
  const f = REG[path];
  if (!f) return { error: [T(name + ': ' + params[0] + ': No such file or directory', 'err')], opts };
  if (isDir(path) && !f) return { error: [T(name + ': ' + params[0] + ': Is a directory', 'err')], opts };
  return { lines: f.content.replace(/\n$/, '').split('\n'), opts, params, path, file: f };
}

def('cat less more bat', 'concatenate files and print', ctx => {
  const r = readFileArg(ctx, ctx.args[0]);
  if (r.error) return { code: 1, lines: r.error };
  const numbered = r.opts.has('n') || ctx.args[0] === 'bat';
  const slice = r.lines.slice(0, 400);
  const out = slice.map((l, i) => numbered ? H('<span class="dim">' + String(i + 1).padStart(5) + '</span>  ' + (r.file ? hl(l, r.file.lang) : esc(l))) : H(r.file ? hl(l, r.file.lang) : esc(l)));
  if (r.lines.length > 400) out.push(T('… ' + (r.lines.length - 400) + ' more lines (open the file in the editor to read everything)', 'dim'));
  return out;
});

/* head/tail accept -n N, -N and --lines=N; strip the count before looking for a file */
function countArg(ctx) {
  const args = ctx.args.slice();
  let n = 10;
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === '-n' || a === '-c') { n = Number(args[i + 1]) || n; args.splice(i, 2); i--; }
    else if (/^-n\d+$/.test(a)) { n = Number(a.slice(2)) || n; args.splice(i, 1); i--; }
    else if (/^-\d+$/.test(a)) { n = Number(a.slice(1)) || n; args.splice(i, 1); i--; }
    else if (/^--lines=\d+$/.test(a)) { n = Number(a.split('=')[1]) || n; args.splice(i, 1); i--; }
  }
  return { n, ctx: Object.assign({}, ctx, { args }) };
}
def('head', 'output the first part of a file', ctx => {
  const { n, ctx: c } = countArg(ctx);
  const r = readFileArg(c, 'head');
  if (r.error) return { code: 1, lines: r.error };
  return r.lines.slice(0, n).map(l => H(r.file ? hl(l, r.file.lang) : esc(l)));
});
def('tail', 'output the last part of a file', ctx => {
  const { n, ctx: c } = countArg(ctx);
  const r = readFileArg(c, 'tail');
  if (r.error) return { code: 1, lines: r.error };
  if (r.opts.has('f')) return r.lines.slice(-n).map(l => T(l)).concat([T('tail: following ' + r.path + ' — press Ctrl+C to stop (it will not change; nobody else is here)', 'dim')]);
  return r.lines.slice(-n).map(l => H(r.file ? hl(l, r.file.lang) : esc(l)));
});
def('wc', 'print newline, word and byte counts', ctx => {
  const r = readFileArg(ctx, 'wc');
  if (r.error) return { code: 1, lines: r.error };
  const text = r.lines.join('\n');
  const l = r.lines.length, w = text.split(/\s+/).filter(Boolean).length, c = text.length + 1;
  if (r.opts.has('l')) return [T(String(l) + (r.file ? ' ' + r.params[0] : ''))];
  if (r.opts.has('w')) return [T(String(w) + (r.file ? ' ' + r.params[0] : ''))];
  if (r.opts.has('c')) return [T(String(c) + (r.file ? ' ' + r.params[0] : ''))];
  return [T(String(l).padStart(7) + String(w).padStart(8) + String(c).padStart(8) + (r.file ? ' ' + r.params[0] : ''))];
});
def('stat', 'display file status', ({ session, args }) => {
  const path = vpath(args[1] || '.', session); const f = REG[path];
  if (!f && !isDir(path)) return { code: 1, lines: [T("stat: cannot statx '" + args[1] + "': No such file or directory", 'err')] };
  const d = fakeMtime(path);
  return [T('  File: ' + (args[1] || '.')), T('  Size: ' + (f ? f.content.length : 4096) + '\tBlocks: 8\tIO Block: 4096\t' + (f ? 'regular file' : 'directory')), T('Access: (' + (f ? '0644/-rw-r--r--' : '0755/drwxr-xr-x') + ')  Uid: ( 1000/' + shellInfo().user + ')   Gid: ( 1000/' + shellInfo().user + ')'), T('Modify: ' + d.toISOString().replace('T', ' ').slice(0, 19) + '.000000000 +0500')];
});
def('du', 'estimate file space usage', ({ session, args }) => {
  const { opts, params } = flags(args.slice(1));
  const root = vpath(params[0] || '.', session);
  const out = [];
  if (!opts.has('s')) for (const e of vfsEntries(root).filter(e => e.dir)) out.push(T(fmtSize(dirSize(root ? root + '/' + e.name : e.name), opts.has('h')).padStart(8) + '\t' + (params[0] || '.') + '/' + e.name));
  out.push(T(fmtSize(dirSize(root), opts.has('h')).padStart(8) + '\t' + (params[0] || '.')));
  return out;
});
def('df', 'report file system disk space usage', ({ args }) => table([
  ['Filesystem', 'Size', 'Used', 'Avail', 'Use%', 'Mounted on'],
  ['/dev/nvme0n1p2', '931G', '412G', '472G', '47%', '/'],
  ['tmpfs', '32G', '1.2G', '31G', '4%', '/dev/shm'],
  ['/dev/nvme0n1p1', '511M', '6.1M', '505M', '2%', '/boot/efi'],
  ['nas.internal.corp:/builds', '12T', '9.8T', '2.2T', '82%', '/mnt/builds'],
], i => i === 0 ? 'bright' : ''));
def('free', 'display amount of free and used memory', ({ args }) => table([
  ['', 'total', 'used', 'free', 'shared', 'buff/cache', 'available'],
  ['Mem:', '32768', String(11200 + rand(0, 900)), String(8100 + rand(0, 400)), '412', '13400', '20800'],
  ['Swap:', '8192', '0', '8192', '', '', ''],
], i => i === 0 ? 'bright' : ''));

def('grep rg egrep', 'search for a pattern', ({ session, args, input }) => {
  const { opts, params } = flags(args.slice(1));
  if (!params.length) return { code: 2, lines: [T('usage: grep [-rinv] PATTERN [FILE...]', 'err')] };
  let re;
  try { re = new RegExp(opts.has('F') ? params[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : params[0], opts.has('i') ? 'i' : ''); } catch (e) { return { code: 2, lines: [T('grep: invalid regular expression', 'err')] }; }
  const out = [];
  const mark = (line) => esc(line).replace(new RegExp('(' + re.source.replace(/[&<>]/g, '') + ')', re.flags + 'g'), '<span class="err">$1</span>');
  if (input && !params[1]) {
    input.forEach((row, i) => { const t = lineText(row); if (re.test(t) !== opts.has('v')) out.push(H((opts.has('n') ? '<span class="ok">' + (i + 1) + '</span>:' : '') + mark(t))); });
    return { code: out.length ? 0 : 1, lines: out };
  }
  const targets = params.slice(1).length ? params.slice(1) : ['.'];
  let files = [];
  for (const t of targets) {
    const path = vpath(t, session);
    if (REG[path]) files.push(path);
    else if (isDir(path) && (opts.has('r') || opts.has('R') || args[0] === 'rg' || t === '.')) files.push(...Object.keys(REG).filter(p => !path || p.startsWith(path + '/')));
    else out.push(T('grep: ' + t + ': No such file or directory', 'err'));
  }
  let total = 0;
  for (const p of files) {
    const lines = REG[p].content.split('\n');
    lines.forEach((l, i) => {
      if (total >= 80) return;
      if (re.test(l) !== opts.has('v')) { total++; out.push(H('<span class="mag">' + esc(p) + '</span><span class="dim">:</span><span class="ok">' + (i + 1) + '</span><span class="dim">:</span>' + mark(l.trim().slice(0, 160)))); }
    });
  }
  if (total >= 80) out.push(T('… more matches not shown', 'dim'));
  return { code: total ? 0 : 1, lines: out };
});

def('find fd', 'search for files in a directory hierarchy', ({ session, args }) => {
  const { params } = flags(args.filter(a => !['-name', '-iname', '-type', '-path'].includes(a)).slice(1));
  const nameIdx = args.findIndex(a => a === '-name' || a === '-iname');
  const pattern = nameIdx >= 0 ? args[nameIdx + 1] : (args[0] === 'fd' ? params[0] : null);
  const typeIdx = args.indexOf('-type');
  const type = typeIdx >= 0 ? args[typeIdx + 1] : null;
  const root = vpath((args[0] === 'fd' ? params[1] : params[0]) || '.', session);
  const re = pattern ? new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', args[nameIdx] === '-iname' || args[0] === 'fd' ? 'i' : '') : null;
  const out = [];
  const all = [...vfsDirs()].filter(d => d && (!root || d.startsWith(root + '/') || d === root)).map(d => ({ path: d, dir: true }))
    .concat(Object.keys(REG).filter(p => !root || p.startsWith(root + '/')).map(p => ({ path: p, dir: false })));
  for (const e of all.sort((a, b) => a.path.localeCompare(b.path))) {
    if (type === 'f' && e.dir) continue;
    if (type === 'd' && !e.dir) continue;
    if (re && !re.test(e.path.split('/').pop()) && !(args[0] === 'fd' && re.test(e.path))) continue;
    out.push(H(e.dir ? '<span class="info">./' + esc(e.path) + '</span>' : './' + esc(e.path)));
    if (out.length > 150) { out.push(T('… (truncated)', 'dim')); break; }
  }
  return out;
});

def('touch', 'create an empty file or update timestamps', ({ session, args }) => {
  for (const a of args.slice(1).filter(a => !a.startsWith('-'))) {
    const path = vpath(a, session);
    if (!REG[path]) createFile(path, '');
  }
  return [];
});
def('mkdir', 'make directories', ({ session, args }) => {
  const { params } = flags(args.slice(1));
  if (!params.length) return { code: 1, lines: [T('mkdir: missing operand', 'err')] };
  for (const a of params) {
    const path = vpath(a, session);
    if (isDir(path) || REG[path]) return { code: 1, lines: [T("mkdir: cannot create directory '" + a + "': File exists", 'err')] };
    extraDirs.add(path);
    TREE = projectTree(Object.keys(REG)); TREE.push(d(path.split('/').pop(), [], false)); renderTree();
  }
  return [];
});
def('rm rmdir del', 'remove files or directories', ({ session, args }) => {
  const { opts, params } = flags(args.slice(1));
  if (params.some(p => ['/', '/*', '~', '*'].includes(p)) && (opts.has('r') || opts.has('R'))) {
    return { code: 1, lines: [T("rm: it is dangerous to operate recursively on '/'", 'err'), T('rm: use --no-preserve-root to override this failsafe', 'err'), T('(the failsafe has no override in this build. you are welcome.)', 'dim')] };
  }
  if (!params.length) return { code: 1, lines: [T('rm: missing operand', 'err')] };
  const out = [];
  for (const a of params) {
    const path = vpath(a, session);
    if (REG[path]) { if (REG[path].typed && REG[path].path === ap) out.push(T("rm: cannot remove '" + a + "': Text file busy (it is open in the editor)", 'err')); else removeFile(path); }
    else if (isDir(path)) {
      if (!opts.has('r') && !opts.has('R') && args[0] !== 'rmdir') { out.push(T("rm: cannot remove '" + a + "': Is a directory", 'err')); continue; }
      for (const p of Object.keys(REG).filter(p => p.startsWith(path + '/'))) removeFile(p);
      extraDirs.delete(path);
    } else out.push(T("rm: cannot remove '" + a + "': No such file or directory", 'err'));
  }
  return { code: out.length ? 1 : 0, lines: out };
});
def('mv cp', 'move or copy files', ({ session, args }) => {
  const { params } = flags(args.slice(1));
  if (params.length < 2) return { code: 1, lines: [T(args[0] + ': missing destination file operand', 'err')] };
  const src = vpath(params[0], session); let dst = vpath(params[1], session);
  const f = REG[src];
  if (!f) return { code: 1, lines: [T(args[0] + ": cannot stat '" + params[0] + "': No such file or directory", 'err')] };
  if (isDir(dst)) dst = dst + '/' + f.name;
  createFile(dst, f.content);
  if (args[0] === 'mv') removeFile(src);
  return [];
});

def('code open start xdg-open vim vi nvim nano emacs subl', 'open a file in the editor', ({ session, args }) => {
  const target = args.slice(1).find(a => !a.startsWith('-') && a !== '.');
  if (!target) {
    if (/^(vim|vi|nvim)$/.test(args[0])) return [T('VIM - Vi IMproved 9.1', 'bright'), T(''), T('type  :q<Enter>               to exit         '), T('type  :help<Enter>  or  <F1>  for on-line help'), T(''), T('(you are not actually in vim. type :q anyway, it feels good)', 'dim')];
    if (args[0] === 'emacs') return [T('Loading emacs… this is a good time to get coffee.', 'dim')];
    return [T('Opening ' + TOPIC.project + ' in a new window…', 'dim')];
  }
  const path = vpath(target, session);
  if (!REG[path]) {
    if (/^(vim|vi|nvim|nano|code)$/.test(args[0])) { createFile(path, ''); openPath(path); welcomeEl.classList.remove('show'); return [T('"' + target + '" [New]', 'dim')]; }
    return { code: 1, lines: [T(args[0] + ': ' + target + ': No such file or directory', 'err')] };
  }
  openPath(path); welcomeEl.classList.remove('show');
  return [T('"' + target + '" ' + lineCountOf(REG[path]) + 'L, ' + REG[path].content.length + 'B', 'dim')];
});
def(':q :q! :wq :x', 'not an editor command', () => [T('E492: Not an editor command: ' + ':q', 'err'), T('(this is a terminal. the editor is the big thing above it.)', 'dim')]);

def('sudo su doas', 'execute a command as another user', ({ args }) => {
  if (args.slice(1).join(' ').includes('make me a sandwich')) return [T('Okay.', 'ok')];
  return { code: 1, lines: [T('[sudo] password for ' + shellInfo().user + ': ', 'dim'), T(shellInfo().user + ' is not in the sudoers file.  This incident will be reported.', 'err')] };
});
def('make', 'run a Makefile target', async ctx => {
  const target = ctx.args[1] || 'build';
  const script = TOPIC.scripts.find(s => s[0] === target);
  if (script) { append(ctx.session, script[1], 'dim'); const code = await runJobFor(ctx.session, script[1]); return { code, lines: [] }; }
  if (ctx.args[1] && /sandwich/.test(ctx.args.join(' '))) return [T('What? Make it yourself.', 'warn')];
  return { code: 2, lines: [T("make: *** No rule to make target '" + target + "'.  Stop.", 'err')] };
});

/* ---- git ---- */
function gitDiffFor(path) {
  const f = REG[path];
  const lines = f.content.split('\n');
  const at = f.typed && f.st ? Math.max(0, f.st.lineNo - 4) : Math.min(lines.length - 1, 6 + (pathHash(path) % 20));
  const ctx = lines.slice(at, at + 7).filter(l => l !== undefined);
  const out = [H('<span class="bright">diff --git a/' + esc(path) + ' b/' + esc(path) + '</span>'), H('<span class="dim">index ' + rand(0x100000, 0xffffff).toString(16) + '..' + rand(0x100000, 0xffffff).toString(16) + ' 100644</span>'), H('<span class="bright">--- a/' + esc(path) + '</span>'), H('<span class="bright">+++ b/' + esc(path) + '</span>'), H('<span class="info">@@ -' + (at + 1) + ',' + ctx.length + ' +' + (at + 1) + ',' + (ctx.length + 1) + ' @@</span>')];
  ctx.forEach((l, i) => {
    if (i === 3 && l.trim()) { out.push(H('<span class="err">-' + esc(l.replace(/(\w+)\s*$/, '$1_v1')) + '</span>')); out.push(H('<span class="ok">+' + esc(l) + '</span>')); out.push(H('<span class="ok">+' + esc(l.replace(/\S.*/, m => (l.match(/^\s*/) || [''])[0] + (f.lang === 'py' ? '# reviewed: ' : '// reviewed: ') + m.slice(0, 40)).trimEnd()) + '</span>')); }
    else out.push(T(' ' + l));
  });
  return out;
}

def('git', 'the stupid content tracker', async ({ session, args, topic }) => {
  const sub = args[1];
  const say = (t, s) => T(t, s);
  if (!sub || sub === 'help') return [T('usage: git <command> [<args>]', ''), T(''), T('   status    log    diff    branch    checkout    switch    add    commit    push    pull    fetch    stash    blame    remote    show    tag'), T('')];
  if (sub === 'status') {
    const out = [T('On branch ' + topic.branch), T(aheadCount ? "Your branch is ahead of 'origin/" + topic.branch + "' by " + aheadCount + ' commit' + (aheadCount > 1 ? 's' : '') + '.' : "Your branch is up to date with 'origin/" + topic.branch + "'."), T('')];
    if (scmChanges.size) {
      out.push(T('Changes not staged for commit:'), T('  (use "git add <file>..." to update what will be committed)', 'dim'), T('  (use "git restore <file>..." to discard changes in working directory)', 'dim'));
      for (const p of scmChanges) out.push(H('\t<span class="err">modified:   ' + esc(p) + '</span>'));
      out.push(T(''), T('no changes added to commit (use "git add" and/or "git commit -a")'));
    } else out.push(T('nothing to commit, working tree clean'));
    return out;
  }
  if (sub === 'log') {
    const n = Number(args.find((a, i) => args[i - 1] === '-n') || (args.find(a => /^-\d+$/.test(a)) || '-12').slice(1)) || 12;
    const commits = topic.commits.slice(0, n);
    if (args.includes('--oneline') || args.includes('--graph')) {
      return commits.map((c, i) => H((args.includes('--graph') ? '<span class="err">*</span> ' : '') + '<span class="warn">' + esc(c[0]) + '</span> ' + (i === 0 ? '<span class="info">(HEAD -&gt; ' + esc(topic.branch) + ', origin/' + esc(topic.branch) + ')</span> ' : '') + esc(c[1])));
    }
    const out = [];
    commits.forEach((c, i) => {
      out.push(H('<span class="warn">commit ' + esc(c[0]) + rand(0x10000000, 0xffffffff).toString(16) + rand(0x10000000, 0xffffffff).toString(16) + '</span>' + (i === 0 ? ' <span class="info">(HEAD -&gt; ' + esc(topic.branch) + ')</span>' : '')));
      out.push(T('Author: ' + c[2] + ' <' + c[2].toLowerCase().replace(/[^a-z]+/g, '.') + '@' + topic.remote.split(':')[0].replace(/^git(lab|hub)\./, '') + '>'));
      out.push(T('Date:   ' + c[3]), T(''), T('    ' + c[1]), T(''));
    });
    return out;
  }
  if (sub === 'diff') {
    const target = args[2] && !args[2].startsWith('-') ? vpath(args[2], session) : null;
    const files = target ? (REG[target] ? [target] : []) : [...scmChanges];
    if (args.includes('--stat')) return files.map(p => T(' ' + p + ' | ' + rand(2, 40) + ' ' + '+'.repeat(rand(1, 12)) + '-'.repeat(rand(0, 4)))).concat([T(' ' + files.length + ' files changed, ' + rand(10, 200) + ' insertions(+), ' + rand(2, 40) + ' deletions(-)')]);
    if (!files.length) return [];
    return files.flatMap(gitDiffFor);
  }
  if (sub === 'branch') {
    const { opts, params } = flags(args.slice(2));
    if (opts.has('d') || opts.has('D')) { const b = params[0]; if (b === topic.branch) return { code: 1, lines: [T("error: Cannot delete branch '" + b + "' checked out at '" + envValue('PWD', session) + "'", 'err')] }; topic.branches = topic.branches.filter(x => x !== b); return [T('Deleted branch ' + b + ' (was ' + rand(0x100000, 0xffffff).toString(16) + ').')]; }
    if (params[0]) { if (!topic.branches.includes(params[0])) topic.branches.push(params[0]); return []; }
    const list = topic.branches.map(b => b === topic.branch ? H('* <span class="ok">' + esc(b) + '</span>') : T('  ' + b));
    if (opts.has('a') || opts.has('r')) list.push(...topic.branches.slice(0, 3).map(b => H('  <span class="err">remotes/origin/' + esc(b) + '</span>')));
    return list;
  }
  if (sub === 'checkout' || sub === 'switch') {
    const creating = ['-b', '-c'].includes(args[2]);
    const branch = args[creating ? 3 : 2];
    if (!branch) return { code: 1, lines: [T('fatal: missing branch name', 'err')] };
    if (branch === '.' || branch === '--') { scmChanges.clear(); renderScm(); return [T('Updated ' + rand(1, 5) + ' paths from the index')]; }
    if (REG[vpath(branch, session)]) { scmChanges.delete(vpath(branch, session)); renderScm(); return [T('Updated 1 path from the index')]; }
    if (creating && !topic.branches.includes(branch)) topic.branches.push(branch);
    if (!topic.branches.includes(branch)) return { code: 1, lines: [T("error: pathspec '" + branch + "' did not match any file(s) known to git", 'err')] };
    topic.branch = branch; branchEl.innerHTML = '⑂ ' + esc(branch) + '<span id="autodot"> ●</span>'; updatePrompt();
    return [T((creating ? 'Switched to a new branch ' : 'Switched to branch ') + "'" + branch + "'")].concat(creating ? [] : [T("Your branch is up to date with 'origin/" + branch + "'.")]);
  }
  if (sub === 'add') { if (!args[2]) return { code: 1, lines: [T('Nothing specified, nothing added.', 'err'), T('hint: Maybe you wanted to say \'git add .\'?', 'dim')] }; return []; }
  if (sub === 'commit') {
    const i = args.indexOf('-m');
    if (i < 0 || !args[i + 1]) return { code: 1, lines: [T('Aborting commit due to empty commit message.', 'err'), T('hint: use git commit -m "message"', 'dim')] };
    if (!scmChanges.size && !args.includes('--allow-empty')) return [T('On branch ' + topic.branch), T('nothing to commit, working tree clean')];
    const hash = rand(0x1000000, 0xfffffff).toString(16), count = scmChanges.size;
    topic.commits.unshift([hash.slice(0, 7), args[i + 1], 'You', 'just now']); topic.commits = topic.commits.slice(0, 60);
    const changed = [...scmChanges];
    scmChanges.clear(); aheadCount++; $('commitmsg').value = ''; renderScm(); renderSync(); renderTabs(); noteCommit();
    return [T('[' + topic.branch + ' ' + hash.slice(0, 7) + '] ' + args[i + 1]), T(' ' + count + ' file' + (count > 1 ? 's' : '') + ' changed, ' + rand(4, 120) + ' insertions(+), ' + rand(1, 30) + ' deletions(-)')].concat(changed.slice(0, 4).map(p => T(' ' + (REG[p] ? 'rewrite' : 'create mode 100644') + ' ' + p, 'dim')));
  }
  if (sub === 'push') {
    if (!aheadCount) return [T('Everything up-to-date')];
    const pushed = aheadCount;
    append(session, 'Enumerating objects: ' + rand(8, 40) + ', done.', 'dim'); await sleep(350);
    append(session, 'Counting objects: 100% (' + rand(8, 40) + '/' + rand(8, 40) + '), done.', 'dim'); await sleep(250);
    append(session, 'Writing objects: 100% (' + rand(5, 20) + '/' + rand(5, 20) + '), ' + (rand(20, 320) / 10).toFixed(2) + ' KiB | ' + rand(1, 9) + '.' + rand(10, 99) + ' MiB/s, done.', 'dim'); await sleep(450);
    aheadCount = 0; renderSync();
    return [T('To ' + topic.remote), T('   ' + rand(0x100000, 0xffffff).toString(16) + '..' + rand(0x100000, 0xffffff).toString(16) + '  ' + topic.branch + ' -> ' + topic.branch), T('(' + pushed + ' commit' + (pushed > 1 ? 's' : '') + ' pushed. CI will have opinions shortly.)', 'dim')];
  }
  if (sub === 'pull' || sub === 'fetch') {
    append(session, 'remote: Enumerating objects: ' + rand(20, 200) + ', done.', 'dim'); await sleep(500);
    append(session, 'From ' + topic.remote); await sleep(200);
    const out = [H('   <span class="dim">' + rand(0x100000, 0xffffff).toString(16) + '..' + rand(0x100000, 0xffffff).toString(16) + '</span>  main       -&gt; origin/main')];
    if (sub === 'pull') out.push(T('Already up to date.'));
    return out;
  }
  if (sub === 'stash') {
    const op = args[2] || 'push';
    if (op === 'list') return gitStash.map((s, i) => T('stash@{' + i + '}: WIP on ' + s.branch + ': ' + s.hash + ' ' + s.msg));
    if (op === 'pop' || op === 'apply') { const s = gitStash.shift(); if (!s) return { code: 1, lines: [T('No stash entries found.', 'err')] }; s.files.forEach(p => REG[p] && scmChanges.add(p)); renderScm(); return [T('On branch ' + topic.branch), ...s.files.map(p => H('\t<span class="err">modified:   ' + esc(p) + '</span>')), T('Dropped refs/stash@{0} (' + s.hash + ')')]; }
    if (!scmChanges.size) return [T('No local changes to save')];
    const entry = { branch: topic.branch, hash: rand(0x100000, 0xffffff).toString(16), msg: topic.commits[0] ? topic.commits[0][1] : 'work', files: [...scmChanges] };
    gitStash.unshift(entry); scmChanges.clear(); renderScm();
    return [T('Saved working directory and index state WIP on ' + topic.branch + ': ' + entry.hash + ' ' + entry.msg)];
  }
  if (sub === 'blame') {
    const path = vpath(args[2] || '', session); const f = REG[path];
    if (!f) return { code: 1, lines: [T("fatal: no such path '" + (args[2] || '') + "' in HEAD", 'err')] };
    return f.content.split('\n').slice(0, 40).map((l, i) => { const c = topic.commits[(pathHash(path) + i * 7) % topic.commits.length]; return H('<span class="warn">' + esc(c[0]) + '</span> (<span class="info">' + esc(c[2].padEnd(16).slice(0, 16)) + '</span> ' + esc(fakeMtime(path + i).toISOString().slice(0, 10)) + ' ' + String(i + 1).padStart(3) + ') ' + esc(l)); });
  }
  if (sub === 'remote') return args.includes('-v') ? [T('origin\tgit@' + topic.remote + '.git (fetch)'), T('origin\tgit@' + topic.remote + '.git (push)')] : [T('origin')];
  if (sub === 'show') { const c = topic.commits[0]; return [H('<span class="warn">commit ' + esc(c[0]) + '</span>'), T('Author: ' + c[2]), T('Date:   ' + c[3]), T(''), T('    ' + c[1]), T('')].concat(scmChanges.size ? gitDiffFor([...scmChanges][0]) : (rotation[0] ? gitDiffFor(rotation[0]) : [])); }
  if (sub === 'tag') return args[2] ? [] : ['v' + topic.version.replace(/\.\d+$/, '.0'), 'v' + topic.version].map(t => T(t));
  if (sub === 'rev-parse') return [T(args.includes('--abbrev-ref') ? topic.branch : rand(0x10000000, 0xffffffff).toString(16) + rand(0x10000000, 0xffffffff).toString(16) + rand(0x10000000, 0xffffffff).toString(16))];
  if (sub === 'config') return args[2] === 'user.name' ? [T(shellInfo().user)] : args[2] === '--list' ? [T('user.name=' + shellInfo().user), T('user.email=' + shellInfo().user + '@' + topic.remote.split(':')[0].replace(/^git(lab|hub)\./, '')), T('core.autocrlf=input'), T('pull.rebase=true')] : [];
  if (sub === 'clone') return { code: 128, lines: [T("fatal: destination path already exists and is not an empty directory. also: you are already inside a repository.", 'err')] };
  if (sub === 'rebase' || sub === 'merge') return [T('Already up to date.')];
  if (sub === 'restore' || sub === 'reset') { scmChanges.clear(); renderScm(); return [] ; }
  return { code: 1, lines: [T("git: '" + sub + "' is not a git command. See 'git --help'.", 'err')] };
});

/* ---- toolchain versions / info ---- */
const VERSIONS = {
  node: 'v20.14.0', npm: '10.7.0', pnpm: '9.6.0', yarn: '1.22.22', bun: '1.1.20', npx: '10.7.0', python: 'Python 3.11.9', python3: 'Python 3.11.9', pip: 'pip 24.0 from /usr/lib/python3.11/site-packages/pip (python 3.11)', pip3: 'pip 24.0',
  go: 'go version go1.22.5 linux/amd64', cargo: 'cargo 1.79.0 (ffa9cf99a 2024-06-03)', rustc: 'rustc 1.79.0 (129f3b996 2024-06-10)', java: 'openjdk 21.0.3 2024-04-16 LTS', javac: 'javac 21.0.3', mvn: 'Apache Maven 3.9.8', gradle: 'Gradle 8.8',
  docker: 'Docker version 27.0.3, build 7d4bcd8', kubectl: 'Client Version: v1.30.2\nKustomize Version: v5.0.4\nServer Version: v1.29.6-eks-1552ad0', terraform: 'Terraform v1.9.2\non linux_amd64', helm: 'version.BuildInfo{Version:"v3.15.3"}', ansible: 'ansible [core 2.17.2]',
  cmake: 'cmake version 3.29.6', ninja: '1.12.1', gcc: 'gcc (GCC) 14.1.1', 'g++': 'g++ (GCC) 14.1.1', clang: 'clang version 18.1.8', 'clang++': 'clang version 18.1.8', dbt: 'Core:\n  - installed: 1.8.3\n  - latest:    1.8.3 - Up to date!', spark: 'version 3.5.1', airflow: '2.9.3', solc: 'solc, the solidity compiler commandline interface\nVersion: 0.8.24+commit.e11b9ed9.Linux.g++', tsc: 'Version 5.5.3', git: 'git version 2.45.2', bash: 'GNU bash, version 5.2.21(1)-release (x86_64-pc-linux-gnu)', probe: 'probe-rs 0.24.0', adb: 'Android Debug Bridge version 1.0.41', xcodebuild: 'Xcode 15.4\nBuild version 15F31d', pod: '1.15.2', flutter: 'Flutter 3.22.2', swift: 'swift-driver version: 1.90.11.1',
};
for (const tool of Object.keys(VERSIONS)) {
  const prev = BUILTINS[tool];
  def(tool, 'toolchain: ' + tool, async ctx => {
    const a = ctx.args;
    if (a.length === 2 && /^(-v|--version|-V|version|-version|--v)$/.test(a[1])) return VERSIONS[tool].split('\n').map(l => T(l));
    if (tool === 'node' && a[1] === '-e') { try { return [T(String(Function('"use strict"; return (' + a.slice(2).join(' ') + ')')()))]; } catch (e) { return { code: 1, lines: [T(e.name + ': ' + e.message, 'err')] }; } }
    if ((tool === 'node' || tool === 'python' || tool === 'python3') && a.length === 1) return [T(tool === 'node' ? 'Welcome to Node.js ' + VERSIONS.node + '.\nType ".help" for more information.\n> (interactive REPLs are not simulated; use node -e "1 + 1")' : VERSIONS.python + ' (main, Jun 2024)\n>>> (interactive REPLs are not simulated; run a file instead)', 'dim')];
    if (tool === 'docker') return dockerCmd(ctx);
    if (tool === 'kubectl') return kubectlCmd(ctx);
    if (prev) return prev(ctx);
    const code = await runJobFor(ctx.session, ctx.raw);
    if (code === 127) return { code: 127, lines: [T(tool + ': unknown subcommand or arguments: ' + a.slice(1).join(' '), 'err'), T('(try "' + tool + ' --version" or one of the project tasks in Terminal → Run Task)', 'dim')] };
    return { code, lines: [] };
  });
}

function dockerCmd({ args, topic }) {
  const sub = args[1];
  const containers = topic.ports.map((p, i) => ['c' + (pathHash(topic.project + p[0]) % 0xfffff).toString(16).padStart(5, 'a') + rand(1000, 9999), p[2] + ':latest', '"' + (p[2] === 'node' ? 'npm run dev' : p[2]) + '"', rand(1, 9) + ' hours ago', 'Up ' + rand(1, 9) + ' hours', '0.0.0.0:' + p[0] + '->' + p[0] + '/tcp', topic.project + '-' + p[2] + '-' + (i + 1)]);
  if (sub === 'ps') return table([['CONTAINER ID', 'IMAGE', 'COMMAND', 'CREATED', 'STATUS', 'PORTS', 'NAMES'], ...containers], i => i === 0 ? 'bright' : '');
  if (sub === 'images' || sub === 'image') return table([['REPOSITORY', 'TAG', 'IMAGE ID', 'CREATED', 'SIZE'], [topic.image, 'dev', rand(0x10000000, 0xffffffff).toString(16).slice(0, 12), '2 hours ago', rand(120, 900) + 'MB'], [topic.image, topic.version, rand(0x10000000, 0xffffffff).toString(16).slice(0, 12), '3 days ago', rand(120, 900) + 'MB'], ['postgres', '16', 'f2b8b0a3c1d4', '5 weeks ago', '432MB'], ['redis', '7-alpine', '7f3c1e9a2b10', '5 weeks ago', '41MB']], i => i === 0 ? 'bright' : '');
  if (sub === 'logs') return [T(new Date().toISOString() + ' info: ' + topic.project + ' listening on :' + topic.ports[0][0]), T(new Date().toISOString() + ' info: connected to ' + (topic.dbLine || 'upstream')), T(new Date().toISOString() + ' warn: healthcheck took 412ms (threshold 300ms). shrug.', 'warn')];
  if (sub === 'stop' || sub === 'rm' || sub === 'kill') return [T(args[2] || containers[0][6])];
  if (sub === 'compose') return null; // handled by job
  if (sub === 'info') return [T('Client: Docker Engine - Community'), T(' Version:    27.0.3'), T(' Context:    default'), T('Server:'), T(' Containers: ' + containers.length), T(' Images: 24'), T(' Storage Driver: overlay2'), T(' Total Memory: 31.3GiB')];
  return null;
}
function kubectlCmd({ args, topic }) {
  const sub = args[1], kind = (args[2] || '').replace(/s$/, '');
  const pods = [1, 2, 3].map(i => [topic.deployName + '-' + rand(0x100000, 0xffffff).toString(16).slice(0, 9) + '-' + Math.random().toString(36).slice(2, 7), '1/1', 'Running', String(rand(0, 2)), rand(2, 40) + 'h']);
  if (sub === 'get' && (kind === 'pod' || kind === 'po')) return table([['NAME', 'READY', 'STATUS', 'RESTARTS', 'AGE'], ...pods], i => i === 0 ? 'bright' : '');
  if (sub === 'get' && (kind === 'deployment' || kind === 'deploy')) return table([['NAME', 'READY', 'UP-TO-DATE', 'AVAILABLE', 'AGE'], [topic.deployName, '3/3', '3', '3', rand(3, 90) + 'd']], i => i === 0 ? 'bright' : '');
  if (sub === 'get' && (kind === 'svc' || kind === 'service')) return table([['NAME', 'TYPE', 'CLUSTER-IP', 'EXTERNAL-IP', 'PORT(S)', 'AGE'], [topic.deployName, 'ClusterIP', '10.100.' + rand(0, 255) + '.' + rand(1, 254), '<none>', topic.ports[0][0] + '/TCP', rand(3, 90) + 'd']], i => i === 0 ? 'bright' : '');
  if (sub === 'get' && (kind === 'ns' || kind === 'namespace')) return table([['NAME', 'STATUS', 'AGE'], [topic.namespace, 'Active', '212d'], ['kube-system', 'Active', '380d'], ['monitoring', 'Active', '301d']], i => i === 0 ? 'bright' : '');
  if (sub === 'get' && (kind === 'node')) return table([['NAME', 'STATUS', 'ROLES', 'AGE', 'VERSION'], ['ip-10-40-1-12.internal', 'Ready', '<none>', '41d', 'v1.29.6-eks'], ['ip-10-40-2-77.internal', 'Ready', '<none>', '41d', 'v1.29.6-eks'], ['ip-10-40-3-140.internal', 'Ready', '<none>', '12d', 'v1.29.6-eks']], i => i === 0 ? 'bright' : '');
  if (sub === 'config') return [T(args[2] === 'current-context' ? topic.namespace.replace(/-.*/, '') + '-eu-central-1' : 'apiVersion: v1\ncurrent-context: ' + topic.namespace.replace(/-.*/, '') + '-eu-central-1')];
  if (sub === 'logs') return [T('{"level":"info","ts":"' + new Date().toISOString() + '","msg":"listening","port":' + topic.ports[0][0] + '}'), T('{"level":"info","ts":"' + new Date().toISOString() + '","msg":"healthz ok","latency_ms":' + rand(2, 40) + '}')];
  if (sub === 'describe') return [T('Name:         ' + topic.deployName), T('Namespace:    ' + topic.namespace), T('Replicas:     3 desired | 3 updated | 3 total | 3 available | 0 unavailable'), T('StrategyType: RollingUpdate'), T('Conditions:'), T('  Type           Status  Reason'), T('  Available      True    MinimumReplicasAvailable'), T('  Progressing    True    NewReplicaSetAvailable')];
  if (sub === 'version') return VERSIONS.kubectl.split('\n').map(l => T(l));
  return null;
}
def('docker', 'container tooling', async ctx => { const r = dockerCmd(ctx); if (r) return r; const code = await runJobFor(ctx.session, ctx.raw); return { code, lines: code === 127 ? [T('docker: unknown command: ' + ctx.args.slice(1).join(' '), 'err')] : [] }; });
def('kubectl k', 'kubernetes cli', async ctx => { const r = kubectlCmd(ctx); if (r) return r; const code = await runJobFor(ctx.session, ctx.raw); return { code, lines: code === 127 ? [T('error: unknown command "' + ctx.args.slice(1).join(' ') + '"', 'err')] : [] }; });

/* ---- processes ---- */
function fakeProcs(topic) {
  const sh = shellInfo();
  const base = [['root', '1', '0.0', '0.1', '/sbin/init'], ['root', '412', '0.0', '0.3', '/usr/lib/systemd/systemd-journald'], [sh.user, '1720', '0.2', '1.4', '/usr/bin/gnome-shell'], [sh.user, '2210', '1.8', '6.2', '/usr/share/code/code --type=renderer'], [sh.user, '2251', '0.4', '2.1', '/usr/share/code/code --type=utility --utility-sub-type=node.mojom.NodeService'], [sh.user, '2394', '0.0', '0.1', '/bin/bash']];
  topic.ports.forEach((p, i) => base.push([sh.user, String(2600 + i * 37), (rand(1, 30) / 10).toFixed(1), (rand(5, 60) / 10).toFixed(1), (p[2] === 'node' ? 'node ' + (topic.scripts[0] ? topic.scripts[0][1] : 'server.js') : p[2]) + '  # :' + p[0]]));
  base.push([sh.user, String(3000 + rand(1, 900)), '0.0', '0.0', 'ps aux']);
  return base;
}
def('ps', 'report a snapshot of processes', ({ topic }) => table([['USER', 'PID', '%CPU', '%MEM', 'COMMAND'], ...fakeProcs(topic)], i => i === 0 ? 'bright' : ''));
def('top htop btop', 'display processes', async ({ session, topic }) => {
  const header = appendHtml(session, '');
  const body = appendHtml(session, '');
  const epoch = session.epoch;
  for (let i = 0; i < 6; i++) {
    const procs = fakeProcs(topic).map(p => [p[1], p[0], '20', '0', (rand(80, 900) * 1000).toLocaleString(), (rand(40, 400) * 1000).toLocaleString(), 'S', (rand(0, 40) / 10).toFixed(1), p[3], '0:' + String(rand(1, 59)).padStart(2, '0') + '.' + rand(10, 99), p[4]]).sort((a, b) => b[7] - a[7]);
    header.innerHTML = '<span class="bright">top - ' + nowStr() + ' up  4:32,  1 user,  load average: ' + (0.4 + Math.random()).toFixed(2) + ', ' + (0.5 + Math.random()).toFixed(2) + ', 0.61</span>\nTasks: <span class="bright">' + (180 + rand(0, 20)) + '</span> total,   <span class="bright">' + rand(1, 3) + '</span> running, ' + (177 + rand(0, 20)) + ' sleeping,   0 stopped,   0 zombie\n%Cpu(s):  <span class="bright">' + (rand(20, 120) / 10).toFixed(1) + '</span> us,  ' + (rand(5, 30) / 10).toFixed(1) + ' sy,  0.0 ni, ' + (rand(850, 940) / 10).toFixed(1) + ' id,  0.1 wa,  0.0 hi,  0.1 si,  0.0 st\nMiB Mem :  32000.0 total,   8120.4 free,  11234.9 used,  12644.7 buff/cache\n\n<span class="bright">    PID USER      PR  NI    VIRT    RES S  %CPU  %MEM     TIME+ COMMAND</span>';
    body.innerHTML = procs.slice(0, 10).map(p => esc(p[0].padStart(7) + ' ' + p[1].padEnd(9) + p[2].padStart(3) + p[3].padStart(4) + p[4].padStart(9) + p[5].padStart(8) + ' ' + p[6] + p[7].padStart(6) + p[8].padStart(6) + p[9].padStart(10) + ' ' + p[10])).join('\n') + (i < 5 ? '\n<span class="dim">refreshing… (q or Ctrl+C to quit)</span>' : '');
    termEl.scrollTop = termEl.scrollHeight;
    await sleep(1200);
    if (session.epoch !== epoch) return { code: 130, lines: [] };
  }
  body.innerHTML += '\n<span class="dim">top: session ended after 6 refreshes.</span>';
  return [];
});
def('kill pkill killall', 'terminate a process', ({ args }) => args[1] ? [] : { code: 1, lines: [T('usage: kill [-s signal] pid…', 'err')] });

/* ---- network ---- */
def('ping', 'send ICMP ECHO_REQUEST to network hosts', async ({ session, args }) => {
  const host = args.slice(1).find(a => !a.startsWith('-'));
  if (!host) return { code: 2, lines: [T('ping: usage error: Destination address required', 'err')] };
  const ip = /^\d+\.\d+\.\d+\.\d+$/.test(host) ? host : (host === 'localhost' ? '127.0.0.1' : (10 + pathHash(host) % 200) + '.' + (pathHash(host + '1') % 255) + '.' + (pathHash(host + '2') % 255) + '.' + (1 + pathHash(host + '3') % 250));
  append(session, 'PING ' + host + ' (' + ip + ') 56(84) bytes of data.');
  const epoch = session.epoch; const times = [];
  for (let i = 1; i <= 4; i++) {
    await sleep(900); if (session.epoch !== epoch) return { code: 130, lines: [] };
    const t = host === 'localhost' ? (0.03 + Math.random() * 0.05) : (8 + Math.random() * 30 + pathHash(host) % 40);
    times.push(t);
    append(session, '64 bytes from ' + ip + ': icmp_seq=' + i + ' ttl=' + (host === 'localhost' ? 64 : 57) + ' time=' + t.toFixed(2) + ' ms');
  }
  const min = Math.min(...times), max = Math.max(...times), avg = times.reduce((a, b) => a + b) / 4;
  return [T(''), T('--- ' + host + ' ping statistics ---'), T('4 packets transmitted, 4 received, 0% packet loss, time 3004ms'), T('rtt min/avg/max/mdev = ' + min.toFixed(3) + '/' + avg.toFixed(3) + '/' + max.toFixed(3) + '/' + ((max - min) / 4).toFixed(3) + ' ms')];
});
def('curl wget http', 'transfer a URL', async ({ session, args, topic }) => {
  const url = args.slice(1).find(a => !a.startsWith('-')) || '';
  if (!url) return { code: 2, lines: [T(args[0] + ': try \'' + args[0] + ' --help\' for more information', 'err')] };
  await sleep(rand(120, 600));
  const port = (url.match(/:(\d+)/) || [])[1];
  const local = /localhost|127\.0\.0\.1/.test(url);
  const verbose = args.includes('-v') || args.includes('-i') || args.includes('-I');
  const head = verbose ? [T('HTTP/1.1 200 OK', 'dim'), T('content-type: application/json; charset=utf-8', 'dim'), T('x-request-id: ' + rand(0x10000000, 0xffffffff).toString(16) + rand(0x10000000, 0xffffffff).toString(16), 'dim'), T('date: ' + new Date().toUTCString(), 'dim'), T('', 'dim')] : [];
  if (local) {
    const known = topic.ports.find(p => String(p[0]) === port);
    if (!known) return { code: 7, lines: [T(args[0] + ': (7) Failed to connect to localhost port ' + (port || 80) + ' after 3 ms: Connection refused', 'err')] };
    if (/health|ready|live|status|ping/.test(url)) return head.concat([T('{"status":"ok","service":"' + topic.project + '","version":"' + topic.version + '","uptime":' + rand(1000, 90000) + '}')]);
    return head.concat([T('{"service":"' + topic.project + '","port":' + port + ',"process":"' + known[2] + '","message":"' + known[1] + ' is listening. try /healthz"}')]);
  }
  if (/api\.github\.com|json|api\./.test(url)) return head.concat([T('{"ok":true,"data":[],"generated_at":"' + new Date().toISOString() + '","note":"this response never left the workspace"}')]);
  if (args[0] === 'wget') return [T('--' + new Date().toISOString().slice(0, 19) + '--  ' + url, 'dim'), T('Resolving ' + url.replace(/^https?:\/\//, '').split('/')[0] + '… 93.184.216.34', 'dim'), T('HTTP request sent, awaiting response… 200 OK', 'dim'), T('Length: ' + rand(2000, 90000) + ' (' + rand(2, 90) + 'K) [text/html]', 'dim'), T("Saving to: '" + (url.split('/').pop() || 'index.html') + "'", 'dim'), T(''), T((url.split('/').pop() || 'index.html') + '   100%[===================>]  ' + rand(2, 90) + '.' + rand(10, 99) + 'K  --.-KB/s    in 0.02s', 'ok')];
  return head.concat([T('<!doctype html>'), T('<html><head><title>' + url.replace(/^https?:\/\//, '').split('/')[0] + '</title></head>'), T('<body><h1>It works.</h1><p>Simulated response. No packets were harmed.</p></body></html>')]);
});
def('ssh scp sftp telnet', 'remote login', async ({ session, args }) => {
  const host = args.slice(1).find(a => !a.startsWith('-')) || 'remote';
  if (/towel\.blinkenlights/.test(host)) return [T('      /~\\', ''), T("     ( oo )  A long time ago in a galaxy far, far away..."), T('     _\\=/_'), T('    /  _  \\   (the movie has been rotated out of production)', 'dim')];
  const epoch = session.epoch;
  append(session, 'Connecting to ' + host.replace(/^.*@/, '') + '…', 'dim');
  for (let i = 0; i < 3; i++) { await sleep(1100); if (session.epoch !== epoch) return { code: 130, lines: [] }; }
  return { code: 255, lines: [T('ssh: connect to host ' + host.replace(/^.*@/, '') + ' port 22: Connection timed out', 'err'), T('(outbound connections are disabled in this workspace. the bastion is also on lunch.)', 'dim')] };
});
def('ifconfig ip', 'show network interfaces', () => [T('eth0: flags=4163<UP,BROADCAST,RUNNING,MULTICAST>  mtu 1500'), T('        inet 10.40.2.' + rand(10, 250) + '  netmask 255.255.255.0  broadcast 10.40.2.255'), T('        ether 02:42:0a:28:02:' + rand(10, 99) + '  txqueuelen 1000  (Ethernet)'), T('        RX packets ' + rand(100000, 9000000) + '  bytes ' + rand(100000000, 9000000000) + ' (' + rand(1, 9) + '.' + rand(1, 9) + ' GB)'), T(''), T('lo: flags=73<UP,LOOPBACK,RUNNING>  mtu 65536'), T('        inet 127.0.0.1  netmask 255.0.0.0')]);
def('netstat ss lsof', 'list open ports', ({ topic }) => table([['Proto', 'Local Address', 'State', 'PID/Program name'], ...topic.ports.map((p, i) => ['tcp', '0.0.0.0:' + p[0], 'LISTEN', (2600 + i * 37) + '/' + p[2]]), ['tcp', '127.0.0.1:631', 'LISTEN', '780/cupsd']], i => i === 0 ? 'bright' : ''));

/* ---- easter eggs (the terminal is allowed to have fun) ---- */
def('neofetch fastfetch screenfetch', 'show system information with a logo', ({ topic }) => {
  const sh = shellInfo();
  const logo = ['        .--.        ', '       |o_o |       ', '       |:_/ |       ', '      //   \\ \\      ', '     (|     | )     ', '    /\'\\_   _/`\\    ', '    \\___)=(___/    '];
  const info = [sh.user + '@' + sh.host, '-'.repeat((sh.user + '@' + sh.host).length), 'OS: FauxOS 26.04 LTS x86_64', 'Host: Relief Workstation', 'Kernel: 6.8.0-45-generic', 'Uptime: 4 hours, 32 mins', 'Packages: 2419 (dpkg), 84 (npm -g)', 'Shell: bash 5.2.21', 'Resolution: ' + screen.width + 'x' + screen.height, 'DE: Visual Studio Code', 'Terminal: workbench', 'CPU: Intel i9-13900K (32) @ 5.800GHz', 'GPU: NVIDIA GeForce RTX 4080', 'Memory: 11234MiB / 32000MiB', 'Project: ' + topic.project + ' (' + topic.branch + ')'];
  return info.map((line, i) => H('<span class="info">' + esc(logo[i] || ' '.repeat(20)) + '</span>  ' + (i === 0 ? '<span class="ok">' + esc(line) + '</span>' : esc(line))));
});
def('cowsay cowthink', 'a cow says things', ({ args }) => {
  const msg = args.slice(1).join(' ') || 'moo. also: the build is green.';
  const width = Math.min(60, msg.length);
  const words = msg.split(' '); const rows = []; let cur = '';
  for (const w of words) { if ((cur + ' ' + w).trim().length > width) { rows.push(cur.trim()); cur = w; } else cur += ' ' + w; }
  if (cur.trim()) rows.push(cur.trim());
  const w = Math.max(...rows.map(r => r.length));
  const out = [T(' ' + '_'.repeat(w + 2))];
  rows.forEach((r, i) => out.push(T((rows.length === 1 ? '< ' : i === 0 ? '/ ' : i === rows.length - 1 ? '\\ ' : '| ') + r.padEnd(w) + (rows.length === 1 ? ' >' : i === 0 ? ' \\' : i === rows.length - 1 ? ' /' : ' |'))));
  out.push(T(' ' + '-'.repeat(w + 2)), T('        \\   ^__^'), T('         \\  (oo)\\_______'), T('            (__)\\       )\\/\\'), T('                ||----w |'), T('                ||     ||'));
  return out;
});
def('fortune', 'print a random, hopefully interesting, adage', () => [T(pick(['The best code is the code you did not have to write. The second best is the code the intern wrote.', 'A deadline is a date by which the plan will change.', 'It compiles. Ship it. (— someone, moments before the incident)', 'Every 100% CPU has a story. Usually a while(true).', 'Documentation is a love letter to your future self. Most of us are single.', 'The bug is not in the code. The bug is in the assumptions. The assumptions are in the code.', 'Weeks of coding can save you hours of planning.', 'Tabs vs spaces was never about tabs or spaces.', 'On the seventh day, the sprint ended and there was retrospective.', 'You are not paid to type. You are paid to have typed the right thing.']))]);
def('sl', 'steam locomotive', async ({ session }) => {
  const frames = [['      ====        ________                ___________ ', '  _D _|  |_______/        \\__I_I_____===__|_________| ', '   |(_)---  |   H\\________/ |   |        =|___ ___|   ', '   /     |  |   H  |  |     |   |         ||_| |_||   ', '  |      |  |   H  |__--------------------| [___] |   ', '  | ________|___H__/__|_____/[][]~\\_______|       |   ', '  |/ |   |-----------I_____I [][] []  D   |=======|__ ', '__/ =| o |=-~~\\  /~~\\  /~~\\  /~~\\ ____Y___________|__ ', ' |/-=|___|=    ||    ||    ||    |_____/~\\___/        ', '  \\_/      \\O=====O=====O=====O_/      \\_/            ']];
  const rows = frames[0].map(() => appendHtml(session, ''));
  const epoch = session.epoch;
  for (let shift = 60; shift >= -70; shift -= 6) {
    rows.forEach((row, i) => { const line = frames[0][i]; row.innerHTML = '<span class="warn">' + esc(shift >= 0 ? ' '.repeat(shift) + line : line.slice(-shift)) + '</span>'; });
    termEl.scrollTop = termEl.scrollHeight;
    await sleep(90);
    if (session.epoch !== epoch) break;
  }
  return [T('(you meant ls. everyone means ls.)', 'dim')];
});
def('matrix cmatrix', 'follow the white rabbit', async ({ session }) => {
  const rows = Array.from({ length: 12 }, () => appendHtml(session, ''));
  const epoch = session.epoch; const cols = 70; const chars = 'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄ0123456789';
  const heads = Array.from({ length: cols }, () => rand(-12, 12));
  for (let f = 0; f < 36; f++) {
    for (let r = 0; r < 12; r++) {
      let html = '';
      for (let c = 0; c < cols; c++) { const d = heads[c] - r; html += d === 0 ? '<span class="bright">' + chars[rand(0, chars.length - 1)] + '</span>' : d > 0 && d < 7 ? '<span class="ok">' + chars[rand(0, chars.length - 1)] + '</span>' : ' '; }
      rows[r].innerHTML = html;
    }
    heads.forEach((h, i) => { heads[i] = h > 18 ? rand(-10, 0) : h + 1; });
    termEl.scrollTop = termEl.scrollHeight;
    await sleep(110);
    if (session.epoch !== epoch) break;
  }
  return [T('Wake up.', 'dim')];
});
def('hello hi hey', 'greeting', () => [T('Hello, ' + shellInfo().user + '. Everything is fine. The build is green. Nobody is looking.', 'dim')]);
def('coffee', 'brew coffee', () => ({ code: 418, lines: [T("HTTP 418: I'm a teapot", 'warn'), T('(the espresso machine is on a separate VLAN)', 'dim')] }));
def('zen ambient chill', 'open the ambient view (Esc to close)', ({ args }) => { openZen(args[1]); return [T('ambient view opened. press Esc to come back.', 'dim')]; });
def('stats score xp', 'show typing metrics', () => {
  const accuracy = metrics.correct + metrics.mistakes ? Math.round(metrics.correct / (metrics.correct + metrics.mistakes) * 100) : 100;
  return [H('<span class="bright">DevMetrics · local</span>'), T('level      ' + levelOf(metrics.xp) + '  (' + RANKS[Math.min(RANKS.length - 1, levelOf(metrics.xp) - 1)] + ')'), T('xp         ' + metrics.xp), T('accuracy   ' + accuracy + '%   (' + metrics.correct + ' correct, ' + metrics.mistakes + ' misses)'), T('streak     ' + streak + '   best ' + metrics.best), T('lines      ' + metrics.challenges + ' completed in exact mode'), T('bugs       ' + bugData.c + ' resolved today'), T('commands   ' + commandsRun + ' this session'), T(''), T('exact mode is ' + (settings.strict ? 'ON' : 'off') + '. toggle with "focus on|off" or Ctrl+Alt+G. type "achievements" for the trophy shelf.', 'dim')];
});
def('focus exact', 'toggle exact typing mode', ({ args }) => { const want = args[1] === 'on' ? true : args[1] === 'off' ? false : !settings.strict; if (want !== settings.strict) toggleStrict(); return [T('exact input ' + (settings.strict ? 'enabled: type the faint // @trace line character by character.' : 'disabled: any key advances the code.'), 'dim')]; });
def('achievements trophies', 'show unlocked achievements', () => ACHIEVEMENTS.map(a => H((unlocked.has(a.id) ? '<span class="ok">★</span> ' : '<span class="dim">☆</span> ') + (unlocked.has(a.id) ? '<span class="bright">' + esc(a.title) + '</span>' : '<span class="dim">' + esc(a.title) + '</span>') + '  <span class="dim">' + esc(a.hint) + '</span>')));
def('yes', 'output a string repeatedly', ({ args }) => Array.from({ length: 30 }, () => T(args[1] || 'y')).concat([T('(yes: stopped after 30 lines. nobody deserves more than that.)', 'dim')]));
def('whatis', 'describe a command', ({ args }) => args[1] && CMD_HELP[args[1]] ? [T(args[1] + ' (1)  - ' + CMD_HELP[args[1]])] : { code: 1, lines: [T((args[1] || '') + ': nothing appropriate.', 'err')] });

/* ================= running jobs ================= */

function jobFor(command) {
  const args = command.split(/\s+/);
  const job = detectJob(command, args);
  if (job) return job;
  const script = /^(npm|pnpm|yarn|bun)\s+(run\s+)?(\S+)/.exec(command);
  if (script && TOPIC.scripts.some(s => s[0] === script[3])) return TOPIC.jobs[0];
  return null;
}

async function runJobFor(session, command) {
  const job = jobFor(command);
  if (!job) return 127;
  return executeJob(session, job, command, TOPIC);
}

executeJob = async function (session, job, command, topic, ambient) {
  const epoch = ++session.epoch, gen = topicGen;
  session.busy = true; session.aborted = false;
  if (session === currentSession) updatePrompt();
  renderTerminalTools();
  logOutput('Started ' + command);
  const style = line => /PASS|SUCCESS|success|Successfully|complete|Finished|✓|passed/.test(line) ? 'ok' : /warn/i.test(line) ? 'warn' : /error|fail/i.test(line) ? 'err' : '';
  try {
    const fn = JOBLIB[job];
    if (fn && !jobLock) {
      jobLock = { session, epoch, ambient: !!ambient };
      try { await fn(topic, gen); } catch (e) { /* cancelled or topic switched */ }
      finally { if (jobLock && jobLock.session === session) jobLock = null; }
    } else {
      const lines = jobLines(job, command, topic);
      if (ambient) appendHtml(session, '<span class="dim">' + nowStr() + '</span>  <span class="mag">$</span> ' + esc(command));
      for (const line of lines.slice(1)) {
        await sleep(line ? 120 + Math.random() * 220 : 60);
        if (session.epoch !== epoch || gen !== topicGen || !sessions.includes(session)) return 130;
        append(session, line, style(line));
      }
    }
    if (session.epoch !== epoch || gen !== topicGen) return 130;
    if (!ambient) append(session, 'Process exited with code 0', 'dim');
    logOutput('Completed ' + command + ' · exit 0');
    return 0;
  } finally {
    if (session.epoch === epoch) { session.busy = false; if (session === currentSession) updatePrompt(); renderTerminalTools(); }
  }
};

/* ================= the command loop ================= */

const PIPE_FILTERS = new Set(['grep', 'rg', 'egrep', 'head', 'tail', 'wc', 'sort', 'uniq', 'cat', 'less', 'more', 'nl', 'tee', 'cut', 'tr', 'xargs']);

function applyFilter(name, args, input) {
  const { opts, params } = flags(args.slice(1));
  const text = input.map(lineText);
  if (name === 'sort') { const s = text.slice().sort(opts.has('n') ? (a, b) => parseFloat(a) - parseFloat(b) : undefined); if (opts.has('r')) s.reverse(); return s.map(l => T(l)); }
  if (name === 'uniq') { const out = []; let prev = null, count = 0; for (const l of text.concat([null])) { if (l === prev) { count++; continue; } if (prev !== null) out.push(T(opts.has('c') ? String(count).padStart(7) + ' ' + prev : prev)); prev = l; count = 1; } return out; }
  if (name === 'nl') return text.map((l, i) => T(String(i + 1).padStart(6) + '\t' + l));
  if (name === 'cut') { const d = args[args.indexOf('-d') + 1] || '\t'; const f = Number((args[args.indexOf('-f') + 1] || '1')) - 1; return text.map(l => T(l.split(d)[f] || '')); }
  if (name === 'tr') { const from = params[0] || '', to = params[1] || ''; return text.map(l => T(from === 'a-z' ? l.toUpperCase() : from === 'A-Z' ? l.toLowerCase() : l.split(from).join(to))); }
  if (name === 'tee') return input;
  if (name === 'xargs') return [T(text.join(' '))];
  return null;
}

runCommand = async function (raw, opts) {
  const session = (opts && opts.session) || currentSession;
  const topic = TOPIC;
  const line = String(raw || '').trim();
  if (!session || !topic) return;
  session.lastActive = Date.now();
  if (session.busy) {
    if (jobLock && jobLock.session === session && jobLock.ambient) { session.epoch++; jobLock = null; session.busy = false; append(session, '^C', 'dim'); }
    else { showToast('A task is still running here. Press Ctrl+C to stop it or open a new terminal.', 'Terminal'); return; }
  }
  appendHtml(session, promptHtml(session) + ' ' + esc(line));
  $('terminput').value = ''; session.draft = '';
  if (!line) return;
  session.history.push(line); session.history = session.history.slice(-200); session.historyIndex = session.history.length;
  commandsRun++;
  checkAchievements();
  let last = 0;
  const epoch = ++session.epoch;
  session.busy = true; renderTerminalTools(); updatePrompt();
  try {
    for (const seg of splitChain(line)) {
      if (seg.op === '&&' && last !== 0) continue;
      if (seg.op === '||' && last === 0) continue;
      last = await runPipeline(session, seg.cmd, topic);
      if (!sessions.includes(session) || session.epoch !== epoch) { last = 130; break; }
    }
  } finally {
    if (session.epoch === epoch) { session.busy = false; renderTerminalTools(); }
  }
  session.lastExitCode = last; session.exitCode = last;
  if (session === currentSession) updatePrompt();
};

async function runPipeline(session, cmd, topic) {
  const { stage: firstRaw, redirect } = parseRedirect(cmd);
  const stages = splitPipes(firstRaw);
  let input = null, code = 0;
  for (let i = 0; i < stages.length; i++) {
    const raw = stages[i];
    const args = argv(raw, session);
    if (!args.length) continue;
    const name = args[0];
    const isLast = i === stages.length - 1;
    if (i > 0 && input && applyFilter(name, args, input)) { input = applyFilter(name, args, input); continue; }
    const fn = BUILTINS[name];
    let result;
    if (fn) {
      try { result = await fn({ session, topic, args, raw, input }); }
      catch (e) { result = { code: 1, lines: [T(name + ': ' + e.message, 'err')] }; }
    } else if (/^\.\/|\.sh$/.test(name)) {
      const path = vpath(name, session);
      result = REG[path] ? [T('+ running ' + name, 'dim'), T('done.', 'dim')] : { code: 127, lines: [T('bash: ' + name + ': No such file or directory', 'err')] };
    } else if (/^[A-Za-z_]\w*=/.test(raw)) {
      const [k, ...v] = raw.split('='); session.env[k] = v.join('='); result = [];
    } else {
      const c = await runJobFor(session, raw);
      if (c === 127) result = { code: 127, lines: [T('bash: ' + name + ': command not found', 'err')].concat(suggest(name)) };
      else result = { code: c, lines: [] };
    }
    if (!sessions.includes(session)) return 130;
    const lines = Array.isArray(result) ? result : (result.lines || []);
    code = Array.isArray(result) ? 0 : (result.code || 0);
    if (!isLast) {
      // stderr is not piped: show errors from an inner stage, pass an empty stream on
      if (code !== 0) { emit(session, lines); input = []; } else input = lines;
      continue;
    }
    if (redirect) {
      const path = vpath(redirect.target, session);
      const text = lines.map(lineText).join('\n') + (lines.length ? '\n' : '');
      createFile(path, redirect.mode === '>>' && REG[path] ? REG[path].content + text : text);
    } else emit(session, lines);
  }
  return code;
}

function suggest(name) {
  const pool = Object.keys(BUILTINS).concat(Object.values(JOB_COMMANDS).map(c => c.split(' ')[0]));
  const near = pool.filter(c => c.length > 2 && (c.startsWith(name.slice(0, 2)) || name.startsWith(c.slice(0, 2))) && Math.abs(c.length - name.length) <= 2).slice(0, 3);
  return near.length ? [T('Did you mean: ' + [...new Set(near)].join(', ') + '?', 'dim')] : [];
}

/* ---- input handling (replaces the workbench listeners on the same input) ---- */
(function wireInput() {
  const input = $('terminput');
  const fresh = input.cloneNode(true);
  input.replaceWith(fresh);
  const form = $('termform');
  const freshForm = form.cloneNode(false);
  while (form.firstChild) freshForm.appendChild(form.firstChild);
  form.replaceWith(freshForm);
  freshForm.addEventListener('submit', e => { e.preventDefault(); runCommand($('terminput').value).catch(err => append(currentSession, 'shell: ' + err.message, 'err')); });
  $('terminput').addEventListener('keydown', e => {
    const session = currentSession; if (!session) return;
    if (e.ctrlKey && e.key.toLowerCase() === 'c' && !window.getSelection().toString()) { e.preventDefault(); cancelCommand(); return; }
    if (e.ctrlKey && e.key.toLowerCase() === 'l') { e.preventDefault(); session.rows = []; termEl.innerHTML = ''; return; }
    if (e.ctrlKey && e.key.toLowerCase() === 'd' && !e.target.value) { e.preventDefault(); runCommand('exit'); return; }
    if (e.ctrlKey && e.key.toLowerCase() === 'u') { e.preventDefault(); e.target.value = ''; return; }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      if (session.historyIndex === session.history.length) session.draft = e.target.value;
      session.historyIndex = Math.max(0, Math.min(session.history.length, session.historyIndex + (e.key === 'ArrowUp' ? -1 : 1)));
      e.target.value = session.history[session.historyIndex] ?? session.draft;
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      const value = e.target.value, words = value.split(' '), last = words.pop();
      let options;
      if (!words.length) options = Object.keys(BUILTINS).concat([...new Set(Object.values(JOB_COMMANDS).map(c => c.split(' ')[0]))]);
      else if (words[0] === 'git' && words.length === 1) options = ['status', 'log', 'diff', 'branch', 'checkout', 'switch', 'add', 'commit', 'push', 'pull', 'fetch', 'stash', 'blame', 'remote', 'show', 'tag'];
      else if (words[0] === 'git' && ['checkout', 'switch'].includes(words[1])) options = TOPIC.branches;
      else if (/^(npm|pnpm|yarn)$/.test(words[0]) && words[1] === 'run') options = TOPIC.scripts.map(s => s[0]);
      else if (words[0] === 'make') options = TOPIC.scripts.map(s => s[0]);
      else {
        const slash = last.lastIndexOf('/');
        const dirPart = slash >= 0 ? last.slice(0, slash + 1) : '';
        const dir = vpath(dirPart || '.', session);
        options = vfsEntries(dir).map(e => dirPart + e.name + (e.dir ? '/' : ''));
      }
      const matches = [...new Set(options)].filter(o => o.startsWith(last)).sort();
      if (matches.length === 1) e.target.value = [...words, matches[0]].join(' ') + (matches[0].endsWith('/') ? '' : ' ');
      else if (matches.length > 1) {
        let common = matches[0];
        for (const m of matches) while (!m.startsWith(common)) common = common.slice(0, -1);
        if (common.length > last.length) e.target.value = [...words, common].join(' ');
        else appendHtml(session, promptHtml(session) + ' ' + esc(value) + '\n' + matches.slice(0, 24).map(esc).join('  '));
      }
    }
  });
  termEl.addEventListener('click', () => { if (!window.getSelection().toString()) $('terminput').focus(); });
})();

/* ================= ambient build noise in the dev-server terminal ================= */

(async function ambientLoop() {
  await sleep(7000);
  while (true) {
    const idle = Date.now() - lastKey > 15000;
    await sleep(idle ? rand(9, 22) * 1000 : rand(25, 60) * 1000);
    if (!TOPIC || !settings.ambient || document.hidden) continue;
    if (welcomeEl.classList.contains('show') || !overlay.classList.contains('hidden')) continue;
    const watch = sessions.find(s => s.kind === 'watch');
    if (!watch || watch.busy || jobLock) continue;
    if (Date.now() - (watch.lastActive || 0) < 20000) continue;
    const job = pick(TOPIC.jobs);
    const gen = topicGen;
    await executeJob(watch, job, JOB_COMMANDS[job] || job, TOPIC, true);
    if (gen === topicGen && sessions.includes(watch)) appendHtml(watch, '<span class="dim">watching for file changes...</span>');
  }
})();

/* ================= start typed files somewhere in the middle ================= */
/* A 1,200-line file typed from line 1 never finishes. Real people open a file and edit
   the part they are working on, so long files start at a natural boundary deep inside. */

resetTyped = function (f) {
  const n = lineCountOf(f);
  let start = 0;
  if (n > 220) {
    start = Math.floor(n * (0.3 + Math.random() * 0.4));
    while (start < n - 40 && f.lines[start - 1] && f.lines[start - 1].trim() !== '') start++;
  }
  const pos = start ? f.lines.slice(0, start).join('\n').length + 1 : 0;
  const doneHtml = f.lines.slice(0, start).map((line, i) => '<div class="line"><span class="ln">' + (i + 1) + '</span><span class="lc">' + hl(line, f.lang) + '</span></div>').join('');
  f.st = { pos, lineNo: start + 1, curText: '', doneHtml };
};

/* ================= achievements (quiet) ================= */

const RANKS = ['Intern', 'Junior', 'Mid-level', 'Senior', 'Staff', 'Principal', 'Distinguished', 'Fellow', '10x', 'Architect of the Void'];
function levelOf(xp) { return 1 + Math.floor(xp / 500); }
const unlocked = new Set(stored('relief.achievements', []));
let commitsMade = 0;
const visitedProfiles = new Set(stored('relief.visited', []));
const ACHIEVEMENTS = [
  { id: 'warmup', title: 'Warm-up', hint: 'type 100 correct characters in exact mode', test: () => metrics.correct >= 100 },
  { id: 'zone', title: 'In the zone', hint: 'reach a streak of 50', test: () => metrics.best >= 50 },
  { id: 'deep', title: 'Deep focus', hint: 'reach a streak of 200', test: () => metrics.best >= 200 },
  { id: 'senior', title: 'Senior', hint: 'reach level 5', test: () => levelOf(metrics.xp) >= 5 },
  { id: 'principal', title: 'Principal', hint: 'reach level 10', test: () => levelOf(metrics.xp) >= 10 },
  { id: 'exterminator', title: 'Exterminator', hint: 'resolve 10 highlighted issues in one day', test: () => bugData.c >= 10 },
  { id: 'shipped', title: 'Shipped it', hint: 'make 5 commits', test: () => commitsMade >= 5 },
  { id: 'owl', title: 'Night owl', hint: 'type something between midnight and 5am', test: () => { const h = new Date().getHours(); return h < 5 && Date.now() - lastKey < 2000; } },
  { id: 'polyglot', title: 'Polyglot', hint: 'open 5 different projects', test: () => visitedProfiles.size >= 5 },
  { id: 'native', title: 'Terminal native', hint: 'run 50 commands', test: () => commandsRun >= 50 },
  { id: 'rabbit', title: 'Followed the white rabbit', hint: 'you know what you typed', test: () => sessions.some(s => s.history.some(c => /^(c?matrix|sl|cowsay|neofetch|fortune|zen)/.test(c))) },
];
function checkAchievements() {
  for (const a of ACHIEVEMENTS) {
    if (unlocked.has(a.id) || !a.test()) continue;
    unlocked.add(a.id);
    persist('relief.achievements', [...unlocked]);
    setTimeout(() => showToast('Milestone reached: ' + a.title + '. Keep shipping.', 'DevMetrics'), 400);
  }
}
function noteCommit() { commitsMade++; checkAchievements(); }
recordInput = (base => correct => { base(correct); if (correct && metrics.correct % 25 === 0) checkAchievements(); })(recordInput);
commitChanges = (base => (message, session) => { const before = aheadCount; base(message, session); if (aheadCount > before) noteCommit(); })(commitChanges);
setInterval(() => {
  const level = levelOf(metrics.xp);
  $('focusrank').textContent = 'LSP: ready' + (metrics.xp ? ' · L' + level : '');
  $('focusrank').title = 'Language service status' + (metrics.xp ? ' · ' + RANKS[Math.min(RANKS.length - 1, level - 1)] : '');
}, 1500);
loadTopic = (base => id => { base(id); visitedProfiles.add(id); persist('relief.visited', [...visitedProfiles]); checkAchievements(); })(loadTopic);

/* ================= ambient overlay ================= */

let zenRaf = null;
function openZen(scene) {
  let el = $('zen');
  if (!el) {
    el = document.createElement('div');
    el.id = 'zen';
    el.innerHTML = '<canvas></canvas><div class="zen-ui"><span id="zen-clock"></span><span class="zen-hint">rain · stars · waves — click to switch, Esc to return</span></div>';
    document.body.appendChild(el);
    el.addEventListener('click', () => openZen(({ rain: 'stars', stars: 'waves', waves: 'rain' })[el.dataset.scene]));
  }
  el.dataset.scene = ['rain', 'stars', 'waves'].includes(scene) ? scene : (el.dataset.scene && !scene ? el.dataset.scene : 'rain');
  el.classList.add('show');
  if (zenRaf) cancelAnimationFrame(zenRaf);
  const canvas = el.querySelector('canvas'); const ctx = canvas.getContext('2d');
  const drops = Array.from({ length: 260 }, () => ({ x: Math.random(), y: Math.random(), v: 0.6 + Math.random() * 1.2, l: 10 + Math.random() * 18 }));
  const stars = Array.from({ length: 320 }, () => ({ x: Math.random(), y: Math.random(), z: 0.2 + Math.random() * 0.8, t: Math.random() * 6 }));
  let t0 = performance.now();
  const draw = now => {
    if (!el.classList.contains('show')) return;
    const w = canvas.width = el.clientWidth, h = canvas.height = el.clientHeight;
    const t = (now - t0) / 1000;
    ctx.fillStyle = '#0b0f14'; ctx.fillRect(0, 0, w, h);
    const scene = el.dataset.scene;
    if (scene === 'rain') {
      ctx.strokeStyle = 'rgba(140,180,220,0.35)'; ctx.lineWidth = 1;
      for (const d of drops) { d.y += d.v * 0.012; if (d.y > 1.05) { d.y = -0.05; d.x = Math.random(); } ctx.beginPath(); ctx.moveTo(d.x * w, d.y * h); ctx.lineTo(d.x * w + 1.5, d.y * h + d.l); ctx.stroke(); }
      ctx.fillStyle = 'rgba(20,30,44,0.9)'; ctx.fillRect(0, h * 0.86, w, h * 0.14);
      for (let i = 0; i < 14; i++) { const r = ((t * 0.7 + i * 0.37) % 1); ctx.strokeStyle = 'rgba(140,180,220,' + (0.3 * (1 - r)).toFixed(2) + ')'; ctx.beginPath(); ctx.ellipse((i * 137 % w), h * 0.9 + (i * 53 % (h * 0.08)), 4 + r * 40, 1.5 + r * 10, 0, 0, Math.PI * 2); ctx.stroke(); }
    } else if (scene === 'stars') {
      for (const s of stars) { const tw = 0.5 + 0.5 * Math.sin(t * 1.3 + s.t); ctx.fillStyle = 'rgba(220,230,255,' + (0.25 + 0.6 * tw * s.z).toFixed(2) + ')'; const x = ((s.x + t * 0.004 * s.z) % 1) * w; ctx.fillRect(x, s.y * h, 1 + s.z * 1.6, 1 + s.z * 1.6); }
      ctx.fillStyle = 'rgba(60,40,90,0.15)'; ctx.beginPath(); ctx.ellipse(w * 0.7, h * 0.3, w * 0.35, h * 0.25, 0.4, 0, Math.PI * 2); ctx.fill();
    } else {
      for (let k = 0; k < 4; k++) {
        ctx.strokeStyle = 'rgba(120,200,190,' + (0.18 + k * 0.12).toFixed(2) + ')'; ctx.lineWidth = 1.5; ctx.beginPath();
        for (let x = 0; x <= w; x += 4) { const y = h * 0.55 + Math.sin(x / (120 + k * 40) + t * (0.8 + k * 0.3)) * (18 + k * 12) + Math.sin(x / 37 + t * 1.7) * 6; if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
        ctx.stroke();
      }
    }
    el.querySelector('#zen-clock').textContent = String(new Date().getHours()).padStart(2, '0') + ':' + String(new Date().getMinutes()).padStart(2, '0');
    zenRaf = requestAnimationFrame(draw);
  };
  zenRaf = requestAnimationFrame(draw);
}
function closeZen() { const el = $('zen'); if (el) el.classList.remove('show'); if (zenRaf) cancelAnimationFrame(zenRaf); zenRaf = null; }
window.addEventListener('keydown', e => {
  const el = $('zen');
  if (el && el.classList.contains('show')) { if (e.key === 'Escape' || e.key === ' ') { e.preventDefault(); e.stopImmediatePropagation(); closeZen(); } else if (e.ctrlKey && e.altKey && e.key.toLowerCase() === 'z') { e.preventDefault(); e.stopImmediatePropagation(); closeZen(); } else e.stopImmediatePropagation(); return; }
  if (e.ctrlKey && e.altKey && e.key.toLowerCase() === 'z') { e.preventDefault(); e.stopImmediatePropagation(); openZen(); }
}, true);
COMMANDS.push(['View: Ambient Mode', () => openZen(), 'Ctrl+Alt+Z']);
COMMANDS.push(['Language Service: Achievements', () => { setPanel('TERMINAL'); runCommand('achievements'); }]);

/* the first session of a project shows its boot output; make sure the prompt is right */
setTimeout(() => { renderTerminalTools(); updatePrompt(); }, 0);
