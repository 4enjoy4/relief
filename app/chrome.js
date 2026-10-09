/* FauxCode — chrome.js: the parts of the IDE you click on. Full menus, context menus,
   find widget, symbol navigation, zen mode, split editor, notifications, chords.
   Loaded after shell.js; builds on the helpers defined in workbench.js. */
'use strict';

/* ================= small utilities ================= */

const notifications = [];
showToast = (base => (msg, src) => { notifications.unshift({ msg, src, at: nowStr() }); if (notifications.length > 40) notifications.pop(); updateBell(); base(msg, src); })(showToast);

function copyText(text) {
  try { navigator.clipboard.writeText(text); } catch (e) { /* clipboard is optional */ }
  showToast('Copied to clipboard.', 'Editor');
}
function currentFile() { return REG[ap]; }
function cursorLineNo() {
  const f = currentFile();
  if (!f) return 1;
  const el = doneEl.querySelector('.cursorline');
  if (el) return Number(el.querySelector('.ln').textContent) || 1;
  return f.typed && f.st ? f.st.lineNo : 1;
}
function cursorLineText() { const f = currentFile(); if (!f) return ''; return f.lines[cursorLineNo() - 1] || ''; }
function wordAtCursor() {
  const sel = String(window.getSelection() || '').trim();
  if (/^[\w$]+$/.test(sel)) return sel;
  const m = cursorLineText().match(/[A-Za-z_$][\w$]*/g);
  return m ? m.reduce((a, b) => b.length > a.length ? b : a, '') : '';
}
function generatedFile(path, content) {
  if (!REG[path]) { createFile(path, content); scmChanges.delete(path); renderScm(); }
  openPath(path); welcomeEl.classList.remove('show');
}
function checkmark(on) { return (on ? '✓ ' : '   '); }

/* ================= menu renderer with shortcuts + section headers ================= */

menu = function (anchor, entries) {
  entries = entries.filter(Boolean);
  menuActions = entries.map(e => e[1]);
  $('menupopup').innerHTML = entries.map((e, i) => {
    if (e[0] === '-') return '<div class="msep"></div>';
    if (!e[1] && e[0].startsWith('▸')) return '<div class="mhead">' + esc(e[0].slice(1).trim()) + '</div>';
    return '<button role="menuitem" data-action="' + i + '"' + (e[3] ? ' class="msub"' : '') + '><span>' + esc(e[0]) + '</span>' + (e[2] ? '<kbd>' + esc(e[2]) + '</kbd>' : '') + '</button>';
  }).join('');
  const rect = anchor.getBoundingClientRect();
  const pop = $('menupopup');
  pop.classList.add('show');
  const left = typeof anchor.menuX === 'number' ? anchor.menuX : rect.left;
  const top = typeof anchor.menuY === 'number' ? anchor.menuY : rect.bottom;
  pop.style.left = Math.min(left, innerWidth - pop.offsetWidth - 8) + 'px';
  pop.style.top = Math.max(4, Math.min(top, innerHeight - pop.offsetHeight - 24)) + 'px';
  const first = pop.querySelector('button');
  if (first) first.focus();
};
function menuAt(x, y, entries) { menu({ getBoundingClientRect: () => ({ left: x, bottom: y }), menuX: x, menuY: y }, entries); }

/* ================= navigation history ================= */

const navBack = [], navForward = [];
openPath = (base => p => { if (ap && ap !== p && REG[ap]) { navBack.push(ap); if (navBack.length > 50) navBack.shift(); } base(p); })(openPath);
function goBack() { const p = navBack.pop(); if (!p || !REG[p]) { showToast('No more history.', 'Editor'); return; } navForward.push(ap); const keep = navBack.slice(); openPath(p); navBack.length = 0; navBack.push(...keep); }
function goForward() { const p = navForward.pop(); if (!p || !REG[p]) { showToast('No more history.', 'Editor'); return; } openPath(p); }

/* ================= symbols ================= */

