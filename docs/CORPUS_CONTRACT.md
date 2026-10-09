# FauxCode profile corpus contract

A *profile* is one fake project the workbench can open (e.g. "Mobile development").
Each profile lives in exactly one file: `app/corpus/<id>.js`. It is plain browser
JavaScript (no modules, no imports) loaded by a `<script>` tag. It must not touch
the DOM. It registers itself by calling `PROFILES.register({...})`.

Validate with:  `node tools/validate_corpus.js app/corpus/<id>.js`

## File skeleton

```js
/* FauxCode profile: Mobile development: pulse-mobile */
(function () {
'use strict';
const SRC = {};

SRC.HOME_SCREEN = `import React from 'react';
...
`;

// ...more SRC.* strings...

PROFILES.register({
  id: 'mobile',
  label: 'Mobile development',
  stack: 'React Native · Kotlin · Swift',
  desc: 'Cross-platform app with native modules: offline sync, push, biometrics.',
  project: 'pulse-mobile',              // repo / folder name, lowercase-kebab
  version: '4.2.0',
  branch: 'feature/MOB-512-offline-sync',
  remote: 'github.internal.corp:mobile/pulse-mobile',
  image: 'registry.internal.corp/mobile/pulse-ci',
  deployName: 'pulse-api-mock',
  namespace: 'mobile-staging',
  dbLine: null,                         // 'postgres://host:5432/db' or null
  migrateLines: [],                     // migration names or []
  primaryLang: 'ts',                    // ts | py | kotlin | swift | rust | go | java | cpp | sol | hcl
  checker: 'tsc',                       // tsc | pyright | kotlinc | swiftc | cargo check | go vet | javac | clang++ | solc | terraform validate
  checkFiles: 312,                      // number the type checker "checks"
  termproc: 'node: pulse-mobile',      // label of terminal #1
  hmrPath: '/src/screens/HomeScreen.tsx', // or null when there is no dev server
  shell: { user: 'dev', host: 'pulse-mbp', pkg: 'npm' },   // pkg: npm | pnpm | yarn | pip | cargo | go | mvn | gradle | cmake | dbt
  ports: [[8081, 'Metro bundler', 'node'], [5555, 'adb server', 'adb']],   // 2-5 rows
  scripts: [['start', 'react-native start'], ['test', 'jest'], ['lint', 'eslint src']],  // 4-8 rows (npm scripts / make targets / cargo aliases)
  branches: ['main', 'develop', 'feature/MOB-512-offline-sync', 'hotfix/MOB-498-crash-on-resume'], // 4-7, must include `branch`
  commits: [                            // 8-12 rows: [shortHash, subject, author, relativeDate]
    ['9f3e2a1', 'feat(sync): queue mutations while offline', 'Dana Kowalski', '2 hours ago'],
    ['c41b0d7', 'fix(android): crash when resuming with expired token', 'Yusuf Demir', '5 hours ago'],
  ],
  lintFiles: [                          // 3-5 rows, paths MUST exist in files()
    ['src/screens/HomeScreen.tsx', '41:7   Unexpected magic number: 300', 'no-magic-numbers'],
  ],
  suites: [                             // 2-4 rows: [testFilePath, minTests, maxTests]: paths MUST exist in files()
    ['src/sync/__tests__/sync.engine.spec.ts', 9, 14],
  ],
  jobs: ['typecheck', 'jest', 'eslint', 'npminstall', 'gitfetch', 'metro', 'gradle', 'xcodebuild', 'pod', 'adb', 'detox', 'fastlane'],
  bootLines: [                          // 5-9 lines of HTML shown when terminal #1 opens
    '<span class="mag">$</span> npm run start',
    '<span class="dim">&gt; pulse-mobile@4.2.0 start</span>',
    '<span class="dim">&gt; react-native start</span>',
    '',
    '<span class="info">Welcome to Metro v0.80.9</span>',
    '  <span class="dim">watching for file changes...</span>',
  ],
  debug: {
    conf: 'Debug Android (Hermes)',
    vars: [['queue.length', '14'], ['isOnline', 'false'], ['lastSyncedAt', '"2026-09-07T08:41:02Z"']],
    watch: [['queue.every(isPending)', 'true'], ['retryBudget', '3 (optimistic)']],
    stack: ['SyncEngine.flush  sync.engine.ts:88', 'NetInfo.listener  network.ts:31', 'processTicksAndRejections  node:internal'],
  },
  files: () => [
    // [path, content, typed?] : typed:true marks files the "developer" is actively writing (5-8 of them)
    ['src/sync/sync.engine.ts', genLargeTsClass(SRC.SYNC_ENGINE, 'SyncEngine', 'offline sync', ['validateMutation', 'normalizeBatch', 'persistCheckpoint', 'publishDelta', 'reconcileConflict', 'compactQueue'], 1100), true],
    ['src/screens/HomeScreen.tsx', SRC.HOME_SCREEN, true],
    ['android/app/src/main/java/com/pulse/OfflineStoreModule.kt', genLargeKotlinClass(SRC.OFFLINE_STORE, 'OfflineStoreModule', 'offline store', ['validateRow', 'encodeRow', 'persistRow', 'evictStale', 'emitChange'], 600), true],
    ['package.json', SRC.PACKAGE_JSON],
    // ...
  ],
  tree: () => [
    d('android', [d('app', [d('src', [d('main', [d('java', [d('com', [d('pulse', [fnode('android/app/src/main/java/com/pulse/OfflineStoreModule.kt')], true)], true)], true)], true)], true)], true),
    d('src', [
      d('screens', [fnode('src/screens/HomeScreen.tsx')], true),
      d('sync', [d('__tests__', [fnode('src/sync/__tests__/sync.engine.spec.ts')]), fnode('src/sync/sync.engine.ts')], true),
    ], true),
    d('node_modules', [d('react-native', []), d('@react-navigation', []), d('left-pad', [])]),
    fnode('package.json'),
  ],
});
})();
```

