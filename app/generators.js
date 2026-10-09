/* FauxCode — source generators.
   Deterministic (seeded) generators that turn a handwritten base file into a large,
   coherent module: every generated method belongs to the same class, shares the same
   naming, tracing and error-handling conventions, and references the other generated
   members. Nothing here touches the DOM. See docs/CORPUS_CONTRACT.md for the contract. */
'use strict';

/* ================= seeded randomness ================= */

function seedRng(seed) {
  let h = 2166136261;
  for (const ch of String(seed)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return function () {
    h += 0x6D2B79F5;
    let t = Math.imul(h ^ (h >>> 15), 1 | h);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ================= naming ================= */

const GEN_NOUN_POOL = [
  'snapshot', 'batch', 'record', 'cursor', 'checkpoint', 'conflict', 'queue', 'delta', 'payload',
  'envelope', 'manifest', 'window', 'segment', 'partition', 'lease', 'ticket', 'policy', 'quota',
  'budget', 'handle', 'session', 'token', 'digest', 'replica', 'shard', 'bucket', 'journal',
  'event', 'signal', 'probe', 'sample', 'frame', 'region', 'candidate', 'outcome', 'receipt',
];

const GEN_ADJ_POOL = ['stale', 'pending', 'sealed', 'orphaned', 'degraded', 'partial', 'archived', 'quarantined'];

function genCap(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }
function genCamel(s) { return s.replace(/[-_ ]+(\w)/g, (m, c) => c.toUpperCase()).replace(/^[A-Z]/, c => c.toLowerCase()); }
function genPascal(s) { return genCap(genCamel(s)); }
function genSnake(s) { return s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[-\s]+/g, '_').toLowerCase(); }
function genDotted(s) { return genSnake(s).replace(/_/g, '.'); }
function genConst(s) { return genSnake(s).toUpperCase(); }

function genNouns(subject, rng, count) {
  const own = subject.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 3 && !['with', 'from', 'into'].includes(w));
  const pool = GEN_NOUN_POOL.slice();
  const out = own.slice(0, 2);
  while (out.length < count && pool.length) {
    const i = Math.floor(rng() * pool.length);
    const n = pool.splice(i, 1)[0];
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

/* A planner that hands out (verb, noun, template) triples without repeating names. */
function genPlanner(className, subject, verbs, rng) {
  const nouns = genNouns(subject, rng, 9);
  const used = new Set();
  const names = [];
  let step = 0;
  return {
    nouns,
    names,
    rng,
    pick(arr) { return arr[Math.floor(rng() * arr.length)]; },
    int(lo, hi) { return lo + Math.floor(rng() * (hi - lo + 1)); },
    next() {
      const verb = verbs[step % verbs.length];
      const noun = nouns[Math.floor(step / verbs.length) % nouns.length];
      step += 1;
      let base = genCamel(verb) + genPascal(noun);
      let name = base;
      let k = 2;
      while (used.has(name)) { name = base + k; k += 1; }
      used.add(name);
      names.push(name);
      return { verb: genCamel(verb), Verb: genPascal(verb), noun, Noun: genPascal(noun), name, Name: genPascal(name), snake: genSnake(name) };
    },
    ref(fallback) { return names.length > 1 ? names[Math.floor(rng() * (names.length - 1))] : fallback; },
  };
}

function genTrim(base) {
  return base.replace(/\s+$/, '').split('\n');
}

/* ================= TypeScript ================= */

const TS_TEMPLATES = [
  function validate(m, P, C) {
    const n = P.int(12, 48);
    return [
      '',
      '  /** Validates the ' + m.noun + ' before ' + m.verb + ' runs. Rejects early, complains loudly. */',
      '  private ' + m.name + '(input: ' + m.Noun + 'Input, traceId: string): ' + m.Noun + 'Input {',
      '    const issues: string[] = [];',
      "    if (!input.id || input.id.length < 8) {",
      "      issues.push('" + m.noun + " id is too short to be real');",
      '    }',
      '    if (input.revision < 0) {',
      "      issues.push('" + m.noun + " revision cannot be negative');",
      '    }',
      '    if (Object.keys(input.attributes).length > ' + n + ') {',
      "      issues.push('" + m.noun + " carries more than " + n + " attributes');",
      '    }',
      '    if (issues.length) {',
      "      this.trace.warn({ traceId, issues }, '" + m.noun + " rejected');",
      "      throw new " + C + "Error('" + m.snake + ": ' + issues.join('; '));",
      '    }',
      '    return input;',
      '  }',
    ];
  },
  function normalize(m, P, C, S) {
    return [
      '',
      '  /** Normalizes a raw ' + m.noun + ' into the shape the rest of ' + C + ' expects. */',
      '  private ' + m.name + '(raw: Record<string, unknown>, traceId: string): ' + m.Noun + 'Input {',
      '    const attributes = this.stripUndefined((raw.attributes as Record<string, unknown>) || {});',
      '    return {',
      "      id: String(raw.id ?? raw." + m.noun + "Id ?? ''),",
      '      revision: Number(raw.revision ?? 0),',
      "      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date(0).toISOString(),",
      "      source: (raw.source as string) || '" + S + "',",
      '      attributes,',
      '      traceId,',
      '    };',
      '  }',
    ];
  },
  function batch(m, P, C, S) {
    const ref = P.ref(m.name);
    return [
      '',
      '  /** Runs ' + m.verb + ' over a batch of ' + m.noun + 's. One failure does not sink the batch. */',
      '  private async ' + m.name + 'Batch(items: ' + m.Noun + 'Input[], traceId: string): Promise<BatchOutcome> {',
      '    const startedAt = Date.now();',
      '    const outcome: BatchOutcome = { processed: 0, skipped: 0, failed: 0 };',
      '    for (const item of items) {',
      '      try {',
      '        if (this.isStale(item)) {',
      '          outcome.skipped += 1;',
      '          continue;',
      '        }',
      '        await this.' + ref + '(item as never, traceId);',
      '        outcome.processed += 1;',
      '      } catch (error) {',
      '        outcome.failed += 1;',
      "        this.trace.warn({ traceId, id: item.id, error }, '" + m.verb + " failed for " + m.noun + "');",
      '      }',
      '    }',
      "    this.telemetry.timing('" + S + "." + m.snake + ".batch_ms', Date.now() - startedAt);",
      '    return outcome;',
      '  }',
    ];
  },
  function retry(m, P, C) {
    const ref = P.ref(m.name);
    const attempts = P.int(3, 5);
    return [
      '',
      '  /** Retries ' + m.verb + ' with capped backoff. ' + attempts + ' attempts, then we stop pretending. */',
      '  private async ' + m.name + 'WithRetry(input: ' + m.Noun + 'Input, traceId: string): Promise<' + m.Noun + 'Input> {',
      '    let attempt = 0;',
      '    let lastError: unknown = null;',
      '    while (attempt < ' + attempts + ') {',
      '      attempt += 1;',
      '      try {',
      '        return (await this.' + ref + '(input as never, traceId)) as ' + m.Noun + 'Input;',
      '      } catch (error) {',
      '        lastError = error;',
      '        const delay = Math.min(' + P.int(2, 8) * 1000 + ', ' + P.int(50, 250) + ' * 2 ** attempt);',
      "        this.trace.debug({ traceId, attempt, delay }, 'retrying " + m.verb + "');",
      '        await new Promise((resolve) => setTimeout(resolve, delay));',
      '      }',
      '    }',
      "    throw lastError instanceof Error ? lastError : new " + C + "Error('" + m.snake + " exhausted retries');",
      '  }',
    ];
  },
  function cached(m, P, C, S) {
    return [
      '',
      '  /** Memoizes ' + m.verb + ' per ' + m.noun + ' id for a short while. Short is relative. */',
      '  private async ' + m.name + 'Cached(id: string, traceId: string): Promise<' + m.Noun + 'Input | null> {',
      "    const key = '" + S + ":" + m.noun + ":' + id;",
      '    const hit = this.memo.get(key);',
      '    if (hit && hit.expiresAt > Date.now()) {',
      "      this.telemetry.increment('" + S + ".memo.hit');",
      '      return hit.value as ' + m.Noun + 'Input;',
      '    }',
      '    const fresh = await this.load' + m.Noun + '(id, traceId);',
      '    if (fresh) {',
      '      this.memo.set(key, { value: fresh, expiresAt: Date.now() + this.policy.ttlMs });',
      '    }',
      "    this.telemetry.increment('" + S + ".memo.miss');",
      '    return fresh;',
      '  }',
    ];
  },
  function publish(m, P, C, S) {
    return [
      '',
      '  /** Emits a ' + m.noun + ' event so downstream consumers can pretend to care. */',
      '  private async ' + m.name + 'Event(input: ' + m.Noun + 'Input, traceId: string): Promise<void> {',
      '    const event: DomainEvent = {',
      "      type: '" + S + "." + m.noun + "." + genSnake(m.verb) + "',",
      '      id: input.id,',
      '      revision: input.revision,',
      '      emittedAt: new Date().toISOString(),',
      '      traceId,',
      '    };',
      '    await this.bus.publish(event);',
      "    this.trace.debug({ traceId, type: event.type }, 'event published');",
      '  }',
    ];
  },
  function guard(m, P, C) {
    const adj = P.pick(GEN_ADJ_POOL);
    return [
      '',
      '  /** Guards ' + m.verb + ': a ' + adj + ' ' + m.noun + ' must not be touched again. */',
      '  private assert' + m.Name + 'Allowed(input: ' + m.Noun + 'Input): void {',
      '    if (this.isStale(input)) {',
      "      throw new " + C + "Error('" + m.noun + " ' + input.id + ' is " + adj + " (revision ' + input.revision + ')');",
      '    }',
      "    if (input.source === 'legacy' && !this.policy.allowLegacy) {",
      "      throw new " + C + "Error('legacy " + m.noun + "s are read-only in this build');",
      '    }',
      '  }',
    ];
  },
  function pipeline(m, P, C) {
    const a = P.ref(m.name), b = P.ref(m.name), c = P.ref(m.name);
    return [
      '',
      '  /** Runs the ' + m.verb + ' pipeline for one ' + m.noun + ': each step gets the previous output. */',
      '  private async ' + m.name + 'Pipeline(input: ' + m.Noun + 'Input, traceId: string): Promise<' + m.Noun + 'Input> {',
      '    const steps: Array<(value: ' + m.Noun + 'Input) => Promise<unknown> | unknown> = [',
      '      (value) => this.' + a + '(value as never, traceId),',
      '      (value) => this.' + b + '(value as never, traceId),',
      '      (value) => this.' + c + '(value as never, traceId),',
      '    ];',
      '    let current = input;',
      '    for (const step of steps) {',
      '      current = ((await step(current)) as ' + m.Noun + 'Input) ?? current;',
      '    }',
      '    return current;',
      '  }',
    ];
  },
];

function genLargeTsClass(base, className, subject, verbs, targetLines) {
  const lines = genTrim(base);
  const closing = lines[lines.length - 1].trim() === '}' ? lines.pop() : '}';
  const P = genPlanner(className, subject, verbs, seedRng(className + subject));
  const S = genDotted(subject);
  const nounsUsed = new Set();
  lines.push(
    '',
    '  // ---- ' + subject + ' internals ----',
    '  // Everything below follows the same contract: trace, validate, do the thing, publish.',
    "  private readonly trace = new TraceLog('" + className + "');",
    '  private readonly telemetry = new InlineTelemetry();',
    '  private readonly bus = new DomainEventBus();',
    '  private readonly memo = new Map<string, { value: unknown; expiresAt: number }>();',
    '  private readonly policy = { allowLegacy: false, batchSize: ' + P.int(50, 500) + ', ttlMs: ' + P.int(5, 60) + '_000 };',
    '',
    '  private stripUndefined(input: Record<string, unknown>): Record<string, unknown> {',
    '    return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));',
    '  }',
    '',
    '  private isStale(input: { updatedAt: string }): boolean {',
    '    return Date.now() - Date.parse(input.updatedAt) > this.policy.ttlMs * 10;',
    '  }',
  );
  const supportReserve = 40;
  while (lines.length < targetLines - supportReserve) {
    const m = P.next();
    nounsUsed.add(m.Noun);
    const tpl = P.pick(TS_TEMPLATES);
    for (const l of tpl(m, P, className, S)) lines.push(l);
  }
  for (const Noun of nounsUsed) {
    lines.push(
      '',
      '  private async load' + Noun + '(id: string, traceId: string): Promise<' + Noun + 'Input | null> {',
      "    this.trace.debug({ traceId, id }, 'loading " + Noun.toLowerCase() + "');",
      "    return { id, revision: 0, updatedAt: new Date().toISOString(), source: '" + S + "', attributes: {}, traceId };",
      '  }',
    );
  }
  lines.push(closing, '', '/* ---- supporting types for the ' + subject + ' section ---- */');
  for (const Noun of nounsUsed) {
    lines.push('', 'export interface ' + Noun + 'Input {', '  id: string;', '  revision: number;', '  updatedAt: string;', '  source: string;', '  attributes: Record<string, unknown>;', '  traceId: string;', '}');
  }
  lines.push(
    '',
    'export interface BatchOutcome {', '  processed: number;', '  skipped: number;', '  failed: number;', '}',
    '',
    'export interface DomainEvent {', '  type: string;', '  id: string;', '  revision: number;', '  emittedAt: string;', '  traceId: string;', '}',
    '',
    'export class ' + className + 'Error extends Error {',
    '  constructor(message: string) {',
    '    super(message);',
    "    this.name = '" + className + "Error';",
    '  }',
    '}',
    '',
    'class TraceLog {',
    '  constructor(private readonly scope: string) {}',
    '  debug(meta: Record<string, unknown>, message: string): void { void meta; void message; }',
    "  warn(meta: Record<string, unknown>, message: string): void { console.warn(this.scope + ': ' + message, meta); }",
    '}',
    '',
    'class InlineTelemetry {',
    '  increment(metric: string, value = 1): void { void metric; void value; }',
    '  timing(metric: string, ms: number): void { void metric; void ms; }',
    '}',
    '',
    'class DomainEventBus {',
    '  async publish(event: DomainEvent): Promise<void> { void event; }',
    '}',
  );
  return lines.join('\n') + '\n';
}

/* ================= Python ================= */

const PY_TEMPLATES = [
  function validate(m, P, C, S) {
    const n = P.int(12, 48);
    return [
      '',
      '    def ' + m.snake + '(self, payload: dict, trace_id: str) -> dict:',
      '        """Validate a ' + m.noun + ' before ' + m.verb + ' runs. Reject early, complain loudly."""',
      '        issues: list[str] = []',
      '        if not payload.get("id") or len(str(payload["id"])) < 8:',
      '            issues.append("' + m.noun + ' id is too short to be real")',
      '        if int(payload.get("revision", 0)) < 0:',
      '            issues.append("' + m.noun + ' revision cannot be negative")',
      '        if len(payload.get("attributes", {})) > ' + n + ':',
      '            issues.append("' + m.noun + ' carries more than ' + n + ' attributes")',
      '        if issues:',
      '            self._logger.warning("' + m.noun + ' rejected", extra={"trace_id": trace_id, "issues": issues})',
      '            raise ' + C + 'Error("' + m.snake + ': " + "; ".join(issues))',
      '        return payload',
    ];
  },
  function normalize(m, P, C, S) {
    return [
      '',
      '    def ' + m.snake + '(self, raw: dict, trace_id: str) -> dict:',
      '        """Normalize a raw ' + m.noun + ' into the shape the rest of ' + C + ' expects."""',
      '        attributes = {key: value for key, value in (raw.get("attributes") or {}).items() if value is not None}',
      '        return {',
      '            "id": str(raw.get("id") or raw.get("' + m.noun + '_id") or ""),',
      '            "revision": int(raw.get("revision") or 0),',
      '            "updated_at": raw.get("updated_at") or "1970-01-01T00:00:00Z",',
      '            "source": raw.get("source") or "' + S + '",',
      '            "attributes": attributes,',
      '            "trace_id": trace_id,',
      '        }',
    ];
  },
  function batch(m, P, C, S) {
    const ref = P.ref(m.name);
    return [
      '',
      '    def ' + m.snake + '_batch(self, items: list[dict], trace_id: str) -> BatchOutcome:',
      '        """Run ' + m.verb + ' over a batch of ' + m.noun + 's. One failure does not sink the batch."""',
      '        started = time.monotonic()',
      '        outcome = BatchOutcome()',
      '        for item in items:',
      '            try:',
      '                if self._is_stale(item):',
      '                    outcome.skipped += 1',
      '                    continue',
      '                self.' + genSnake(ref) + '(item, trace_id)',
      '                outcome.processed += 1',
      '            except ' + C + 'Error as exc:',
      '                outcome.failed += 1',
      '                self._logger.warning("' + m.verb + ' failed for ' + m.noun + '", extra={"trace_id": trace_id, "error": str(exc)})',
      '        self._telemetry.timing("' + S + '.' + m.snake + '.batch_ms", (time.monotonic() - started) * 1000)',
      '        return outcome',
    ];
  },
  function retry(m, P, C, S) {
    const ref = P.ref(m.name);
    const attempts = P.int(3, 5);
    return [
      '',
      '    def ' + m.snake + '_with_retry(self, payload: dict, trace_id: str) -> dict:',
      '        """Retry ' + m.verb + ' with capped backoff. ' + attempts + ' attempts, then we stop pretending."""',
      '        last_error: Exception | None = None',
      '        for attempt in range(1, ' + (attempts + 1) + '):',
      '            try:',
      '                return self.' + genSnake(ref) + '(payload, trace_id)',
      '            except ' + C + 'Error as exc:',
      '                last_error = exc',
      '                delay = min(' + P.int(2, 8) + '.0, ' + (P.int(5, 25) / 100).toFixed(2) + ' * 2 ** attempt)',
      '                self._logger.debug("retrying ' + m.verb + '", extra={"trace_id": trace_id, "attempt": attempt, "delay": delay})',
      '                time.sleep(delay)',
      '        raise last_error or ' + C + 'Error("' + m.snake + ' exhausted retries")',
    ];
  },
  function cached(m, P, C, S) {
    return [
      '',
      '    def ' + m.snake + '_cached(self, key_id: str, trace_id: str) -> dict | None:',
      '        """Memoize ' + m.verb + ' per ' + m.noun + ' id for a short while. Short is relative."""',
      '        key = "' + S + ':' + m.noun + ':" + key_id',
      '        hit = self._memo.get(key)',
      '        if hit is not None and hit[1] > time.monotonic():',
      '            self._telemetry.increment("' + S + '.memo.hit")',
      '            return hit[0]',
      '        fresh = self._load_' + genSnake(m.noun) + '(key_id, trace_id)',
      '        if fresh is not None:',
      '            self._memo[key] = (fresh, time.monotonic() + self._policy["ttl_seconds"])',
      '        self._telemetry.increment("' + S + '.memo.miss")',
      '        return fresh',
    ];
  },
  function publish(m, P, C, S) {
    return [
      '',
      '    def ' + m.snake + '_event(self, payload: dict, trace_id: str) -> None:',
      '        """Emit a ' + m.noun + ' event so downstream consumers can pretend to care."""',
      '        event = {',
      '            "type": "' + S + '.' + m.noun + '.' + genSnake(m.verb) + '",',
      '            "id": payload["id"],',
      '            "revision": payload.get("revision", 0),',
      '            "emitted_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),',
      '            "trace_id": trace_id,',
      '        }',
      '        self._bus.publish(event)',
      '        self._logger.debug("event published", extra={"trace_id": trace_id, "type": event["type"]})',
    ];
  },
  function guard(m, P, C, S) {
    const adj = P.pick(GEN_ADJ_POOL);
    return [
      '',
      '    def assert_' + m.snake + '_allowed(self, payload: dict) -> None:',
      '        """Guard ' + m.verb + ': a ' + adj + ' ' + m.noun + ' must not be touched again."""',
      '        if self._is_stale(payload):',
      '            raise ' + C + 'Error(f"' + m.noun + ' {payload[\'id\']} is ' + adj + ' (revision {payload.get(\'revision\', 0)})")',
      '        if payload.get("source") == "legacy" and not self._policy["allow_legacy"]:',
      '            raise ' + C + 'Error("legacy ' + m.noun + 's are read-only in this build")',
    ];
  },
];

function genLargePythonModule(base, className, subject, verbs, targetLines) {
  const lines = genTrim(base);
  if (!/^import time$/m.test(base) && !/^import time\b/m.test(base)) {
    const firstImport = lines.findIndex(l => /^(import|from) /.test(l));
    lines.splice(firstImport < 0 ? 0 : firstImport, 0, 'import time');
  }
  const P = genPlanner(className, subject, verbs, seedRng(className + subject));
  const S = genDotted(subject);
  const nounsUsed = new Set();
  lines.push(
    '',
    '',
    'class BatchOutcome:',
    '    """Counts for one batch run. Nothing fancy, nothing hidden."""',
    '',
    '    def __init__(self) -> None:',
    '        self.processed = 0',
    '        self.skipped = 0',
    '        self.failed = 0',
    '',
    '    def as_dict(self) -> dict:',
    '        return {"processed": self.processed, "skipped": self.skipped, "failed": self.failed}',
    '',
    '',
    'class ' + className + 'Error(RuntimeError):',
    '    """Raised when the ' + subject + ' pipeline refuses to continue."""',
    '',
    '',
    'class _Telemetry:',
    '    def increment(self, metric: str, value: int = 1) -> None:',
    '        pass',
    '',
    '    def timing(self, metric: str, ms: float) -> None:',
    '        pass',
    '',
    '',
    'class _EventBus:',
    '    def publish(self, event: dict) -> None:',
    '        pass',
    '',
    '',
    'class ' + className + ':',
    '    """Traceable helpers used by the ' + subject + ' pipeline.',
    '',
    '    Every step follows the same contract: trace, validate, do the thing, publish.',
    '    """',
    '',
    '    def __init__(self, logger, telemetry=None, bus=None):',
    '        self._logger = logger',
    '        self._telemetry = telemetry or _Telemetry()',
    '        self._bus = bus or _EventBus()',
    '        self._memo: dict[str, tuple[dict, float]] = {}',
    '        self._policy = {"allow_legacy": False, "batch_size": ' + P.int(50, 500) + ', "ttl_seconds": ' + P.int(5, 120) + '}',
    '',
    '    def _is_stale(self, payload: dict) -> bool:',
    '        updated = payload.get("updated_at") or "1970-01-01T00:00:00Z"',
    '        return updated < time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - 86400))',
  );
  while (lines.length < targetLines - 12) {
    const m = P.next();
    nounsUsed.add(m.noun);
    const tpl = P.pick(PY_TEMPLATES);
    for (const l of tpl(m, P, className, S)) lines.push(l);
  }
  for (const noun of nounsUsed) {
    lines.push(
      '',
      '    def _load_' + genSnake(noun) + '(self, key_id: str, trace_id: str) -> dict | None:',
      '        self._logger.debug("loading ' + noun + '", extra={"trace_id": trace_id, "id": key_id})',
      '        return {"id": key_id, "revision": 0, "updated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "source": "' + S + '", "attributes": {}}',
    );
  }
  return lines.join('\n') + '\n';
}

/* ================= Kotlin ================= */

const KT_TEMPLATES = [
  function validate(m, P, C) {
    const n = P.int(12, 48);
    return [
      '',
      '  /** Validates the ' + m.noun + ' before ' + m.verb + ' runs. Rejects early, complains loudly. */',
      '  private fun ' + m.name + '(input: ' + m.Noun + 'Input, traceId: String): ' + m.Noun + 'Input {',
      '    val issues = mutableListOf<String>()',
      '    if (input.id.length < 8) issues += "' + m.noun + ' id is too short to be real"',
      '    if (input.revision < 0) issues += "' + m.noun + ' revision cannot be negative"',
      '    if (input.attributes.size > ' + n + ') issues += "' + m.noun + ' carries more than ' + n + ' attributes"',
      '    if (issues.isNotEmpty()) {',
      '      trace.warn(traceId, "' + m.noun + ' rejected: " + issues.joinToString("; "))',
      '      throw ' + C + 'Exception("' + m.snake + ': " + issues.joinToString("; "))',
      '    }',
      '    return input',
      '  }',
    ];
  },
  function normalize(m, P, C, S) {
    return [
      '',
      '  /** Normalizes a raw ' + m.noun + ' map into the shape the rest of ' + C + ' expects. */',
      '  private fun ' + m.name + '(raw: Map<String, Any?>, traceId: String): ' + m.Noun + 'Input {',
      '    @Suppress("UNCHECKED_CAST")',
      '    val attributes = (raw["attributes"] as? Map<String, Any?>).orEmpty().filterValues { it != null }',
      '    return ' + m.Noun + 'Input(',
      '      id = (raw["id"] ?: raw["' + m.noun + 'Id"] ?: "").toString(),',
      '      revision = (raw["revision"] as? Number)?.toLong() ?: 0L,',
      '      updatedAt = raw["updatedAt"] as? String ?: EPOCH,',
      '      source = raw["source"] as? String ?: "' + S + '",',
      '      attributes = attributes,',
      '      traceId = traceId,',
      '    )',
      '  }',
    ];
  },
  function batch(m, P, C, S) {
    const ref = P.ref(m.name);
    return [
      '',
      '  /** Runs ' + m.verb + ' over a batch of ' + m.noun + 's. One failure does not sink the batch. */',
      '  private fun ' + m.name + 'Batch(items: List<' + m.Noun + 'Input>, traceId: String): BatchOutcome {',
      '    val startedAt = System.nanoTime()',
      '    val outcome = BatchOutcome()',
      '    for (item in items) {',
      '      try {',
      '        if (isStale(item.updatedAt)) {',
      '          outcome.skipped += 1',
      '          continue',
      '        }',
      '        ' + ref + '(item as Nothing, traceId)',
      '        outcome.processed += 1',
      '      } catch (error: ' + C + 'Exception) {',
      '        outcome.failed += 1',
      '        trace.warn(traceId, "' + m.verb + ' failed for ' + m.noun + ' " + item.id + ": " + error.message)',
      '      }',
      '    }',
      '    telemetry.timing("' + S + '.' + m.snake + '.batch_ms", (System.nanoTime() - startedAt) / 1_000_000)',
      '    return outcome',
      '  }',
    ];
  },
  function retry(m, P, C) {
    const ref = P.ref(m.name);
    const attempts = P.int(3, 5);
    return [
      '',
      '  /** Retries ' + m.verb + ' with capped backoff. ' + attempts + ' attempts, then we stop pretending. */',
      '  private fun ' + m.name + 'WithRetry(input: ' + m.Noun + 'Input, traceId: String): ' + m.Noun + 'Input {',
      '    var lastError: Throwable? = null',
      '    repeat(' + attempts + ') { attempt ->',
      '      try {',
      '        return ' + ref + '(input as Nothing, traceId) as ' + m.Noun + 'Input',
      '      } catch (error: ' + C + 'Exception) {',
      '        lastError = error',
      '        val delay = minOf(' + P.int(2, 8) * 1000 + 'L, ' + P.int(50, 250) + 'L shl attempt)',
      '        trace.debug(traceId, "retrying ' + m.verb + ' in " + delay + "ms")',
      '        Thread.sleep(delay)',
      '      }',
      '    }',
      '    throw lastError ?: ' + C + 'Exception("' + m.snake + ' exhausted retries")',
      '  }',
    ];
  },
  function cached(m, P, C, S) {
    return [
      '',
      '  /** Memoizes ' + m.verb + ' per ' + m.noun + ' id for a short while. Short is relative. */',
      '  private fun ' + m.name + 'Cached(id: String, traceId: String): ' + m.Noun + 'Input? {',
      '    val key = "' + S + ':' + m.noun + ':" + id',
      '    memo[key]?.let { hit ->',
      '      if (hit.expiresAt > System.currentTimeMillis()) {',
      '        telemetry.increment("' + S + '.memo.hit")',
      '        return hit.value as ' + m.Noun + 'Input',
      '      }',
      '    }',
      '    val fresh = load' + m.Noun + '(id, traceId)',
      '    if (fresh != null) memo[key] = MemoEntry(fresh, System.currentTimeMillis() + policy.ttlMs)',
      '    telemetry.increment("' + S + '.memo.miss")',
      '    return fresh',
      '  }',
    ];
  },
  function publish(m, P, C, S) {
    return [
      '',
      '  /** Emits a ' + m.noun + ' event so downstream consumers can pretend to care. */',
      '  private fun ' + m.name + 'Event(input: ' + m.Noun + 'Input, traceId: String) {',
      '    val event = DomainEvent(',
      '      type = "' + S + '.' + m.noun + '.' + genSnake(m.verb) + '",',
      '      id = input.id,',
      '      revision = input.revision,',
      '      emittedAt = System.currentTimeMillis(),',
      '      traceId = traceId,',
      '    )',
      '    bus.publish(event)',
      '    trace.debug(traceId, "event published: " + event.type)',
      '  }',
    ];
  },
  function guard(m, P, C) {
    const adj = P.pick(GEN_ADJ_POOL);
    return [
      '',
      '  /** Guards ' + m.verb + ': a ' + adj + ' ' + m.noun + ' must not be touched again. */',
      '  private fun assert' + m.Name + 'Allowed(input: ' + m.Noun + 'Input) {',
      '    check(!isStale(input.updatedAt)) { "' + m.noun + ' " + input.id + " is ' + adj + ' (revision " + input.revision + ")" }',
      '    check(input.source != "legacy" || policy.allowLegacy) { "legacy ' + m.noun + 's are read-only in this build" }',
      '  }',
    ];
  },
];

function genLargeKotlinClass(base, className, subject, verbs, targetLines) {
  const lines = genTrim(base);
  const closing = lines[lines.length - 1].trim() === '}' ? lines.pop() : '}';
  const P = genPlanner(className, subject, verbs, seedRng(className + subject));
  const S = genDotted(subject);
  const nounsUsed = new Set();
  lines.push(
    '',
    '  // ---- ' + subject + ' internals ----',
    '  // Everything below follows the same contract: trace, validate, do the thing, publish.',
    '  private val trace = TraceLog("' + className + '")',
    '  private val telemetry = InlineTelemetry()',
    '  private val bus = DomainEventBus()',
    '  private val memo = HashMap<String, MemoEntry>()',
    '  private val policy = Policy(allowLegacy = false, batchSize = ' + P.int(50, 500) + ', ttlMs = ' + P.int(5, 60) + '_000L)',
    '',
    '  private fun isStale(updatedAt: String): Boolean =',
    '    System.currentTimeMillis() - java.time.Instant.parse(updatedAt).toEpochMilli() > policy.ttlMs * 10',
  );
  while (lines.length < targetLines - 45) {
    const m = P.next();
    nounsUsed.add(m.Noun);
    const tpl = P.pick(KT_TEMPLATES);
    for (const l of tpl(m, P, className, S)) lines.push(l);
  }
  for (const Noun of nounsUsed) {
    lines.push(
      '',
      '  private fun load' + Noun + '(id: String, traceId: String): ' + Noun + 'Input? {',
      '    trace.debug(traceId, "loading ' + Noun.toLowerCase() + ' " + id)',
      '    return ' + Noun + 'Input(id, 0L, EPOCH, "' + S + '", emptyMap(), traceId)',
      '  }',
    );
  }
  lines.push(closing, '', '// ---- supporting types for the ' + subject + ' section ----', '', 'private const val EPOCH = "1970-01-01T00:00:00Z"');
  for (const Noun of nounsUsed) {
    lines.push('', 'data class ' + Noun + 'Input(', '  val id: String,', '  val revision: Long,', '  val updatedAt: String,', '  val source: String,', '  val attributes: Map<String, Any?>,', '  val traceId: String,', ')');
  }
  lines.push(
    '',
    'class BatchOutcome(var processed: Int = 0, var skipped: Int = 0, var failed: Int = 0)',
    '',
    'data class DomainEvent(val type: String, val id: String, val revision: Long, val emittedAt: Long, val traceId: String)',
    '',
    'data class MemoEntry(val value: Any, val expiresAt: Long)',
    '',
    'data class Policy(val allowLegacy: Boolean, val batchSize: Int, val ttlMs: Long)',
    '',
    'class ' + className + 'Exception(message: String) : RuntimeException(message)',
    '',
    'class TraceLog(private val scope: String) {',
    '  fun debug(traceId: String, message: String) = Unit',
    '  fun warn(traceId: String, message: String) = android.util.Log.w(scope, "[" + traceId + "] " + message)',
    '}',
    '',
    'class InlineTelemetry {',
    '  fun increment(metric: String, value: Int = 1) = Unit',
    '  fun timing(metric: String, ms: Long) = Unit',
    '}',
    '',
    'class DomainEventBus {',
    '  fun publish(event: DomainEvent) = Unit',
    '}',
  );
  return lines.join('\n') + '\n';
}

/* ================= Swift ================= */

const SWIFT_TEMPLATES = [
  function validate(m, P, C) {
    const n = P.int(12, 48);
    return [
      '',
      '  /// Validates the ' + m.noun + ' before ' + m.verb + ' runs. Rejects early, complains loudly.',
      '  private func ' + m.name + '(_ input: ' + m.Noun + 'Input, traceId: String) throws -> ' + m.Noun + 'Input {',
      '    var issues: [String] = []',
      '    if input.id.count < 8 { issues.append("' + m.noun + ' id is too short to be real") }',
      '    if input.revision < 0 { issues.append("' + m.noun + ' revision cannot be negative") }',
      '    if input.attributes.count > ' + n + ' { issues.append("' + m.noun + ' carries more than ' + n + ' attributes") }',
      '    guard issues.isEmpty else {',
      '      trace.warn(traceId, "' + m.noun + ' rejected: " + issues.joined(separator: "; "))',
      '      throw ' + C + 'Error.rejected("' + m.snake + ': " + issues.joined(separator: "; "))',
      '    }',
      '    return input',
      '  }',
    ];
  },
  function normalize(m, P, C, S) {
    return [
      '',
      '  /// Normalizes a raw ' + m.noun + ' dictionary into the shape the rest of ' + C + ' expects.',
      '  private func ' + m.name + '(_ raw: [String: Any], traceId: String) -> ' + m.Noun + 'Input {',
      '    let attributes = (raw["attributes"] as? [String: Any]) ?? [:]',
      '    return ' + m.Noun + 'Input(',
      '      id: (raw["id"] as? String) ?? (raw["' + m.noun + 'Id"] as? String) ?? "",',
      '      revision: (raw["revision"] as? Int) ?? 0,',
      '      updatedAt: (raw["updatedAt"] as? String) ?? Self.epoch,',
      '      source: (raw["source"] as? String) ?? "' + S + '",',
      '      attributes: attributes,',
      '      traceId: traceId',
      '    )',
      '  }',
    ];
  },
  function batch(m, P, C, S) {
    const ref = P.ref(m.name);
    return [
      '',
      '  /// Runs ' + m.verb + ' over a batch of ' + m.noun + 's. One failure does not sink the batch.',
      '  private func ' + m.name + 'Batch(_ items: [' + m.Noun + 'Input], traceId: String) -> BatchOutcome {',
      '    let startedAt = DispatchTime.now()',
      '    var outcome = BatchOutcome()',
      '    for item in items {',
      '      do {',
      '        if isStale(item.updatedAt) {',
      '          outcome.skipped += 1',
      '          continue',
      '        }',
      '        _ = try ' + ref + '(item as! Never, traceId: traceId)',
      '        outcome.processed += 1',
      '      } catch {',
      '        outcome.failed += 1',
      '        trace.warn(traceId, "' + m.verb + ' failed for ' + m.noun + ' \\(item.id): \\(error)")',
      '      }',
      '    }',
      '    telemetry.timing("' + S + '.' + m.snake + '.batch_ms", since: startedAt)',
      '    return outcome',
      '  }',
    ];
  },
  function retry(m, P, C) {
    const ref = P.ref(m.name);
    const attempts = P.int(3, 5);
    return [
      '',
      '  /// Retries ' + m.verb + ' with capped backoff. ' + attempts + ' attempts, then we stop pretending.',
      '  private func ' + m.name + 'WithRetry(_ input: ' + m.Noun + 'Input, traceId: String) throws -> ' + m.Noun + 'Input {',
      '    var lastError: Error?',
      '    for attempt in 1...' + attempts + ' {',
      '      do {',
      '        return try ' + ref + '(input as! Never, traceId: traceId) as! ' + m.Noun + 'Input',
      '      } catch {',
      '        lastError = error',
      '        let delay = min(' + (P.int(2, 8)).toFixed(1) + ', ' + (P.int(5, 25) / 100).toFixed(2) + ' * pow(2.0, Double(attempt)))',
      '        trace.debug(traceId, "retrying ' + m.verb + ' in \\(delay)s")',
      '        Thread.sleep(forTimeInterval: delay)',
      '      }',
      '    }',
      '    throw lastError ?? ' + C + 'Error.exhausted("' + m.snake + '")',
      '  }',
    ];
  },
  function cached(m, P, C, S) {
    return [
      '',
      '  /// Memoizes ' + m.verb + ' per ' + m.noun + ' id for a short while. Short is relative.',
      '  private func ' + m.name + 'Cached(id: String, traceId: String) -> ' + m.Noun + 'Input? {',
      '    let key = "' + S + ':' + m.noun + ':" + id',
      '    if let hit = memo[key], hit.expiresAt > Date() {',
      '      telemetry.increment("' + S + '.memo.hit")',
      '      return hit.value as? ' + m.Noun + 'Input',
      '    }',
      '    let fresh = load' + m.Noun + '(id: id, traceId: traceId)',
      '    if let fresh = fresh {',
      '      memo[key] = MemoEntry(value: fresh, expiresAt: Date().addingTimeInterval(policy.ttl))',
      '    }',
      '    telemetry.increment("' + S + '.memo.miss")',
      '    return fresh',
      '  }',
    ];
  },
  function publish(m, P, C, S) {
    return [
      '',
      '  /// Emits a ' + m.noun + ' event so downstream consumers can pretend to care.',
      '  private func ' + m.name + 'Event(_ input: ' + m.Noun + 'Input, traceId: String) {',
      '    let event = DomainEvent(',
      '      type: "' + S + '.' + m.noun + '.' + genSnake(m.verb) + '",',
      '      id: input.id,',
      '      revision: input.revision,',
      '      emittedAt: Date(),',
      '      traceId: traceId',
      '    )',
      '    bus.publish(event)',
      '    trace.debug(traceId, "event published: " + event.type)',
      '  }',
    ];
  },
  function guard(m, P, C) {
    const adj = P.pick(GEN_ADJ_POOL);
    return [
      '',
      '  /// Guards ' + m.verb + ': a ' + adj + ' ' + m.noun + ' must not be touched again.',
      '  private func assert' + m.Name + 'Allowed(_ input: ' + m.Noun + 'Input) throws {',
      '    guard !isStale(input.updatedAt) else {',
      '      throw ' + C + 'Error.rejected("' + m.noun + ' \\(input.id) is ' + adj + ' (revision \\(input.revision))")',
      '    }',
      '    guard input.source != "legacy" || policy.allowLegacy else {',
      '      throw ' + C + 'Error.rejected("legacy ' + m.noun + 's are read-only in this build")',
      '    }',
      '  }',
    ];
  },
];

function genLargeSwiftClass(base, className, subject, verbs, targetLines) {
  const lines = genTrim(base);
  const closing = lines[lines.length - 1].trim() === '}' ? lines.pop() : '}';
  const P = genPlanner(className, subject, verbs, seedRng(className + subject));
  const S = genDotted(subject);
  const nounsUsed = new Set();
  lines.push(
    '',
    '  // MARK: - ' + subject + ' internals',
    '  // Everything below follows the same contract: trace, validate, do the thing, publish.',
    '  private static let epoch = "1970-01-01T00:00:00Z"',
    '  private let trace = TraceLog(scope: "' + className + '")',
    '  private let telemetry = InlineTelemetry()',
    '  private let bus = DomainEventBus()',
    '  private var memo: [String: MemoEntry] = [:]',
    '  private let policy = Policy(allowLegacy: false, batchSize: ' + P.int(50, 500) + ', ttl: ' + P.int(5, 60) + ')',
    '',
    '  private func isStale(_ updatedAt: String) -> Bool {',
    '    guard let date = ISO8601DateFormatter().date(from: updatedAt) else { return true }',
    '    return Date().timeIntervalSince(date) > policy.ttl * 10',
    '  }',
  );
  while (lines.length < targetLines - 50) {
    const m = P.next();
    nounsUsed.add(m.Noun);
    const tpl = P.pick(SWIFT_TEMPLATES);
    for (const l of tpl(m, P, className, S)) lines.push(l);
  }
  for (const Noun of nounsUsed) {
    lines.push(
      '',
      '  private func load' + Noun + '(id: String, traceId: String) -> ' + Noun + 'Input? {',
      '    trace.debug(traceId, "loading ' + Noun.toLowerCase() + ' " + id)',
      '    return ' + Noun + 'Input(id: id, revision: 0, updatedAt: Self.epoch, source: "' + S + '", attributes: [:], traceId: traceId)',
      '  }',
    );
  }
  lines.push(closing, '', '// MARK: - supporting types for the ' + subject + ' section');
  for (const Noun of nounsUsed) {
    lines.push('', 'struct ' + Noun + 'Input {', '  let id: String', '  let revision: Int', '  let updatedAt: String', '  let source: String', '  let attributes: [String: Any]', '  let traceId: String', '}');
  }
  lines.push(
    '',
    'struct BatchOutcome {', '  var processed = 0', '  var skipped = 0', '  var failed = 0', '}',
    '',
    'struct DomainEvent {', '  let type: String', '  let id: String', '  let revision: Int', '  let emittedAt: Date', '  let traceId: String', '}',
    '',
    'struct MemoEntry {', '  let value: Any', '  let expiresAt: Date', '}',
    '',
    'struct Policy {', '  let allowLegacy: Bool', '  let batchSize: Int', '  let ttl: TimeInterval', '}',
    '',
    'enum ' + className + 'Error: Error {', '  case rejected(String)', '  case exhausted(String)', '}',
    '',
    'final class TraceLog {',
    '  private let scope: String',
    '  init(scope: String) { self.scope = scope }',
    '  func debug(_ traceId: String, _ message: String) {}',
    '  func warn(_ traceId: String, _ message: String) { NSLog("%@ [%@] %@", scope, traceId, message) }',
    '}',
    '',
    'final class InlineTelemetry {',
    '  func increment(_ metric: String, value: Int = 1) {}',
    '  func timing(_ metric: String, since: DispatchTime) {}',
    '}',
    '',
    'final class DomainEventBus {',
    '  func publish(_ event: DomainEvent) {}',
    '}',
  );
  return lines.join('\n') + '\n';
}

/* ================= Java ================= */

const JAVA_TEMPLATES = [
  function validate(m, P, C) {
    const n = P.int(12, 48);
    return [
      '',
      '    /** Validates the ' + m.noun + ' before ' + m.verb + ' runs. Rejects early, complains loudly. */',
      '    private ' + m.Noun + 'Input ' + m.name + '(' + m.Noun + 'Input input, String traceId) {',
      '        List<String> issues = new ArrayList<>();',
      '        if (input.id() == null || input.id().length() < 8) {',
      '            issues.add("' + m.noun + ' id is too short to be real");',
      '        }',
      '        if (input.revision() < 0) {',
      '            issues.add("' + m.noun + ' revision cannot be negative");',
      '        }',
      '        if (input.attributes().size() > ' + n + ') {',
      '            issues.add("' + m.noun + ' carries more than ' + n + ' attributes");',
      '        }',
      '        if (!issues.isEmpty()) {',
      '            trace.warn(traceId, "' + m.noun + ' rejected: " + String.join("; ", issues));',
      '            throw new ' + C + 'Exception("' + m.snake + ': " + String.join("; ", issues));',
      '        }',
      '        return input;',
      '    }',
    ];
  },
  function normalize(m, P, C, S) {
    return [
      '',
      '    /** Normalizes a raw ' + m.noun + ' map into the shape the rest of ' + C + ' expects. */',
      '    private ' + m.Noun + 'Input ' + m.name + '(Map<String, Object> raw, String traceId) {',
      '        Map<String, Object> attributes = new HashMap<>();',
      '        Object rawAttributes = raw.get("attributes");',
      '        if (rawAttributes instanceof Map<?, ?> map) {',
      '            map.forEach((key, value) -> { if (value != null) attributes.put(String.valueOf(key), value); });',
      '        }',
      '        return new ' + m.Noun + 'Input(',
      '            String.valueOf(raw.getOrDefault("id", raw.getOrDefault("' + m.noun + 'Id", ""))),',
      '            ((Number) raw.getOrDefault("revision", 0)).longValue(),',
      '            String.valueOf(raw.getOrDefault("updatedAt", EPOCH)),',
      '            String.valueOf(raw.getOrDefault("source", "' + S + '")),',
      '            attributes,',
      '            traceId);',
      '    }',
    ];
  },
  function batch(m, P, C, S) {
    const ref = P.ref(m.name);
    return [
      '',
      '    /** Runs ' + m.verb + ' over a batch of ' + m.noun + 's. One failure does not sink the batch. */',
      '    private BatchOutcome ' + m.name + 'Batch(List<' + m.Noun + 'Input> items, String traceId) {',
      '        long startedAt = System.nanoTime();',
      '        BatchOutcome outcome = new BatchOutcome();',
      '        for (' + m.Noun + 'Input item : items) {',
      '            try {',
      '                if (isStale(item.updatedAt())) {',
      '                    outcome.skipped++;',
      '                    continue;',
      '                }',
      '                ' + ref + '(null, traceId);',
      '                outcome.processed++;',
      '            } catch (' + C + 'Exception error) {',
      '                outcome.failed++;',
      '                trace.warn(traceId, "' + m.verb + ' failed for ' + m.noun + ' " + item.id() + ": " + error.getMessage());',
      '            }',
      '        }',
      '        telemetry.timing("' + S + '.' + m.snake + '.batch_ms", (System.nanoTime() - startedAt) / 1_000_000L);',
      '        return outcome;',
      '    }',
    ];
  },
  function retry(m, P, C) {
    const ref = P.ref(m.name);
    const attempts = P.int(3, 5);
    return [
      '',
      '    /** Retries ' + m.verb + ' with capped backoff. ' + attempts + ' attempts, then we stop pretending. */',
      '    private ' + m.Noun + 'Input ' + m.name + 'WithRetry(' + m.Noun + 'Input input, String traceId) {',
      '        RuntimeException lastError = null;',
      '        for (int attempt = 1; attempt <= ' + attempts + '; attempt++) {',
      '            try {',
      '                return (' + m.Noun + 'Input) (Object) ' + ref + '(null, traceId);',
      '            } catch (' + C + 'Exception error) {',
      '                lastError = error;',
      '                long delay = Math.min(' + P.int(2, 8) * 1000 + 'L, ' + P.int(50, 250) + 'L << attempt);',
      '                trace.debug(traceId, "retrying ' + m.verb + ' in " + delay + "ms");',
      '                sleepQuietly(delay);',
      '            }',
      '        }',
      '        throw lastError != null ? lastError : new ' + C + 'Exception("' + m.snake + ' exhausted retries");',
      '    }',
    ];
  },
  function cached(m, P, C, S) {
    return [
      '',
      '    /** Memoizes ' + m.verb + ' per ' + m.noun + ' id for a short while. Short is relative. */',
      '    private Optional<' + m.Noun + 'Input> ' + m.name + 'Cached(String id, String traceId) {',
      '        String key = "' + S + ':' + m.noun + ':" + id;',
      '        MemoEntry hit = memo.get(key);',
      '        if (hit != null && hit.expiresAt() > System.currentTimeMillis()) {',
      '            telemetry.increment("' + S + '.memo.hit");',
      '            return Optional.of((' + m.Noun + 'Input) hit.value());',
      '        }',
      '        Optional<' + m.Noun + 'Input> fresh = load' + m.Noun + '(id, traceId);',
      '        fresh.ifPresent(value -> memo.put(key, new MemoEntry(value, System.currentTimeMillis() + policy.ttlMs())));',
      '        telemetry.increment("' + S + '.memo.miss");',
      '        return fresh;',
      '    }',
    ];
  },
  function publish(m, P, C, S) {
    return [
      '',
      '    /** Emits a ' + m.noun + ' event so downstream consumers can pretend to care. */',
      '    private void ' + m.name + 'Event(' + m.Noun + 'Input input, String traceId) {',
      '        DomainEvent event = new DomainEvent(',
      '            "' + S + '.' + m.noun + '.' + genSnake(m.verb) + '",',
      '            input.id(),',
      '            input.revision(),',
      '            Instant.now(),',
      '            traceId);',
      '        bus.publish(event);',
      '        trace.debug(traceId, "event published: " + event.type());',
      '    }',
    ];
  },
  function guard(m, P, C) {
    const adj = P.pick(GEN_ADJ_POOL);
    return [
      '',
      '    /** Guards ' + m.verb + ': a ' + adj + ' ' + m.noun + ' must not be touched again. */',
      '    private void assert' + m.Name + 'Allowed(' + m.Noun + 'Input input) {',
      '        if (isStale(input.updatedAt())) {',
      '            throw new ' + C + 'Exception("' + m.noun + ' " + input.id() + " is ' + adj + ' (revision " + input.revision() + ")");',
      '        }',
      '        if ("legacy".equals(input.source()) && !policy.allowLegacy()) {',
      '            throw new ' + C + 'Exception("legacy ' + m.noun + 's are read-only in this build");',
      '        }',
      '    }',
    ];
  },
];

function genLargeJavaClass(base, className, subject, verbs, targetLines) {
  const lines = genTrim(base);
  const closing = lines[lines.length - 1].trim() === '}' ? lines.pop() : '}';
  const P = genPlanner(className, subject, verbs, seedRng(className + subject));
  const S = genDotted(subject);
  const nounsUsed = new Set();
  lines.push(
    '',
    '    // ---- ' + subject + ' internals ----',
    '    // Everything below follows the same contract: trace, validate, do the thing, publish.',
    '    private static final String EPOCH = "1970-01-01T00:00:00Z";',
    '    private final TraceLog trace = new TraceLog("' + className + '");',
    '    private final InlineTelemetry telemetry = new InlineTelemetry();',
    '    private final DomainEventBus bus = new DomainEventBus();',
    '    private final Map<String, MemoEntry> memo = new HashMap<>();',
    '    private final Policy policy = new Policy(false, ' + P.int(50, 500) + ', ' + P.int(5, 60) + '_000L);',
    '',
    '    private boolean isStale(String updatedAt) {',
    '        return Duration.between(Instant.parse(updatedAt), Instant.now()).toMillis() > policy.ttlMs() * 10;',
    '    }',
    '',
    '    private static void sleepQuietly(long millis) {',
    '        try {',
    '            Thread.sleep(millis);',
    '        } catch (InterruptedException interrupted) {',
    '            Thread.currentThread().interrupt();',
    '        }',
    '    }',
  );
  while (lines.length < targetLines - 60) {
    const m = P.next();
    nounsUsed.add(m.Noun);
    const tpl = P.pick(JAVA_TEMPLATES);
    for (const l of tpl(m, P, className, S)) lines.push(l);
  }
  for (const Noun of nounsUsed) {
    lines.push(
      '',
      '    private Optional<' + Noun + 'Input> load' + Noun + '(String id, String traceId) {',
      '        trace.debug(traceId, "loading ' + Noun.toLowerCase() + ' " + id);',
      '        return Optional.of(new ' + Noun + 'Input(id, 0L, EPOCH, "' + S + '", Map.of(), traceId));',
      '    }',
    );
  }
  lines.push('', '    // ---- supporting types for the ' + subject + ' section ----');
  for (const Noun of nounsUsed) {
    lines.push('', '    record ' + Noun + 'Input(String id, long revision, String updatedAt, String source, Map<String, Object> attributes, String traceId) {}');
  }
  lines.push(
    '',
    '    static final class BatchOutcome {',
    '        int processed;',
    '        int skipped;',
    '        int failed;',
    '    }',
    '',
    '    record DomainEvent(String type, String id, long revision, Instant emittedAt, String traceId) {}',
    '',
    '    record MemoEntry(Object value, long expiresAt) {}',
    '',
    '    record Policy(boolean allowLegacy, int batchSize, long ttlMs) {}',
    '',
    '    static final class ' + className + 'Exception extends RuntimeException {',
    '        ' + className + 'Exception(String message) {',
    '            super(message);',
    '        }',
    '    }',
    '',
    '    static final class TraceLog {',
    '        private final String scope;',
    '        TraceLog(String scope) { this.scope = scope; }',
    '        void debug(String traceId, String message) {}',
    '        void warn(String traceId, String message) { System.err.println(scope + " [" + traceId + "] " + message); }',
    '    }',
    '',
    '    static final class InlineTelemetry {',
    '        void increment(String metric) {}',
    '        void timing(String metric, long ms) {}',
    '    }',
    '',
    '    static final class DomainEventBus {',
    '        void publish(DomainEvent event) {}',
    '    }',
    closing,
  );
  return lines.join('\n') + '\n';
}

/* ================= Rust ================= */

const RS_TEMPLATES = [
  function validate(m, P, C) {
    const n = P.int(12, 48);
    return [
      '',
      '    /// Validates the ' + m.noun + ' before ' + m.verb + ' runs. Rejects early, complains loudly.',
      '    fn ' + m.snake + '(&self, input: &' + m.Noun + 'Input, trace_id: u32) -> Result<(), ' + C + 'Error> {',
      '        if input.id.len() < 8 {',
      '            self.trace.warn(trace_id, "' + m.noun + ' id is too short to be real");',
      '            return Err(' + C + 'Error::Rejected("' + m.snake + ': id"));',
      '        }',
      '        if input.attributes.len() > ' + n + ' {',
      '            self.trace.warn(trace_id, "' + m.noun + ' carries too many attributes");',
      '            return Err(' + C + 'Error::Rejected("' + m.snake + ': attributes"));',
      '        }',
      '        Ok(())',
      '    }',
    ];
  },
  function normalize(m, P, C, S) {
    return [
      '',
      '    /// Normalizes a raw ' + m.noun + ' into the shape the rest of ' + C + ' expects.',
      '    fn ' + m.snake + '(&self, raw: &Raw' + m.Noun + ', trace_id: u32) -> ' + m.Noun + 'Input {',
      '        let mut attributes = heapless::Vec::new();',
      '        for (key, value) in raw.attributes.iter() {',
      '            if value.is_some() {',
      '                let _ = attributes.push((*key, value.unwrap_or(0)));',
      '            }',
      '        }',
      '        ' + m.Noun + 'Input {',
      '            id: raw.id,',
      '            revision: raw.revision.unwrap_or(0),',
      '            updated_at: raw.updated_at.unwrap_or(0),',
      '            source: raw.source.unwrap_or("' + S + '"),',
      '            attributes,',
      '            trace_id,',
      '        }',
      '    }',
    ];
  },
  function batch(m, P, C, S) {
    const ref = genSnake(P.ref(m.name));
    return [
      '',
      '    /// Runs ' + m.verb + ' over a batch of ' + m.noun + 's. One failure does not sink the batch.',
      '    pub fn ' + m.snake + '_batch(&mut self, items: &[' + m.Noun + 'Input], trace_id: u32) -> BatchOutcome {',
      '        let started = Instant::now();',
      '        let mut outcome = BatchOutcome::default();',
      '        for item in items {',
      '            if self.is_stale(item.updated_at) {',
      '                outcome.skipped += 1;',
      '                continue;',
      '            }',
      '            match self.' + ref + '_step(item, trace_id) {',
      '                Ok(()) => outcome.processed += 1,',
      '                Err(err) => {',
      '                    outcome.failed += 1;',
      '                    self.trace.warn(trace_id, "' + m.verb + ' failed for ' + m.noun + '");',
      '                    let _ = err;',
      '                }',
      '            }',
      '        }',
      '        self.telemetry.timing("' + S + '.' + m.snake + '.batch_ms", started.elapsed().as_millis() as u32);',
      '        outcome',
      '    }',
    ];
  },
  function retry(m, P, C) {
    const attempts = P.int(3, 5);
    return [
      '',
      '    /// Retries ' + m.verb + ' with capped backoff. ' + attempts + ' attempts, then we stop pretending.',
      '    pub async fn ' + m.snake + '_with_retry(&mut self, input: &' + m.Noun + 'Input, trace_id: u32) -> Result<(), ' + C + 'Error> {',
      '        let mut last = ' + C + 'Error::Exhausted("' + m.snake + '");',
      '        for attempt in 1..=' + attempts + 'u32 {',
      '            match self.' + m.snake + '_step(input, trace_id) {',
      '                Ok(()) => return Ok(()),',
      '                Err(err) => {',
      '                    last = err;',
      '                    let delay = core::cmp::min(' + P.int(2, 8) * 1000 + ', ' + P.int(50, 250) + ' << attempt);',
      '                    self.trace.debug(trace_id, "retrying ' + m.verb + '");',
      '                    Timer::after(Duration::from_millis(delay as u64)).await;',
      '                }',
      '            }',
      '        }',
      '        Err(last)',
      '    }',
    ];
  },
  function step(m, P, C, S) {
    return [
      '',
      '    /// One unit of ' + m.verb + ' work for a single ' + m.noun + '.',
      '    fn ' + m.snake + '_step(&mut self, input: &' + m.Noun + 'Input, trace_id: u32) -> Result<(), ' + C + 'Error> {',
      '        if input.source == "legacy" && !self.policy.allow_legacy {',
      '            return Err(' + C + 'Error::Rejected("legacy ' + m.noun + 's are read-only in this build"));',
      '        }',
      '        let digest = crc16(&input.id.as_bytes()[..core::cmp::min(8, input.id.len())]);',
      '        self.journal.push(JournalEntry { id_digest: digest, revision: input.revision, trace_id }).map_err(|_| ' + C + 'Error::Full)?;',
      '        self.telemetry.increment("' + S + '.' + m.snake + '.ok");',
      '        Ok(())',
      '    }',
    ];
  },
  function publish(m, P, C, S) {
    return [
      '',
      '    /// Emits a ' + m.noun + ' event so downstream consumers can pretend to care.',
      '    fn ' + m.snake + '_event(&mut self, input: &' + m.Noun + 'Input, trace_id: u32) {',
      '        let event = DomainEvent {',
      '            kind: EventKind::' + m.Verb + m.Noun + ',',
      '            revision: input.revision,',
      '            emitted_at: self.clock.now_ms(),',
      '            trace_id,',
      '        };',
      '        if self.events.push(event).is_err() {',
      '            self.trace.warn(trace_id, "event queue full, dropping ' + m.noun + ' event");',
      '        }',
      '    }',
    ];
  },
];

function genLargeRustModule(base, typeName, subject, verbs, targetLines) {
  const lines = genTrim(base);
  const P = genPlanner(typeName, subject, verbs, seedRng(typeName + subject));
  const S = genDotted(subject);
  const nounsUsed = new Set();
  const kinds = new Set();
  lines.push(
    '',
    '// ---- ' + subject + ' internals ----',
    '// Everything below follows the same contract: trace, validate, do the thing, publish.',
    '',
    'const JOURNAL_CAPACITY: usize = ' + P.int(16, 128) + ';',
    'const EVENT_CAPACITY: usize = ' + P.int(8, 32) + ';',
    '',
    '#[derive(Debug)]',
    'pub enum ' + typeName + 'Error {',
    '    Rejected(&\'static str),',
    '    Exhausted(&\'static str),',
    '    Full,',
    '}',
    '',
    '#[derive(Default, Debug, Clone, Copy)]',
    'pub struct BatchOutcome {',
    '    pub processed: u16,',
    '    pub skipped: u16,',
    '    pub failed: u16,',
    '}',
    '',
    '#[derive(Debug, Clone, Copy)]',
    'pub struct JournalEntry {',
    '    pub id_digest: u16,',
    '    pub revision: u32,',
    '    pub trace_id: u32,',
    '}',
    '',
    '#[derive(Debug, Clone, Copy)]',
    'pub struct Policy {',
    '    pub allow_legacy: bool,',
    '    pub batch_size: u16,',
    '    pub ttl_ms: u32,',
    '}',
    '',
    'pub struct TraceLog {',
    '    scope: &\'static str,',
    '}',
    '',
    'impl TraceLog {',
    '    pub const fn new(scope: &\'static str) -> Self {',
    '        Self { scope }',
    '    }',
    '    pub fn debug(&self, trace_id: u32, message: &str) {',
    '        defmt::debug!("{} [{}] {}", self.scope, trace_id, message);',
    '    }',
    '    pub fn warn(&self, trace_id: u32, message: &str) {',
    '        defmt::warn!("{} [{}] {}", self.scope, trace_id, message);',
    '    }',
    '}',
    '',
    '#[derive(Default)]',
    'pub struct InlineTelemetry {',
    '    counters: heapless::FnvIndexMap<&\'static str, u32, 32>,',
    '}',
    '',
    'impl InlineTelemetry {',
    '    pub fn increment(&mut self, metric: &\'static str) {',
    '        let entry = self.counters.entry(metric).or_insert(0);',
    '        if let Ok(entry) = entry {',
    '            *entry += 1;',
    '        }',
    '    }',
    '    pub fn timing(&mut self, _metric: &\'static str, _ms: u32) {}',
    '}',
    '',
    'pub struct MonotonicClock;',
    '',
    'impl MonotonicClock {',
    '    pub fn now_ms(&self) -> u64 {',
    '        Instant::now().as_millis()',
    '    }',
    '}',
    '',
    'fn crc16(bytes: &[u8]) -> u16 {',
    '    let mut crc: u16 = 0xFFFF;',
    '    for byte in bytes {',
    '        crc ^= (*byte as u16) << 8;',
    '        for _ in 0..8 {',
    '            crc = if crc & 0x8000 != 0 { (crc << 1) ^ 0x1021 } else { crc << 1 };',
    '        }',
    '    }',
    '    crc',
    '}',
    '',
    'pub struct ' + typeName + 'Pipeline {',
    '    trace: TraceLog,',
    '    telemetry: InlineTelemetry,',
    '    clock: MonotonicClock,',
    '    policy: Policy,',
    '    journal: heapless::Vec<JournalEntry, JOURNAL_CAPACITY>,',
    '    events: heapless::Vec<DomainEvent, EVENT_CAPACITY>,',
    '}',
    '',
    'impl ' + typeName + 'Pipeline {',
    '    pub const fn new() -> Self {',
    '        Self {',
    '            trace: TraceLog::new("' + typeName + '"),',
    '            telemetry: InlineTelemetry { counters: heapless::FnvIndexMap::new() },',
    '            clock: MonotonicClock,',
    '            policy: Policy { allow_legacy: false, batch_size: ' + P.int(8, 64) + ', ttl_ms: ' + P.int(5, 60) + '_000 },',
    '            journal: heapless::Vec::new(),',
    '            events: heapless::Vec::new(),',
    '        }',
    '    }',
    '',
    '    fn is_stale(&self, updated_at: u64) -> bool {',
    '        self.clock.now_ms().saturating_sub(updated_at) > (self.policy.ttl_ms as u64) * 10',
    '    }',
  );
  while (lines.length < targetLines - 70) {
    const m = P.next();
    nounsUsed.add(m.Noun);
    kinds.add(m.Verb + m.Noun);
    const tpl = P.pick(RS_TEMPLATES);
    for (const l of tpl(m, P, typeName, S)) lines.push(l);
  }
  lines.push('}', '', '// ---- supporting types for the ' + subject + ' section ----');
  for (const Noun of nounsUsed) {
    lines.push(
      '',
      '#[derive(Debug, Clone)]',
      'pub struct ' + Noun + 'Input {',
      '    pub id: &\'static str,',
      '    pub revision: u32,',
      '    pub updated_at: u64,',
      '    pub source: &\'static str,',
      '    pub attributes: heapless::Vec<(&\'static str, u32), 16>,',
      '    pub trace_id: u32,',
      '}',
      '',
      'pub struct Raw' + Noun + ' {',
      '    pub id: &\'static str,',
      '    pub revision: Option<u32>,',
      '    pub updated_at: Option<u64>,',
      '    pub source: Option<&\'static str>,',
      '    pub attributes: heapless::Vec<(&\'static str, Option<u32>), 16>,',
      '}',
    );
  }
  lines.push('', '#[derive(Debug, Clone, Copy, PartialEq, Eq)]', 'pub enum EventKind {');
  for (const k of kinds) lines.push('    ' + k + ',');
  lines.push(
    '}',
    '',
    '#[derive(Debug, Clone, Copy)]',
    'pub struct DomainEvent {',
    '    pub kind: EventKind,',
    '    pub revision: u32,',
    '    pub emitted_at: u64,',
    '    pub trace_id: u32,',
    '}',
    '',
    '#[cfg(test)]',
    'mod tests {',
    '    use super::*;',
    '',
    '    #[test]',
    '    fn crc16_matches_reference_vector() {',
    '        assert_eq!(crc16(b"123456789"), 0x29B1);',
    '    }',
    '',
    '    #[test]',
    '    fn pipeline_starts_empty() {',
    '        let pipeline = ' + typeName + 'Pipeline::new();',
    '        assert_eq!(pipeline.journal.len(), 0);',
    '        assert_eq!(pipeline.events.len(), 0);',
    '    }',
    '}',
  );
  return lines.join('\n') + '\n';
}

/* ================= Go ================= */

const GO_TEMPLATES = [
  function validate(m, P, C) {
    const n = P.int(12, 48);
    return [
      '',
      '// ' + m.name + ' validates the ' + m.noun + ' before ' + m.verb + ' runs. Rejects early, complains loudly.',
      'func (s *' + C + ') ' + m.name + '(input ' + m.Noun + 'Input, traceID string) error {',
      '    var issues []string',
      '    if len(input.ID) < 8 {',
      '        issues = append(issues, "' + m.noun + ' id is too short to be real")',
      '    }',
      '    if input.Revision < 0 {',
      '        issues = append(issues, "' + m.noun + ' revision cannot be negative")',
      '    }',
      '    if len(input.Attributes) > ' + n + ' {',
      '        issues = append(issues, "' + m.noun + ' carries more than ' + n + ' attributes")',
      '    }',
      '    if len(issues) > 0 {',
      '        s.trace.Warn(traceID, "' + m.noun + ' rejected: "+strings.Join(issues, "; "))',
      '        return fmt.Errorf("' + m.snake + ': %s: %w", strings.Join(issues, "; "), Err' + C + 'Rejected)',
      '    }',
      '    return nil',
      '}',
    ];
  },
  function normalize(m, P, C, S) {
    return [
      '',
      '// ' + m.name + ' normalizes a raw ' + m.noun + ' map into the shape the rest of ' + C + ' expects.',
      'func (s *' + C + ') ' + m.name + '(raw map[string]any, traceID string) ' + m.Noun + 'Input {',
      '    attributes := map[string]any{}',
      '    if nested, ok := raw["attributes"].(map[string]any); ok {',
      '        for key, value := range nested {',
      '            if value != nil {',
      '                attributes[key] = value',
      '            }',
      '        }',
      '    }',
      '    revision, _ := raw["revision"].(float64)',
      '    updatedAt, _ := raw["updated_at"].(string)',
      '    source, _ := raw["source"].(string)',
      '    if source == "" {',
      '        source = "' + S + '"',
      '    }',
      '    return ' + m.Noun + 'Input{',
      '        ID:         fmt.Sprint(raw["id"]),',
      '        Revision:   int64(revision),',
      '        UpdatedAt:  updatedAt,',
      '        Source:     source,',
      '        Attributes: attributes,',
      '        TraceID:    traceID,',
      '    }',
      '}',
    ];
  },
  function batch(m, P, C, S) {
    const ref = P.ref(m.name);
    return [
      '',
      '// ' + m.name + 'Batch runs ' + m.verb + ' over a batch of ' + m.noun + 's. One failure does not sink the batch.',
      'func (s *' + C + ') ' + m.name + 'Batch(ctx context.Context, items []' + m.Noun + 'Input, traceID string) BatchOutcome {',
      '    startedAt := time.Now()',
      '    var outcome BatchOutcome',
      '    for _, item := range items {',
      '        if ctx.Err() != nil {',
      '            break',
      '        }',
      '        if s.isStale(item.UpdatedAt) {',
      '            outcome.Skipped++',
      '            continue',
      '        }',
      '        if err := s.' + ref + 'Step(ctx, item.ID, traceID); err != nil {',
      '            outcome.Failed++',
      '            s.trace.Warn(traceID, "' + m.verb + ' failed for ' + m.noun + ' "+item.ID+": "+err.Error())',
      '            continue',
      '        }',
      '        outcome.Processed++',
      '    }',
      '    s.telemetry.Timing("' + S + '.' + m.snake + '.batch_ms", time.Since(startedAt))',
      '    return outcome',
      '}',
    ];
  },
  function retry(m, P, C) {
    const attempts = P.int(3, 5);
    return [
      '',
      '// ' + m.name + 'WithRetry retries ' + m.verb + ' with capped backoff. ' + attempts + ' attempts, then we stop pretending.',
      'func (s *' + C + ') ' + m.name + 'WithRetry(ctx context.Context, id string, traceID string) error {',
      '    var lastErr error',
      '    for attempt := 1; attempt <= ' + attempts + '; attempt++ {',
      '        lastErr = s.' + m.name + 'Step(ctx, id, traceID)',
      '        if lastErr == nil {',
      '            return nil',
      '        }',
      '        delay := time.Duration(' + P.int(50, 250) + '<<attempt) * time.Millisecond',
      '        if delay > ' + P.int(2, 8) + '*time.Second {',
      '            delay = ' + P.int(2, 8) + ' * time.Second',
      '        }',
      '        s.trace.Debug(traceID, "retrying ' + m.verb + ' in "+delay.String())',
      '        select {',
      '        case <-ctx.Done():',
      '            return ctx.Err()',
      '        case <-time.After(delay):',
      '        }',
      '    }',
      '    return fmt.Errorf("' + m.snake + ' exhausted retries: %w", lastErr)',
      '}',
    ];
  },
  function step(m, P, C, S) {
    return [
      '',
      '// ' + m.name + 'Step is one unit of ' + m.verb + ' work for a single ' + m.noun + '.',
      'func (s *' + C + ') ' + m.name + 'Step(ctx context.Context, id string, traceID string) error {',
      '    if err := ctx.Err(); err != nil {',
      '        return err',
      '    }',
      '    key := "' + S + ':' + m.noun + ':" + id',
      '    if entry, ok := s.memo[key]; ok && entry.expiresAt.After(time.Now()) {',
      '        s.telemetry.Increment("' + S + '.memo.hit")',
      '        return nil',
      '    }',
      '    s.memo[key] = memoEntry{value: id, expiresAt: time.Now().Add(s.policy.TTL)}',
      '    s.telemetry.Increment("' + S + '.' + m.snake + '.ok")',
      '    return nil',
      '}',
    ];
  },
  function publish(m, P, C, S) {
    return [
      '',
      '// ' + m.name + 'Event emits a ' + m.noun + ' event so downstream consumers can pretend to care.',
      'func (s *' + C + ') ' + m.name + 'Event(ctx context.Context, input ' + m.Noun + 'Input, traceID string) error {',
      '    event := DomainEvent{',
      '        Type:      "' + S + '.' + m.noun + '.' + genSnake(m.verb) + '",',
      '        ID:        input.ID,',
      '        Revision:  input.Revision,',
      '        EmittedAt: time.Now().UTC(),',
      '        TraceID:   traceID,',
      '    }',
      '    if err := s.bus.Publish(ctx, event); err != nil {',
      '        return fmt.Errorf("publish %s: %w", event.Type, err)',
      '    }',
      '    s.trace.Debug(traceID, "event published: "+event.Type)',
      '    return nil',
      '}',
    ];
  },
  function guard(m, P, C) {
    const adj = P.pick(GEN_ADJ_POOL);
    return [
      '',
      '// assert' + m.Name + 'Allowed guards ' + m.verb + ': a ' + adj + ' ' + m.noun + ' must not be touched again.',
      'func (s *' + C + ') assert' + m.Name + 'Allowed(input ' + m.Noun + 'Input) error {',
      '    if s.isStale(input.UpdatedAt) {',
      '        return fmt.Errorf("' + m.noun + ' %s is ' + adj + ' (revision %d): %w", input.ID, input.Revision, Err' + C + 'Rejected)',
      '    }',
      '    if input.Source == "legacy" && !s.policy.AllowLegacy {',
      '        return fmt.Errorf("legacy ' + m.noun + 's are read-only in this build: %w", Err' + C + 'Rejected)',
      '    }',
      '    return nil',
      '}',
    ];
  },
];

function genLargeGoFile(base, typeName, subject, verbs, targetLines) {
  const lines = genTrim(base);
  const P = genPlanner(typeName, subject, verbs, seedRng(typeName + subject));
  const S = genDotted(subject);
  const nounsUsed = new Set();
  lines.push(
    '',
    '// ---- ' + subject + ' internals ----',
    '// Everything below follows the same contract: trace, validate, do the thing, publish.',
    '',
    '// Err' + typeName + 'Rejected is returned when a ' + subject + ' input fails validation.',
    'var Err' + typeName + 'Rejected = errors.New("' + genSnake(subject) + ' rejected")',
    '',
    '// BatchOutcome counts what happened to one batch.',
    'type BatchOutcome struct {',
    '    Processed int',
    '    Skipped   int',
    '    Failed    int',
    '}',
    '',
    '// DomainEvent is the envelope every ' + subject + ' event travels in.',
    'type DomainEvent struct {',
    '    Type      string',
    '    ID        string',
    '    Revision  int64',
    '    EmittedAt time.Time',
    '    TraceID   string',
    '}',
    '',
    'type memoEntry struct {',
    '    value     any',
    '    expiresAt time.Time',
    '}',
    '',
    '// Policy holds the knobs nobody should turn without a ticket.',
    'type Policy struct {',
    '    AllowLegacy bool',
    '    BatchSize   int',
    '    TTL         time.Duration',
    '}',
    '',
    'type traceLog struct{ scope string }',
    '',
    'func (t traceLog) Debug(traceID, message string) {}',
    'func (t traceLog) Warn(traceID, message string)  { log.Printf("%s [%s] %s", t.scope, traceID, message) }',
    '',
    'type inlineTelemetry struct{}',
    '',
    'func (inlineTelemetry) Increment(metric string)                 {}',
    'func (inlineTelemetry) Timing(metric string, took time.Duration) {}',
    '',
    'type domainEventBus struct{}',
    '',
    'func (domainEventBus) Publish(ctx context.Context, event DomainEvent) error { return nil }',
    '',
    'func (s *' + typeName + ') isStale(updatedAt string) bool {',
    '    parsed, err := time.Parse(time.RFC3339, updatedAt)',
    '    if err != nil {',
    '        return true',
    '    }',
    '    return time.Since(parsed) > s.policy.TTL*10',
    '}',
  );
  while (lines.length < targetLines - 20) {
    const m = P.next();
    nounsUsed.add(m.Noun);
    const tpl = P.pick(GO_TEMPLATES);
    for (const l of tpl(m, P, typeName, S)) lines.push(l);
  }
  lines.push('', '// ---- supporting types for the ' + subject + ' section ----');
  for (const Noun of nounsUsed) {
    lines.push(
      '',
      '// ' + Noun + 'Input is the normalized ' + Noun.toLowerCase() + ' the pipeline works on.',
      'type ' + Noun + 'Input struct {',
      '    ID         string',
      '    Revision   int64',
      '    UpdatedAt  string',
      '    Source     string',
      '    Attributes map[string]any',
      '    TraceID    string',
      '}',
    );
  }
  return lines.join('\n') + '\n';
}

/* ================= C++ ================= */

const CPP_TEMPLATES = [
  function validate(m, P, C) {
    const n = P.int(12, 48);
    return [
      '',
      '// Validates the ' + m.noun + ' before ' + m.verb + ' runs. Rejects early, complains loudly.',
      'void ' + C + '::' + m.name + '(const ' + m.Noun + 'Input& input, TraceId trace_id) const {',
      '    std::vector<std::string> issues;',
      '    if (input.id.size() < 8) {',
      '        issues.emplace_back("' + m.noun + ' id is too short to be real");',
      '    }',
      '    if (input.revision < 0) {',
      '        issues.emplace_back("' + m.noun + ' revision cannot be negative");',
      '    }',
      '    if (input.attributes.size() > ' + n + ') {',
      '        issues.emplace_back("' + m.noun + ' carries more than ' + n + ' attributes");',
      '    }',
      '    if (!issues.empty()) {',
      '        trace_.warn(trace_id, "' + m.noun + ' rejected: " + join(issues, "; "));',
      '        throw ' + C + 'Error("' + m.snake + ': " + join(issues, "; "));',
      '    }',
      '}',
    ];
  },
  function normalize(m, P, C, S) {
    return [
      '',
      '// Normalizes a raw ' + m.noun + ' into the shape the rest of ' + C + ' expects.',
      m.Noun + 'Input ' + C + '::' + m.name + '(const RawRecord& raw, TraceId trace_id) const {',
      '    ' + m.Noun + 'Input input;',
      '    input.id = raw.get_or("id", raw.get_or("' + m.noun + '_id", ""));',
      '    input.revision = raw.get_or<std::int64_t>("revision", 0);',
      '    input.updated_at = raw.get_or("updated_at", kEpoch);',
      '    input.source = raw.get_or("source", "' + S + '");',
      '    for (const auto& [key, value] : raw.attributes()) {',
      '        if (value.has_value()) {',
      '            input.attributes.emplace(key, *value);',
      '        }',
      '    }',
      '    input.trace_id = trace_id;',
      '    return input;',
      '}',
    ];
  },
  function batch(m, P, C, S) {
    const ref = P.ref(m.name);
    return [
      '',
      '// Runs ' + m.verb + ' over a batch of ' + m.noun + 's. One failure does not sink the batch.',
      'BatchOutcome ' + C + '::' + m.name + 'Batch(std::span<const ' + m.Noun + 'Input> items, TraceId trace_id) {',
      '    const auto started_at = std::chrono::steady_clock::now();',
      '    BatchOutcome outcome;',
      '    for (const auto& item : items) {',
      '        try {',
      '            if (isStale(item.updated_at)) {',
      '                ++outcome.skipped;',
      '                continue;',
      '            }',
      '            ' + ref + 'Step(item.id, trace_id);',
      '            ++outcome.processed;',
      '        } catch (const ' + C + 'Error& error) {',
      '            ++outcome.failed;',
      '            trace_.warn(trace_id, "' + m.verb + ' failed for ' + m.noun + ' " + item.id + ": " + error.what());',
      '        }',
      '    }',
      '    telemetry_.timing("' + S + '.' + m.snake + '.batch_ms", std::chrono::steady_clock::now() - started_at);',
      '    return outcome;',
      '}',
    ];
  },
  function retry(m, P, C) {
    const attempts = P.int(3, 5);
    return [
      '',
      '// Retries ' + m.verb + ' with capped backoff. ' + attempts + ' attempts, then we stop pretending.',
      'void ' + C + '::' + m.name + 'WithRetry(const std::string& id, TraceId trace_id) {',
      '    std::exception_ptr last_error;',
      '    for (int attempt = 1; attempt <= ' + attempts + '; ++attempt) {',
      '        try {',
      '            ' + m.name + 'Step(id, trace_id);',
      '            return;',
      '        } catch (const ' + C + 'Error&) {',
      '            last_error = std::current_exception();',
      '            const auto delay = std::min(std::chrono::milliseconds(' + P.int(2, 8) * 1000 + '), std::chrono::milliseconds(' + P.int(50, 250) + ' << attempt));',
      '            trace_.debug(trace_id, "retrying ' + m.verb + '");',
      '            std::this_thread::sleep_for(delay);',
      '        }',
      '    }',
      '    if (last_error) {',
      '        std::rethrow_exception(last_error);',
      '    }',
      '    throw ' + C + 'Error("' + m.snake + ' exhausted retries");',
      '}',
    ];
  },
  function step(m, P, C, S) {
    return [
      '',
      '// One unit of ' + m.verb + ' work for a single ' + m.noun + '.',
      'void ' + C + '::' + m.name + 'Step(const std::string& id, TraceId trace_id) {',
      '    const std::string key = "' + S + ':' + m.noun + ':" + id;',
      '    if (auto hit = memo_.find(key); hit != memo_.end() && hit->second.expires_at > std::chrono::steady_clock::now()) {',
      '        telemetry_.increment("' + S + '.memo.hit");',
      '        return;',
      '    }',
      '    memo_[key] = MemoEntry{id, std::chrono::steady_clock::now() + policy_.ttl};',
      '    telemetry_.increment("' + S + '.' + m.snake + '.ok");',
      '    (void)trace_id;',
      '}',
    ];
  },
  function publish(m, P, C, S) {
    return [
      '',
      '// Emits a ' + m.noun + ' event so downstream consumers can pretend to care.',
      'void ' + C + '::' + m.name + 'Event(const ' + m.Noun + 'Input& input, TraceId trace_id) {',
      '    DomainEvent event;',
      '    event.type = "' + S + '.' + m.noun + '.' + genSnake(m.verb) + '";',
      '    event.id = input.id;',
      '    event.revision = input.revision;',
      '    event.emitted_at = std::chrono::system_clock::now();',
      '    event.trace_id = trace_id;',
      '    bus_.publish(std::move(event));',
      '    trace_.debug(trace_id, "event published");',
      '}',
    ];
  },
  function guard(m, P, C) {
    const adj = P.pick(GEN_ADJ_POOL);
    return [
      '',
      '// Guards ' + m.verb + ': a ' + adj + ' ' + m.noun + ' must not be touched again.',
      'void ' + C + '::assert' + m.Name + 'Allowed(const ' + m.Noun + 'Input& input) const {',
      '    if (isStale(input.updated_at)) {',
      '        throw ' + C + 'Error("' + m.noun + ' " + input.id + " is ' + adj + ' (revision " + std::to_string(input.revision) + ")");',
      '    }',
      '    if (input.source == "legacy" && !policy_.allow_legacy) {',
      '        throw ' + C + 'Error("legacy ' + m.noun + 's are read-only in this build");',
      '    }',
      '}',
    ];
  },
];

function genLargeCppFile(base, className, subject, verbs, targetLines) {
  const lines = genTrim(base);
  const P = genPlanner(className, subject, verbs, seedRng(className + subject));
  const S = genDotted(subject);
  const nounsUsed = new Set();
  const ns = (base.match(/^namespace\s+([\w:]+)\s*\{/m) || [])[1];
  // close an open namespace so the generated section can reopen it cleanly
  const closesNs = ns && /^\}\s*\/\/\s*namespace/m.test(base);
  if (ns && closesNs) {
    const idx = lines.map(l => l.trim()).lastIndexOf(lines.map(l => l.trim()).filter(l => /^\}\s*\/\/\s*namespace/.test(l)).pop());
    if (idx >= 0) lines.splice(idx, 1);
  }
  lines.push(
    '',
    '// ---- ' + subject + ' internals ----',
    '// Everything below follows the same contract: trace, validate, do the thing, publish.',
    '',
    'namespace {',
    '',
    'constexpr const char* kEpoch = "1970-01-01T00:00:00Z";',
    '',
    'std::string join(const std::vector<std::string>& parts, const char* sep) {',
    '    std::string out;',
    '    for (std::size_t i = 0; i < parts.size(); ++i) {',
    '        if (i) out += sep;',
    '        out += parts[i];',
    '    }',
    '    return out;',
    '}',
    '',
    '}  // namespace',
    '',
    className + 'Error::' + className + 'Error(std::string message) : std::runtime_error(std::move(message)) {}',
    '',
    'bool ' + className + '::isStale(const std::string& updated_at) const {',
    '    // ISO-8601 strings sort lexicographically; we exploit that and feel only mildly guilty.',
    '    return updated_at < policy_.stale_before;',
    '}',
  );
  while (lines.length < targetLines - 45) {
    const m = P.next();
    nounsUsed.add(m.Noun);
    const tpl = P.pick(CPP_TEMPLATES);
    for (const l of tpl(m, P, className, S)) lines.push(l);
  }
  lines.push('', '// ---- supporting definitions for the ' + subject + ' section ----');
  lines.push(
    '',
    'void TraceLog::debug(TraceId, const std::string&) const {}',
    '',
    'void TraceLog::warn(TraceId trace_id, const std::string& message) const {',
    '    std::fprintf(stderr, "%s [%u] %s\\n", scope_.c_str(), static_cast<unsigned>(trace_id), message.c_str());',
    '}',
    '',
    'void InlineTelemetry::increment(std::string_view) {}',
    '',
    'void InlineTelemetry::timing(std::string_view, std::chrono::steady_clock::duration) {}',
    '',
    'void DomainEventBus::publish(DomainEvent event) {',
    '    std::lock_guard<std::mutex> lock(mutex_);',
    '    pending_.push_back(std::move(event));',
    '    if (pending_.size() > ' + P.int(256, 4096) + ') {',
    '        pending_.pop_front();  // the oldest event has served its purpose: being old',
    '    }',
    '}',
  );
  if (ns && closesNs) lines.push('', '}  // namespace ' + ns);
  return lines.join('\n') + '\n';
}

/* ================= SQL ================= */

const SQL_COLUMN_POOL = [
  ['external_ref', 'VARCHAR(64)'], ['status', "VARCHAR(16) NOT NULL DEFAULT 'pending'"], ['amount_minor', 'BIGINT NOT NULL DEFAULT 0'],
  ['currency', "CHAR(3) NOT NULL DEFAULT 'EUR'"], ['payload', 'JSONB NOT NULL DEFAULT \'{}\'::jsonb'], ['attempts', 'INTEGER NOT NULL DEFAULT 0'],
  ['scheduled_for', 'TIMESTAMPTZ'], ['completed_at', 'TIMESTAMPTZ'], ['owner_id', 'VARCHAR(64)'], ['region', "VARCHAR(8) NOT NULL DEFAULT 'eu-1'"],
  ['checksum', 'VARCHAR(64)'], ['version', 'INTEGER NOT NULL DEFAULT 1'], ['notes', 'TEXT'], ['priority', 'SMALLINT NOT NULL DEFAULT 5'],
  ['expires_at', 'TIMESTAMPTZ'], ['source_system', "VARCHAR(32) NOT NULL DEFAULT 'core'"],
];

function genLargeSql(base, schema, nouns, targetLines) {
  const lines = genTrim(base);
  const rng = seedRng(schema + nouns.join(','));
  const pick = arr => arr[Math.floor(rng() * arr.length)];
  const int = (lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));
  let round = 0;
  const tables = nouns.map(n => genSnake(n));
  const created = new Set();
  const comments = [
    'Reviewed by two people and one very tired DBA.',
    'Indexed because the dashboard query was taking a coffee break.',
    'Nullable on purpose. Ask before you change that.',
    'Partial index: only the rows anyone actually queries.',
    'Backfilled by a script that ran once and was never seen again.',
    'Constraint added after the incident. You know the one.',
    'Kept for audit. Regulators love a good timestamp.',
  ];
  while (lines.length < targetLines - 6) {
    const t = tables[round % tables.length];
    const pass = Math.floor(round / tables.length);
    round += 1;
    if (pass === 0) {
      created.add(t);
      const cols = [];
      const pool = SQL_COLUMN_POOL.slice();
      const n = int(4, 8);
      for (let i = 0; i < n && pool.length; i++) cols.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]);
      lines.push('', '-- ' + t + ': ' + pick(comments), 'CREATE TABLE IF NOT EXISTS ' + schema + '.' + t + ' (', '    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,', '    ' + t + '_ref VARCHAR(64) NOT NULL UNIQUE,');
      for (const [name, type] of cols) lines.push('    ' + name + ' ' + type + ',');
      lines.push('    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),', '    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()', ');', '', 'CREATE INDEX IF NOT EXISTS idx_' + t + '_created', '    ON ' + schema + '.' + t + ' (created_at DESC);');
    } else if (pass === 1) {
      const col = pick(SQL_COLUMN_POOL)[0];
      lines.push('', '-- ' + pick(comments), 'CREATE INDEX IF NOT EXISTS idx_' + t + '_' + col, '    ON ' + schema + '.' + t + ' (' + col + ')', "    WHERE " + col + ' IS NOT NULL;');
    } else if (pass === 2) {
      const other = pick(tables.filter(x => x !== t));
      lines.push('', 'ALTER TABLE ' + schema + '.' + t, '    ADD COLUMN IF NOT EXISTS ' + other + '_id BIGINT REFERENCES ' + schema + '.' + other + ' (id);', '', "COMMENT ON COLUMN " + schema + '.' + t + '.' + other + "_id IS '" + pick(comments).replace(/'/g, "''") + "';");
    } else if (pass === 3) {
      lines.push('', 'CREATE OR REPLACE FUNCTION ' + schema + '.touch_' + t + '() RETURNS trigger AS $$', 'BEGIN', '    NEW.updated_at = now();', '    RETURN NEW;', 'END;', "$$ LANGUAGE plpgsql;", '', 'DROP TRIGGER IF EXISTS trg_touch_' + t + ' ON ' + schema + '.' + t + ';', 'CREATE TRIGGER trg_touch_' + t, '    BEFORE UPDATE ON ' + schema + '.' + t, '    FOR EACH ROW EXECUTE FUNCTION ' + schema + '.touch_' + t + '();');
    } else {
      lines.push('', '-- nightly reconciliation view for ' + t, 'CREATE OR REPLACE VIEW ' + schema + '.v_' + t + '_daily AS', 'SELECT', "    date_trunc('day', created_at) AS day,", '    count(*) AS rows_created,', "    count(*) FILTER (WHERE status = 'failed') AS rows_failed", 'FROM ' + schema + '.' + t, 'GROUP BY 1;');
    }
  }
  if (!/^COMMIT;/m.test(base)) lines.push('', 'COMMIT;');
  return lines.join('\n') + '\n';
}

/* ================= Terraform ================= */

const TF_RESOURCES = {
  vpc: ['aws_vpc', ['cidr_block           = "10.{n}.0.0/16"', 'enable_dns_hostnames = true', 'enable_dns_support   = true']],
  subnet: ['aws_subnet', ['vpc_id            = aws_vpc.main.id', 'cidr_block        = "10.{n}.{n}.0/24"', 'availability_zone = local.azs[{i}]', 'map_public_ip_on_launch = false']],
  eks: ['aws_eks_cluster', ['role_arn = aws_iam_role.eks.arn', 'version  = var.eks_version', '', 'vpc_config {', '  subnet_ids = local.private_subnet_ids', '}']],
  nodegroup: ['aws_eks_node_group', ['cluster_name    = aws_eks_cluster.main.name', 'node_role_arn   = aws_iam_role.nodes.arn', 'subnet_ids      = local.private_subnet_ids', 'instance_types  = ["m6i.xlarge"]', '', 'scaling_config {', '  desired_size = {n}', '  max_size     = {n2}', '  min_size     = 2', '}']],
  rds: ['aws_db_instance', ['engine                 = "postgres"', 'engine_version         = "16.3"', 'instance_class         = "db.r6g.large"', 'allocated_storage      = {n}0', 'multi_az               = true', 'skip_final_snapshot    = false', 'deletion_protection    = true']],
  redis: ['aws_elasticache_replication_group', ['engine               = "redis"', 'node_type            = "cache.r6g.large"', 'num_cache_clusters   = 2', 'automatic_failover_enabled = true', 'at_rest_encryption_enabled = true']],
  alb: ['aws_lb', ['load_balancer_type = "application"', 'internal           = false', 'security_groups    = [aws_security_group.alb.id]', 'subnets            = local.public_subnet_ids', 'idle_timeout       = {n}']],
  waf: ['aws_wafv2_web_acl', ['scope = "REGIONAL"', '', 'default_action {', '  allow {}', '}', '', 'visibility_config {', '  cloudwatch_metrics_enabled = true', '  metric_name                = "{name}"', '  sampled_requests_enabled   = true', '}']],
  s3: ['aws_s3_bucket', ['bucket        = "{project}-{name}-{n}"', 'force_destroy = false']],
  iam: ['aws_iam_role', ['assume_role_policy = data.aws_iam_policy_document.{name}_assume.json', 'max_session_duration = 3600']],
  kms: ['aws_kms_key', ['description             = "{name} encryption key"', 'deletion_window_in_days = 30', 'enable_key_rotation     = true']],
  cloudwatch: ['aws_cloudwatch_metric_alarm', ['comparison_operator = "GreaterThanThreshold"', 'evaluation_periods  = 3', 'metric_name         = "CPUUtilization"', 'namespace           = "AWS/EKS"', 'period              = 60', 'statistic           = "Average"', 'threshold           = {n}', 'alarm_actions       = [aws_sns_topic.alerts.arn]']],
  sqs: ['aws_sqs_queue', ['visibility_timeout_seconds = {n}0', 'message_retention_seconds  = 345600', 'kms_master_key_id          = aws_kms_key.main.arn']],
  sg: ['aws_security_group', ['vpc_id = aws_vpc.main.id', '', 'ingress {', '  from_port   = 443', '  to_port     = 443', '  protocol    = "tcp"', '  cidr_blocks = [var.allowed_cidr]', '}', '', 'egress {', '  from_port   = 0', '  to_port     = 0', '  protocol    = "-1"', '  cidr_blocks = ["0.0.0.0/0"]', '}']],
};

function genLargeTerraform(base, project, nouns, targetLines) {
  const lines = genTrim(base);
  const rng = seedRng(project + nouns.join(','));
  const int = (lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));
  const kinds = Object.keys(TF_RESOURCES);
  const comments = ['Do not rename: the state file remembers everything.', 'Sized for last year\'s traffic plus the marketing campaign nobody told us about.', 'Reviewed in a meeting that could have been an email.', 'Tagged for cost allocation, which is finance-speak for blame.', 'Terraform plan says 0 to destroy. We check twice anyway.'];
  let i = 0;
  while (lines.length < targetLines - 20) {
    const noun = nouns[i % nouns.length];
    const pass = Math.floor(i / nouns.length);
    const name = genSnake(noun);
    const kindKey = kinds.find(k => name.includes(k)) || kinds[i % kinds.length];
    const [type, body] = TF_RESOURCES[kindKey];
    i += 1;
    if (pass === 0) {
      lines.push('', '# ' + noun + ' — ' + comments[Math.floor(rng() * comments.length)], 'resource "' + type + '" "' + name + '" {');
      for (const b of body) {
        lines.push(b ? '  ' + b.replace(/\{n2\}/g, String(int(4, 12))).replace(/\{n\}/g, String(int(1, 9))).replace(/\{i\}/g, String(int(0, 2))).replace(/\{name\}/g, name).replace(/\{project\}/g, project) : '');
      }
      lines.push('', '  tags = merge(local.tags, {', '    Name      = "' + project + '-' + name + '"', '    Component = "' + noun + '"', '  })', '}');
    } else if (pass === 1) {
      lines.push('', 'variable "' + name + '_enabled" {', '  description = "Whether the ' + noun + ' stack is provisioned in this environment."', '  type        = bool', '  default     = ' + (rng() > 0.3 ? 'true' : 'false'), '}', '', 'output "' + name + '_id" {', '  description = "Identifier of the ' + noun + ' resource."', '  value       = ' + type + '.' + name + '.id', '}');
    } else if (pass === 2) {
      lines.push('', 'data "aws_iam_policy_document" "' + name + '_assume" {', '  statement {', '    actions = ["sts:AssumeRole"]', '    principals {', '      type        = "Service"', '      identifiers = ["' + (rng() > 0.5 ? 'eks' : 'ec2') + '.amazonaws.com"]', '    }', '  }', '}');
    } else {
      lines.push('', 'module "' + name + '_monitoring" {', '  source  = "../../modules/monitoring"', '  name    = "' + project + '-' + name + '"', '  arn     = ' + type + '.' + name + '.arn', '  alarm_topic = aws_sns_topic.alerts.arn', '  thresholds = {', '    warning  = ' + int(60, 75), '    critical = ' + int(85, 95), '  }', '}');
    }
  }
  return lines.join('\n') + '\n';
}