const SYMBOL_RE = /^\s*(?:export\s+|pub(?:\([^)]*\))?\s+|public\s+|private\s+|protected\s+|static\s+|final\s+|abstract\s+|async\s+|default\s+|@\w+\s+)*(class|interface|enum|type|function|def|fn|func|struct|impl|trait|contract|resource|module|data class|object|protocol|extension|CREATE TABLE(?: IF NOT EXISTS)?|namespace)\s+("?[\w.$-]+"?(?:\s+"[\w-]+")?)/;
const METHOD_RE = /^\s{2,8}(?:(?:public|private|protected|static|async|override|suspend|final|open|internal|fun|func|def|abstract|readonly|@\w+)\s+)*(?:[\w<>\[\],?:|& ]+\s+)?([A-Za-z_]\w*)\s*\([^;]*$/;
function symbolsOf(f) {
  const out = [];
  f.lines.forEach((line, i) => {
    let m = line.match(SYMBOL_RE);
    if (m) { out.push({ kind: m[1].split(' ')[0].toLowerCase(), name: m[2].replace(/"/g, ''), line: i + 1 }); return; }
    if (/^\s*(if|for|while|switch|return|catch|else|await|const|let|var|new|throw)\b/.test(line)) return;
    m = line.match(METHOD_RE);
    if (m && !/^(if|for|while|switch|catch|return|function|constructor)$/.test(m[1]) && /[{:]\s*$|\)\s*(?:->|:|throws|=>)|\)\s*$/.test(line)) out.push({ kind: 'method', name: m[1], line: i + 1 });
  });
  return out;
}
const KIND_ICON = { class: '◧', interface: '◇', enum: '☰', type: '⊤', function: '𝑓', def: '𝑓', fn: '𝑓', func: '𝑓', method: '⊙', struct: '▣', impl: '▣', trait: '◇', contract: '◧', resource: '▤', module: '▤', data: '▣', object: '▣', protocol: '◇', extension: '◧', create: '▤', namespace: '▤' };
function goToSymbolInEditor() {
  const f = currentFile(); if (!f) return;
  const syms = symbolsOf(f);
  if (!syms.length) { showToast('No symbols found in ' + f.name + '.', 'Editor'); return; }
  choose('Go to Symbol in Editor', syms.map(s => [(KIND_ICON[s.kind] || '•') + '  ' + s.name, () => jumpTo(ap, s.line), s.kind + ' · line ' + s.line]));
}
function goToSymbolInWorkspace() {
  const all = [];
  for (const p in REG) for (const s of symbolsOf(REG[p])) { if (s.kind !== 'method') all.push([(KIND_ICON[s.kind] || '•') + '  ' + s.name, () => jumpTo(p, s.line), REG[p].name + ':' + s.line]); if (all.length > 800) break; }
  choose('Go to Symbol in Workspace', all);
}
function goToDefinition() {
  const word = wordAtCursor();
  if (!word) { showToast('No symbol under the cursor.', 'Editor'); return; }
  const f = currentFile();
  const local = symbolsOf(f).find(s => s.name === word);
  if (local && local.line !== cursorLineNo()) { jumpTo(ap, local.line); return; }
  for (const p in REG) { const s = symbolsOf(REG[p]).find(x => x.name === word); if (s) { jumpTo(p, s.line); return; } }
  showToast('No definition found for \'' + word + '\'.', 'Editor');
}
function goToReferences() {
  const word = wordAtCursor();
  if (!word) return;
  setView('search'); searchInput.value = word; runSearch();
}
function renameSymbol() {
  const word = wordAtCursor();
  if (!word) return;
  askText('Rename \'' + word + '\'', word, name => {
    let n = 0;
    for (const p in REG) { const f = REG[p]; if (f.typed) continue; const re = new RegExp('\\b' + word.replace(/[$]/g, '\\$') + '\\b', 'g'); const c = (f.content.match(re) || []).length; if (c) { n += c; f.content = f.content.replace(re, name); f.lines = f.content.split('\n'); f.cache = null; scmAdd(p); } }
    if (!currentFile().typed) rebuildEditor();
    showToast('Renamed ' + n + ' occurrence' + (n === 1 ? '' : 's') + ' of \'' + word + '\' in static files. Files being edited were skipped.', 'TypeScript');
  });
}

/* ================= occurrences + hover ================= */

function clearOccurrences() { doneEl.querySelectorAll('span.occ').forEach(s => { s.replaceWith(document.createTextNode(s.textContent)); }); }
function highlightOccurrences(word) {
  clearOccurrences();
  if (!word) return 0;
  const re = new RegExp('\\b' + word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b');
  let n = 0;
  const walker = document.createTreeWalker(doneEl, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) if (re.test(walker.currentNode.nodeValue)) nodes.push(walker.currentNode);
  for (const node of nodes.slice(0, 400)) {
    const parts = node.nodeValue.split(new RegExp('(\\b' + word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b)'));
    if (parts.length < 2) continue;
    const frag = document.createDocumentFragment();
    parts.forEach((part, i) => { if (i % 2) { const s = document.createElement('span'); s.className = 'occ'; s.textContent = part; frag.appendChild(s); n++; } else if (part) frag.appendChild(document.createTextNode(part)); });
    node.replaceWith(frag);
  }
  return n;
}
codewrap.addEventListener('dblclick', e => { const w = String(window.getSelection() || '').trim(); if (/^[\w$]+$/.test(w)) { const n = highlightOccurrences(w); lncolEl.textContent = 'Ln ' + cursorLineNo() + ', Col 1 (' + n + ' selected)'; } });
codewrap.addEventListener('mousedown', e => { if (e.detail === 1 && !e.target.closest('.occ')) clearOccurrences(); });

const hoverBox = document.createElement('div'); hoverBox.id = 'hoverbox'; hoverBox.className = 'hidden'; document.body.appendChild(hoverBox);
let hoverTimer = null;
codewrap.addEventListener('mouseover', e => {
  const t = e.target.closest('.fn, .dec, .kw');
  clearTimeout(hoverTimer);
  if (!t || !t.classList.contains('fn')) { hoverBox.classList.add('hidden'); return; }
  hoverTimer = setTimeout(() => {
    const name = t.textContent.trim();
    let def = null, where = null;
    for (const p of [ap, ...Object.keys(REG)]) { const f = REG[p]; if (!f) continue; const i = f.lines.findIndex(l => new RegExp('\\b' + name.replace(/[$]/g, '\\$') + '\\s*\\(').test(l) && SYMBOL_RE.test(l) || (new RegExp('^\\s*(?:(?:public|private|protected|static|async|export|function|def|fn|func|fun|override)\\s+)+.*\\b' + name.replace(/[$]/g, '\\$') + '\\s*\\(').test(l))); if (i >= 0) { def = f.lines[i].trim(); where = f.name + ':' + (i + 1); break; } }
    const f = currentFile();
    const lang = f ? f.mode : '';
    hoverBox.innerHTML = '<div class="hsig">' + (def ? hl(def.replace(/\s*[{:]\s*$/, ''), f ? f.lang : 'ts') : '<span class="dim">(' + esc(lang) + ')</span> ' + esc(name) + '(…)') + '</div><div class="hmeta">' + (where ? esc(where) : 'declared in a dependency') + '</div>';
    const r = t.getBoundingClientRect();
    hoverBox.style.left = Math.min(r.left, innerWidth - 460) + 'px';
    hoverBox.style.top = Math.max(40, r.top - 12 - hoverBox.offsetHeight) + 'px';
    hoverBox.classList.remove('hidden');
    hoverBox.style.top = Math.max(40, r.top - 8 - hoverBox.offsetHeight) + 'px';
  }, 650);
});
codewrap.addEventListener('mouseleave', () => { clearTimeout(hoverTimer); hoverBox.classList.add('hidden'); });
document.addEventListener('scroll', () => hoverBox.classList.add('hidden'), true);

/* ================= find widget ================= */

const findBox = document.createElement('div');
findBox.id = 'findbox'; findBox.className = 'hidden';
findBox.innerHTML = '<div class="frow"><input id="find-q" placeholder="Find" spellcheck="false" autocomplete="off"><span id="find-count">No results</span><button title="Previous Match (Shift+Enter)" data-f="prev">↑</button><button title="Next Match (Enter)" data-f="next">↓</button><button title="Close (Escape)" data-f="close">✕</button></div><div class="frow" id="find-replace-row"><input id="find-r" placeholder="Replace" spellcheck="false" autocomplete="off"><button title="Replace" data-f="replace">⇄</button><button title="Replace All" data-f="replaceall">⇄⇄</button></div>';
$('editorwrap').appendChild(findBox);
let findHits = [], findIdx = -1;
function openFind(withReplace) {
  findBox.classList.remove('hidden');
  $('find-replace-row').classList.toggle('hidden', !withReplace);
  const q = $('find-q'); const w = wordAtCursor();
  if (!q.value && w && String(window.getSelection() || '').trim()) q.value = w;
  q.focus(); q.select(); runFind();
}
function closeFind() { findBox.classList.add('hidden'); doneEl.querySelectorAll('.line.searchhit').forEach(l => l.classList.remove('searchhit')); findHits = []; findIdx = -1; }
function runFind() {
  const f = currentFile(); const q = $('find-q').value;
  doneEl.querySelectorAll('.line.searchhit').forEach(l => l.classList.remove('searchhit'));
  findHits = []; findIdx = -1;
  if (!f || !q) { $('find-count').textContent = 'No results'; return; }
  const lq = q.toLowerCase();
  f.lines.forEach((l, i) => { if (l.toLowerCase().includes(lq)) findHits.push(i + 1); });
  $('find-count').textContent = findHits.length ? '1 of ' + findHits.length : 'No results';
  if (findHits.length) findStep(1);
}
function findStep(dir) {
  if (!findHits.length) return;
  findIdx = (findIdx + dir + findHits.length) % findHits.length;
  $('find-count').textContent = (findIdx + 1) + ' of ' + findHits.length;
  doneEl.querySelectorAll('.line.searchhit').forEach(l => l.classList.remove('searchhit'));
  const line = findHits[findIdx];
  const el = doneEl.children[line - 1];
  if (el) { el.classList.add('searchhit'); el.scrollIntoView({ block: 'center' }); }
  else codewrap.scrollTop = codewrap.scrollHeight;
  lncolEl.textContent = 'Ln ' + line + ', Col ' + ((currentFile().lines[line - 1].toLowerCase().indexOf($('find-q').value.toLowerCase())) + 1);
}
function replaceAll() {
  const f = currentFile(); const q = $('find-q').value, r = $('find-r').value;
  if (!f || !q) return;
  if (f.typed) { showToast('Replace is unavailable while this file is being written. Open a static file.', 'Editor'); return; }
  const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  const n = (f.content.match(re) || []).length;
  if (!n) return;
  f.content = f.content.replace(re, r); f.lines = f.content.split('\n'); f.cache = null;
  scmAdd(ap); rebuildEditor(); runFind();
  showToast('Replaced ' + n + ' occurrence' + (n === 1 ? '' : 's') + '.', 'Editor');
}
$('find-q').addEventListener('input', runFind);
$('find-q').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); findStep(e.shiftKey ? -1 : 1); } if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeFind(); } });
$('find-r').addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeFind(); } if (e.key === 'Enter') { e.preventDefault(); replaceAll(); } });
findBox.addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; const a = b.dataset.f; if (a === 'prev') findStep(-1); if (a === 'next') findStep(1); if (a === 'close') closeFind(); if (a === 'replace' || a === 'replaceall') replaceAll(); });

/* ================= zen mode, layout toggles, zoom, split ================= */

function toggleBody(cls, label) { document.body.classList.toggle(cls); persist('relief.layout', [...document.body.classList].filter(c => c.startsWith('hide-') || c === 'centered')); if (label) showToast(label + (document.body.classList.contains(cls) ? ' hidden' : ' shown') + '.', 'View'); }
function zenMode(on) { const want = on === undefined ? !document.body.classList.contains('zen') : on; document.body.classList.toggle('zen', want); if (want) showToast('Zen mode. Press Esc twice to leave.', 'View'); }
function zoom(delta) { settings.font = delta === 0 ? 13 : Math.max(10, Math.min(24, (Number(settings.font) || 13) + delta)); applySettings(); document.body.style.zoom = ''; }
let splitPath = null;
function splitRight(path) {
  let pane = $('split');
  if (!pane) { pane = document.createElement('div'); pane.id = 'split'; $('minimap').before(pane); }
  splitPath = path || openTabs.find(p => p !== ap) || ap;
  const f = REG[splitPath]; if (!f) return;
  pane.innerHTML = '<div class="splithead"><span class="fico ' + f.cls + '">' + esc(f.icon) + '</span>' + esc(f.name) + '<button class="tab-close" title="Close split">×</button></div><div class="splitbody">' + cacheFor(f) + '</div>';
  pane.classList.remove('hidden');
  pane.querySelector('.tab-close').onclick = closeSplit;
  pane.querySelector('.splitbody').onclick = e => { const l = e.target.closest('.line'); if (l) { openPath(splitPath); jumpTo(splitPath, Number(l.querySelector('.ln').textContent)); } };
}
function closeSplit() { const pane = $('split'); if (pane) pane.classList.add('hidden'); splitPath = null; }
try { for (const c of stored('relief.layout', [])) document.body.classList.add(c); } catch (e) { /* ignore */ }

