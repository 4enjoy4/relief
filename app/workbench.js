'use strict';

const $ = id => document.getElementById(id);
function stored(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch (_) { return fallback; } }
function persist(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) {} }
const settings = Object.assign({strict:false, ambient:true, font:13, quiet:false, wrap:false}, stored('relief.settings', {}));
const metrics = Object.assign({xp:0, correct:0, mistakes:0, challenges:0, best:0}, stored('relief.metrics', {}));
let streak = 0, typedThisSession = 0, activeSeconds = 0, lastInputAt = 0;
let panelName = 'TERMINAL', sessions = [], currentSession = null, terminalSequence = 0;
let outputLog = [], debugLog = [], menuActions = [], modalCleanup = null;
let sourceEditing = false, debugStep = 0;
const sessionStates = new Map();
const hint = document.createElement('div');
hint.id = 'trace-hint';
codewrap.appendChild(hint);
const overlay = document.createElement('div');
overlay.id = 'overlay'; overlay.className = 'hidden';
overlay.innerHTML = '<section id="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title"></section>';
document.body.appendChild(overlay);
let restoreFocus = null;

function closeDialog() {
  if (modalCleanup) modalCleanup();
  modalCleanup = null; sourceEditing = false;
  overlay.classList.add('hidden'); $('dialog').innerHTML = '';
  if (restoreFocus?.isConnected) restoreFocus.focus();
}
function dialog(title, html, cleanup) {
  if (modalCleanup) modalCleanup();
  modalCleanup = cleanup || null;
  restoreFocus = document.activeElement;
  $('dialog').innerHTML = '<div class="dialog-head"><h2 id="dialog-title">' + esc(title) + '</h2><button id="dialog-close" aria-label="Close dialog">×</button></div>' + html;
  overlay.classList.remove('hidden');
  $('dialog-close').onclick = closeDialog;
  ($('dialog').querySelector('input,textarea,select') || $('dialog-close')).focus();
}
overlay.addEventListener('click', e => { if (e.target === overlay) closeDialog(); });

function menu(anchor, entries) {
  menuActions = entries.map(e => e[1]);
  $('menupopup').innerHTML = entries.map((e, i) => e[0] === '-' ? '<div class="msep"></div>' : '<button role="menuitem" data-action="' + i + '">' + esc(e[0]) + '</button>').join('');
  const rect = anchor.getBoundingClientRect();
  $('menupopup').classList.add('show');
  $('menupopup').style.left = Math.min(rect.left, innerWidth - $('menupopup').offsetWidth - 8) + 'px';
  $('menupopup').style.top = Math.max(4, Math.min(rect.bottom, innerHeight - $('menupopup').offsetHeight - 24)) + 'px';
  $('menupopup').querySelector('button')?.focus();
}
$('menupopup').addEventListener('click', e => {
  const button = e.target.closest('button');
  if (!button) return;
  $('menupopup').classList.remove('show');
  menuActions[Number(button.dataset.action)]?.();
});
document.addEventListener('pointerdown', e => {
  if (!e.target.closest('#menupopup, [data-menu], #branch, #termlabel')) $('menupopup').classList.remove('show');
});

function choose(title, choices) {
  dialog(title, '<input id="choice-filter" aria-label="Filter choices" placeholder="Type to filter…" autocomplete="off"><div class="command-list" id="choices"></div>');
  let filtered = choices, selected = 0;
  const draw = () => {
    filtered = choices.filter(x => x[0].toLowerCase().includes($('choice-filter').value.toLowerCase()));
    selected = Math.max(0, Math.min(selected, filtered.length - 1));
    $('choices').innerHTML = filtered.length ? filtered.map((x, i) => '<button class="' + (i === selected ? 'selected' : '') + '" data-choice="' + i + '"><span>' + esc(x[0]) + '</span><small>' + esc(x[2] || '') + '</small></button>').join('') : '<div class="dialog-copy">No matching entries.</div>';
  };
  const activate = i => { const action = filtered[i]?.[1]; if (action) { closeDialog(); action(); } };
  $('choice-filter').oninput = () => { selected = 0; draw(); };
  $('choice-filter').onkeydown = e => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); selected += e.key === 'ArrowDown' ? 1 : -1; draw(); $('choices').children[selected]?.scrollIntoView({block:'nearest'}); }
    if (e.key === 'Enter') { e.preventDefault(); activate(selected); }
  };
  $('choices').onclick = e => { const item = e.target.closest('[data-choice]'); if (item) activate(Number(item.dataset.choice)); };
  draw();
}
function askText(title, value, action) {
  dialog(title, '<form id="text-form"><input id="text-value" aria-label="' + esc(title) + '" value="' + esc(value) + '" required autocomplete="off"><button class="action">Apply</button></form>');
  $('text-form').onsubmit = e => { e.preventDefault(); const value = $('text-value').value.trim(); if (value) { closeDialog(); action(value); } };
}

function showWorkspace() { closeDialog(); renderCards(); welcomeEl.classList.add('show'); }
function setView(view) { document.querySelector('[data-view="' + view + '"]').click(); $('sidebar').classList.remove('hidden'); if (view === 'search') searchInput.focus(); }
function quickOpen() { choose('Go to File', Object.keys(REG).map(path => [path, () => { welcomeEl.classList.remove('show'); openPath(path); }, REG[path].mode])); }
function chooseBranch() { choose('Checkout branch', TOPIC.branches.map(branch => [branch, () => { TOPIC.branch = branch; branchEl.textContent = '⑂ ' + branch; append(currentSession, 'Switched to branch ' + branch, 'ok'); updatePrompt(); }, branch === TOPIC.branch ? 'current' : ''])); }
function toggleAutopilot() { autopilot = !autopilot; showToast('Editor assistance ' + (autopilot ? 'enabled' : 'paused'), 'Language service'); }
function toggleStrict() { settings.strict = !settings.strict; autopilot = false; streak = 0; persist('relief.settings', settings); updateHint(); }
function applySettings() {
  settings.font = Math.max(10, Math.min(22, Number(settings.font) || 13));
  document.body.classList.toggle('quiet', settings.quiet);
  document.body.classList.toggle('wordwrap', settings.wrap);
  codewrap.style.fontSize = settings.font + 'px';
  persist('relief.settings', settings); updateHint();
}
function preferences() {
  dialog('Workspace Settings', '<div class="settings-row"><span>Editor mode</span><select id="setting-mode"><option value="assist">Assisted input</option><option value="strict">Exact input</option></select></div><div class="settings-row"><span>Background task output</span><input type="checkbox" id="setting-ambient"></div><div class="settings-row"><span>Minimal status bar</span><input type="checkbox" id="setting-quiet"></div><div class="settings-row"><span>Word wrap</span><input type="checkbox" id="setting-wrap"></div><div class="settings-row"><span>Editor font size</span><select id="setting-font">' + [11,12,13,14,16,18,20,22].map(n => '<option>' + n + '</option>').join('') + '</select></div><div class="settings-row"><span>Color theme</span><select id="setting-theme"><option value="dark">Dark+</option><option value="darcula">Darcula</option><option value="midnight">Midnight</option></select></div>');
  $('setting-mode').value = settings.strict ? 'strict' : 'assist';
  $('setting-mode').onchange = () => { settings.strict = $('setting-mode').value === 'strict'; autopilot = false; applySettings(); };
  ['ambient','quiet','wrap'].forEach(key => { $('setting-' + key).checked = settings[key]; $('setting-' + key).onchange = e => { settings[key] = e.target.checked; applySettings(); }; });
  $('setting-font').value = settings.font;
  $('setting-font').onchange = e => { settings.font = Number(e.target.value); applySettings(); };
  $('setting-theme').value = document.body.classList.contains('theme-midnight') ? 'midnight' : document.body.classList.contains('theme-darcula') ? 'darcula' : 'dark';
  $('setting-theme').onchange = e => applyTheme(e.target.value);
}
applyTheme = (base => theme => { base(theme); document.body.classList.toggle('theme-midnight', theme === 'midnight'); })(applyTheme);

