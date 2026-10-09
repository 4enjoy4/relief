'use strict';

function projectTree(paths) {
  const root = [];
  for (const path of paths) {
    let children = root;
    const parts = path.split('/');
    parts.slice(0, -1).forEach((name, depth) => {
      let node = children.find(n => n.dir && n.name === name);
      if (!node) { node = d(name, [], depth < 2); children.push(node); }
      children = node.children;
    });
    children.push(fnode(path));
  }
  return root;
}

function profileDefaults(p) {
  p.primaryLang ||= p.id === 'ml' ? 'py' : 'ts';
  p.checker ||= p.primaryLang === 'py' ? 'pyright' : 'tsc';
  p.shell ||= {user: 'dev', host: 'workstation', pkg: p.primaryLang === 'py' ? 'pip' : 'npm'};
  p.ports ||= [[3000, 'Application', 'node'], [9229, 'Debugger', 'node']];
  p.scripts ||= [['dev', 'npm run dev'], ['build', 'npm run build'], ['test', 'npm test'], ['lint', 'npm run lint']];
  p.branches ||= ['main', 'develop', p.branch, 'fix/observability'];
  p.commits ||= [
    ['a18b23c', 'fix: preserve checkpoint across retry', 'Alex Morgan', '2 hours ago'],
    ['b39c42d', 'test: cover timeout boundaries', 'Sam Chen', '4 hours ago'],
    ['c53d61e', 'feat: expose service health metrics', 'Jamie Park', 'yesterday'],
    ['d74e82f', 'refactor: isolate transport adapter', 'Alex Morgan', 'yesterday'],
    ['e95f03a', 'fix: release resources on shutdown', 'Sam Chen', '2 days ago'],
    ['fa1604b', 'chore: pin development toolchain', 'Jamie Park', '3 days ago'],
    ['ab2705c', 'docs: record failure recovery procedure', 'Alex Morgan', '4 days ago'],
    ['bc3806d', 'feat: add initial service skeleton', 'Sam Chen', 'last week'],
  ];
  p.debug ||= DBG[p.id] || {conf: 'Launch ' + p.project, vars: [['pending', '12'], ['attempt', '2'], ['healthy', 'true']], watch: [['retryBudget', '3'], ['queue.length', '12']], stack: ['processBatch  service:48', 'runWorker  main:22']};
  p.files ||= p.fileList;
  p.fileList ||= p.files;
  return p;
}

const PROFILES = {
  register(p) { TOPICS[p.id] = profileDefaults(p); },
};

for (const p of Object.values(TOPICS)) {
  profileDefaults(p);
  const original = p.fileList;
  p.fileList = p.files = () => {
    const files = original();
    // Retain the original handwritten repositories and add domain-specific classes.
    const subjects = p.id === 'banking' ? ['SettlementBatch', 'LiquidityMonitor', 'PaymentRouter', 'AccountSnapshot', 'RiskPolicy', 'ReconciliationJob']
      : p.id === 'ml' ? ['FeatureStore', 'DriftMonitor', 'DatasetSnapshot', 'ExperimentTracker', 'InferenceBatch', 'ModelHealth']
      : ['SessionStore', 'RequestScheduler', 'NotificationQueue', 'TenantPolicy', 'CacheSnapshot', 'HealthProbe'];
    subjects.forEach((name, index) => {
      const python = p.primaryLang === 'py';
      const path = 'services/' + name + (python ? '.py' : '.ts');
      const content = python
        ? genLargePythonModule('from __future__ import annotations\nimport logging\nimport time\n', name, name.toLowerCase(), ['validate', 'normalize', 'persist', 'reconcile', 'publish'], index === 0 ? 1150 : 170)
        : genLargeTsClass('export class ' + name + ' {\n}\n', name, name.toLowerCase(), ['validate', 'normalize', 'persist', 'reconcile', 'publish'], index === 0 ? 1150 : 170);
      files.push([path, content, index < 2]);
    });
    return files;
  };
  p.tree = () => projectTree(p.fileList().map(f => f[0]));
}

function makeProfile(spec, files) {
  return profileDefaults({
    version: '2.4.0', branch: 'feature/' + spec.id + '-resilience',
    remote: 'git.internal.corp:engineering/' + spec.project,
    image: 'registry.internal.corp/' + spec.project, deployName: spec.project,
    namespace: spec.id + '-staging', dbLine: null, migrateLines: [], hmrPath: null,
    checkFiles: 248, termproc: spec.pkg + ' — ' + spec.project,
    shell: {user: 'dev', host: 'workstation', pkg: spec.pkg},
    ports: [[8080, 'Health endpoint', spec.pkg], [9090, 'Metrics', spec.pkg]],
    scripts: [['build', spec.build], ['test', spec.test], ['lint', spec.lint], ['dev', spec.dev]],
    lintFiles: [[files[2][0], '24:7  Prefer an explicit timeout', 'timeout-policy']],
    suites: [[files.find(f => /test|spec/.test(f[0]))?.[0] || files[3][0], 12, 12]],
    bootLines: ['$ ' + spec.dev, '', '[workspace] ' + spec.project + '@2.4.0', '[ready] configuration loaded', '[watch] waiting for changes'],
    ...spec,
    files: () => files,
    fileList: () => files,
    tree: () => projectTree(files.map(f => f[0])),
  });
}