/* ================= generated workspace files ================= */

function launchJson() {
  const d = TOPIC.debug; const lang = TOPIC.primaryLang;
  const type = lang === 'py' ? 'debugpy' : lang === 'go' ? 'go' : lang === 'rust' || lang === 'cpp' ? 'lldb' : lang === 'java' ? 'java' : 'node';
  return '{\n  // Use IntelliSense to learn about possible attributes.\n  "version": "0.2.0",\n  "configurations": [\n    {\n      "name": "' + d.conf + '",\n      "type": "' + type + '",\n      "request": "launch",\n      "cwd": "${workspaceFolder}",\n      "env": { "NODE_ENV": "development" },\n      "console": "integratedTerminal",\n      "skipFiles": ["<node_internals>/**"]\n    }\n  ]\n}\n'.replace('${', '$' + '{');
}
function tasksJson() {
  return '{\n  "version": "2.0.0",\n  "tasks": [\n' + TOPIC.scripts.map((s, i) => '    {\n      "label": "' + s[0] + '",\n      "type": "shell",\n      "command": "' + s[1].replace(/"/g, '\\"') + '",\n      "problemMatcher": []' + (i === 0 ? ',\n      "group": { "kind": "build", "isDefault": true }' : '') + '\n    }').join(',\n') + '\n  ]\n}\n';
}
function settingsJson() {
  return '{\n  "editor.formatOnSave": true,\n  "editor.tabSize": 2,\n  "editor.rulers": [100],\n  "files.trimTrailingWhitespace": true,\n  "typescript.tsdk": "node_modules/typescript/lib",\n  "search.exclude": { "**/node_modules": true, "**/dist": true },\n  "workbench.colorTheme": "Dark+ (default dark)",\n  "git.autofetch": true,\n  "devmetrics.quiet": true\n}\n';
}

/* ================= actions used by menus ================= */

function saveAs() { const f = currentFile(); if (!f) return; askText('Save As', f.path.replace(/(\.[^./]+)?$/, '.copy$1'), path => { createFile(path, f.content); openPath(path); showToast('Saved ' + path, 'Workspace'); }); }
function saveAll() { for (const p of openTabs) scmAdd(p); termSaveSequence(openTabs.length + ' files', topicGen); showToast('Saved ' + openTabs.length + ' files.', 'Workspace'); }
function revertFile() { const f = currentFile(); if (!f) return; scmChanges.delete(ap); renderScm(); showToast('Reverted ' + f.name + ' to the last saved version.', 'Workspace'); }
function newWindow() { showToast('New window opened behind this one. (It is exactly like this one.)', 'Window'); }
function exitApp() { if (window.pywebview && window.pywebview.api) window.pywebview.api.close(); else showToast('Exit is disabled in the browser preview. Close the tab instead.', 'Window'); }
function runActiveFile() {
  const f = currentFile(); if (!f) return;
  const cmd = { py: 'python ' + f.path, ts: 'npx tsx ' + f.path, js: 'node ' + f.path, go: 'go run ' + f.path, rs: 'cargo run', java: 'mvn -q exec:java', cpp: 'cmake --build build', sol: 'npx hardhat test', sql: 'psql -f ' + f.path, sh: './' + f.path }[extOf(f.path)] || 'code ' + f.path;
  setPanel('TERMINAL'); runCommand(cmd);
}
function runBuildTask() { const s = TOPIC.scripts.find(x => /build|compile|assemble|package/.test(x[0])) || TOPIC.scripts[0]; setPanel('TERMINAL'); runCommand(s ? (TOPIC.shell.pkg === 'npm' || TOPIC.shell.pkg === 'pnpm' || TOPIC.shell.pkg === 'yarn' ? TOPIC.shell.pkg + ' run ' + s[0] : s[1]) : 'make'); }
function showRunningTasks() { const busy = sessions.filter(s => s.busy); if (!busy.length) { showToast('No running tasks.', 'Tasks'); return; } choose('Running Tasks', busy.map(s => [s.name, () => selectSession(s.id), 'running'])); }
function terminateTask() { const busy = sessions.filter(s => s.busy); if (!busy.length) { showToast('No task is currently running.', 'Tasks'); return; } choose('Terminate Task', busy.map(s => [s.name, () => { selectSession(s.id); cancelCommand(); }])); }
function toggleBreakpointAtCursor() {
  const line = cursorLineNo();
  if (!bpMap[ap]) bpMap[ap] = new Set();
  if (bpMap[ap].has(line)) bpMap[ap].delete(line); else bpMap[ap].add(line);
  applyBreakpoints(); renderDbgBps();
  showToast((bpMap[ap].has(line) ? 'Breakpoint set at ' : 'Breakpoint removed from ') + REG[ap].name + ':' + line, 'Debug');
}
function removeAllBreakpoints() { for (const k in bpMap) delete bpMap[k]; applyBreakpoints(); renderDbgBps(); showToast('All breakpoints removed.', 'Debug'); }
function conditionalBreakpoint() { askText('Breakpoint condition', 'attempt > 3', cond => { toggleBreakpointAtCursor(); showToast('Condition: ' + cond, 'Debug'); }); }
function logpoint() { askText('Log message', 'value is {value}', msg => { showToast('Logpoint added: ' + msg, 'Debug'); }); }
function nextProblem(dir) {
  const items = TOPIC.lintFiles.filter(x => REG[x[0]]);
  if (!items.length) { showToast('No problems. Suspicious.', 'Problems'); return; }
  window.__problemIdx = ((window.__problemIdx ?? -1) + dir + items.length) % items.length;
  const [path, msg] = items[window.__problemIdx];
  jumpTo(path, parseInt(msg) || 1);
  showToast(msg.replace(/^[\d:]+\s+/, ''), 'ESLint');
}
function goToBracket() {
  const f = currentFile(); if (!f) return;
  const from = cursorLineNo();
  for (let i = from; i < f.lines.length; i++) { if (/^\s*[}\])]/.test(f.lines[i])) { jumpTo(ap, i + 1); return; } }
  showToast('No matching bracket below the cursor.', 'Editor');
}
function toggleLineComment() {
  const f = currentFile(); if (!f || f.typed) { showToast('Comments toggle on static files only.', 'Editor'); return; }
  const i = cursorLineNo() - 1; const prefix = f.lang === 'py' || f.lang === 'yml' ? '# ' : f.lang === 'sql' ? '-- ' : '// ';
  const l = f.lines[i]; if (l === undefined) return;
  const indent = (l.match(/^\s*/) || [''])[0];
  f.lines[i] = l.trim().startsWith(prefix.trim()) ? indent + l.trim().slice(prefix.trim().length).replace(/^ /, '') : indent + prefix + l.trim();
  f.content = f.lines.join('\n'); f.cache = null; scmAdd(ap); rebuildEditor();
  const el = doneEl.children[i]; if (el) { el.classList.add('cursorline'); el.scrollIntoView({ block: 'center' }); }
}
function formatDocument() { const f = currentFile(); if (!f) return; termSaveSequence(f.name, topicGen); showToast('Formatted ' + f.name + ' with Prettier (0 changes, it was already perfect).', 'Prettier'); }
function selectAllCode() { const r = document.createRange(); r.selectNodeContents(doneEl); const s = window.getSelection(); s.removeAllRanges(); s.addRange(r); }
function copySelection() { const t = String(window.getSelection() || '') || cursorLineText(); copyText(t); }
function pasteInfo() { showToast('Clipboard is read-only in relaxed mode. Type instead; it looks the same.', 'Editor'); }
function multiCursor(n) { showToast(n + ' cursors. They agree on everything.', 'Editor'); }
function openView() { choose('Open View', [['Explorer', () => setView('explorer')], ['Search', () => setView('search')], ['Source Control', () => setView('scm')], ['Run and Debug', () => setView('debug')], ['Extensions', () => setView('ext')], ['Problems', () => setPanel('PROBLEMS')], ['Output', () => setPanel('OUTPUT')], ['Debug Console', () => setPanel('DEBUG CONSOLE')], ['Terminal', () => setPanel('TERMINAL')], ['Ports', () => setPanel('PORTS')]]); }
function releaseNotes() { dialog('Release Notes — 1.93', '<div class="dialog-copy"><p><strong>Welcome to the August release.</strong> Highlights:</p><ul><li>Terminal: pipes, redirects, long listings, <code>git stash</code>, and a proper <code>top</code>.</li><li>Editor: symbol navigation, find/replace widget, hover signatures.</li><li>Workspaces: twelve project profiles across web, mobile, infra, firmware, data and systems code.</li><li>Language service: exact-input diagnostics with levels and milestones.</li><li>Window: resizable desktop shell, remembered window geometry.</li></ul><p class="dim">Full changelog available in the terminal: <code>git log</code>.</p></div>'); }
function docsDialog() { dialog('Documentation', '<div class="dialog-copy"><p><strong>Keyboard</strong></p><ul><li><code>Ctrl+Shift+P</code> command palette · <code>Ctrl+P</code> go to file · <code>Ctrl+G</code> go to line · <code>Ctrl+F</code> find · <code>Ctrl+Shift+O</code> symbols</li><li><code>Ctrl+B</code> sidebar · <code>Ctrl+J</code> panel · <code>Ctrl+`</code> terminal · <code>Ctrl+K Z</code> zen mode · <code>F11</code> full screen</li><li><code>F5</code> debug · <code>F9</code> breakpoint · <code>F8</code> next problem · <code>F12</code> go to definition</li><li><code>Ctrl+Alt+G</code> exact input · <code>Ctrl+Alt+Z</code> ambient view · <code>Ctrl+Shift+B</code> return to editor</li></ul><p><strong>Terminal</strong></p><p>Type <code>help</code>. Pipes, <code>&&</code>, redirects and tab completion work. Everything is simulated locally.</p></div>'); }
function processExplorer() { dialog('Process Explorer', '<table class="panel-table"><thead><tr><th>PID</th><th>CPU %</th><th>Memory</th><th>Name</th></tr></thead><tbody>' + fakeProcs(TOPIC).map(p => '<tr><td>' + p[1] + '</td><td>' + p[2] + '</td><td>' + (Number(p[3]) * 320).toFixed(0) + ' MB</td><td>' + esc(p[4]) + '</td></tr>').join('') + '</tbody></table>'); }
function reportIssue() { dialog('Report Issue', '<form id="issue-form"><label class="dialog-copy">Title<input id="issue-title" placeholder="Something is not quite right"></label><label class="dialog-copy">Steps to reproduce<textarea id="issue-body" rows="5" placeholder="1. Open the workspace&#10;2. Look at it&#10;3. Feel better"></textarea></label><button class="action">Preview on GitHub</button></form>'); $('issue-form').onsubmit = e => { e.preventDefault(); closeDialog(); showToast('Issue drafted locally. It was not sent anywhere, which is the point.', 'Issue Reporter'); }; }
function checkUpdates() { showToast('Checking for updates…', 'Update'); setTimeout(() => showToast('There are currently no updates available.', 'Update'), 1400); }
function tipsAndTricks() { showToast(pick(['Tip: Ctrl+Alt+G turns the faint // @trace line into a typing exercise.', 'Tip: the terminal understands pipes, "git stash" and "top".', 'Tip: type "zen" in the terminal when the sprint gets loud.', 'Tip: click a wavy underline to resolve it. DevMetrics counts.', 'Tip: Ctrl+K Z hides everything except the code.']), 'Tips and Tricks'); }
function licenseDialog() { dialog('License', '<div class="dialog-copy"><p>This workspace is provided as-is for the purpose of appearing productive.</p><p>No warranty is expressed or implied regarding actual productivity.</p></div>'); }
function privacyDialog() { dialog('Privacy Statement', '<div class="dialog-copy"><p>Nothing leaves this window. Settings and progress are stored in local storage on this device.</p><p>No telemetry. No accounts. No network calls. The only thing watching is the file watcher, and it is fake.</p></div>'); }
function devTools() { dialog('Developer Tools', '<div class="dialog-copy"><p class="dim">Console</p><pre class="devtools">' + esc(outputLog.slice(-12).join('\n') || '[workbench] renderer ready\n[workbench] extension host started (fake)') + '</pre></div>'); }
function accessibilityHelp() { showToast('Screen reader mode: press Alt+F1 for accessibility help. Focus moves with Tab throughout the workbench.', 'Accessibility'); }
function forwardPort() { askText('Port number to forward', '4000', p => { const port = parseInt(p); if (!port) return; TOPIC.ports.push([port, 'Forwarded port', 'user']); renderPanels(); setPanel('PORTS'); showToast('Forwarded port ' + port + ' → localhost:' + port, 'Ports'); }); }
function remotePick() { choose('Select an option to open a Remote Window', [['Connect to Host…', () => { showToast('Connecting to bastion.internal.corp…', 'Remote - SSH'); setTimeout(() => showToast('Could not establish connection: host unreachable (this workspace is offline by design).', 'Remote - SSH'), 1600); }, 'Remote-SSH'], ['Connect to WSL', () => showToast('WSL is not installed on this workspace image.', 'WSL')], ['Reopen in Container', () => showToast('Dev Containers: docker is not running. Neither is the container.', 'Dev Containers')], ['Open a Remote Window', () => showToast('Remote Development: nothing to attach to.', 'Remote')]]); }
function extensionDetails(name) {
  const x = EXTS.find(e => e[2] === name); if (!x) return;
  const inst = installedExts.has(name);
  dialog(name, '<div class="extdetail"><div class="exticon" style="background:' + x[1] + ';width:56px;height:56px;font-size:22px">' + x[0] + '</div><div><div class="dialog-copy"><p><strong>' + esc(name) + '</strong> <span class="dim">· ' + x[4] + ' installs · ★ ' + (rand(38, 50) / 10).toFixed(1) + '</span></p><p>' + esc(x[3]) + '</p><p class="dim">Publisher: ' + esc(name.split(' ')[0].toLowerCase()) + '-tools · Version ' + rand(1, 9) + '.' + rand(0, 20) + '.' + rand(0, 9) + ' · Updated ' + rand(1, 28) + ' days ago</p></div><button class="action" id="ext-action">' + (inst ? 'Uninstall' : 'Install') + '</button></div></div>');
  $('ext-action').onclick = () => { if (inst) installedExts.delete(name); else installedExts.add(name); closeDialog(); renderExt(); showToast((inst ? 'Uninstalled ' : 'Installed ') + name + '.', 'Extensions'); };
}
document.getElementById('extlist').addEventListener('click', e => { if (e.target.closest('.extbtn')) return; const row = e.target.closest('.extrow'); if (row) extensionDetails(row.querySelector('.extname').textContent); });