`d(name, children, open)` declares a folder (open = expanded by default), `fnode(path)` a file. Both are
globals provided by the engine; only call them inside `tree()`. Every `fnode` path must exist in
`files()` and every file should appear somewhere in the tree. Empty folders (node_modules, .venv,
build, target) are fine and make the tree look real.

## Hard rules for source strings (SRC.*)

1. Use JavaScript template literals (backticks). Inside them:
   - **Never** use a backtick character. Rewrite JS/TS template strings as concatenation with `+`.
   - **Never** write `${`: use `'$' + '{'` in the code or avoid it. Bash `${VAR}` must be written `$VAR`.
   - **Every backslash must be doubled**: write `\\n`, `\\s+`, `\\"`, `\\d`, `C:\\\\path`. A single
     backslash silently corrupts the content (`\n` becomes a real newline).
2. Content must end with a single newline: that is, the closing backtick goes on its own line.
3. Indentation: 2 spaces for TS/JS/YAML/JSON/Swift/Kotlin, 4 spaces for Python/Java/C++/Rust/Go
   (Go really uses tabs but spaces are fine here), tabs only in Makefiles.
4. Files must be *coherent*: imports reference other files in the same profile, tests name real
   classes, configs mention the real project name, comments refer to the same ticket ids
   (e.g. MOB-512). Think "one real repo", not "random snippets".
5. Tone of comments: dry, understated office humour, like the existing corpus
   ("// The upstream SLA promises 99.9% uptime. The upstream disagrees."). Roughly one joke per
   30-50 lines; the rest is normal professional code. No profanity, no real company names, no real
   people. Fake internal hosts end in `.internal.corp` or `.internal`.
6. No secrets that look real: use `example`, `localdev`, `changeme` style placeholders.

## Size targets per profile

- 16-24 files total. Of these 5-8 are `typed: true` (the ones the developer "writes"): the two
  generated large files plus 3-6 handwritten ones (the most interesting ones).
- Handwritten (non-generated) content: **at least 1,000 lines total** across the profile.
- Exactly one primary large file generated with a `genLarge*` call and `targetLines` **>= 1000**,
  plus one secondary large file with target 500-700. Both must be `typed: true` and should be the
  first two entries in `files()`.
- Every handwritten "main" source file should be 60-160 lines. Config files can be short.

## Generators (globals provided by the engine: call them only inside `files()`)

Large module generators. `base` is a handwritten string that the generator extends. `verbs` is a list
of 5-8 camelCase verbs (the generator converts to snake_case where the language wants it).
The generator invents nouns from `subject` and produces coherent methods with logging, validation
and error handling. The result has about `targetLines` lines.