function updateHint() {
  const f = REG[ap];
  hint.classList.toggle('hidden', !settings.strict || !f?.typed || welcomeEl.classList.contains('show'));
  if (f?.typed) {
    const remaining = f.content.slice(f.st.pos).split('\n')[0];
    hint.textContent = '// @trace ' + (remaining || '↵') + '  ·  ' + streak;
  }
}
function metricsDialog() {
  const accuracy = metrics.correct + metrics.mistakes ? Math.round(metrics.correct / (metrics.correct + metrics.mistakes) * 100) : 100;
  dialog('Language Service · Diagnostics', '<div class="metric-grid"><div><strong>' + (1 + Math.floor(metrics.xp / 500)) + '</strong>Level</div><div><strong>' + metrics.xp + '</strong>XP</div><div><strong>' + accuracy + '%</strong>Accuracy</div></div><div class="dialog-copy"><p>' + metrics.challenges + ' lines completed · best streak ' + metrics.best + '</p><p>Exact input turns the faint <code>// @trace</code> line into a typing challenge. Type the suggested characters; Enter completes a line. Leading indentation is supplied. Correct characters build your streak and earn XP.</p><p><code>Ctrl+Alt+G</code> toggles exact input. <code>Ctrl+Alt+A</code> toggles assisted background typing. Progress stays on this device.</p></div><button class="action" id="challenge-toggle">' + (settings.strict ? 'Use assisted input' : 'Start exact input') + '</button>');
  $('challenge-toggle').onclick = () => { toggleStrict(); closeDialog(); };
}
function recordInput(correct) {
  lastInputAt = Date.now(); lastKey = lastInputAt;
  if (correct) { metrics.correct++; typedThisSession++; streak++; metrics.xp += 1 + (streak % 50 === 0 ? 10 : 0); metrics.best = Math.max(metrics.best, streak); }
  else { metrics.mistakes++; streak = 0; hint.classList.add('miss'); setTimeout(() => hint.classList.remove('miss'), 180); }
  persist('relief.metrics', metrics);
}
setInterval(() => {
  if (Date.now() - lastInputAt < 5000 && !document.hidden) activeSeconds++;
  $('typingstats').textContent = Math.floor(activeSeconds / 60).toString().padStart(2,'0') + ':' + (activeSeconds % 60).toString().padStart(2,'0') + ' · ' + (activeSeconds ? Math.round(typedThisSession / 5 / (activeSeconds / 60)) : 0) + ' wpm';
  $('focusrank').textContent = 'LSP: ready';
}, 1000);
$('focusrank').onclick = metricsDialog;
$('typingstats').onclick = metricsDialog;