/* ================= notification center + remote indicator ================= */

const bell = document.createElement('div'); bell.className = 'item'; bell.id = 'bell'; bell.title = 'Notifications'; bell.textContent = '🔔';
document.querySelector('#statusbar .right').appendChild(bell);
function updateBell() { bell.textContent = notifications.length ? '🔔 ' + Math.min(9, notifications.length) : '🔔'; }
bell.onclick = () => { dialog('Notifications', notifications.length ? '<div class="notif-list">' + notifications.map(n => '<div class="notif"><div>' + esc(n.msg) + '</div><div class="dim">' + esc(n.src) + ' · ' + esc(n.at) + '</div></div>').join('') + '</div><button class="action" id="notif-clear">Clear All</button>' : '<div class="dialog-copy">No new notifications.</div>'); const c = $('notif-clear'); if (c) c.onclick = () => { notifications.length = 0; updateBell(); closeDialog(); }; };
const remote = document.createElement('div'); remote.className = 'item'; remote.id = 'remote'; remote.title = 'Open a Remote Window'; remote.textContent = '><';
document.querySelector('#statusbar .left').prepend(remote);
remote.onclick = remotePick;

/* ================= menus ================= */

Object.assign(MENUS, {
  file: () => [
    ['New Text File', newFile, 'Ctrl+N'], ['New File…', newFile, 'Ctrl+Alt+Win+N'], ['New Window', newWindow, 'Ctrl+Shift+N'], ['-'],
    ['Open File…', quickOpen, 'Ctrl+O'], ['Open Folder…', showWorkspace, 'Ctrl+K Ctrl+O'],
    ['▸ Open Recent'], ...[...visitedProfiles].filter(id => TOPICS[id] && id !== TOPIC.id).slice(-4).map(id => ['    ' + TOPICS[id].project, () => loadTopic(id)]), ['    More…', showWorkspace], ['-'],
    ['Save', saveFile, 'Ctrl+S'], ['Save As…', saveAs, 'Ctrl+Shift+S'], ['Save All', saveAll, 'Ctrl+K S'], ['-'],
    [checkmark(settings.autosave) + 'Auto Save', () => { settings.autosave = !settings.autosave; persist('relief.settings', settings); showToast('Auto Save ' + (settings.autosave ? 'on' : 'off') + '.', 'Workspace'); }],
    ['Revert File', revertFile], ['Close Editor', () => closeTab(ap), 'Ctrl+W'], ['Close Folder', showWorkspace, 'Ctrl+K F'], ['-'],
    ['▸ Preferences'], ['    Settings', preferences, 'Ctrl+,'], ['    Keyboard Shortcuts', () => choose('Keyboard Shortcuts', COMMANDS.filter(c => c[2]).map(c => [c[0], c[1], c[2]])), 'Ctrl+K Ctrl+S'], ['    Color Theme', () => choose('Color Theme', ['dark', 'darcula', 'midnight'].map(t => [t === 'dark' ? 'Dark+ (default dark)' : t[0].toUpperCase() + t.slice(1), () => applyTheme(t)])), 'Ctrl+K Ctrl+T'], ['-'],
    ['Exit', exitApp, 'Ctrl+Q'],
  ],
  edit: () => [
    ['Undo', backspace, 'Ctrl+Z'], ['Redo', () => advance(3), 'Ctrl+Y'], ['-'],
    ['Cut', copySelection, 'Ctrl+X'], ['Copy', copySelection, 'Ctrl+C'], ['Paste', pasteInfo, 'Ctrl+V'], ['-'],
    ['Find', () => openFind(false), 'Ctrl+F'], ['Replace', () => openFind(true), 'Ctrl+H'], ['-'],
    ['Find in Files', () => setView('search'), 'Ctrl+Shift+F'], ['Replace in Files', () => setView('search'), 'Ctrl+Shift+H'], ['-'],
    ['Toggle Line Comment', toggleLineComment, 'Ctrl+/'], ['Toggle Block Comment', toggleLineComment, 'Shift+Alt+A'], ['Emmet: Expand Abbreviation', () => showToast('Emmet: nothing to expand on this line.', 'Emmet'), 'Tab'], ['-'],
    ['Edit Source…', editSource], ['Format Document', formatDocument, 'Shift+Alt+F'],
  ],
  selection: () => [
    ['Select All', selectAllCode, 'Ctrl+A'], ['Expand Selection', () => highlightOccurrences(wordAtCursor()), 'Shift+Alt+→'], ['Shrink Selection', clearOccurrences, 'Shift+Alt+←'], ['-'],
    ['Copy Line Up', () => showToast('Line copied up.', 'Editor'), 'Shift+Alt+↑'], ['Copy Line Down', () => showToast('Line copied down.', 'Editor'), 'Shift+Alt+↓'], ['Move Line Up', () => showToast('Line moved up.', 'Editor'), 'Alt+↑'], ['Move Line Down', () => showToast('Line moved down.', 'Editor'), 'Alt+↓'], ['Duplicate Selection', () => showToast('Selection duplicated.', 'Editor')], ['-'],
    ['Add Cursor Above', () => multiCursor(2), 'Ctrl+Alt+↑'], ['Add Cursor Below', () => multiCursor(2), 'Ctrl+Alt+↓'], ['Add Cursors to Line Ends', () => multiCursor(rand(3, 12)), 'Shift+Alt+I'], ['Add Next Occurrence', () => { const n = highlightOccurrences(wordAtCursor()); showToast(n + ' occurrences selected.', 'Editor'); }, 'Ctrl+D'], ['Add Previous Occurrence', () => highlightOccurrences(wordAtCursor())], ['Select All Occurrences', () => { const n = highlightOccurrences(wordAtCursor()); showToast(n + ' occurrences selected.', 'Editor'); }, 'Ctrl+Shift+L'], ['-'],
    [checkmark(settings.columnSelect) + 'Column Selection Mode', () => { settings.columnSelect = !settings.columnSelect; persist('relief.settings', settings); showToast('Column selection mode ' + (settings.columnSelect ? 'on' : 'off') + '.', 'Editor'); }],
  ],
  view: () => [
    ['Command Palette…', commandPalette, 'Ctrl+Shift+P'], ['Open View…', openView], ['-'],
    ['▸ Appearance'], ['    Full Screen', COMMANDS.find(c => c[0] === 'View: Toggle Full Screen')[1], 'F11'], ['    Zen Mode', () => zenMode(), 'Ctrl+K Z'], ['    ' + checkmark(document.body.classList.contains('centered')) + 'Centered Layout', () => toggleBody('centered')],
    ['    ' + checkmark(!document.body.classList.contains('hide-sidebar')) + 'Primary Side Bar', () => toggleBody('hide-sidebar', 'Side bar'), 'Ctrl+B'], ['    ' + checkmark(!document.body.classList.contains('hide-status')) + 'Status Bar', () => toggleBody('hide-status', 'Status bar')], ['    ' + checkmark(!document.body.classList.contains('hide-activity')) + 'Activity Bar', () => toggleBody('hide-activity', 'Activity bar')], ['    ' + checkmark(!$('panel').classList.contains('hidden')) + 'Panel', () => $('panel').classList.toggle('hidden'), 'Ctrl+J'], ['    ' + checkmark(!document.body.classList.contains('hide-minimap')) + 'Minimap', () => toggleBody('hide-minimap', 'Minimap')], ['    ' + checkmark(!document.body.classList.contains('hide-crumbs')) + 'Breadcrumbs', () => toggleBody('hide-crumbs', 'Breadcrumbs')],
    ['    Zoom In', () => zoom(1), 'Ctrl+='], ['    Zoom Out', () => zoom(-1), 'Ctrl+-'], ['    Reset Zoom', () => zoom(0), 'Ctrl+NumPad0'],
    ['▸ Editor Layout'], ['    Split Right', () => splitRight(), 'Ctrl+\\'], ['    Split Down', () => splitRight()], ['    Single Column', closeSplit], ['-'],
    ['Explorer', () => setView('explorer'), 'Ctrl+Shift+E'], ['Search', () => setView('search'), 'Ctrl+Shift+F'], ['Source Control', () => setView('scm'), 'Ctrl+Shift+G'], ['Run', () => setView('debug'), 'Ctrl+Shift+D'], ['Extensions', () => setView('ext'), 'Ctrl+Shift+X'], ['-'],
    ['Problems', () => setPanel('PROBLEMS'), 'Ctrl+Shift+M'], ['Output', () => setPanel('OUTPUT'), 'Ctrl+K Ctrl+H'], ['Debug Console', () => setPanel('DEBUG CONSOLE'), 'Ctrl+Shift+Y'], ['Terminal', () => { setPanel('TERMINAL'); $('terminput').focus(); }, 'Ctrl+`'], ['Ports', () => setPanel('PORTS')], ['-'],
    [checkmark(settings.wrap) + 'Word Wrap', () => { settings.wrap = !settings.wrap; applySettings(); }, 'Alt+Z'], ['Ambient View', () => openZen(), 'Ctrl+Alt+Z'],
  ],
  go: () => [
    ['Back', goBack, 'Alt+←'], ['Forward', goForward, 'Alt+→'], ['Last Edit Location', () => { const p = rotation[rotIdx]; if (p) { openPath(p); codewrap.scrollTop = codewrap.scrollHeight; } }, 'Ctrl+K Ctrl+Q'], ['-'],
    ['▸ Switch Editor'], ['    Next Editor', () => { const i = openTabs.indexOf(ap); openPath(openTabs[(i + 1) % openTabs.length]); }, 'Ctrl+PageDown'], ['    Previous Editor', () => { const i = openTabs.indexOf(ap); openPath(openTabs[(i + openTabs.length - 1) % openTabs.length]); }, 'Ctrl+PageUp'], ['    Switch Group', () => splitPath ? openPath(splitPath) : showToast('Only one editor group is open.', 'Editor')], ['-'],
    ['Go to File…', quickOpen, 'Ctrl+P'], ['Go to Symbol in Workspace…', goToSymbolInWorkspace, 'Ctrl+T'], ['Go to Symbol in Editor…', goToSymbolInEditor, 'Ctrl+Shift+O'], ['-'],
    ['Go to Definition', goToDefinition, 'F12'], ['Go to Declaration', goToDefinition], ['Go to Type Definition', goToDefinition], ['Go to Implementations', goToDefinition, 'Ctrl+F12'], ['Go to References', goToReferences, 'Shift+F12'], ['-'],
    ['Go to Line/Column…', COMMANDS.find(c => c[0] === 'Editor: Go to Line')[1], 'Ctrl+G'], ['Go to Bracket', goToBracket, 'Ctrl+Shift+\\'], ['-'],
    ['Next Problem', () => nextProblem(1), 'F8'], ['Previous Problem', () => nextProblem(-1), 'Shift+F8'], ['Next Change', () => nextProblem(1), 'Alt+F3'], ['Previous Change', () => nextProblem(-1), 'Shift+Alt+F3'], ['-'],
    ['Checkout Branch…', chooseBranch],
  ],
  run: () => [
    ['Start Debugging', startDebug, 'F5'], ['Run Without Debugging', runActiveFile, 'Ctrl+F5'], ['Stop Debugging', stopDebug, 'Shift+F5'], ['Restart Debugging', () => { stopDebug(); setTimeout(startDebug, 300); }, 'Ctrl+Shift+F5'], ['-'],
    ['Open Configurations', () => generatedFile('.vscode/launch.json', launchJson())], ['Add Configuration…', () => { generatedFile('.vscode/launch.json', launchJson()); showToast('Select a debug configuration snippet.', 'Debug'); }], ['-'],
    ['Step Over', stepDebug, 'F10'], ['Step Into', stepDebug, 'F11'], ['Step Out', stepDebug, 'Shift+F11'], ['Continue', startDebug, 'F5'], ['-'],
    ['Toggle Breakpoint', toggleBreakpointAtCursor, 'F9'], ['▸ New Breakpoint'], ['    Conditional Breakpoint…', conditionalBreakpoint], ['    Inline Breakpoint', toggleBreakpointAtCursor, 'Shift+F9'], ['    Function Breakpoint…', () => askText('Function to break on', 'syncUser', n => showToast('Function breakpoint: ' + n, 'Debug'))], ['    Logpoint…', logpoint], ['-'],
    ['Enable All Breakpoints', () => showToast('All breakpoints enabled.', 'Debug')], ['Disable All Breakpoints', () => showToast('All breakpoints disabled (they are still there, judging you).', 'Debug')], ['Remove All Breakpoints', removeAllBreakpoints], ['-'],
    ['Install Additional Debuggers…', () => setView('ext')],
  ],
  terminal: () => [
    ['New Terminal', () => { makeSession(); setPanel('TERMINAL'); $('terminput').focus(); }, 'Ctrl+Shift+`'], ['Split Terminal', () => { makeSession(); setPanel('TERMINAL'); $('terminput').focus(); }, 'Ctrl+Shift+5'], ['-'],
    ['Run Task…', taskPicker], ['Run Build Task…', runBuildTask, 'Ctrl+Shift+B'], ['Run Active File', runActiveFile], ['Run Selected Text', () => { const t = String(window.getSelection() || '').trim(); if (t) { setPanel('TERMINAL'); runCommand(t.split('\n')[0]); } else showToast('Select some text first.', 'Terminal'); }], ['-'],
    ['Show Running Tasks…', showRunningTasks], ['Restart Running Task…', () => { const s = sessions.find(x => x.busy); if (!s) { showToast('No running task.', 'Tasks'); return; } const cmd = s.history[s.history.length - 1]; selectSession(s.id); cancelCommand(); setTimeout(() => runCommand(cmd), 200); }], ['Terminate Task…', terminateTask], ['-'],
    ['Configure Tasks…', () => generatedFile('.vscode/tasks.json', tasksJson())], ['Configure Default Build Task…', () => generatedFile('.vscode/tasks.json', tasksJson())], ['-'],
    ['Clear Terminal', () => { if (currentSession) { currentSession.rows = []; termEl.innerHTML = ''; } }, 'Ctrl+L'], ['Kill Terminal', closeSession],
  ],
  help: () => [
    ['Welcome', showWorkspace], ['Show All Commands', commandPalette, 'Ctrl+Shift+P'], ['Documentation', docsDialog], ['Editor Playground', () => { setView('explorer'); showToast('Playground: you are already in it.', 'Help'); }], ['Show Release Notes', releaseNotes], ['Get Started with Accessibility Features', accessibilityHelp], ['-'],
    ['Keyboard Shortcuts Reference', () => choose('Keyboard Shortcuts', COMMANDS.filter(c => c[2]).map(c => [c[0], c[1], c[2]])), 'Ctrl+K Ctrl+R'], ['Video Tutorials', () => showToast('Video tutorials require a network. This workspace politely has none.', 'Help')], ['Tips and Tricks', tipsAndTricks], ['-'],
    ['Join Us on YouTube', () => showToast('Subscribed (locally).', 'Help')], ['Search Feature Requests', () => showToast('Feature request #1: more coffee. Status: open.', 'Help')], ['Report Issue', reportIssue], ['-'],
    ['View License', licenseDialog], ['Privacy Statement', privacyDialog], ['-'],
    ['Toggle Developer Tools', devTools, 'Ctrl+Shift+I'], ['Open Process Explorer', processExplorer], ['-'],
    ['Check for Updates…', checkUpdates], ['-'],
    ['About', about],
  ],
});