/* ================= Kubernetes manifests ================= */

function genLargeK8sManifests(base, appName, services, targetLines) {
  const lines = genTrim(base);
  const rng = seedRng(appName + services.join(','));
  const int = (lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));
  let i = 0;
  while (lines.length < targetLines - 10) {
    const svc = services[i % services.length];
    const pass = Math.floor(i / services.length);
    i += 1;
    const full = appName + '-' + svc;
    if (pass === 0) {
      const port = int(8000, 9000);
      lines.push('---', 'apiVersion: apps/v1', 'kind: Deployment', 'metadata:', '  name: ' + full, '  namespace: ' + appName, '  labels:', '    app.kubernetes.io/name: ' + full, '    app.kubernetes.io/part-of: ' + appName, 'spec:', '  replicas: ' + int(2, 6), '  revisionHistoryLimit: 5', '  selector:', '    matchLabels:', '      app.kubernetes.io/name: ' + full, '  strategy:', '    type: RollingUpdate', '    rollingUpdate:', '      maxSurge: 1', '      maxUnavailable: 0', '  template:', '    metadata:', '      labels:', '        app.kubernetes.io/name: ' + full, '      annotations:', '        prometheus.io/scrape: "true"', '        prometheus.io/port: "' + port + '"', '    spec:', '      serviceAccountName: ' + full, '      containers:', '        - name: ' + svc, '          image: registry.internal.corp/' + appName + '/' + svc + ':1.' + int(0, 40) + '.' + int(0, 9), '          ports:', '            - name: http', '              containerPort: ' + port, '          envFrom:', '            - configMapRef:', '                name: ' + full + '-config', '          resources:', '            requests:', '              cpu: ' + int(100, 500) + 'm', '              memory: ' + int(128, 512) + 'Mi', '            limits:', '              cpu: "' + int(1, 2) + '"', '              memory: ' + int(512, 2048) + 'Mi', '          readinessProbe:', '            httpGet:', '              path: /healthz', '              port: http', '            initialDelaySeconds: 5', '            periodSeconds: 10', '          livenessProbe:', '            httpGet:', '              path: /livez', '              port: http', '            periodSeconds: 20', '            failureThreshold: 3  # three strikes, then kubelet gets involved');
    } else if (pass === 1) {
      lines.push('---', 'apiVersion: v1', 'kind: Service', 'metadata:', '  name: ' + full, '  namespace: ' + appName, 'spec:', '  type: ClusterIP', '  selector:', '    app.kubernetes.io/name: ' + full, '  ports:', '    - name: http', '      port: 80', '      targetPort: http');
    } else if (pass === 2) {
      lines.push('---', 'apiVersion: v1', 'kind: ConfigMap', 'metadata:', '  name: ' + full + '-config', '  namespace: ' + appName, 'data:', '  LOG_LEVEL: "info"', '  LOG_FORMAT: "json"', '  METRICS_ENABLED: "true"', '  UPSTREAM_TIMEOUT_MS: "' + int(500, 4000) + '"', '  FEATURE_' + svc.toUpperCase() + '_V2: "' + (rng() > 0.5 ? 'true' : 'false') + '"  # flip with care');
    } else if (pass === 3) {
      lines.push('---', 'apiVersion: autoscaling/v2', 'kind: HorizontalPodAutoscaler', 'metadata:', '  name: ' + full, '  namespace: ' + appName, 'spec:', '  scaleTargetRef:', '    apiVersion: apps/v1', '    kind: Deployment', '    name: ' + full, '  minReplicas: 2', '  maxReplicas: ' + int(6, 20), '  metrics:', '    - type: Resource', '      resource:', '        name: cpu', '        target:', '          type: Utilization', '          averageUtilization: ' + int(55, 75));
    } else {
      lines.push('---', 'apiVersion: policy/v1', 'kind: PodDisruptionBudget', 'metadata:', '  name: ' + full, '  namespace: ' + appName, 'spec:', '  minAvailable: 1', '  selector:', '    matchLabels:', '      app.kubernetes.io/name: ' + full);
    }
  }
  return lines.join('\n') + '\n';
}