function makeSession() {
  if (sessions.length >= 6) { showToast('Close a terminal before opening another (6 active).', 'Terminal'); return; }
  const session = {id:++terminalSequence, cwd:'', rows:[], history:[], historyIndex:0, epoch:0, busy:false, draft:'', exitCode:0};
  sessions.push(session); selectSession(session.id);
  append(session, 'dev@' + TOPIC.shell.host + '  ' + TOPIC.project, 'dim');
  return session;
}
function append(session, text, style = '') {
  return appendHtml(session, style ? '<span class="' + style + '">' + esc(String(text)) + '</span>' : esc(String(text)));
}
function appendHtml(session, html) {
  if (!session || !sessions.includes(session)) return document.createElement('div');
  session.rows.push(html); if (session.rows.length > 600) session.rows.shift();
  const row = document.createElement('div'); row.className = 'tl'; row.innerHTML = html;
  if (session === currentSession) {
    const atBottom = termEl.scrollHeight - termEl.scrollTop - termEl.clientHeight < 50;
    termEl.appendChild(row); while (termEl.children.length > 600) termEl.firstChild.remove();
    if (atBottom) termEl.scrollTop = termEl.scrollHeight;
  }
  return row;
}
tline = html => appendHtml(currentSession, html);
function selectSession(id) {
  if (currentSession) currentSession.draft = $('terminput').value;
  currentSession = sessions.find(s => s.id === Number(id));
  if (!currentSession) return;
  termEl.innerHTML = currentSession.rows.map(html => '<div class="tl">' + html + '</div>').join('');
  $('terminput').value = currentSession.draft;
  termEl.scrollTop = termEl.scrollHeight; renderTerminalTools(); updatePrompt();
}
function closeSession() {
  if (!currentSession) return;
  currentSession.epoch++; currentSession.busy = false;
  sessions = sessions.filter(s => s !== currentSession); currentSession = null;
  if (!sessions.length) makeSession(); else selectSession(sessions[sessions.length - 1].id);
}
function renderTerminalTools() {
  $('termlabel').innerHTML = '<select id="terminal-select" aria-label="Terminal session">' + sessions.map(s => '<option value="' + s.id + '"' + (s === currentSession ? ' selected' : '') + '>bash — ' + s.id + '</option>').join('') + '</select><button id="terminal-new" title="New terminal" aria-label="New terminal">+</button><button id="terminal-stop" title="Stop task (Ctrl+C)" aria-label="Stop task">■</button><button id="terminal-close" title="Close terminal" aria-label="Close terminal">×</button><button id="panel-expand" title="Expand panel" aria-label="Expand panel">⌃</button><button id="panel-hide" title="Hide panel" aria-label="Hide panel">−</button>';
  $('terminal-select').onchange = e => selectSession(e.target.value);
  $('terminal-new').onclick = () => { makeSession(); setPanel('TERMINAL'); $('terminput').focus(); };
  $('terminal-close').onclick = closeSession;
  $('terminal-stop').onclick = cancelCommand;
  $('panel-hide').onclick = () => $('panel').classList.add('hidden');
  $('panel-expand').onclick = () => { $('panel').style.height = $('panel').offsetHeight > innerHeight * .45 ? '230px' : '60vh'; };
}
function updatePrompt() {
  if (!currentSession || !TOPIC) return;
  $('termprompt').textContent = TOPIC.shell.user + '@' + TOPIC.shell.host + ':~/' + TOPIC.project + (currentSession.cwd ? '/' + currentSession.cwd : '') + ' $';
  $('termbusy').classList.toggle('hidden', !currentSession.busy);
}
function cancelCommand() {
  if (!currentSession) return;
  currentSession.epoch++; currentSession.busy = false; currentSession.exitCode = 130;
  append(currentSession, '^C', 'dim'); updatePrompt();
}
function resolvePath(input, session = currentSession) {
  input = input.replace(/^~\//, '/');
  const parts = input.startsWith('/') ? [] : session.cwd.split('/').filter(Boolean);
  for (const part of input.split('/')) { if (part === '..') parts.pop(); else if (part && part !== '.') parts.push(part); }
  if (parts[0] === TOPIC.project) parts.shift();
  return parts.join('/');
}
function tokens(command) {
  const matches = command.match(/"(?:[^"\\]|\\.)*"|'[^']*'|[^\s]+/g) || [];
  return matches.map(s => /^['"]/.test(s) ? s.slice(1, -1) : s);
}
function logOutput(text) { outputLog.push(nowStr() + '  ' + text); if (outputLog.length > 300) outputLog.shift(); if (panelName === 'OUTPUT') renderPanels(); }

const JOB_COMMANDS = {
  typecheck:'npx tsc --noEmit', jest:'npm test', vitest:'npx vitest run', eslint:'npm run lint', prettier:'npx prettier --check .',
  npminstall:'npm install', npmaudit:'npm audit', vitebuild:'npm run build', webpack:'npx webpack', gitfetch:'git fetch', gitstatus:'git status',
  docker:'docker build .', dockercompose:'docker compose up', k8s:'kubectl get pods', helm:'helm upgrade --install app ./charts', migrate:'npm run migrate', hmr:'npm run dev', lighthouse:'npx lighthouse localhost:3000', e2e:'npx playwright test', storybook:'npm run storybook',
  pytest:'pytest', ruff:'ruff check .', mypy:'mypy .', pipinstall:'pip install -r requirements.txt', black:'black --check .', uvicorn:'uvicorn app:app --reload', alembic:'alembic upgrade head', dataset:'python pipeline/dataset.py', train:'python pipeline/train_model.py', onnx:'python pipeline/export.py', reconcile:'npm run reconcile', compliance:'npm run compliance', atlas:'python tools/atlas_packer.py', shaderc:'glslc assets/fire.frag', fps:'npm run benchmark',
  metro:'npx react-native start', gradle:'./gradlew assembleDebug', xcodebuild:'xcodebuild -scheme Pulse -configuration Debug', pod:'pod install', adb:'adb devices', detox:'npx detox test', fastlane:'bundle exec fastlane beta',
  terraform:'terraform plan', ansible:'ansible-playbook deploy.yml', packer:'packer build image.pkr.hcl', kubectlapply:'kubectl apply -f manifests/', argocd:'argocd app sync staging', prometheus:'promtool check config prometheus.yml', vault:'vault status',
  cargobuild:'cargo build', cargotest:'cargo test', clippy:'cargo clippy', probe:'probe-rs run --chip STM32F411CEUx', defmt:'defmt-print', cbindgen:'cbindgen --output bindings.h',
  gobuild:'go build ./...', gotest:'go test ./...', govet:'go vet ./...', golangci:'golangci-lint run', protoc:'protoc --go_out=. api/dispatch.proto', grpcurl:'grpcurl localhost:8080 list',
  mvn:'mvn package', junit:'mvn test', spotless:'mvn spotless:check', flyway:'mvn flyway:migrate', springboot:'mvn spring-boot:run',
  hardhat:'npx hardhat compile', hardhattest:'npx hardhat test', solc:'solc contracts/SettlementVault.sol', slither:'slither .', gasreport:'npm run gas', hardhatnode:'npx hardhat node',
  dbtrun:'dbt run', dbttest:'dbt test', airflow:'airflow dags list', spark:'spark-submit jobs/spark/orders_incremental.py', greatexpectations:'great_expectations checkpoint run orders',
  cmake:'cmake -S . -B build', ninja:'ninja -C build', ctest:'ctest --test-dir build', clangtidy:'clang-tidy src/*.cpp', valgrind:'valgrind ./build/vector-runtime', benchmark:'./build/benchmark', pybind:'python -m build',
};
function taskPicker() { choose('Run Task', TOPIC.jobs.map(job => [JOB_COMMANDS[job] || job, () => { setPanel('TERMINAL'); runCommand(JOB_COMMANDS[job] || job); }, job])); }

function jobLines(job, command, topic) {
  const sourceFiles = Object.keys(REG).filter(p => /\.(ts|tsx|go|rs|java|py|kt|cpp|sol)$/.test(p));
  const testJobs = /^(jest|vitest|pytest|cargotest|gotest|junit|hardhattest|dbttest|ctest|detox|e2e)$/;
  if (testJobs.test(job)) {
    const total = topic.suites.reduce((n, s) => n + s[1], 0);
    return ['$ ' + command, '', ...topic.suites.flatMap(s => ['PASS  ' + s[0], '  ✓ ' + s[1] + ' cases · validation, recovery, ordering']), '', 'Test Suites: ' + topic.suites.length + ' passed, ' + topic.suites.length + ' total', 'Tests:       ' + total + ' passed, ' + total + ' total', 'Time:        2.184 s'];
  }
  const named = {
    metro:['Welcome to Metro', 'Loading dependency graph, done.', ' BUNDLE  ./index.js', 'Android bundler ready on port 8081', 'Waiting for device connection…'],
    gradle:['> Task :app:preBuild UP-TO-DATE','> Task :app:compileDebugKotlin','> Task :app:mergeDebugResources','> Task :app:dexBuilderDebug','> Task :app:packageDebug','BUILD SUCCESSFUL in 4s','42 actionable tasks: 8 executed, 34 up-to-date'],
    xcodebuild:['Resolve Package Graph','CompileSwift normal arm64','CompileAssetCatalog Pulse.app','CodeSign build/Debug-iphonesimulator/Pulse.app','** BUILD SUCCEEDED **'],
    adb:['List of devices attached','emulator-5554    device product:sdk_gphone64_arm64 model:Pixel_8_API_35','emulator-5556    device product:sdk_gphone64_arm64 model:Pixel_Tablet_API_35'],
    pod:['Analyzing dependencies','Downloading dependencies','Installing React-Core','Generating Pods project','Integrating client project','Pod installation complete!'],
    fastlane:['[lane] Driving the beta lane','[step] increment_build_number','[step] build_app','[archive] Local archive completed','Upload skipped: local signing profile'],
    terraform:['Initializing provider plugins…','Terraform has been successfully initialized!','Refreshing state…','+ module.cluster.aws_eks_node_group.workers','~ module.network.aws_security_group.internal','Plan: 1 to add, 1 to change, 0 to destroy.','Plan saved locally. Apply with terraform apply.'],
    ansible:['PLAY [staging]','TASK [Gathering Facts]','ok: [worker-01]','TASK [Apply configuration]','changed: [worker-01]','PLAY RECAP','worker-01 : ok=12 changed=1 unreachable=0 failed=0'],
    cargobuild:['Compiling proc-macro2 v1.0.86','Compiling embassy-executor v0.7.0','Compiling ' + topic.project + ' v' + topic.version,'Finished dev profile [optimized + debuginfo] target(s) in 3.92s'],
    probe:['Flashing device STM32F411CEUx','Erasing sectors [====================] 100%','Programming     [====================] 100%','Verify successful','INFO boot complete','INFO sensor bus ready · 100 Hz'],
    defmt:['INFO firmware started','DEBUG dma channel configured','INFO sample temperature=24.18 voltage=3.29','DEBUG ring buffer capacity=256 used=12'],
    gobuild:['go: resolving module graph','go: compiling dispatch.internal.corp/service/internal/dispatcher','go: compiling dispatch.internal.corp/service/cmd/server','Build completed: bin/server'],
    mvn:['[INFO] Scanning for projects…','[INFO] Building ' + topic.project + ' ' + topic.version,'[INFO] --- compiler:compile ---','[INFO] Compiling ' + topic.checkFiles + ' source files','[INFO] --- jar:jar ---','[INFO] BUILD SUCCESS'],
    springboot:[':: Spring Boot ::','Starting ' + topic.project,'HikariPool-1 - Start completed.','Tomcat initialized with port 8080 (http)','Started application in 2.402 seconds'],
    hardhat:['Compiling Solidity sources…','Compiled 12 Solidity files successfully (evm target: paris).','Generating typings for: 12 artifacts','Successfully generated 48 typings'],
    hardhatnode:['Started HTTP and WebSocket JSON-RPC server at http://127.0.0.1:8545/','Network: local development · chain ID 31337','eth_chainId','eth_blockNumber','Local node ready.'],
    gasreport:['Contract             Method          Gas','SettlementVault      setEpoch1       43812','AccessRegistry       setQuota1       44108','TimelockPolicy       setDelay1       42995','Report written to reports/gas.txt'],
    dbtrun:['Running with dbt','Found 24 models, 38 data tests, 4 sources','1 of 3 START incremental model marts.fct_orders','1 of 3 OK created incremental model marts.fct_orders','2 of 3 OK created table model marts.dim_customers','3 of 3 OK created view model marts.agg_daily_revenue','Completed successfully. PASS=3 WARN=0 ERROR=0 SKIP=0 TOTAL=3'],
    airflow:['dag_id                  owner       is_paused','orders_incremental      data        False','daily_quality           data        False','warehouse_compaction    platform    True'],
    spark:['INFO SparkContext: Running Spark','INFO DAGScheduler: Submitting result stage 12','INFO TaskSetManager: Finished task 31.0 in stage 12.0 (32/32)','INFO DeltaLog: Committed version 184','INFO orders_incremental: 2841 rows merged; watermark advanced'],
    cmake:['-- The CXX compiler identification is Clang','-- Detecting CXX compiler ABI info - done','-- Found Threads: TRUE','-- Configuring done','-- Generating done','-- Build files have been written to: build'],
    ninja:['ninja: Entering directory `build`','[1/4] Building CXX object src/QueryEngine.cpp.o','[2/4] Building CXX object src/BufferPool.cpp.o','[3/4] Linking CXX static library libvector_runtime.a','[4/4] Linking CXX executable vector-runtime'],
    valgrind:['Memcheck, a memory error detector','HEAP SUMMARY:','  in use at exit: 0 bytes in 0 blocks','  total heap usage: 2,048 allocs, 2,048 frees','All heap blocks were freed -- no leaks are possible','ERROR SUMMARY: 0 errors from 0 contexts'],
    docker:['[+] Building ' + topic.project,'[1/5] FROM base image','[2/5] COPY dependency manifests','[3/5] RUN install dependencies','[4/5] COPY source tree','[5/5] RUN build','exporting layers','writing image sha256:3a291cb47ef0…','Image available in local cache'],
    train:['Loading training and validation splits','Epoch 1/5 loss=0.6124 val_auc=0.8120','Epoch 2/5 loss=0.4801 val_auc=0.8481','Epoch 3/5 loss=0.3925 val_auc=0.8624','Epoch 4/5 loss=0.3508 val_auc=0.8715','Epoch 5/5 loss=0.3284 val_auc=0.8793','Checkpoint written: artifacts/model-best.pt'],
    npminstall:['Resolving dependency tree…','Packages: +148','Progress: resolved 148, reused 142, downloaded 6, added 148','added 148 packages, and audited 149 packages in 3s','found 0 vulnerabilities'],
    npmaudit:['Auditing dependency graph…','found 0 vulnerabilities'],
    pipinstall:['Collecting dependencies from requirements.txt','Using cached wheels','Installing collected packages','Successfully installed project dependencies'],
  };
  if (named[job]) return ['$ ' + command, '', ...named[job]];
  if (/eslint|ruff|clippy|clangtidy|slither|spotless|golangci|mypy|govet|typecheck|solc|prettier|black/.test(job)) return ['$ ' + command, '', 'Checking ' + sourceFiles.length + ' source files…', ...sourceFiles.slice(0,3).map(p => '  checked ' + p), 'Analysis complete: 0 errors.'];
  return ['$ ' + command, '', '[' + job + '] loading ' + topic.project + ' configuration', '[' + job + '] resolving inputs', ...sourceFiles.slice(0,3).map(p => '  processing ' + p), '[' + job + '] completed successfully'];
}

function detectJob(command, args) {
  const exact = Object.entries(JOB_COMMANDS).find(([, cmd]) => cmd === command);
  if (exact) return exact[0];
  const pairs = [[/\bgradlew?\b/, 'gradle'], [/\bxcodebuild\b/,'xcodebuild'], [/^adb\s/,'adb'], [/^pod\s/,'pod'], [/\breact-native\b.*start/,'metro'], [/\bdetox\b/,'detox'], [/\bfastlane\b/,'fastlane'], [/^cargo (build|check)/,'cargobuild'], [/^cargo test/,'cargotest'], [/^cargo clippy/,'clippy'], [/^go build/,'gobuild'], [/^go run/,'gobuild'], [/^go test/,'gotest'], [/^go vet/,'govet'], [/^mvn .*test/,'junit'], [/^mvn /,'mvn'], [/\bhardhat test/,'hardhattest'], [/\bhardhat node/,'hardhatnode'], [/\bhardhat compile/,'hardhat'], [/^terraform (plan|init|validate|apply|fmt)/,'terraform'], [/^dbt test/,'dbttest'], [/^dbt run/,'dbtrun'], [/^docker build/,'docker'], [/^docker compose/,'dockercompose'], [/^kubectl /,'kubectlapply'], [/^pytest/,'pytest'], [/^cmake --build/,'ninja'], [/^cmake /,'cmake'], [/^ctest/,'ctest'], [/^ninja/,'ninja']];
  for (const [pattern, job] of pairs) if (pattern.test(command)) return job;
  if (/^(npm|pnpm|yarn|bun) (install|ci|add)\b/.test(command)) return 'npminstall';
  if (/^(npm|pnpm|yarn|bun) (run )?(test|build|lint|dev|start|migrate|gas)\b/.test(command)) {
    const action = args[1] === 'run' ? args[2] : args[1];
    if (action === 'test') return TOPIC.id === 'blockchain' ? 'hardhattest' : 'jest';
    if (action === 'build') return TOPIC.id === 'blockchain' ? 'hardhat' : 'vitebuild';
    if (action === 'lint') return 'eslint';
    if (action === 'gas') return 'gasreport';
    if (action === 'migrate') return 'migrate';
    return TOPIC.id === 'mobile' ? 'metro' : 'hmr';
  }
  return null;
}

async function runCommand(raw) {
  const session = currentSession, topic = TOPIC;
  const command = raw.trim();
  if (!command || !session) return;
  if (session.busy) { showToast('Task running. Use Ctrl+C to interrupt it.', 'Terminal'); return; }
  session.history.push(command); session.history = session.history.slice(-100); session.historyIndex = session.history.length;
  append(session, '$ ' + command, 'mag'); session.draft = ''; $('terminput').value = '';
  const args = tokens(command), cmd = args[0], sub = args[1];
  const say = (text, style) => append(session, text, style);
  session.exitCode = 0;
  const fail = text => { session.exitCode = 1; say(text, 'err'); };
  if (/[;|><]|\$\(|`/.test(command)) { fail('Shell operators are unavailable. Run one workspace command at a time.'); return; }
  if (cmd === 'clear' || cmd === 'cls') { session.rows = []; termEl.innerHTML = ''; return; }
  if (cmd === 'help') { say('Workspace shell · commands run locally in the simulation', 'dim'); say('pwd  ls [path]  cd <dir>  cat <file>  head <file>  tail <file>  tree  find <name>\nopen <file>  wc -l <file>  echo <text>  date  whoami  history  clear  exit\ngit status|log|diff|branch|switch|checkout|add|commit|push|pull|fetch\nnpm / pnpm / yarn · cargo · go · mvn · gradle · xcodebuild · adb\nterraform · docker · kubectl · dbt · pytest · cmake · ctest\nUse Run → Run Task for commands specific to this project.\n↑/↓ history · Tab completion · Ctrl+C cancel · Ctrl+L clear'); return; }
  if (cmd === 'pwd') { say('/home/' + topic.shell.user + '/' + topic.project + (session.cwd ? '/' + session.cwd : '')); return; }
  if (cmd === 'whoami') { say(topic.shell.user); return; }
  if (cmd === 'date') { say(new Date().toString()); return; }
  if (cmd === 'echo') { say(args.slice(1).join(' ').replace('$?', String(session.lastExitCode || 0))); return; }
  if (cmd === 'history') { say(session.history.map((c,i) => String(i+1).padStart(4) + '  ' + c).join('\n')); return; }
  if (cmd === 'exit') { closeSession(); return; }
  if (cmd === 'cd') {
    const path = !sub || sub === '~' ? '' : resolvePath(sub, session);
    if (path && !Object.keys(REG).some(p => p.startsWith(path + '/'))) fail('bash: cd: ' + sub + ': No such directory');
    else { session.cwd = path; updatePrompt(); }
    return;
  }
  if (cmd === 'ls' || cmd === 'dir') {
    const path = resolvePath(args.slice(1).find(a => !a.startsWith('-')) || '.', session);
    const prefix = path ? path + '/' : '';
    if (REG[path]) say(path.split('/').pop());
    else {
      const names = [...new Set(Object.keys(REG).filter(p => p.startsWith(prefix)).map(p => { const rest = p.slice(prefix.length); return rest.split('/')[0] + (rest.includes('/') ? '/' : ''); }))];
      if (!names.length) fail('ls: cannot access ' + (sub || '.') + ': No such directory'); else say(names.sort().join('   '));
    }
    return;
  }
  if (['cat','head','tail','open','code','wc'].includes(cmd)) {
    const pathArg = args.slice(1).filter(a => !a.startsWith('-')).pop();
    if (!pathArg) { fail('usage: ' + cmd + ' <file>'); return; }
    const path = resolvePath(pathArg, session), f = REG[path];
    if (!f) { fail(cmd + ': ' + pathArg + ': No such file'); return; }
    if (cmd === 'open' || cmd === 'code') { openPath(path); welcomeEl.classList.remove('show'); }
    else if (cmd === 'wc') say(lineCountOf(f) + ' ' + path);
    else { const lines = f.content.trimEnd().split('\n'); say((cmd === 'head' ? lines.slice(0,10) : cmd === 'tail' ? lines.slice(-10) : lines.slice(0,300)).join('\n')); if (cmd === 'cat' && lines.length > 300) say('[showing first 300 lines; use open to inspect the complete file]', 'dim'); }
    return;
  }
  if (cmd === 'tree' || cmd === 'find') { const query = cmd === 'find' ? (sub || '').toLowerCase() : ''; say(Object.keys(REG).filter(p => p.startsWith(session.cwd) && p.toLowerCase().includes(query)).join('\n')); return; }
  if (cmd === 'git') {
    if (!sub || sub === 'help') { say('git status | log | diff | branch | switch <branch> | add . | commit -m "message" | push | pull | fetch'); return; }
    if (sub === 'status') { say('On branch ' + topic.branch + '\n' + (aheadCount ? 'Your branch is ahead by ' + aheadCount + ' commit(s).\n' : '') + (scmChanges.size ? 'Changes to be committed:\n' + [...scmChanges].map(p => '  modified: ' + p).join('\n') : 'nothing to commit, working tree clean')); return; }
    if (sub === 'log') { say(topic.commits.map(c => args.includes('--oneline') ? c[0] + ' ' + c[1] : 'commit ' + c[0] + '\nAuthor: ' + c[2] + '\nDate: ' + c[3] + '\n\n    ' + c[1] + '\n').join('\n')); return; }
    if (sub === 'diff') { say([...scmChanges].map(p => 'diff --git a/' + p + ' b/' + p + '\n--- a/' + p + '\n+++ b/' + p + '\n@@ workspace changes @@\n+' + (REG[p].st?.curText || REG[p].lines[0])).join('\n') || 'No changes.'); return; }
    if (sub === 'branch') { if (args[2] && !args[2].startsWith('-')) { if (!topic.branches.includes(args[2])) topic.branches.push(args[2]); say('Created branch ' + args[2]); } else say(topic.branches.map(b => (b === topic.branch ? '* ' : '  ') + b).join('\n')); return; }
    if (sub === 'checkout' || sub === 'switch') {
      const creating = ['-b','-c'].includes(args[2]), branch = args[creating ? 3 : 2];
      if (creating && branch && !topic.branches.includes(branch)) topic.branches.push(branch);
      if (!topic.branches.includes(branch)) fail('error: unknown branch: ' + (branch || '')); else { topic.branch = branch; branchEl.textContent = '⑂ ' + branch; say('Switched to branch ' + branch); }
      return;
    }
    if (sub === 'add') { if (!args[2]) fail('usage: git add <file|.>'); else say(scmChanges.size + ' modified files staged'); return; }
    if (sub === 'commit') { const i = args.indexOf('-m'); if (i < 0 || !args[i+1]) fail('usage: git commit -m "message"'); else commitChanges(args[i+1], session); return; }
    if (sub === 'push' || sub === 'pull' || sub === 'fetch') { say('From ' + topic.remote); if (sub === 'push') { say(aheadCount ? topic.branch + ' -> ' + topic.branch + ' (' + aheadCount + ' commits)' : 'Everything up-to-date'); aheadCount = 0; renderSync(); } else say('Already up to date.'); return; }
    fail('git: unsupported workspace command ' + sub); return;
  }
  if ((cmd === 'npm' || cmd === 'pnpm' || cmd === 'yarn') && (!sub || sub === 'run' && !args[2])) { say('Scripts available in ' + topic.project + ':\n' + topic.scripts.map(s => '  ' + s[0] + '\n    ' + s[1]).join('\n')); return; }
  if (cmd === 'make') { const script = topic.scripts.find(s => s[0] === (sub || 'build')); if (script && script[1] !== command) { say(script[1], 'dim'); return executeJob(session, detectJob(script[1], tokens(script[1])) || topic.jobs[0], script[1], topic); } }
  if (/^(rm|del|sudo|curl|wget|ssh|powershell|cmd|bash|sh)$/.test(cmd)) { fail(cmd + ': unavailable in the workspace shell'); return; }
  const job = detectJob(command, args);
  if (!job) { session.exitCode = 127; say('bash: ' + command + ': command not found. Type help or choose Run → Run Task.', 'err'); return; }
  return executeJob(session, job, command, topic);
}
async function executeJob(session, job, command, topic) {
  const epoch = ++session.epoch, generation = topicGen;
  session.busy = true; updatePrompt(); logOutput('Started ' + command);
  try {
    for (const line of jobLines(job, command, topic).slice(1)) {
      await sleep(line ? 130 + Math.random() * 180 : 60);
      if (session.epoch !== epoch || generation !== topicGen || !sessions.includes(session)) return;
      append(session, line, /PASS|SUCCESS|success|complete|Finished|✓/.test(line) ? 'ok' : /warning/i.test(line) ? 'warn' : '');
    }
    append(session, 'Process exited with code 0', 'dim'); session.exitCode = 0;
    logOutput('Completed ' + command + ' · exit 0');
  } finally { if (session.epoch === epoch) { session.busy = false; if (session === currentSession) updatePrompt(); } }
}
$('termform').addEventListener('submit', e => { e.preventDefault(); runCommand($('terminput').value).catch(e => { append(currentSession, 'Task failed: ' + e.message, 'err'); }); });
$('terminput').addEventListener('keydown', e => {
  const session = currentSession; if (!session) return;
  if (e.ctrlKey && e.key.toLowerCase() === 'c' && !window.getSelection().toString()) { e.preventDefault(); cancelCommand(); }
  if (e.ctrlKey && e.key.toLowerCase() === 'l') { e.preventDefault(); session.rows = []; termEl.innerHTML = ''; }
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    e.preventDefault(); if (session.historyIndex === session.history.length) session.draft = e.target.value;
    session.historyIndex = Math.max(0, Math.min(session.history.length, session.historyIndex + (e.key === 'ArrowUp' ? -1 : 1)));
    e.target.value = session.history[session.historyIndex] ?? session.draft;
  }
  if (e.key === 'Tab') {
    e.preventDefault(); const value = e.target.value, words = value.split(' '), last = words.pop();
    const options = words.length ? [...Object.keys(REG).map(p => session.cwd && p.startsWith(session.cwd + '/') ? p.slice(session.cwd.length + 1) : p), ...TOPIC.branches] : ['help','pwd','ls','cd','cat','head','tail','tree','find','open','git','clear','history', ...new Set(Object.values(JOB_COMMANDS).map(c => c.split(' ')[0]))];
    const matches = options.filter(p => p.startsWith(last));
    if (matches.length === 1) e.target.value = [...words, matches[0]].join(' ');
    else if (matches.length > 1) append(session, matches.slice(0,16).join('  '), 'dim');
  }
});

function setPanel(name) { panelName = name; $('panel').classList.remove('hidden'); document.querySelectorAll('.ptab').forEach(el => el.classList.toggle('on', el.textContent === name)); renderPanels(); }
function renderPanels() {
  const names = {TERMINAL:'term', PROBLEMS:'problemsview', OUTPUT:'outputview', 'DEBUG CONSOLE':'debugconsoleview', PORTS:'portsview'};
  Object.entries(names).forEach(([name,id]) => $(id).classList.toggle('hidden', panelName !== name));
  $('termform').classList.toggle('hidden', panelName !== 'TERMINAL');
  if (!TOPIC) return;
  $('problemsview').innerHTML = '<div class="pheading">' + TOPIC.lintFiles.length + ' workspace diagnostics</div>' + TOPIC.lintFiles.map(([path, msg, rule], i) => '<button class="problem-link" data-problem="' + i + '">⚠ ' + esc(path) + ' · ' + esc(msg) + ' (' + esc(rule) + ')</button>').join('');
  $('outputview').innerHTML = (outputLog.length ? outputLog : ['Language service initialized.', 'Watching ' + Object.keys(REG).length + ' workspace files.']).map(t => '<div class="prow">' + esc(t) + '</div>').join('');
  $('debugconsoleview').innerHTML = '<div class="pheading">' + esc(TOPIC.debug.conf) + '</div>' + (debugLog.length ? debugLog : ['Debugger is not attached. Press F5 to start.']).map(t => '<div class="prow">' + esc(t) + '</div>').join('');
  $('portsview').innerHTML = '<table class="panel-table"><thead><tr><th>Port</th><th>Service</th><th>Process</th><th>Visibility</th></tr></thead><tbody>' + TOPIC.ports.map(p => '<tr><td>' + p[0] + '</td><td>' + esc(p[1]) + '</td><td>' + esc(p[2]) + '</td><td>Local</td></tr>').join('') + '</tbody></table>';
}
$('paneltabs').addEventListener('click', e => { const tab = e.target.closest('.ptab'); if (tab) setPanel(tab.textContent); });
$('problemsview').onclick = e => { const button = e.target.closest('[data-problem]'); if (button) { const [path,msg] = TOPIC.lintFiles[Number(button.dataset.problem)]; jumpTo(path, parseInt(msg) || 1); } };
/* background build noise now lives in shell.js (ambientLoop) */

function commitChanges(message, session = currentSession) {
  if (!scmChanges.size) { append(session, 'nothing to commit, working tree clean', 'dim'); return; }
  const hash = rand(0x1000000,0xfffffff).toString(16), count = scmChanges.size;
  TOPIC.commits.unshift([hash,message,'You','just now']); TOPIC.commits = TOPIC.commits.slice(0,50);
  append(session, '[' + TOPIC.branch + ' ' + hash + '] ' + message, 'ok'); append(session, count + ' files changed');
  scmChanges.clear(); aheadCount++; $('commitmsg').value = ''; renderScm(); renderSync(); renderTabs();
}
$('commitbtn').addEventListener('click', e => { e.stopImmediatePropagation(); const msg = $('commitmsg').value.trim(); if (msg) commitChanges(msg); else { $('commitmsg').focus(); showToast('Enter a commit message.', 'Source Control'); } }, true);
$('syncbtn').addEventListener('click', e => { e.stopImmediatePropagation(); runCommand('git push'); }, true);
$('commitmsg').addEventListener('keydown', e => { if (e.ctrlKey && e.key === 'Enter') { e.preventDefault(); $('commitbtn').click(); } });
function saveFile() { if (sourceEditing) { $('source-save').click(); return; } if (REG[ap]) { scmAdd(ap); termSaveSequence(REG[ap].name, topicGen); showToast(REG[ap].name + ' saved', 'Workspace'); } }
function editSource() {
  const file = REG[ap]; if (!file) return;
  const original = file.content;
  dialog('Edit ' + file.name, '<textarea id="source-edit" aria-label="Source code editor" spellcheck="false"></textarea><button id="source-save" class="action">Save to workspace</button><span class="dialog-copy">  Ctrl+S · Esc to cancel</span>');
  sourceEditing = true; $('source-edit').value = original; $('source-edit').focus();
  $('source-save').onclick = () => {
    file.content = $('source-edit').value.replace(/\r\n/g,'\n').replace(/\n*$/, '\n'); file.lines = file.content.split('\n'); file.cache = null;
    if (file.typed) resetTyped(file);
    closeDialog(); rebuildEditor(); scmAdd(file.path); updateHint();
    showToast(file.name + ' updated in this workspace', 'Editor');
  };
  $('source-edit').onkeydown = e => { if (e.key === 'Tab') { e.preventDefault(); const input = e.target; input.setRangeText('  ',input.selectionStart,input.selectionEnd,'end'); } };
}
function exportFile() { const f = REG[ap]; if (!f) return; const url = URL.createObjectURL(new Blob([f.content],{type:'text/plain;charset=utf-8'})); const a = document.createElement('a'); a.href=url; a.download=f.name; a.click(); setTimeout(() => URL.revokeObjectURL(url),1000); }
function newFile() { askText('New workspace file', 'src/untitled.ts', path => {
  if (!/^[\w./ -]+$/.test(path) || path.includes('..') || path.startsWith('/') || REG[path]) { showToast('Use a new relative file path.', 'Explorer'); return; }
  const meta = EXTMETA[extOf(path)] || EXTMETA.txt;
  REG[path] = {path,name:path.split('/').pop(), ...meta, content:'// New workspace file\n',lines:['// New workspace file',''],typed:false,st:null,cache:null};
  TREE = projectTree(Object.keys(REG)); openPath(path); editSource();
}); }
function closeTab(path) {
  const index = openTabs.indexOf(path); if (index < 0) return;
  openTabs.splice(index,1);
  if (!openTabs.length) { renderTabs(); showWorkspace(); return; }
  if (ap === path) { const next = openTabs[Math.min(index, openTabs.length-1)]; ap = ''; openPath(next); } else renderTabs();
}
renderTabs = (base => () => { base(); tabsEl.querySelectorAll('.tab').forEach(tab => { const button = document.createElement('button'); button.className='tab-close'; button.setAttribute('aria-label','Close ' + REG[tab.dataset.path].name); button.textContent='×'; tab.appendChild(button); }); })(renderTabs);
tabsEl.addEventListener('click', e => { const close = e.target.closest('.tab-close'); if (close) { e.stopImmediatePropagation(); closeTab(close.closest('.tab').dataset.path); } }, true);
rebuildEditor = (base => () => { base(); updateHint(); })(rebuildEditor);
refreshCurrentLine = (base => () => { base(); updateHint(); })(refreshCurrentLine);
// Opening a static source for inspection must not make background typing steal focus.
advance = (base => n => { if (REG[ap] && !REG[ap].typed) return; base(n); })(advance);

function startDebug() {
  if (debugging) { stopDebug(); return; }
  debugging = true; debugStep = 0; $('dbgstart').textContent = '■';
  debugLog.push('Debugger attached to ' + TOPIC.project + '.', 'Paused at entry point. Press F10 to step, F5 to continue.');
  setPanel('DEBUG CONSOLE'); setView('debug'); renderPanels();
  const breakpoint = Object.keys(bpMap).find(p => bpMap[p].size && REG[p]);
  if (breakpoint) jumpTo(breakpoint, Math.min(...bpMap[breakpoint]));
}
function stepDebug() {
  if (!debugging) startDebug();
  const stack = TOPIC.debug.stack; debugLog.push('Step ' + (++debugStep) + ': ' + stack[(debugStep-1) % stack.length]);
  $('dbgvars').insertAdjacentHTML('beforeend', dbgRow('step',String(debugStep))); renderPanels();
}
function stopDebug() { debugging = false; $('dbgstart').textContent='▶'; debugLog.push('Debugger disconnected.'); renderPanels(); }
$('dbgstart').addEventListener('click', e => { e.stopImmediatePropagation(); startDebug(); }, true);
const debugTools = document.createElement('span'); debugTools.innerHTML = '<button class="toolbutton" id="dbgstep" title="Step over (F10)">↷</button><button class="toolbutton" id="dbgstop" title="Stop debugging (Shift+F5)">■</button>';
$('dbgconf').after(debugTools); $('dbgstep').onclick=stepDebug; $('dbgstop').onclick=stopDebug;

function openMedia() {
  const input = document.createElement('input'); input.type='file'; input.accept='image/*,video/*'; input.multiple=true;
  input.onchange = () => {
    const files = [...input.files].filter(f => /^(image|video)\//.test(f.type)); if (!files.length) return;
    let index=0, url=null;
    const cleanup = () => { $('media-stage')?.querySelector('video')?.pause(); if (url) { URL.revokeObjectURL(url); url=null; } };
    dialog('Asset Preview', '<div id="media-stage"></div><div class="media-toolbar"><button class="toolbutton" id="media-prev" aria-label="Previous asset">←</button><span id="media-name"></span><button class="toolbutton" id="media-next" aria-label="Next asset">→</button></div><div class="dialog-copy">Esc / Ctrl+Shift+B returns to the editor. Files stay on this device.</div>', cleanup);
    const draw = () => { cleanup(); const file=files[index]; url=URL.createObjectURL(file); const el=document.createElement(file.type.startsWith('video/')?'video':'img'); el.src=url; if (el.tagName==='VIDEO') { el.controls=true; el.playsInline=true; } else el.alt=file.name; $('media-stage').replaceChildren(el); $('media-name').textContent=(index+1)+' / '+files.length+' · '+file.name; };
    $('media-prev').onclick=()=>{ index=(index+files.length-1)%files.length; draw(); };
    $('media-next').onclick=()=>{ index=(index+1)%files.length; draw(); }; draw();
  }; input.click();
}
function cover() { closeDialog(); $('menupopup').classList.remove('show'); welcomeEl.classList.remove('show'); if (!openTabs.length) { openTabs=[ap]; renderTabs(); } setPanel('TERMINAL'); $('terminput').blur(); }

function about() { dialog('About this workspace', '<div class="dialog-copy"><p><strong>Relief / FauxCode 2.0</strong></p><p>An offline coding simulator with typing challenges. Terminal builds, deployments, debugging and repository operations are simulated; they never execute system commands or contact a remote server.</p><p>Generated source is demonstration material, not a production application. Local media files are previewed only after you select them.</p><p>Ctrl+Shift+P opens all commands. Ctrl+Alt+G enables exact typing. Ctrl+Shift+B returns to your editor.</p></div>'); }
const COMMANDS = [
  ['File: New File',newFile,'Ctrl+N'],['File: Open File',quickOpen,'Ctrl+P'],['File: Save',saveFile,'Ctrl+S'],['File: Export Current Source',exportFile],['File: Close Editor',()=>closeTab(ap),'Ctrl+W'],['Workspace: Switch Project',showWorkspace],
  ['Editor: Edit Source',editSource],['Editor: Go to Line',()=>askText('Go to Line','1', n=>jumpTo(ap, Math.max(1,Math.min(lineCountOf(REG[ap]),parseInt(n)||1)))),'Ctrl+G'],
  ['View: Explorer',()=>setView('explorer')],['View: Search',()=>setView('search'),'Ctrl+Shift+F'],['View: Source Control',()=>setView('scm')],['View: Run and Debug',()=>setView('debug')],['View: Extensions',()=>setView('ext')],
  ['View: Toggle Sidebar',()=>$('sidebar').classList.toggle('hidden'),'Ctrl+B'],['View: Toggle Panel',()=>$('panel').classList.toggle('hidden'),'Ctrl+J'],['View: Toggle Word Wrap',()=>{settings.wrap=!settings.wrap;applySettings();},'Alt+Z'],
  ['View: Toggle Full Screen',()=>{ if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen().catch(()=>showToast('Use the native maximize button.', 'Window')); },'F11'],
  ['Run: Run Task',taskPicker],['Run: Start / Continue Debugging',startDebug,'F5'],['Run: Step Over',stepDebug,'F10'],['Run: Stop Debugging',stopDebug,'Shift+F5'],
  ['Terminal: New Terminal',()=>{makeSession();setPanel('TERMINAL');$('terminput').focus();}],['Terminal: Focus Terminal',()=>{setPanel('TERMINAL');$('terminput').focus();},'Ctrl+`'],['Terminal: Clear',()=>{currentSession.rows=[];termEl.innerHTML='';}],['Terminal: Stop Task',cancelCommand],
  ['Git: Checkout Branch',chooseBranch],['Git: Commit',()=>setView('scm')],['Git: Sync',()=>runCommand('git push')],
  ['Preferences: Settings',preferences,'Ctrl+,'],['Preferences: Color Theme',()=>choose('Color Theme', ['dark','darcula','midnight'].map(t=>[t,()=>applyTheme(t)]))],
  ['Language Service: Input Diagnostics',metricsDialog],['Language Service: Toggle Exact Input',toggleStrict,'Ctrl+Alt+G'],['Language Service: Toggle Assistance',toggleAutopilot,'Ctrl+Alt+A'],
  ['Preview: Open Local Media',openMedia],['Window: Return to Editor',cover,'Ctrl+Shift+B'],['Help: Keyboard Shortcuts',()=>choose('Keyboard Shortcuts',COMMANDS.filter(c=>c[2]))],['Help: About',about],
];
function commandPalette() { choose('Command Palette', COMMANDS); }
function commandsMatching(prefix) { return COMMANDS.filter(c=>c[0].startsWith(prefix)).map(c=>[c[0].slice(prefix.length),c[1]]); }
const MENUS = {
  file:()=>[...commandsMatching('File: '),['-',null],['Switch Project…',showWorkspace]],
  edit:()=>[['Edit Source…',editSource],['Find in Files',()=>setView('search')],['Preferences…',preferences]],
  selection:()=>[['Select All Source',()=>{ editSource(); $('source-edit').select(); }],['Expand Selection to File',()=>{ editSource(); $('source-edit').select(); }],['Toggle Word Wrap',()=>{settings.wrap=!settings.wrap;applySettings();}]],
  view:()=>[['Command Palette…',commandPalette],...commandsMatching('View: ')],
  go:()=>[['Go to File…',quickOpen],['Go to Line…',COMMANDS.find(c=>c[0]==='Editor: Go to Line')[1]],['Next Editor',()=>{ const i=openTabs.indexOf(ap); openPath(openTabs[(i+1)%openTabs.length]); }],['Previous Editor',()=>{ const i=openTabs.indexOf(ap); openPath(openTabs[(i+openTabs.length-1)%openTabs.length]); }],['Checkout Branch…',chooseBranch]],
  run:()=>commandsMatching('Run: '), terminal:()=>commandsMatching('Terminal: '), help:()=>commandsMatching('Help: '),
};
document.querySelectorAll('[data-menu]').forEach(el=>{el.onclick=()=>menu(el,MENUS[el.dataset.menu]());});
titleEl.onclick=commandPalette;
$('gear').addEventListener('click', e=>{e.stopImmediatePropagation();menu($('gear'),[['Workspace Settings…',preferences],['Switch Project…',showWorkspace],['Color Theme…',COMMANDS.find(c=>c[0]==='Preferences: Color Theme')[1]],['Command Palette…',commandPalette]]);},true);
document.querySelector('[title="Accounts"]').onclick=()=>dialog('Accounts','<div class="dialog-copy"><p>Developer · local workspace</p><p>Profile, preferences and typing progress are stored on this device. No account connection is required.</p></div>');
$('bugs').onclick=()=>{ setPanel('PROBLEMS'); showToast(bugData.c + ' issues resolved today. Click a highlighted code warning to resolve it.', 'Diagnostics'); };
document.querySelector('#statusbar .left .item:nth-child(3)').onclick=()=>runCommand('git fetch');
errEl.parentElement.onclick=()=>setPanel('PROBLEMS');
lncolEl.onclick=COMMANDS.find(c=>c[0]==='Editor: Go to Line')[1];
langEl.onclick=()=>choose('Language Mode', [...new Set(Object.values(EXTMETA).map(m=>m.mode))].map(mode=>[mode,()=>{REG[ap].mode=mode;langEl.textContent=mode;}]));
$('clock').onclick=()=>showToast(new Date().toLocaleString(), 'Local time');
document.querySelectorAll('#statusbar .right .item').forEach(el=>{ if (el.textContent==='UTF-8') el.onclick=()=>showToast('Current file uses UTF-8 encoding.', 'Editor'); if (el.textContent==='LF') el.onclick=()=>showToast('Line endings normalized to LF.', 'Editor'); if (el.textContent.includes('Prettier')) el.onclick=()=>runCommand('npx prettier --check .'); });
$('projname').onclick=()=>{const collapse=TREE.some(n=>n.dir&&n.open); Object.values(DIRS).forEach(n=>n.open=!collapse);renderTree();};
mapEl.onclick=e=>{codewrap.scrollTop=(e.offsetY/mapEl.clientHeight)*(codewrap.scrollHeight-codewrap.clientHeight);};
crumbsEl.onclick=quickOpen;

// Native-language labels and highlighting for the expanded repositories.
for (const [ext,mode,lang] of [['kt','Kotlin','ts'],['kts','Kotlin Script','ts'],['swift','Swift','ts'],['rs','Rust','ts'],['go','Go','ts'],['java','Java','ts'],['cpp','C++','ts'],['hpp','C++ Header','ts'],['h','C Header','ts'],['c','C','ts'],['sol','Solidity','ts'],['tf','Terraform','yml'],['hcl','HCL','yml'],['yaml','YAML','yml'],['toml','TOML','yml'],['sh','Shell Script','py'],['xml','XML','plain'],['proto','Protocol Buffers','ts'],['js','JavaScript','ts'],['jsx','JavaScript JSX','ts'],['css','CSS','ts'],['vert','GLSL','glsl'],['glsl','GLSL','glsl'],['dockerfile','Dockerfile','py'],['makefile','Makefile','py'],['gradle','Gradle','ts']]) EXTMETA[ext]={mode,lang,icon:ext.slice(0,3).toUpperCase(),cls:'ts'};
for (const ext of ['kt','kts','swift','rs','go','java','cpp','hpp','h','c','sol']) {
  const rules = [[/\/\/.*|\/\*.*?\*\//,'com'],[/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/,'str'],[/\b(?:fn|func|fun|let|var|val|mut|pub|impl|trait|struct|enum|match|use|mod|crate|self|Self|class|public|private|protected|static|final|override|package|import|namespace|include|template|typename|const|auto|void|int|bool|boolean|string|String|return|if|else|for|while|switch|case|break|continue|try|catch|throw|throws|new|async|await|suspend|in|out|true|false|null|nil|None|Some|Ok|Err|contract|pragma|function|mapping|uint256|address|external|internal|view|pure|payable|modifier|event|emit|require|revert|constructor|immutable|memory|storage|calldata)\b/,'kw'],[/\b\d[\d_]*(?:\.\d+)?\b/,'num'],[/\b[A-Za-z_]\w*(?=\s*\()/,'fn']];
  COMPILED[ext]={re:new RegExp(rules.map(r=>'('+r[0].source+')').join('|'),'g'),cls:rules.map(r=>r[1])}; EXTMETA[ext].lang=ext;
}

const sidebarHandle=document.createElement('div'); sidebarHandle.className='resize-x';sidebarHandle.setAttribute('role','separator');sidebarHandle.title='Resize sidebar';$('sidebar').after(sidebarHandle);
const panelHandle=document.createElement('div');panelHandle.className='resize-y';panelHandle.setAttribute('role','separator');panelHandle.title='Resize panel';$('panel').prepend(panelHandle);
function resizer(handle, apply) { handle.onpointerdown=e=>{e.preventDefault();handle.setPointerCapture(e.pointerId);const move=event=>apply(event);handle.addEventListener('pointermove',move);handle.onpointerup=()=>{handle.removeEventListener('pointermove',move);};}; }
resizer(sidebarHandle,e=>{$('sidebar').style.width=Math.max(160,Math.min(innerWidth*.46,e.clientX-48))+'px';});
resizer(panelHandle,e=>{$('panel').style.height=Math.max(100,Math.min(innerHeight*.7,innerHeight-e.clientY-22))+'px';});

renderCards = (base => () => {
  base(); document.querySelectorAll('.wcard').forEach(card=>{const p=TOPICS[card.dataset.topic],files=p.fileList();card.insertAdjacentHTML('beforeend','<div class="wmeta">'+files.length+' files · '+files.reduce((n,f)=>n+f[1].split('\n').length-1,0).toLocaleString()+' lines</div>');});
})(renderCards);
const pickerTitle=welcomeEl.querySelector('.wtitle'); const titleRow=document.createElement('div');titleRow.className='wtitle-row';pickerTitle.before(titleRow);titleRow.appendChild(pickerTitle);titleRow.insertAdjacentHTML('beforeend','<button class="toolbutton" id="workspace-close" aria-label="Close workspace picker">×</button>');$('workspace-close').onclick=()=>{welcomeEl.classList.remove('show');if(!openTabs.length){openTabs=[ap];renderTabs();}updateHint();};
const filter=document.createElement('input');filter.id='workspacefilter';filter.placeholder='Filter projects or languages…';filter.setAttribute('aria-label','Filter projects');$('wcards').before(filter);filter.oninput=()=>document.querySelectorAll('.wcard').forEach(c=>c.classList.toggle('hidden',!c.textContent.toLowerCase().includes(filter.value.toLowerCase())));
$('wthemes').insertAdjacentHTML('beforeend','<div class="wtheme" data-theme="midnight">Midnight</div>');

function rememberWorkspace() {
  if (!TOPIC) return;
  sessionStates.set(TOPIC.id,{files:Object.values(REG).map(f=>[f.path,f.content,f.typed,f.st?.pos||0]),ap,tabs:[...openTabs],changes:[...scmChanges],ahead:aheadCount});
}
function restoreWorkspace(state) {
  if (!state) return;
  for (const [path,content,typed,pos] of state.files) {
    const meta=EXTMETA[extOf(path)]||EXTMETA.txt;
    const f=REG[path] || (REG[path]={path,name:path.split('/').pop(),...meta});
    f.content=content;f.lines=content.split('\n');f.typed=typed;f.cache=null;
    if (typed) {
      const prefix=content.slice(0,pos),lines=prefix.split('\n'),curText=lines.pop();
      f.st={pos,lineNo:lines.length+1,curText,doneHtml:lines.map((line,i)=>'<div class="line"><span class="ln">'+(i+1)+'</span><span class="lc">'+hl(line,f.lang)+'</span></div>').join('')};
    }
  }
  rotation=Object.values(REG).filter(f=>f.typed).map(f=>f.path);
  openTabs=state.tabs.filter(p=>REG[p]);if(!openTabs.length)openTabs=[rotation[0]];
  ap=REG[state.ap]?state.ap:openTabs[0];rotIdx=Math.max(0,rotation.indexOf(ap));
  TREE=projectTree(Object.keys(REG));scmChanges.clear();state.changes.filter(p=>REG[p]).forEach(p=>scmChanges.add(p));aheadCount=state.ahead;renderScm();renderSync();rebuildEditor();
}
loadTopic = (base=>id=>{
  rememberWorkspace();sessions.forEach(s=>s.epoch++);sessions=[];currentSession=null;outputLog=[];debugLog=[];filter.value='';
  base(id);makeSession();for(const line of TOPIC.bootLines) appendHtml(currentSession,line);
  restoreWorkspace(sessionStates.get(id));renderPanels();updateHint();
})(loadTopic);
window.addEventListener('beforeunload',()=>{rememberWorkspace();persist('relief.settings',settings);persist('relief.metrics',metrics);});

document.addEventListener('keydown',e=>{
  const ctrl=e.ctrlKey||e.metaKey, key=e.key.toLowerCase(), input=/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
  const handle=fn=>{e.preventDefault();e.stopImmediatePropagation();fn();};
  if (key==='escape') { handle(()=>{if(!overlay.classList.contains('hidden'))closeDialog();else if($('menupopup').classList.contains('show'))$('menupopup').classList.remove('show');else cover();}); return; }
  if (ctrl&&e.shiftKey&&key==='b') return handle(cover);
  if (ctrl&&key==='s') return handle(saveFile);
  if (!overlay.classList.contains('hidden')) {
    if (key==='tab') {const focusable=[...$('dialog').querySelectorAll('input,select,textarea,button')];const first=focusable[0],last=focusable[focusable.length-1];if(e.shiftKey&&e.target===first)handle(()=>last.focus());else if(!e.shiftKey&&e.target===last)handle(()=>first.focus());}
    return;
  }
  if ($('menupopup').classList.contains('show')) {
    if (key==='arrowdown'||key==='arrowup') return handle(()=>{const buttons=[...$('menupopup').querySelectorAll('button')],i=buttons.indexOf(document.activeElement);buttons[(i+(key==='arrowdown'?1:buttons.length-1))%buttons.length].focus();});
    if (key==='enter'||key===' ') return handle(()=>document.activeElement.click());
    return;
  }
  if(ctrl&&e.shiftKey&&key==='p')return handle(commandPalette);
  if(ctrl&&e.shiftKey&&key==='f')return handle(()=>setView('search'));
  if(ctrl&&e.altKey&&key==='g')return handle(toggleStrict);
  if(ctrl&&e.altKey&&key==='a')return handle(toggleAutopilot);
  if(ctrl&&key==='p')return handle(quickOpen);
  if(ctrl&&key===',')return handle(preferences);
  if(ctrl&&key==='j')return handle(()=>$('panel').classList.toggle('hidden'));
  if(ctrl&&key==='b')return handle(()=>$('sidebar').classList.toggle('hidden'));
  if(ctrl&&key==='`')return handle(()=>{setPanel('TERMINAL');$('terminput').focus();});
  if(ctrl&&key==='n')return handle(newFile);
  if(ctrl&&key==='w'&&!input)return handle(()=>closeTab(ap));
  if(ctrl&&key==='g')return handle(COMMANDS.find(c=>c[0]==='Editor: Go to Line')[1]);
  if(e.altKey&&key==='z')return handle(()=>{settings.wrap=!settings.wrap;applySettings();});
  if(key==='f5')return handle(e.shiftKey?stopDebug:startDebug);
  if(key==='f10')return handle(stepDebug);
  if(key==='f11')return handle(COMMANDS.find(c=>c[0]==='View: Toggle Full Screen')[1]);
  if(input||ctrl||e.altKey||e.isComposing||welcomeEl.classList.contains('show'))return;
  if(e.target.closest?.('button,[role=button]')&&(key==='enter'||key===' '))return;
  if(!settings.strict){if(e.key.length===1||key==='enter'){lastInputAt=Date.now();typedThisSession++;}return;}
  const f=REG[ap];if(!f?.typed||fileSwitchPending)return;
  if(e.key.length!==1&&!['enter','tab','backspace'].includes(key))return;
  handle(()=>{
    if(key==='backspace')return;
    const expected=f.content[f.st.pos],actual=key==='enter'?'\n':key==='tab'?'\t':e.key;
    if(key==='tab'&&expected===' '){while(f.content[f.st.pos]===' ')advance(1);updateHint();return;}
    const correct=actual===expected;recordInput(correct);
    if(correct){advance(1);if(actual==='\n'){metrics.challenges++;metrics.xp+=20;while(!fileSwitchPending&&f.content[f.st.pos]===' ')advance(1);persist('relief.metrics',metrics);}}
    updateHint();
  });
},true);
applySettings();

// Keyboard access for the inherited div-based IDE controls.
document.addEventListener('keydown', e=>{if(e.defaultPrevented||!['Enter',' '].includes(e.key)||/^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(e.target.tagName))return;if(e.target.getAttribute('role')==='button'){e.preventDefault();e.target.click();}},true);
function accessibleControls() { document.querySelectorAll('.aicon,.ptab,.wcard,.wtheme,#statusbar .item,[data-menu],.tab,.tree .item,#projname').forEach(el=>{el.tabIndex=0;el.setAttribute('role','button');}); }
const uiObserver=new MutationObserver(accessibleControls);uiObserver.observe($('main'),{childList:true,subtree:true});accessibleControls();