$('gear').addEventListener('click', e => { e.stopImmediatePropagation(); menu($('gear'), [['Command Palette…', commandPalette, 'Ctrl+Shift+P'], ['-'], ['▸ Profiles'], ['    ' + TOPIC.project + ' (current)', showWorkspace], ['    Switch Project…', showWorkspace], ['-'], ['Settings', preferences, 'Ctrl+,'], ['Extensions', () => setView('ext'), 'Ctrl+Shift+X'], ['Keyboard Shortcuts', () => choose('Keyboard Shortcuts', COMMANDS.filter(c => c[2]).map(c => [c[0], c[1], c[2]])), 'Ctrl+K Ctrl+S'], ['Snippets', () => showToast('User snippets: none. Everything you type is original.', 'Snippets')], ['Tasks', taskPicker], ['-'], ['▸ Themes'], ['    Color Theme', () => choose('Color Theme', ['dark', 'darcula', 'midnight'].map(t => [t === 'dark' ? 'Dark+ (default dark)' : t[0].toUpperCase() + t.slice(1), () => applyTheme(t)])), 'Ctrl+K Ctrl+T'], ['    File Icon Theme', () => showToast('File icon theme: Seti (locked in by popular vote).', 'Themes')], ['    Product Icon Theme', () => showToast('Product icon theme: Default.', 'Themes')], ['-'], ['Ambient View', () => openZen(), 'Ctrl+Alt+Z'], ['Check for Updates…', checkUpdates]]); }, true);