/* ================= boilerplate helpers ================= */

function genDockerfile(base, runLines, cmd) {
  const lines = ['FROM ' + base, '', 'WORKDIR /app', 'COPY . .', ''];
  for (const r of runLines) lines.push('RUN ' + r);
  lines.push('', 'CMD ' + cmd, '');
  return lines.join('\n');
}

function genPackageJson(name, version, deps, scripts) {
  const scr = scripts || [['dev', 'vite --host'], ['build', 'vite build'], ['test', 'jest --colors'], ['lint', 'eslint src']];
  const lines = ['{', '  "name": "' + name + '",', '  "version": "' + version + '",', '  "private": true,', '  "scripts": {'];
  scr.forEach((s, i) => lines.push('    "' + s[0] + '": "' + s[1] + '"' + (i < scr.length - 1 ? ',' : '')));
  lines.push('  },', '  "dependencies": {');
  deps.forEach((dep, i) => lines.push('    "' + dep[0] + '": "' + dep[1] + '"' + (i < deps.length - 1 ? ',' : '')));
  lines.push('  }', '}', '');
  return lines.join('\n');
}

function genTsconfig() {
  return ['{', '  "compilerOptions": {', '    "target": "ES2022",', '    "module": "ESNext",', '    "moduleResolution": "bundler",', '    "strict": true,', '    "noUncheckedIndexedAccess": true,', '    "skipLibCheck": true,', '    "outDir": "dist"', '  },', '  "include": ["src"]', '}', ''].join('\n');
}

