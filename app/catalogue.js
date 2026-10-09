'use strict';

// These are display corpora, never executed by the terminal.
const CATALOGUE = [
  {id:'devops', label:'Cloud & DevOps', stack:'Terraform · Kubernetes · Ansible', project:'orbit-infrastructure', primaryLang:'hcl', pkg:'terraform', checker:'terraform validate', build:'terraform plan', test:'terraform validate', lint:'terraform fmt -check', dev:'kubectl get pods -w', jobs:['terraform','ansible','packer','kubectlapply','argocd','prometheus','vault','helm'], classes:['Cluster', 'Network', 'Ingress', 'Database', 'Cache', 'Observability', 'Secrets', 'Autoscaling', 'Backup', 'Identity', 'Storage', 'Gateway']},
  {id:'embedded', label:'Embedded & firmware', stack:'Rust · ARM Cortex-M · Embassy', project:'sensor-firmware', primaryLang:'rust', pkg:'cargo', checker:'cargo check', build:'cargo build --release', test:'cargo test', lint:'cargo clippy', dev:'probe-rs run --chip STM32F411CEUx', jobs:['cargobuild','cargotest','clippy','probe','defmt','cbindgen','gitfetch','benchmark'], classes:['Telemetry', 'SensorBus', 'RingBuffer', 'Watchdog', 'FlashStore', 'PowerManager', 'Calibration', 'PacketCodec', 'Scheduler', 'DeviceConfig', 'Heartbeat', 'Diagnostics']},
  {id:'gobackend', label:'Go backend services', stack:'Go · gRPC · PostgreSQL · Redis', project:'dispatch-service', primaryLang:'go', pkg:'go', checker:'go vet', build:'go build ./...', test:'go test ./...', lint:'golangci-lint run', dev:'go run ./cmd/server', jobs:['gobuild','gotest','govet','golangci','protoc','grpcurl','docker','gitfetch'], classes:['Dispatcher', 'JobQueue', 'WorkerPool', 'LeaseManager', 'RateLimiter', 'EventStore', 'HealthProbe', 'RetryPolicy', 'RequestRouter', 'OutboxRelay', 'MetricsCollector', 'ShutdownHook']},
  {id:'cpp', label:'C++ systems engineering', stack:'C++20 · CMake · Ninja · GoogleTest', project:'vector-runtime', primaryLang:'cpp', pkg:'cmake', checker:'clang++', build:'cmake --build build', test:'ctest --test-dir build', lint:'clang-tidy src/*.cpp', dev:'./build/vector-runtime', jobs:['cmake','ninja','ctest','clangtidy','valgrind','benchmark','pybind','gitfetch'], classes:['QueryEngine', 'VectorIndex', 'BufferPool', 'PageCache', 'WorkScheduler', 'ColumnReader', 'ResultWriter', 'PlanOptimizer', 'MemoryArena', 'SegmentMerger', 'Checkpoint', 'TraceCollector']},
  {id:'blockchain', label:'Smart contract development', stack:'Solidity · Hardhat · TypeScript', project:'harbor-protocol', primaryLang:'sol', pkg:'npm', checker:'solc', build:'npx hardhat compile', test:'npx hardhat test', lint:'slither .', dev:'npx hardhat node', jobs:['hardhat','hardhattest','solc','slither','gasreport','hardhatnode','eslint','gitfetch'], classes:['SettlementVault', 'AccessRegistry', 'TimelockPolicy', 'FeeController', 'ProposalStore', 'EpochTracker', 'RewardDistributor', 'EmergencySwitch', 'CheckpointStore', 'AllowanceGuard', 'TreasuryRouter', 'EventRegistry']},
];

function solidityModule(name, target) {
  const lines = ['// SPDX-License-Identifier: MIT', 'pragma solidity ^0.8.24;', '', '/// @notice Local development ' + name + ' policy module.', 'contract ' + name + ' {', '    address public immutable owner;', '    bool public paused;', '    error Unauthorized();', '    error InvalidTransition();', '    event Updated(bytes32 indexed key, uint256 value);', '', '    constructor() { owner = msg.sender; }', '    modifier onlyOwner() {', '        if (msg.sender != owner) revert Unauthorized();', '        _;', '    }', '    function setPaused(bool value) external onlyOwner { paused = value; }'];
  const nouns = ['Epoch','Quota','Checkpoint','Delay','Limit','Reserve','Threshold','Window'];
  let i = 0;
  while (lines.length < target - 2) {
    const noun = nouns[i % nouns.length] + Math.floor(i / nouns.length + 1);
    lines.push('', '    mapping(bytes32 => uint256) private stored' + noun + ';', '', '    /// @dev Rejects updates while emergency pause is active.', '    function set' + noun + '(bytes32 key, uint256 value) external onlyOwner {', '        if (paused || key == bytes32(0)) revert InvalidTransition();', '        stored' + noun + '[key] = value;', '        emit Updated(key, value);', '    }', '', '    function get' + noun + '(bytes32 key) external view returns (uint256) {', '        return stored' + noun + '[key];', '    }', '', '    function clear' + noun + '(bytes32 key) external onlyOwner {', '        if (paused) revert InvalidTransition();', '        delete stored' + noun + '[key];', '        emit Updated(key, 0);', '    }');
    i++;
  }
  return lines.concat('}', '').join('\n');
}