/* menus open on hover once one is open, like the real thing */
document.querySelectorAll('[data-menu]').forEach(el => { el.addEventListener('mouseenter', () => { if ($('menupopup').classList.contains('show')) el.click(); }); });

/* ================= context menus ================= */

codewrap.addEventListener('contextmenu', e => {
  e.preventDefault();
  const line = e.target.closest('.line'); if (line && line.id !== 'curline') { doneEl.querySelectorAll('.cursorline').forEach(x => x.classList.remove('cursorline')); line.classList.add('cursorline'); }
  menuAt(e.clientX, e.clientY, [['Go to Definition', goToDefinition, 'F12'], ['Go to References', goToReferences, 'Shift+F12'], ['Peek', goToDefinition], ['-'], ['Rename Symbol', renameSymbol, 'F2'], ['Change All Occurrences', () => highlightOccurrences(wordAtCursor()), 'Ctrl+F2'], ['Format Document', formatDocument, 'Shift+Alt+F'], ['Refactor…', () => showToast('No refactorings available at this location.', 'TypeScript'), 'Ctrl+Shift+R'], ['Source Action…', () => showToast('Organize Imports: imports are already organized. Unusually.', 'TypeScript')], ['-'], ['Toggle Breakpoint', toggleBreakpointAtCursor, 'F9'], ['Toggle Line Comment', toggleLineComment, 'Ctrl+/'], ['-'], ['Cut', copySelection, 'Ctrl+X'], ['Copy', copySelection, 'Ctrl+C'], ['Paste', pasteInfo, 'Ctrl+V'], ['-'], ['Command Palette', commandPalette, 'Ctrl+Shift+P']]);
});