function genReadme(project, desc, stack) {
  return ['# ' + project, '', desc, '', '## Stack', '', stack.map(s => '- ' + s).join('\n'), '', '## Development', '', 'See the internal wiki for onboarding. Ask in #' + project + '-dev before touching prod config.', '', '> "It works on my machine" is a confession, not a defense.', ''].join('\n');
}

function genEnv(vars) {
  return vars.map(v => v[0] + '=' + v[1]).join('\n') + '\n# real values live in the vault. obviously.\n';
}

function genCi(project) {
  return ['name: ci', '', 'on:', '  pull_request:', '  push:', '    branches: [main]', '', 'jobs:', '  checks:', '    runs-on: ubuntu-latest', '    steps:', '      - uses: actions/checkout@v4', '      - uses: actions/setup-node@v4', '        with:', '          node-version: 20', '      - run: npm ci', '      - run: npm run lint', '      - run: npm test', '      # ' + project + ': keep this green or the merge queue keeps you', ''].join('\n');
}

function genSpec(subject, importPath, cases) {
  const lines = ["import { " + subject + " } from '" + importPath + "';", '', "describe('" + subject + "', () => {"];
  for (const c of cases) {
    lines.push("  it('" + c + "', () => {", '    // arranged, acted, asserted. the holy trinity.', '    expect(true).toBe(true);', '  });', '');
  }
  lines.push('});', '');
  return lines.join('\n');
}