for (const spec of CATALOGUE) {
  const files = spec.classes.map((name, index) => {
    const count = index === 0 ? 1250 : index === 1 ? 650 : 140;
    const verbs = ['validate', 'prepare', 'persist', 'reconcile', 'publish', 'inspect'];
    let source, ext, folder = 'src';
    if (spec.id === 'devops') {
      source = genLargeTerraform('# ' + spec.project + ' / ' + name + '\n', spec.project + '-' + name.toLowerCase(), [name.toLowerCase(), 'policy', 'metrics', 'network', 'storage', 'identity'], count); ext = 'tf'; folder = 'infra/modules';
    } else if (spec.id === 'embedded') {
      source = genLargeRustModule('#![allow(dead_code)]\nuse std::collections::{HashMap, VecDeque};\nuse std::time::{Duration, Instant};\n\n#[derive(Default)]\npub struct ' + name + ' {}\n', name, name.toLowerCase(), verbs, count); ext = 'rs';
    } else if (spec.id === 'gobackend') {
      source = genLargeGoFile('package ' + name.toLowerCase() + '\n\nimport (\n    "context"\n    "errors"\n    "fmt"\n    "sync"\n    "time"\n)\n\ntype ' + name + ' struct { mu sync.Mutex }\n', name, name.toLowerCase(), verbs, count); ext = 'go'; folder = 'internal/' + name.toLowerCase();
    } else if (spec.id === 'cpp') {
      source = genLargeCppFile('#include "' + name + '.hpp"\n#include <chrono>\n#include <string>\n#include <vector>\n#include <stdexcept>\n#include <unordered_map>\n', name, name.toLowerCase(), verbs, count); ext = 'cpp';
    } else { source = solidityModule(name, count); ext = 'sol'; folder = 'contracts'; }
    return [folder + '/' + name + '.' + ext, source, index < 6];
  });
  if (spec.id === 'cpp') {
    for (const name of spec.classes.slice(0, 4)) files.push(['include/' + name + '.hpp', '#pragma once\n#include <string>\n#include <vector>\n\nnamespace runtime {\nclass ' + name + ' {\npublic:\n    explicit ' + name + '() = default;\n    void start();\n    void stop();\n    bool healthy() const;\nprivate:\n    bool running_ = false;\n};\n}\n']);
    files.push(['CMakeLists.txt', 'cmake_minimum_required(VERSION 3.24)\nproject(vector_runtime LANGUAGES CXX)\nset(CMAKE_CXX_STANDARD 20)\nfile(GLOB SOURCES src/*.cpp)\nadd_library(vector_runtime ${SOURCES})\ntarget_include_directories(vector_runtime PUBLIC include)\nenable_testing()\n']);
  }
  if (spec.id === 'gobackend') files.push(['go.mod', 'module dispatch.internal.corp/service\n\ngo 1.23\n'], ['api/dispatch.proto', 'syntax = "proto3";\npackage dispatch.v1;\nservice Dispatcher { rpc Submit(SubmitRequest) returns (SubmitResponse); }\nmessage SubmitRequest { string id = 1; bytes payload = 2; }\nmessage SubmitResponse { bool accepted = 1; }\n']);
  if (spec.id === 'embedded') files.push(['Cargo.toml', '[package]\nname = "sensor-firmware"\nversion = "2.4.0"\nedition = "2021"\n\n[dependencies]\nembassy-executor = "0.7"\nheapless = "0.8"\n'], ['.cargo/config.toml', '[build]\ntarget = "thumbv7em-none-eabihf"\n\n[target.thumbv7em-none-eabihf]\nrunner = "probe-rs run --chip STM32F411CEUx"\n']);
  if (spec.id === 'blockchain') files.push(['hardhat.config.ts', "import { HardhatUserConfig } from 'hardhat/config';\nimport '@nomicfoundation/hardhat-toolbox';\nconst config: HardhatUserConfig = { solidity: '0.8.24', networks: { hardhat: { chainId: 31337 } } };\nexport default config;\n"], ['package.json', genPackageJson(spec.project, '2.4.0', [['hardhat','^2.22.0']], spec.scripts)]);
  files.push(['tests/recovery.spec.md', '# Recovery scenarios\n\n- Reject a malformed payload before writing state.\n- Preserve the checkpoint after a transient timeout.\n- Retry only idempotent operations.\n- Release leases when the worker stops.\n- Restore the previous snapshot after cancellation.\n- Emit one completion event per accepted request.\n'], ['config/local.yml', 'environment: local\nservice: ' + spec.project + '\ntelemetry:\n  port: 9090\n  sample_rate: 0.1\nretry:\n  attempts: 3\n  timeout_ms: 5000\n'], ['Makefile', 'build:\n\t' + spec.build + '\n\ntest:\n\t' + spec.test + '\n\nlint:\n\t' + spec.lint + '\n'], ['.gitignore', genGitignore(spec.id === 'embedded' ? 'rust' : spec.id === 'gobackend' ? 'go' : spec.id === 'devops' ? 'terraform' : spec.id === 'cpp' ? 'cpp' : 'node')], ['.editorconfig', genEditorconfig()], ['README.md', genReadme(spec.project, spec.label + ' workspace.', spec.stack.split(' · '))]);
  PROFILES.register(makeProfile({...spec, desc: 'Inspect ' + spec.classes.slice(0, 4).join(', ') + ' and the complete build workflow.'}, files));
}

// Freeze generated file lists once; switching repositories should not rebuild corpora.
for (const p of Object.values(TOPICS)) {
  const entries = p.fileList();
  p.files = p.fileList = () => entries;
  p.tree = () => projectTree(entries.map(f => f[0]));
}