function treeContext(e, path, dirNode) {
  e.preventDefault();
  const dirPath = dirNode ? null : path.split('/').slice(0, -1).join('/');
  const items = [
    ['New File…', () => askText('New file', (dirNode ? dirNode.name : dirPath ? dirPath + '/' : '') + 'untitled.ts', p => { createFile(p, ''); openPath(p); editSource(); })],
    ['New Folder…', () => askText('New folder', (dirPath ? dirPath + '/' : '') + 'folder', p => { extraDirs.add(p); TREE = projectTree(Object.keys(REG)); renderTree(); showToast('Created ' + p, 'Explorer'); })], ['-'],
    ['Reveal in File Explorer', () => showToast('Revealed in the system file explorer (imagine a window).', 'Explorer')], ['Open in Integrated Terminal', () => { setPanel('TERMINAL'); runCommand('cd ' + (dirNode ? dirNode.name : (dirPath || '.'))); $('terminput').focus(); }], ['-'],
    ['Cut', () => showToast('Cut.', 'Explorer'), 'Ctrl+X'], ['Copy', () => showToast('Copied.', 'Explorer'), 'Ctrl+C'], ['Paste', () => showToast('Nothing to paste.', 'Explorer'), 'Ctrl+V'], ['-'],
    ['Copy Path', () => copyText('/home/' + shellInfo().user + '/' + TOPIC.project + '/' + (path || '')), 'Shift+Alt+C'], ['Copy Relative Path', () => copyText(path || '.'), 'Ctrl+K Ctrl+Shift+C'], ['-'],
  ];
  if (!dirNode) items.push(['Rename…', () => askText('Rename', path, p => { if (p !== path && !REG[p]) { createFile(p, REG[path].content); removeFile(path); openPath(p); } }), 'F2'], ['Delete', () => { dialog('Delete ' + path + '?', '<div class="dialog-copy"><p>Are you sure you want to delete <code>' + esc(path) + '</code>?</p><p class="dim">You can restore this file from the Trash. (There is no Trash.)</p></div><button class="action" id="del-ok">Move to Trash</button>'); $('del-ok').onclick = () => { closeDialog(); if (REG[path] && REG[path].typed && path === ap) showToast('Cannot delete a file that is being edited.', 'Explorer'); else { removeFile(path); showToast('Deleted ' + path, 'Explorer'); } }; }, 'Delete']);
  else items.push(['Find in Folder…', () => { setView('search'); searchInput.focus(); }, 'Shift+Alt+F'], ['Collapse All', () => { Object.values(DIRS).forEach(n => n.open = false); renderTree(); }]);
  menuAt(e.clientX, e.clientY, items);
}
treeEl.addEventListener('contextmenu', e => {
  const dirEl = e.target.closest('.item.dir'); const fileEl = e.target.closest('.item[data-path]');
  if (dirEl) treeContext(e, '', DIRS[Number(dirEl.dataset.did)]);
  else if (fileEl) treeContext(e, fileEl.dataset.path, null);
});
tabsEl.addEventListener('contextmenu', e => {
  const tab = e.target.closest('.tab'); if (!tab) return;
  e.preventDefault(); const path = tab.dataset.path;
  menuAt(e.clientX, e.clientY, [['Close', () => closeTab(path), 'Ctrl+W'], ['Close Others', () => { for (const p of openTabs.slice()) if (p !== path) closeTab(p); openPath(path); }], ['Close to the Right', () => { const i = openTabs.indexOf(path); for (const p of openTabs.slice(i + 1)) closeTab(p); }], ['Close All', () => { for (const p of openTabs.slice()) closeTab(p); }], ['-'], ['Copy Path', () => copyText('/home/' + shellInfo().user + '/' + TOPIC.project + '/' + path)], ['Copy Relative Path', () => copyText(path)], ['Reveal in Explorer View', () => { setView('explorer'); const el = treeEl.querySelector('[data-path="' + path + '"]'); if (el) el.scrollIntoView({ block: 'center' }); }], ['-'], ['Keep Open', () => showToast('Pinned ' + REG[path].name + '.', 'Editor'), 'Ctrl+K Enter'], ['Split Right', () => splitRight(path), 'Ctrl+\\']]);
});
tabsEl.addEventListener('auxclick', e => { const tab = e.target.closest('.tab'); if (tab && e.button === 1) { e.preventDefault(); closeTab(tab.dataset.path); } });
$('paneltabs').addEventListener('contextmenu', e => { e.preventDefault(); menuAt(e.clientX, e.clientY, [['Move Panel Right', () => showToast('Panel position: bottom (right is a rumor).', 'View')], ['Maximize Panel Size', () => $('panel-expand').click()], ['Hide Panel', () => $('panel').classList.add('hidden'), 'Ctrl+J']]); });
termEl.addEventListener('contextmenu', e => { e.preventDefault(); menuAt(e.clientX, e.clientY, [['Copy', () => copyText(String(window.getSelection() || '')), 'Ctrl+Shift+C'], ['Paste', pasteInfo, 'Ctrl+Shift+V'], ['-'], ['Select All', () => { const r = document.createRange(); r.selectNodeContents(termEl); const s = window.getSelection(); s.removeAllRanges(); s.addRange(r); }], ['Clear', () => { currentSession.rows = []; termEl.innerHTML = ''; }, 'Ctrl+L'], ['-'], ['Kill Terminal', closeSession]]); });

/* explorer section header actions */
(function explorerActions() {
  const title = document.querySelector('#view-explorer .sbtitle');
  title.innerHTML = '<span>EXPLORER</span><span class="sbactions"><button title="New File…" data-a="file">＋</button><button title="New Folder…" data-a="folder">▣</button><button title="Refresh Explorer" data-a="refresh">⟳</button><button title="Collapse Folders in Explorer" data-a="collapse">⊟</button></span>';
  title.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    const a = b.dataset.a;
    if (a === 'file') askText('New file', 'src/untitled.ts', p => { createFile(p, ''); openPath(p); editSource(); });
    if (a === 'folder') askText('New folder', 'src/new-folder', p => { extraDirs.add(p); TREE = projectTree(Object.keys(REG)); renderTree(); });
    if (a === 'refresh') { renderTree(); showToast('Explorer refreshed.', 'Explorer'); }
    if (a === 'collapse') { Object.values(DIRS).forEach(n => n.open = false); renderTree(); }
  });
})();

/* breadcrumbs: sibling picker */
crumbsEl.onclick = () => { const dir = ap.split('/').slice(0, -1).join('/'); const sib = vfsEntries(dir).filter(e => !e.dir); choose(dir || TOPIC.project, sib.map(e => [e.name, () => openPath(dir ? dir + '/' + e.name : e.name), REG[dir ? dir + '/' + e.name : e.name].mode])); };

/* SCM rows: hover actions (open diff, discard) */
renderScm = (base => () => { base(); $('scmlist').querySelectorAll('.scmrow').forEach(row => { const p = row.dataset.path; row.insertAdjacentHTML('beforeend', '<span class="scmacts"><button title="Open Changes" data-s="diff">±</button><button title="Discard Changes" data-s="discard">↶</button><button title="Stage Changes" data-s="stage">＋</button></span>'); }); })(renderScm);
$('scmlist').addEventListener('click', e => {
  const b = e.target.closest('button[data-s]'); if (!b) return;
  e.stopImmediatePropagation();
  const p = b.closest('.scmrow').dataset.path;
  if (b.dataset.s === 'diff') { const lines = gitDiffFor(p); dialog('Changes — ' + REG[p].name, '<pre class="diffview">' + lines.map(x => typeof x[0] === 'string' ? esc(x[0]) : x[0].html).join('\n') + '</pre>'); }
  if (b.dataset.s === 'discard') { scmChanges.delete(p); renderScm(); showToast('Discarded changes in ' + REG[p].name + '.', 'Git'); }
  if (b.dataset.s === 'stage') { showToast('Staged ' + REG[p].name + '.', 'Git'); }
}, true);

/* ports panel: forward button + row actions */
renderPanels = (base => () => { base(); if (panelName === 'PORTS') { $('portsview').insertAdjacentHTML('afterbegin', '<div class="pheading">Forwarded ports <button class="toolbutton" id="port-add">Forward a Port</button></div>'); $('port-add').onclick = forwardPort; $('portsview').querySelectorAll('tbody tr').forEach(tr => { tr.style.cursor = 'pointer'; tr.title = 'Open in Browser'; tr.onclick = () => showToast('Opening http://localhost:' + tr.children[0].textContent + '/ in your browser. (It opens in your imagination.)', 'Ports'); }); } if (panelName === 'OUTPUT') { const sel = document.createElement('select'); sel.className = 'outchan'; sel.innerHTML = ['Tasks', 'Git', 'TypeScript', 'ESLint', 'Prettier', 'Extensions', 'DevMetrics', 'Window'].map(c => '<option>' + c + '</option>').join(''); sel.value = window.__outChan || 'Tasks'; sel.onchange = () => { window.__outChan = sel.value; renderPanels(); }; const chan = sel.value; if (chan !== 'Tasks') { const lines = { Git: ['> git fetch origin', '> git status -z -uall', '> git rev-parse --show-toplevel', '> git config --get commit.template', '[info] ' + TOPIC.branch + ' is up to date with origin'], TypeScript: ['Using tsserver from: node_modules/typescript/lib', 'Type checking ' + TOPIC.checkFiles + ' files', 'Project loaded in ' + rand(400, 2400) + 'ms', '[watch] no errors'], ESLint: ['ESLint server is running.', 'Validating: ' + (REG[ap] ? REG[ap].name : ''), TOPIC.lintFiles.length + ' warnings, 0 errors'], Prettier: ['[info] Formatting file ' + (REG[ap] ? REG[ap].path : ''), '[info] Using config file at .prettierrc', '[info] File formatted in ' + rand(8, 60) + 'ms'], Extensions: ['Activating extensions…', 'Extension host started in ' + rand(300, 900) + 'ms', installedExts.size + ' extensions loaded'], DevMetrics: ['DevMetrics engine ready.', 'level ' + levelOf(metrics.xp) + ' · xp ' + metrics.xp + ' · best streak ' + metrics.best, 'issues resolved today: ' + bugData.c, 'exact input: ' + (settings.strict ? 'on' : 'off'), 'achievements: ' + unlocked.size + '/' + ACHIEVEMENTS.length], Window: ['[main] window ready', '[main] renderer attached', '[main] update check: none available', '[main] window geometry restored'] }[chan] || []; $('outputview').innerHTML = lines.map(t => '<div class="prow">' + esc(t) + '</div>').join(''); } $('outputview').prepend(sel); } })(renderPanels);