* function: base must be...: appends
* `genLargeTsClass(base, className, subject, verbs, targetLines)`: a TS file whose **last line is the class's closing `}`**: private methods inside the class, then supporting interfaces/helpers after it
* `genLargePythonModule(base, className, subject, verbs, targetLines)`: any Python module: a new class `className` with methods, then module-level helpers
* `genLargeKotlinClass(base, className, subject, verbs, targetLines)`: a Kotlin file whose last line is the class's closing `}`: private funs inside the class, then data classes/helpers
* `genLargeSwiftClass(base, className, subject, verbs, targetLines)`: a Swift file whose last line is the class's closing `}`: private funcs inside the class, then structs/extensions
* `genLargeJavaClass(base, className, subject, verbs, targetLines)`: a Java file whose last line is the class's closing `}`: private methods inside the class, then nested static helper classes
* `genLargeRustModule(base, typeName, subject, verbs, targetLines)`: a Rust module that defines `struct typeName`: `impl typeName { ... }` blocks, free fns, a `#[cfg(test)] mod tests`
* `genLargeGoFile(base, typeName, subject, verbs, targetLines)`: a Go file that defines `type typeName struct`: methods `func (s *typeName) Xxx(...)`, helper funcs
* `genLargeCppFile(base, className, subject, verbs, targetLines)`: a .cpp file with includes (class declared elsewhere): `Type ClassName::method(...) { ... }` definitions and static helpers
* `genLargeSql(base, schema, nouns, targetLines)`: a SQL migration file: CREATE TABLE / INDEX / ALTER / COMMENT blocks for `nouns` (array of 6-12 table nouns)
* `genLargeTerraform(base, project, nouns, targetLines)`: a .tf file: resource / module / variable / output blocks
* `genLargeK8sManifests(base, appName, services, targetLines)`: a YAML file: Deployment/Service/ConfigMap/HPA docs per service name

Boilerplate helpers (return strings):

- `genDockerfile(baseImage, runLines[], cmdJsonString)`
- `genPackageJson(name, version, deps[[name, ver]], scripts[[name, cmd]]?)`
- `genTsconfig()`
- `genReadme(project, description, stackLines[])`
- `genEnv(vars[[KEY, value]])`
- `genCi(project)`: GitHub Actions workflow for node projects
- `genSpec(subject, importPath, caseTitles[])`: jest spec
- `genPyTest(module, caseNames[])`: pytest file
- `genGitignore(kind)`: kind: node | python | rust | go | java | cpp | mobile | terraform
- `genEditorconfig()`

You may also hand-write any config file as a SRC string (preferred for variety: pom.xml,
build.gradle.kts, Cargo.toml, go.mod, CMakeLists.txt, Podfile, hardhat.config.ts, dbt_project.yml ...).

## Jobs catalogue (names allowed in `jobs`)

Pick 8-12 that fit the stack.

- Generic: `typecheck jest vitest eslint prettier npminstall npmaudit vitebuild webpack gitfetch gitstatus docker dockercompose k8s helm migrate hmr lighthouse e2e storybook`
- Python: `pytest ruff mypy pipinstall black uvicorn alembic dataset train onnx`
- Banking: `reconcile compliance`
- Game: `atlas shaderc fps`
- Mobile: `metro gradle xcodebuild pod adb detox fastlane`
- DevOps: `terraform ansible packer kubectlapply argocd prometheus vault`
- Embedded/Rust: `cargobuild cargotest clippy probe defmt cbindgen`
- Go: `gobuild gotest govet golangci protoc grpcurl`
- Java: `mvn junit spotless flyway springboot`
- Blockchain: `hardhat hardhattest solc slither gasreport hardhatnode`
- Data engineering: `dbtrun dbttest airflow spark greatexpectations`
- C++: `cmake ninja ctest clangtidy valgrind benchmark pybind`

## Highlighting

Automatic by extension / filename: ts tsx js jsx py yml yaml json sql frag vert glsl kt kts swift rs go java
cpp cc cxx hpp h c sol tf hcl sh bash toml xml plist html css scss proto md txt env gradle Makefile
Dockerfile CMakeLists.txt Podfile Gemfile ini cfg csv lock.
