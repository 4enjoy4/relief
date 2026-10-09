#!/usr/bin/env node
/* Validates a FauxCode profile corpus file against docs/CORPUS_CONTRACT.md.
   Usage: node tools/validate_corpus.js app/corpus/<id>.js [more files...]
   Exit code 1 when any error is found. Warnings do not fail the run. */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const JOBS = new Set(('typecheck jest vitest eslint prettier npminstall npmaudit vitebuild webpack gitfetch gitstatus docker dockercompose k8s helm migrate hmr lighthouse e2e storybook ' +
  'pytest ruff mypy pipinstall black uvicorn alembic dataset train onnx reconcile compliance atlas shaderc fps ' +
  'metro gradle xcodebuild pod adb detox fastlane terraform ansible packer kubectlapply argocd prometheus vault ' +
  'cargobuild cargotest clippy probe defmt cbindgen gobuild gotest govet golangci protoc grpcurl ' +
  'mvn junit spotless flyway springboot hardhat hardhattest solc slither gasreport hardhatnode ' +
  'dbtrun dbttest airflow spark greatexpectations cmake ninja ctest clangtidy valgrind benchmark pybind').split(/\s+/));

const LANGS = new Set(['ts', 'py', 'kotlin', 'swift', 'rust', 'go', 'java', 'cpp', 'sol', 'hcl']);

function padLines(base, n) {
  const lines = base.trimEnd().split('\n');
  while (lines.length < n) lines.push('    // generated line ' + lines.length);
  return lines.slice(0, n).join('\n') + '\n';
}

// Stub generators: when the real app/generators.js exists we use it, otherwise stubs that
// only reproduce the requested line count so structure checks still work.
function loadGenerators(sandbox) {
  const real = path.join(__dirname, '..', 'app', 'generators.js');
  if (fs.existsSync(real)) {
    try {
      vm.runInContext(fs.readFileSync(real, 'utf8'), sandbox, { filename: 'generators.js' });
      sandbox.__realGenerators = true;
      return;
    } catch (e) {
      console.log('  (real generators.js failed to load, using stubs: ' + e.message + ')');
    }
  }
  const large = (base, a, b, c, n) => padLines(base, n);
  Object.assign(sandbox, {
    genLargeTsClass: large, genLargePythonModule: large, genLargeKotlinClass: large,
    genLargeSwiftClass: large, genLargeJavaClass: large, genLargeRustModule: large,
    genLargeGoFile: large, genLargeCppFile: large, genLargeSql: large,
    genLargeTerraform: large, genLargeK8sManifests: large,
    genDockerfile: () => 'FROM stub\n', genPackageJson: () => '{}\n', genTsconfig: () => '{}\n',
    genReadme: () => '# stub\n', genEnv: () => 'A=b\n', genCi: () => 'name: ci\n',
    genSpec: () => 'describe stub\n', genPyTest: () => 'def test(): pass\n',
    genGitignore: () => 'node_modules\n', genEditorconfig: () => 'root = true\n',
  });
}