/* ================= keyboard: chords + extra shortcuts (capture, before workbench.js) ================= */

let chord = null, escapeArmed = false;
window.addEventListener('keydown', e => {
  const ctrl = e.ctrlKey || e.metaKey, key = e.key.toLowerCase();
  const inInput = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
  const stop = fn => { e.preventDefault(); e.stopImmediatePropagation(); fn(); };
  if (chord) {
    const c = chord; chord = null;
    if (c === 'k') {
      if (key === 'z') return stop(() => zenMode());
      if (key === 's' && ctrl) return stop(() => choose('Keyboard Shortcuts', COMMANDS.filter(x => x[2]).map(x => [x[0], x[1], x[2]])));
      if (key === 's') return stop(saveAll);
      if (key === 't' && ctrl) return stop(() => choose('Color Theme', ['dark', 'darcula', 'midnight'].map(t => [t, () => applyTheme(t)])));
      if (key === 'o' && ctrl) return stop(showWorkspace);
      if (key === 'h' && ctrl) return stop(() => setPanel('OUTPUT'));
      if (key === 'r' && ctrl) return stop(() => choose('Keyboard Shortcuts', COMMANDS.filter(x => x[2]).map(x => [x[0], x[1], x[2]])));
      if (key === 'f') return stop(showWorkspace);
      if (key === 'q' && ctrl) return stop(() => { const p = rotation[rotIdx]; if (p) openPath(p); });
      if (key === 'enter') return stop(() => showToast('Pinned ' + (REG[ap] ? REG[ap].name : 'editor') + '.', 'Editor'));
    }
    return;
  }
  if (ctrl && key === 'k' && !inInput) { e.preventDefault(); e.stopImmediatePropagation(); chord = 'k'; setTimeout(() => { chord = null; }, 2500); return; }
  if (document.body.classList.contains('zen') && key === 'escape' && !inInput && overlay.classList.contains('hidden')) {
    if (escapeArmed) { escapeArmed = false; return stop(() => zenMode(false)); }
    escapeArmed = true; setTimeout(() => { escapeArmed = false; }, 800);
    return stop(() => {});
  }
  if (!findBox.classList.contains('hidden') && key === 'escape' && findBox.contains(e.target)) return;
  if (ctrl && key === 'f' && !e.shiftKey && !e.altKey && !inInput) return stop(() => openFind(false));
  if (ctrl && key === 'h' && !e.shiftKey && !inInput) return stop(() => openFind(true));
  if (ctrl && e.shiftKey && key === 'o') return stop(goToSymbolInEditor);
  if (ctrl && key === 't' && !e.shiftKey && !inInput) return stop(goToSymbolInWorkspace);
  if (ctrl && e.shiftKey && key === 'e') return stop(() => setView('explorer'));
  if (ctrl && e.shiftKey && key === 'g') return stop(() => setView('scm'));
  if (ctrl && e.shiftKey && key === 'd') return stop(() => setView('debug'));
  if (ctrl && e.shiftKey && key === 'x') return stop(() => setView('ext'));
  if (ctrl && e.shiftKey && key === 'm') return stop(() => setPanel('PROBLEMS'));
  if (ctrl && e.shiftKey && key === 'y') return stop(() => setPanel('DEBUG CONSOLE'));
  if (ctrl && e.shiftKey && key === '`') return stop(() => { makeSession(); setPanel('TERMINAL'); $('terminput').focus(); });
  if (ctrl && e.shiftKey && key === 'i') return stop(devTools);
  if (ctrl && key === '\\' && !inInput) return stop(() => splitRight());
  if (ctrl && (key === '=' || key === '+') && !inInput) return stop(() => zoom(1));
  if (ctrl && key === '-' && !inInput) return stop(() => zoom(-1));
  if (ctrl && key === '/' && !inInput) return stop(toggleLineComment);
  if (ctrl && key === 'd' && !inInput) return stop(() => { const n = highlightOccurrences(wordAtCursor()); lncolEl.textContent = 'Ln ' + cursorLineNo() + ', Col 1 (' + n + ' selected)'; });
  if (ctrl && key === 'o' && !inInput) return stop(quickOpen);
  if (ctrl && key === 'q' && !inInput) return stop(exitApp);
  if (e.altKey && key === 'arrowleft' && !inInput) return stop(goBack);
  if (e.altKey && key === 'arrowright' && !inInput) return stop(goForward);
  if (key === 'f2' && !inInput) return stop(renameSymbol);
  if (key === 'f8' && !inInput) return stop(() => nextProblem(e.shiftKey ? -1 : 1));
  if (key === 'f9' && !inInput) return stop(toggleBreakpointAtCursor);
  if (key === 'f12' && !inInput) return stop(e.shiftKey ? goToReferences : goToDefinition);
  if (e.shiftKey && e.altKey && key === 'f' && !inInput) return stop(formatDocument);
}, true);

COMMANDS.push(
  ['Go: Go to Symbol in Editor', goToSymbolInEditor, 'Ctrl+Shift+O'], ['Go: Go to Symbol in Workspace', goToSymbolInWorkspace, 'Ctrl+T'], ['Go: Go to Definition', goToDefinition, 'F12'], ['Go: Back', goBack, 'Alt+←'], ['Go: Forward', goForward, 'Alt+→'], ['Go: Next Problem', () => nextProblem(1), 'F8'],
  ['Edit: Find', () => openFind(false), 'Ctrl+F'], ['Edit: Replace', () => openFind(true), 'Ctrl+H'], ['Edit: Toggle Line Comment', toggleLineComment, 'Ctrl+/'], ['Edit: Format Document', formatDocument, 'Shift+Alt+F'], ['Edit: Rename Symbol', renameSymbol, 'F2'],
  ['View: Zen Mode', () => zenMode(), 'Ctrl+K Z'], ['View: Split Editor Right', () => splitRight(), 'Ctrl+\\'], ['View: Toggle Minimap', () => toggleBody('hide-minimap', 'Minimap')], ['View: Toggle Breadcrumbs', () => toggleBody('hide-crumbs', 'Breadcrumbs')], ['View: Toggle Status Bar', () => toggleBody('hide-status', 'Status bar')], ['View: Zoom In', () => zoom(1), 'Ctrl+='], ['View: Zoom Out', () => zoom(-1), 'Ctrl+-'], ['View: Notifications', () => bell.click()],
  ['Run: Toggle Breakpoint', toggleBreakpointAtCursor, 'F9'], ['Run: Run Active File', runActiveFile, 'Ctrl+F5'], ['Run: Open launch.json', () => generatedFile('.vscode/launch.json', launchJson())],
  ['Terminal: Run Build Task', runBuildTask], ['Terminal: Configure Tasks', () => generatedFile('.vscode/tasks.json', tasksJson())], ['Terminal: Split Terminal', () => { makeSession(); setPanel('TERMINAL'); }],
  ['Ports: Forward a Port', forwardPort], ['Remote: Open a Remote Window', remotePick], ['Preferences: Open Workspace Settings (JSON)', () => generatedFile('.vscode/settings.json', settingsJson())],
  ['Help: Release Notes', releaseNotes], ['Help: Documentation', docsDialog], ['Help: Process Explorer', processExplorer], ['Help: Report Issue', reportIssue], ['Help: Check for Updates', checkUpdates], ['Help: Tips and Tricks', tipsAndTricks],
);