function genPyTest(module, cases) {
  const lines = ['import pytest', '', 'from ' + module + ' import *', ''];
  for (const c of cases) {
    lines.push('def test_' + c + '():', '    # arranged, acted, asserted. the holy trinity.', '    assert True', '');
  }
  return lines.join('\n');
}

function genGitignore(kind) {
  const common = ['# OS', '.DS_Store', 'Thumbs.db', '', '# editors', '.idea/', '.vscode/*', '!.vscode/settings.json', ''];
  const per = {
    node: ['node_modules/', 'dist/', 'coverage/', '.env', '*.log'],
    python: ['__pycache__/', '*.pyc', '.venv/', '.pytest_cache/', '.mypy_cache/', 'artifacts/', '.env'],
    rust: ['target/', '*.bin', '*.elf', '.embed.local.toml'],
    go: ['bin/', 'vendor/', '*.test', 'coverage.out'],
    java: ['target/', '*.class', '*.jar', '.mvn/wrapper/*.jar'],
    cpp: ['build/', 'cmake-build-*/', 'compile_commands.json', '*.o', 'vcpkg_installed/'],
    mobile: ['node_modules/', 'ios/Pods/', 'ios/build/', 'android/build/', 'android/app/build/', '*.keystore', '.env'],
    terraform: ['.terraform/', '*.tfstate', '*.tfstate.backup', '.terraform.lock.hcl', 'crash.log'],
  };
  return common.concat(['# ' + kind], per[kind] || per.node, ['']).join('\n');
}

function genEditorconfig() {
  return ['root = true', '', '[*]', 'charset = utf-8', 'end_of_line = lf', 'insert_final_newline = true', 'trim_trailing_whitespace = true', 'indent_style = space', 'indent_size = 2', '', '[*.{py,java,go,rs,cpp,hpp,c,h}]', 'indent_size = 4', '', '[Makefile]', 'indent_style = tab', ''].join('\n');
}