function validate(file) {
  const errors = [], warns = [];
  const src = fs.readFileSync(file, 'utf8');

  // 1. suspicious single backslashes inside the source (would corrupt template literals)
  const lines = src.split('\n');
  lines.forEach((l, i) => {
    const m = l.match(/(^|[^\\])\\(?![\\$`])/);
    if (m) warns.push('line ' + (i + 1) + ': single backslash — inside a template literal it must be doubled: ' + l.trim().slice(0, 90));
  });
  if (/\$\{/.test(src)) errors.push('source contains "${" — template interpolation is forbidden in corpus content');

  // 2. evaluate
  const registered = [];
  const sandbox = {
    console,
    PROFILES: { register: p => registered.push(p) },
    d: (name, children, open) => ({ dir: true, name, children: children || [], open: !!open }),
    fnode: p => ({ path: p }),
    // legacy helper used by app/profiles.js-style corpora (mobile.js): accept it, fill defaults
    makeProfile: (spec, files) => Object.assign({
      version: '2.4.0', branch: 'feature/' + spec.id, remote: 'git.internal.corp/' + spec.project, image: spec.project, deployName: spec.project,
      namespace: spec.id, dbLine: null, migrateLines: [], hmrPath: null, checkFiles: 100, termproc: spec.project,
      shell: { user: 'dev', host: 'workstation', pkg: spec.pkg || 'npm' }, ports: [[3000, 'app', 'node']], scripts: [['build', spec.build || 'make'], ['test', spec.test || 'make test']],
      branches: ['main', 'feature/' + spec.id], commits: Array.from({ length: 8 }, (_, i) => ['a' + i + 'b2c3d', 'chore: commit ' + i, 'Dev', 'today']),
      lintFiles: [], suites: [], bootLines: ['$ make'], debug: { conf: 'x', vars: [], watch: [], stack: [] },
      files: () => files, tree: () => files.map(f => ({ path: f[0] })),
    }, spec, { branch: 'feature/' + spec.id, branches: ['main', 'feature/' + spec.id] }),
  };
  vm.createContext(sandbox);
  loadGenerators(sandbox);
  try {
    vm.runInContext(src, sandbox, { filename: path.basename(file) });
  } catch (e) {
    errors.push('failed to evaluate: ' + e.message);
    return { errors, warns };
  }
  if (registered.length !== 1) {
    errors.push('expected exactly one PROFILES.register() call, found ' + registered.length);
    return { errors, warns };
  }
  const p = registered[0];
  const need = {
    id: 'string', label: 'string', stack: 'string', desc: 'string', project: 'string', version: 'string',
    branch: 'string', remote: 'string', image: 'string', deployName: 'string', namespace: 'string',
    primaryLang: 'string', checker: 'string', checkFiles: 'number', termproc: 'string',
    shell: 'object', ports: 'object', scripts: 'object', branches: 'object', commits: 'object',
    lintFiles: 'object', suites: 'object', jobs: 'object', bootLines: 'object', debug: 'object',
    files: 'function', tree: 'function',
  };
  for (const k in need) {
    if (typeof p[k] !== need[k]) errors.push('field "' + k + '" missing or not a ' + need[k]);
  }
  if (!('dbLine' in p)) errors.push('field "dbLine" missing (use null)');
  if (!('migrateLines' in p)) errors.push('field "migrateLines" missing (use [])');
  if (!('hmrPath' in p)) errors.push('field "hmrPath" missing (use null)');
  if (errors.length) return { errors, warns };

  if (path.basename(file, '.js') !== p.id) errors.push('id "' + p.id + '" must match file name ' + path.basename(file));
  if (!LANGS.has(p.primaryLang)) errors.push('primaryLang "' + p.primaryLang + '" not one of ' + [...LANGS].join('|'));
  if (!p.branches.includes(p.branch)) errors.push('branches must include the current branch "' + p.branch + '"');
  if (p.branches.length < 4) warns.push('fewer than 4 branches');
  if (p.commits.length < 8) warns.push('fewer than 8 commits');
  p.commits.forEach((c, i) => { if (!Array.isArray(c) || c.length !== 4) errors.push('commits[' + i + '] must be [hash, subject, author, when]'); });
  p.ports.forEach((c, i) => { if (!Array.isArray(c) || c.length !== 3) errors.push('ports[' + i + '] must be [port, label, process]'); });
  p.scripts.forEach((c, i) => { if (!Array.isArray(c) || c.length !== 2) errors.push('scripts[' + i + '] must be [name, command]'); });
  for (const j of p.jobs) if (!JOBS.has(j)) errors.push('unknown job "' + j + '"');
  if (p.jobs.length < 6) warns.push('fewer than 6 jobs');
  if (!Array.isArray(p.bootLines) || p.bootLines.length < 4) warns.push('bootLines should have 4-9 entries');
  for (const k of ['conf', 'vars', 'watch', 'stack']) if (!(k in p.debug)) errors.push('debug.' + k + ' missing');

  // files
  let files;
  try { files = p.files(); } catch (e) { errors.push('files() threw: ' + e.message); return { errors, warns }; }
  const seen = new Set();
  let typed = 0, total = 0, handwritten = 0, maxGen = 0;
  // Legacy profiles prepare a files array before calling makeProfile.
  const filesText = (src.match(/files:\s*\(\)\s*=>\s*\[([\s\S]*?)\n\s*\],\s*\n\s*tree:/) || ['', ''])[1] || src;
  const genPaths = new Set();
  for (const m of filesText.matchAll(/\['([^']+)',\s*genLarge\w+\([^)]*?,\s*(\d+)\)/g)) {
    genPaths.add(m[1]);
    maxGen = Math.max(maxGen, Number(m[2]));
  }
  files.forEach((e, i) => {
    if (!Array.isArray(e) || typeof e[0] !== 'string' || typeof e[1] !== 'string') { errors.push('files()[' + i + '] must be [path, string, typed?]'); return; }
    const [fp, content] = e;
    if (seen.has(fp)) errors.push('duplicate file path ' + fp);
    seen.add(fp);
    if (!content.length) errors.push('empty content: ' + fp);
    if (!content.endsWith('\n')) warns.push('content should end with a newline: ' + fp);
    if (content.endsWith('\n\n')) warns.push('content ends with a blank line: ' + fp);
    if (/\t/.test(content) && !/Makefile|\.mk$|go\.mod|\.go$/.test(fp)) warns.push('tab characters in ' + fp);
    const n = content.split('\n').length - 1;
    total += n;
    if (genPaths.has(fp)) { if (!e[2]) errors.push('generated large file must be typed: ' + fp); }
    else handwritten += n;
    if (e[2]) typed++;
  });
  if (files.length < 16) warns.push('only ' + files.length + ' files (target 16-24)');
  if (typed < 5 || typed > 8) warns.push(typed + ' typed files (target 5-8)');
  if (handwritten < 1000) errors.push('handwritten content is ' + handwritten + ' lines (need >= 1000)');
  if (maxGen < 1000) errors.push('no generated file with targetLines >= 1000 (max found ' + maxGen + ')');
  for (const [fp] of p.lintFiles) if (!seen.has(fp)) errors.push('lintFiles path not in files(): ' + fp);
  for (const [fp] of p.suites) if (!seen.has(fp)) errors.push('suites path not in files(): ' + fp);

  // tree
  let tree;
  try { tree = p.tree(); } catch (e) { errors.push('tree() threw: ' + e.message); return { errors, warns }; }
  const inTree = new Set();
  (function walk(nodes, depth) {
    if (!Array.isArray(nodes)) { errors.push('tree children must be arrays'); return; }
    for (const n of nodes) {
      if (n.dir) { if (!n.name) errors.push('dir without name'); walk(n.children, depth + 1); }
      else if (n.path) { if (!seen.has(n.path)) errors.push('tree path not in files(): ' + n.path); inTree.add(n.path); }
      else errors.push('unknown tree node ' + JSON.stringify(n));
    }
  })(tree, 0);
  for (const fp of seen) if (!inTree.has(fp)) warns.push('file not shown in tree: ' + fp);

  console.log('  profile ' + p.id + ': ' + files.length + ' files, ' + typed + ' typed, ' + total + ' lines total, ' + handwritten + ' handwritten, largest generated target ' + maxGen + (sandbox.__realGenerators ? ' (real generators)' : ' (stub generators)'));
  return { errors, warns };
}

let failed = false;
for (const file of process.argv.slice(2)) {
  console.log(file);
  const { errors, warns } = validate(file);
  for (const w of warns) console.log('  warn: ' + w);
  for (const e of errors) console.log('  ERROR: ' + e);
  if (errors.length) failed = true;
  else console.log('  OK');
}
if (!process.argv[2]) { console.log('usage: node tools/validate_corpus.js app/corpus/<id>.js'); process.exit(2); }
process.exit(failed ? 1 : 0);
