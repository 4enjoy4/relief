
'use strict';

/* ================= helpers ================= */
const sleep = ms => new Promise(r => setTimeout(r, ms));
const rand = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const pick = arr => arr[rand(0, arr.length - 1)];
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }

/* ================= syntax highlighting ================= */
const RULES = {
  ts: [
    [/\/\/.*/, 'com'],
    [/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/, 'str'],
    [/@[A-Za-z_]\w*/, 'dec'],
    [/\b(?:import|from|export|default|const|let|var|function|return|if|else|for|of|in|while|do|new|class|interface|type|extends|implements|async|await|try|catch|finally|throw|this|super|private|public|protected|readonly|static|enum|switch|case|break|continue|null|undefined|true|false|void|never|any|string|number|boolean|unknown|as|is|get|set|instanceof|typeof|keyof)\b/, 'kw'],
    [/\b\d[\d_]*(?:\.\d+)?\b/, 'num'],
    [/\b[A-Za-z_$][\w$]*(?=\s*\()/, 'fn'],
  ],
  py: [
    [/#.*/, 'com'],
    [/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/, 'str'],
    [/@[A-Za-z_][\w.]*/, 'dec'],
    [/\b(?:def|return|import|from|class|if|elif|else|for|while|try|except|finally|with|as|lambda|None|True|False|self|raise|pass|async|await|yield|in|not|and|or|is|global|del|dict|list|str|int|float|bool|print)\b/, 'kw'],
    [/\b\d[\d_]*(?:\.\d+)?\b/, 'num'],
    [/\b[A-Za-z_]\w*(?=\s*\()/, 'fn'],
  ],
  yml: [
    [/#.*/, 'com'],
    [/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/, 'str'],
    [/^\s*(?:-\s+)?[\w.$-]+(?=:)/, 'key'],
    [/\$[A-Z_][A-Z0-9_]*/, 'dec'],
    [/\b\d[\d_]*(?:\.\d+)?\b/, 'num'],
    [/\b(?:true|false|null|on|off|manual)\b/, 'kw'],
  ],
  json: [
    [/"(?:[^"\\]|\\.)*"(?=\s*:)/, 'key'],
    [/"(?:[^"\\]|\\.)*"/, 'str'],
    [/\b\d[\d_]*(?:\.\d+)?\b/, 'num'],
    [/\b(?:true|false|null)\b/, 'kw'],
  ],
  sql: [
    [/--.*/, 'com'],
    [/'(?:[^'\\]|\\.)*'/, 'str'],
    [/\b(?:SELECT|FROM|WHERE|INSERT|INTO|VALUES|UPDATE|SET|DELETE|CREATE|TABLE|INDEX|ALTER|ADD|COLUMN|PRIMARY|KEY|FOREIGN|REFERENCES|NOT|NULL|DEFAULT|UNIQUE|CONSTRAINT|CHECK|DECIMAL|NUMERIC|VARCHAR|TEXT|TIMESTAMPTZ|TIMESTAMP|BOOLEAN|BIGINT|SERIAL|BEGIN|COMMIT|ROLLBACK|TRANSACTION|IF|EXISTS|ON|AND|OR|IN|AS|JOIN|LEFT|INNER|GROUP|BY|ORDER|HAVING|COUNT|SUM|AVG|CASE|WHEN|THEN|ELSE|END|WITH|RETURNING|GENERATED|ALWAYS|IDENTITY)\b/, 'kw'],
    [/\b\d[\d_]*(?:\.\d+)?\b/, 'num'],
    [/\b[a-z_]\w*(?=\s*\()/, 'fn'],
  ],
  glsl: [
    [/\/\/.*/, 'com'],
    [/\bgl_[A-Za-z]\w*\b/, 'dec'],
    [/\b(?:precision|mediump|highp|lowp|uniform|varying|attribute|in|out|void|float|int|bool|vec2|vec3|vec4|mat2|mat3|mat4|sampler2D|if|else|for|return|const|struct|break|continue)\b/, 'kw'],
    [/\b\d[\d_]*(?:\.\d+)?\b/, 'num'],
    [/\b[A-Za-z_]\w*(?=\s*\()/, 'fn'],
  ],
  plain: [],
};
const COMPILED = {};
for (const lang in RULES) {
  if (!RULES[lang].length) { COMPILED[lang] = null; continue; }
  COMPILED[lang] = {
    re: new RegExp(RULES[lang].map(r => '(' + r[0].source + ')').join('|'), 'g'),
    cls: RULES[lang].map(r => r[1]),
  };
}
function hl(text, lang) {
  const c = COMPILED[lang];
  if (!c || !text) return esc(text);
  let out = '', last = 0;
  for (const m of text.matchAll(c.re)) {
    out += esc(text.slice(last, m.index));
    let cls = '';
    for (let g = 1; g < m.length; g++) { if (m[g] !== undefined) { cls = c.cls[g - 1]; break; } }
    out += '<span class="' + cls + '">' + esc(m[0]) + '</span>';
    last = m.index + m[0].length;
  }
  return out + esc(text.slice(last));
}

/* ================= corpus: application development ================= */

const WA_USER = `import { Injectable, Logger } from '@nestjs/common';
import { UpstreamGateway } from '../gateways/upstream.gateway';
import { RetryStrategy } from './retry.strategy';
import { MetricsService } from './metrics.service';
import { UserRecord, SyncResult, SyncStatus, GatewayResponse } from '../types/user.types';

// APP-2841: harden retry logic for flaky upstream timeouts.
// The upstream SLA promises 99.9% uptime. The upstream disagrees.

@Injectable()
export class UserService {
  private readonly logger = new Logger(UserService.name);
  private readonly maxAttempts = 5;

  constructor(
    private readonly gateway: UpstreamGateway,
    private readonly retry: RetryStrategy,
    private readonly metrics: MetricsService,
  ) {}

  async syncUser(userId: string): Promise<SyncResult> {
    this.validate(userId);

    // NOTE: do not remove this await. User records duplicate without it.
    // Nobody knows why. We have accepted this.
    await this.metrics.increment('user.sync.initiated');

    let attempt = 0;
    while (attempt < this.maxAttempts) {
      attempt += 1;
      try {
        const response = await this.gateway.fetchUser({
          userId,
          includeProfile: true,
          includePreferences: true,
        });
        this.logger.log('sync succeeded on attempt ' + attempt);
        return this.toResult(response, attempt);
      } catch (err) {
        if (!this.retry.isRetryable(err)) {
          throw err;
        }
        const delay = this.retry.nextDelay(attempt);
        this.logger.warn('attempt ' + attempt + ' failed, retrying in ' + delay + 'ms');
        await this.sleep(delay);
      }
    }

    await this.metrics.increment('user.sync.exhausted');
    return { status: SyncStatus.Failed, attempts: attempt, userId };
  }

  async updateProfile(userId: string, patch: Partial<UserRecord>): Promise<SyncResult> {
    // Product asked for "instant" profile updates. This is as instant as it gets.
    const existing = await this.gateway.fetchUser({ userId });
    if (!existing) {
      throw new Error('no record found for user ' + userId);
    }
    const merged = { ...existing, ...patch, updatedAt: new Date().toISOString() };
    const response = await this.gateway.putUser(userId, merged);
    await this.metrics.increment('user.profile.updated');
    return this.toResult(response, 1);
  }

  private validate(userId: string): void {
    if (!userId || userId.length < 8) {
      throw new TypeError('userId looks suspicious: ' + userId);
    }
  }

  private toResult(response: GatewayResponse, attempts: number): SyncResult {
    return {
      status: response.ok ? SyncStatus.Synced : SyncStatus.Stale,
      attempts,
      userId: response.userId,
      revision: response.revision,
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
`;

const WA_RETRY = `import { Injectable } from '@nestjs/common';

// Exponential backoff with full jitter.
// See: AWS Architecture Blog, "Exponential Backoff and Jitter".
// We read the article. We are basically distributed systems experts now.

const BASE_DELAY_MS = 200;
const MAX_DELAY_MS = 30_000;

const RETRYABLE_CODES = new Set([
  'ETIMEDOUT',
  'ECONNRESET',
  'GATEWAY_BUSY',
  'RATE_LIMITED',
  'UPSTREAM_HICCUP', // their words, not ours
]);

@Injectable()
export class RetryStrategy {
  nextDelay(attempt: number): number {
    const exponential = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt);
    return Math.round(Math.random() * exponential);
  }

  isRetryable(err: unknown): boolean {
    if (err instanceof GatewayError) {
      return RETRYABLE_CODES.has(err.code);
    }
    return err instanceof Error && err.message.includes('timeout');
  }
}

export class GatewayError extends Error {
  constructor(
    public readonly code: string,
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'GatewayError';
  }
}

export class CircuitBreaker {
  private failures = 0;
  private openedAt: number | null = null;

  constructor(
    private readonly threshold = 8,
    private readonly cooldownMs = 15_000,
  ) {}

  recordFailure(): void {
    this.failures += 1;
    if (this.failures >= this.threshold) {
      this.openedAt = Date.now();
    }
  }

  recordSuccess(): void {
    this.failures = 0;
    this.openedAt = null;
  }

  get isOpen(): boolean {
    if (this.openedAt === null) {
      return false;
    }
    if (Date.now() - this.openedAt > this.cooldownMs) {
      // half-open: let one brave request through
      this.openedAt = null;
      return false;
    }
    return true;
  }
}
`;

const WA_DASH = `import { useEffect, useMemo, useState } from 'react';
import { StatCard } from './components/StatCard';
import { UsageChart } from './components/UsageChart';
import { fetchDashboardStats } from './api.client';
import type { DashboardStats } from './types';

// APP-3102: the dashboard nobody asked for and everybody uses.

const REFRESH_INTERVAL_MS = 30_000;

export function Dashboard() {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const data = await fetchDashboardStats();
        if (!cancelled) {
          setStats(data);
          setLastUpdated(new Date());
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError('failed to load stats, retrying quietly...');
        }
      }
    }

    load();
    const timer = setInterval(load, REFRESH_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const uptimeLabel = useMemo(() => {
    if (!stats) return '—';
    return stats.uptimePercent.toFixed(2) + '%';
  }, [stats]);

  if (error && !stats) {
    return <div className="dashboard-error">{error}</div>;
  }

  return (
    <main className="dashboard">
      <header className="dashboard-header">
        <h1>Platform Overview</h1>
        <span className="muted">
          {lastUpdated ? 'updated ' + lastUpdated.toLocaleTimeString() : 'loading...'}
        </span>
      </header>

      <section className="stat-grid">
        <StatCard label="Requests / min" value={stats ? stats.requestsPerMinute : 0} />
        <StatCard label="Error rate" value={stats ? stats.errorRate : 0} suffix="%" />
        <StatCard label="Uptime (30d)" value={uptimeLabel} />
        <StatCard label="Active users" value={stats ? stats.activeUsers : 0} />
      </section>

      <UsageChart data={stats ? stats.usageSeries : []} height={280} />
    </main>
  );
}
`;

const WA_CACHE = `import asyncio
import time
from collections import OrderedDict
from dataclasses import dataclass
from typing import Any, Optional

# Cache invalidation is one of the two hard problems in computer science.
# This module bravely attempts both of them.

DEFAULT_TTL_SECONDS = 300
MAX_ENTRIES = 10_000


@dataclass
class CacheEntry:
    value: Any
    expires_at: float
    hits: int = 0


class CacheManager:
    def __init__(self, ttl: int = DEFAULT_TTL_SECONDS, max_entries: int = MAX_ENTRIES):
        self._store: OrderedDict[str, CacheEntry] = OrderedDict()
        self._ttl = ttl
        self._max_entries = max_entries
        self._lock = asyncio.Lock()
        self._evictions = 0

    async def get(self, key: str) -> Optional[Any]:
        async with self._lock:
            entry = self._store.get(key)
            if entry is None:
                return None
            if entry.expires_at < time.monotonic():
                del self._store[key]
                return None
            entry.hits += 1
            self._store.move_to_end(key)
            return entry.value

    async def set(self, key: str, value: Any, ttl: Optional[int] = None) -> None:
        async with self._lock:
            expires = time.monotonic() + (ttl or self._ttl)
            self._store[key] = CacheEntry(value=value, expires_at=expires)
            self._store.move_to_end(key)
            while len(self._store) > self._max_entries:
                self._store.popitem(last=False)
                self._evictions += 1

    async def invalidate(self, prefix: str) -> int:
        # Called by exactly one cron job that nobody remembers scheduling.
        async with self._lock:
            doomed = [k for k in self._store if k.startswith(prefix)]
            for key in doomed:
                del self._store[key]
            return len(doomed)

    def stats(self) -> dict:
        total_hits = sum(e.hits for e in self._store.values())
        return {
            "entries": len(self._store),
            "hits": total_hits,
            "evictions": self._evictions,
        }


async def warm_cache(manager: CacheManager, loader, keys: list[str]) -> None:
    # "Warming the cache" sounds cozy. It is not.
    sem = asyncio.Semaphore(16)

    async def _load(key: str) -> None:
        async with sem:
            value = await loader(key)
            await manager.set(key, value)

    await asyncio.gather(*[_load(k) for k in keys])
`;

const WA_DEPLOY = `# deploy.pipeline.yml
# CI/CD pipeline for web-platform.
# Edit with care: this file has feelings and a long memory.

stages:
  - lint
  - test
  - build
  - deploy

variables:
  NODE_VERSION: "20.11"
  REGISTRY: registry.internal.corp/platform
  KUBE_NAMESPACE: platform-prod

lint:
  stage: lint
  image: node:20-alpine
  script:
    - npm ci --prefer-offline
    - npm run lint
    - npm run typecheck

backend-tests:
  stage: test
  image: node:20-alpine
  services:
    - postgres:16
    - redis:7
  script:
    - npm run test:backend -- --coverage

frontend-build:
  stage: test
  image: node:20-alpine
  script:
    - npm run build:frontend
    - npm run test:frontend

build-image:
  stage: build
  image: docker:26
  script:
    - docker build -t $REGISTRY/backend:$CI_COMMIT_SHORT_SHA .
    - docker push $REGISTRY/backend:$CI_COMMIT_SHORT_SHA

deploy-prod:
  stage: deploy
  image: bitnami/kubectl:1.29
  when: manual   # the "are you sure?" button
  environment:
    name: production
  script:
    - kubectl -n $KUBE_NAMESPACE set image deploy/backend
      app=$REGISTRY/backend:$CI_COMMIT_SHORT_SHA
    - kubectl -n $KUBE_NAMESPACE rollout status deploy/backend --timeout=180s
`;

const WA_GATEWAY = `import { Injectable } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { GatewayError } from '../src/retry.strategy';

const UPSTREAM_BASE = process.env.UPSTREAM_URL || 'https://api.upstream.internal';
const TIMEOUT_MS = 4_000;

@Injectable()
export class UpstreamGateway {
  constructor(private readonly http: HttpService) {}

  async fetchUser(params: { userId: string; includeProfile?: boolean; includePreferences?: boolean }) {
    const response = await firstValueFrom(
      this.http.get(UPSTREAM_BASE + '/v2/users/' + params.userId, {
        timeout: TIMEOUT_MS,
        params: {
          profile: params.includeProfile ? 1 : 0,
          preferences: params.includePreferences ? 1 : 0,
        },
      }),
    );
    if (response.status >= 500) {
      throw new GatewayError('UPSTREAM_HICCUP', response.status, 'upstream unavailable');
    }
    return response.data;
  }

  async putUser(userId: string, body: unknown) {
    const response = await firstValueFrom(
      this.http.put(UPSTREAM_BASE + '/v2/users/' + userId, body, { timeout: TIMEOUT_MS }),
    );
    return response.data;
  }
}
`;

const WA_AUTH = `import { Body, Controller, Post, UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';
import { LoginDto, RefreshDto } from '../types/auth.types';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('login')
  async login(@Body() dto: LoginDto) {
    const session = await this.auth.verifyCredentials(dto.email, dto.password);
    if (!session) {
      // same message for wrong user and wrong password. we are not a hint system.
      throw new UnauthorizedException('invalid credentials');
    }
    return this.auth.issueTokens(session);
  }

  @Post('refresh')
  async refresh(@Body() dto: RefreshDto) {
    const session = await this.auth.verifyRefreshToken(dto.refreshToken);
    if (!session) {
      throw new UnauthorizedException('refresh token expired');
    }
    return this.auth.issueTokens(session);
  }
}
`;

const WA_METRICS = `import { Injectable } from '@nestjs/common';
import { StatsD } from 'hot-shots';

@Injectable()
export class MetricsService {
  private readonly client = new StatsD({
    host: process.env.STATSD_HOST || 'localhost',
    prefix: 'platform.',
    errorHandler: () => undefined, // metrics must never take down the app
  });

  async increment(metric: string, value = 1): Promise<void> {
    this.client.increment(metric, value);
  }

  gauge(metric: string, value: number): void {
    this.client.gauge(metric, value);
  }

  timing(metric: string, ms: number): void {
    this.client.timing(metric, ms);
  }
}
`;

const WA_TYPES = `export interface UserRecord {
  userId: string;
  email: string;
  displayName: string;
  locale: string;
  updatedAt: string;
  preferences: Record<string, unknown>;
}

export enum SyncStatus {
  Synced = 'synced',
  Stale = 'stale',
  Failed = 'failed',
}

export interface SyncResult {
  status: SyncStatus;
  attempts: number;
  userId: string;
  revision?: number;
}

export interface GatewayResponse {
  ok: boolean;
  userId: string;
  revision: number;
}
`;

const WA_APP = `import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { Dashboard } from './Dashboard';
import { Layout } from './components/Layout';

export function App() {
  return (
    <BrowserRouter>
      <Layout>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="*" element={<div className="nf">404 — but in a friendly way</div>} />
        </Routes>
      </Layout>
    </BrowserRouter>
  );
}
`;

const WA_LAYOUT = `import type { ReactNode } from 'react';

export function Layout({ children }: { children: ReactNode }) {
  return (
    <div className="app-shell">
      <header className="app-header">web-platform</header>
      <main className="app-content">{children}</main>
      <footer className="app-footer">internal build — not for the press release</footer>
    </div>
  );
}
`;

const WA_AUTHSVC = `import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { compare } from 'bcrypt';
import { SessionInfo, UserDirectory } from '../types/auth.types';

@Injectable()
export class AuthService {
  constructor(
    private readonly jwt: JwtService,
    private readonly users: UserDirectory,
  ) {}

  async verifyCredentials(email: string, password: string): Promise<SessionInfo | null> {
    const user = await this.users.findByEmail(email);
    if (!user) {
      return null;
    }
    const ok = await compare(password, user.passwordHash);
    return ok ? { userId: user.userId, email } : null;
  }

  async verifyRefreshToken(token: string): Promise<SessionInfo | null> {
    try {
      const payload = await this.jwt.verifyAsync(token);
      return { userId: payload.sub, email: payload.email };
    } catch (err) {
      return null;
    }
  }

  issueTokens(session: SessionInfo) {
    return {
      accessToken: this.jwt.sign({ sub: session.userId }, { expiresIn: '15m' }),
      refreshToken: this.jwt.sign({ sub: session.userId, email: session.email }, { expiresIn: '7d' }),
    };
  }
}
`;

const WA_AUTHTYPES = `export interface LoginDto {
  email: string;
  password: string;
}

export interface RefreshDto {
  refreshToken: string;
}

export interface SessionInfo {
  userId: string;
  email: string;
}

export abstract class UserDirectory {
  abstract findByEmail(
    email: string,
  ): Promise<{ userId: string; passwordHash: string } | null>;
}
`;

const WA_STATCARD = `interface StatCardProps {
  label: string;
  value: number | string;
  suffix?: string;
}

export function StatCard({ label, value, suffix }: StatCardProps) {
  return (
    <div className="stat-card">
      <span className="stat-label">{label}</span>
      <span className="stat-value">
        {typeof value === 'number' ? value.toLocaleString() : value}
        {suffix}
      </span>
    </div>
  );
}
`;

const WA_CHART = `interface UsageChartProps {
  data: number[];
  height: number;
}

export function UsageChart({ data, height }: UsageChartProps) {
  if (!data.length) {
    return <div className="chart-empty" style={{ height }}>collecting data...</div>;
  }
  const max = Math.max(...data, 1);
  const points = data
    .map((v, i) => (i / (data.length - 1)) * 100 + ',' + (100 - (v / max) * 90))
    .join(' ');

  return (
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" style={{ height, width: '100%' }}>
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}
`;

const WA_APICLIENT = `import type { DashboardStats } from './types';

const BASE = import.meta.env.VITE_API_URL || '/api';

async function request<T>(path: string): Promise<T> {
  const res = await fetch(BASE + path, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error('request failed: ' + res.status + ' ' + path);
  }
  return res.json() as Promise<T>;
}

export function fetchDashboardStats(): Promise<DashboardStats> {
  return request<DashboardStats>('/stats/dashboard');
}
`;

const WA_FTYPES = `export interface DashboardStats {
  requestsPerMinute: number;
  errorRate: number;
  uptimePercent: number;
  activeUsers: number;
  usageSeries: number[];
}
`;

const WA_SEED = `import argparse
import random

from faker import Faker

# Seeds the local database with users that look real enough to demo
# and fake enough that legal does not send us emails.

fake = Faker()

LOCALES = ["en_US", "de_DE", "ja_JP", "pt_BR"]


def make_user(index: int) -> dict:
    return {
        "user_id": "u_" + str(100000 + index),
        "email": fake.unique.email(),
        "display_name": fake.name(),
        "locale": random.choice(LOCALES),
        "active": random.random() > 0.1,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--count", type=int, default=500)
    args = parser.parse_args()

    users = [make_user(i) for i in range(args.count)]
    print("seeded", len(users), "users")


if __name__ == "__main__":
    main()
`;

const WA_VITE = `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
`;

const WA_COMPOSE = `services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_DB: platform
      POSTGRES_PASSWORD: localdev   # yes, we know. it is local.
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"

  backend:
    build: ./backend
    depends_on:
      - postgres
      - redis
    ports:
      - "3000:3000"

volumes:
  pgdata:
`;

/* ================= corpus: banking service ================= */

const BK_LEDGER = `import { Injectable, Logger } from '@nestjs/common';
import { AccountRepository } from '../accounts/account.repository';
import { AuditLogger } from '../audit/audit.logger';
import { LedgerEntry, PostingRequest, PostingResult } from './ledger.types';

// BANK-1337: double-entry posting engine.
// Rule #1: money must balance. This comment is load-bearing.

@Injectable()
export class LedgerService {
  private readonly logger = new Logger(LedgerService.name);

  constructor(
    private readonly accounts: AccountRepository,
    private readonly audit: AuditLogger,
  ) {}

  async post(request: PostingRequest): Promise<PostingResult> {
    this.assertBalanced(request.entries);

    const txId = this.nextTransactionId(request);
    await this.audit.record('ledger.posting.started', txId);

    // Postings are all-or-nothing. There is no "mostly posted".
    return this.accounts.withTransaction(async (tx) => {
      for (const entry of request.entries) {
        const account = await this.accounts.lockForUpdate(tx, entry.accountId);
        const newBalance = account.balanceMinor + this.signedAmount(entry);

        if (newBalance < 0 && !account.overdraftEnabled) {
          throw new InsufficientFundsError(entry.accountId, entry.amountMinor);
        }

        await this.accounts.applyEntry(tx, {
          accountId: entry.accountId,
          amountMinor: entry.amountMinor,
          direction: entry.direction,
          transactionId: txId,
          balanceAfter: newBalance,
        });
      }

      await this.audit.record('ledger.posting.committed', txId);
      this.logger.log('posted ' + request.entries.length + ' entries for tx ' + txId);
      return { transactionId: txId, status: 'committed' };
    });
  }

  private assertBalanced(entries: LedgerEntry[]): void {
    const sum = entries.reduce((acc, e) => acc + this.signedAmount(e), 0);
    if (sum !== 0) {
      // If you are reading this in production, cancel your evening plans.
      throw new UnbalancedPostingError(sum);
    }
  }

  private signedAmount(entry: LedgerEntry): number {
    return entry.direction === 'debit' ? -entry.amountMinor : entry.amountMinor;
  }

  private nextTransactionId(request: PostingRequest): string {
    return 'tx_' + request.idempotencyKey;
  }
}

export class UnbalancedPostingError extends Error {
  constructor(public readonly delta: number) {
    super('posting does not balance, delta=' + delta + ' minor units');
  }
}

export class InsufficientFundsError extends Error {
  constructor(accountId: string, amountMinor: number) {
    super('insufficient funds on ' + accountId + ' for ' + amountMinor);
  }
}
`;

const BK_VALIDATOR = `import { Injectable } from '@nestjs/common';
import { isValidIban } from '../accounts/iban.utils';
import { PostingRequest } from './ledger.types';

// Validation order matters: cheap checks first, database checks last.
// The database is a diva and we do not wake her unnecessarily.

const MAX_ENTRIES_PER_POSTING = 64;
const MAX_AMOUNT_MINOR = 1_000_000_00; // 1M in minor units, per compliance

@Injectable()
export class TransactionValidator {
  validate(request: PostingRequest): string[] {
    const errors: string[] = [];

    if (!request.idempotencyKey || request.idempotencyKey.length < 16) {
      errors.push('idempotencyKey must be at least 16 chars');
    }
    if (!request.entries.length) {
      errors.push('posting must contain at least one entry');
    }
    if (request.entries.length > MAX_ENTRIES_PER_POSTING) {
      errors.push('too many entries: ' + request.entries.length);
    }

    for (const entry of request.entries) {
      if (!Number.isInteger(entry.amountMinor)) {
        // floating point money is how banks end up in the news
        errors.push('amount must be integer minor units: ' + entry.amountMinor);
      }
      if (entry.amountMinor <= 0) {
        errors.push('amount must be positive: ' + entry.amountMinor);
      }
      if (entry.amountMinor > MAX_AMOUNT_MINOR) {
        errors.push('amount exceeds single-posting limit');
      }
      if (entry.counterpartyIban && !isValidIban(entry.counterpartyIban)) {
        errors.push('invalid IBAN: ' + entry.counterpartyIban);
      }
      if (entry.direction !== 'debit' && entry.direction !== 'credit') {
        errors.push('direction must be debit or credit');
      }
    }

    return errors;
  }
}
`;

const BK_FRAUD = `import math
from dataclasses import dataclass
from datetime import datetime, timedelta

# Fraud scoring rules. Tuned on historical data and vibes.
# Score >= 0.8 blocks the transaction and pages someone.

VELOCITY_WINDOW = timedelta(minutes=10)
NIGHT_HOURS = range(2, 5)  # crime enjoys a schedule, apparently


@dataclass
class TxContext:
    account_id: str
    amount_minor: int
    country: str
    hour: int
    recent_tx_count: int
    avg_amount_minor: float
    new_beneficiary: bool


def velocity_score(ctx: TxContext) -> float:
    # 12 transfers in 10 minutes is enthusiasm. 40 is a script.
    return min(1.0, ctx.recent_tx_count / 40.0)


def amount_anomaly_score(ctx: TxContext) -> float:
    if ctx.avg_amount_minor <= 0:
        return 0.3  # new account, mildly suspicious of everyone
    ratio = ctx.amount_minor / ctx.avg_amount_minor
    return min(1.0, math.log10(max(ratio, 1.0)) / 2.0)


def time_of_day_score(ctx: TxContext) -> float:
    return 0.4 if ctx.hour in NIGHT_HOURS else 0.0


def beneficiary_score(ctx: TxContext) -> float:
    return 0.35 if ctx.new_beneficiary else 0.0


WEIGHTS = {
    velocity_score: 0.35,
    amount_anomaly_score: 0.35,
    time_of_day_score: 0.15,
    beneficiary_score: 0.15,
}


def fraud_score(ctx: TxContext) -> float:
    total = 0.0
    for rule, weight in WEIGHTS.items():
        total += weight * rule(ctx)
    return round(min(total, 1.0), 4)


def decide(ctx: TxContext) -> str:
    score = fraud_score(ctx)
    if score >= 0.8:
        return "block"
    if score >= 0.5:
        return "review"
    return "allow"
`;

const BK_INTEREST = `// Interest accrual. Uses banker's rounding, obviously.
// Rates are annual, accrual is daily, complaints are quarterly.

const DAYS_IN_YEAR = 365;

export interface AccrualInput {
  principalMinor: number;
  annualRateBps: number; // basis points, because percent was too readable
  days: number;
}

export function dailyRate(annualRateBps: number): number {
  return annualRateBps / 10_000 / DAYS_IN_YEAR;
}

export function accrueInterest(input: AccrualInput): number {
  const rate = dailyRate(input.annualRateBps);
  let accrued = 0;
  let principal = input.principalMinor;

  for (let day = 0; day < input.days; day++) {
    const todays = principal * rate;
    accrued += todays;
    principal += todays; // daily compounding, the quiet workhorse
  }

  return bankersRound(accrued);
}

export function bankersRound(value: number): number {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  // exactly .5: round to even, as the ancients decreed
  return floor % 2 === 0 ? floor : floor + 1;
}
`;

const BK_MIGRATION = `-- 002_add_ledger_tables.sql
-- Adds double-entry ledger tables. Reviewed twice. Ships with the next deploy.

BEGIN;

CREATE TABLE IF NOT EXISTS ledger_transactions (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    transaction_id VARCHAR(64) NOT NULL UNIQUE,
    idempotency_key VARCHAR(128) NOT NULL UNIQUE,
    status VARCHAR(16) NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ledger_entries (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    transaction_id VARCHAR(64) NOT NULL REFERENCES ledger_transactions (transaction_id),
    account_id VARCHAR(64) NOT NULL,
    direction VARCHAR(6) NOT NULL CHECK (direction IN ('debit', 'credit')),
    amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
    balance_after BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_entries_account
    ON ledger_entries (account_id, created_at);

-- Balances must reconcile to zero per transaction.
-- Enforced in code AND checked nightly, because trust is not a strategy.

COMMIT;
`;

const BK_REPO = `import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

@Injectable()
export class AccountRepository {
  constructor(private readonly ds: DataSource) {}

  withTransaction<T>(fn: (tx: EntityManager) => Promise<T>): Promise<T> {
    return this.ds.transaction('SERIALIZABLE', fn);
  }

  async lockForUpdate(tx: EntityManager, accountId: string) {
    const rows = await tx.query(
      'SELECT account_id, balance_minor, overdraft_enabled FROM accounts WHERE account_id = $1 FOR UPDATE',
      [accountId],
    );
    if (!rows.length) {
      throw new Error('unknown account: ' + accountId);
    }
    return {
      accountId: rows[0].account_id,
      balanceMinor: Number(rows[0].balance_minor),
      overdraftEnabled: rows[0].overdraft_enabled,
    };
  }

  async applyEntry(tx: EntityManager, entry: Record<string, unknown>) {
    await tx.query(
      'INSERT INTO ledger_entries (transaction_id, account_id, direction, amount_minor, balance_after) VALUES ($1, $2, $3, $4, $5)',
      [entry.transactionId, entry.accountId, entry.direction, entry.amountMinor, entry.balanceAfter],
    );
    await tx.query(
      'UPDATE accounts SET balance_minor = $2 WHERE account_id = $1',
      [entry.accountId, entry.balanceAfter],
    );
  }
}
`;

const BK_IBAN = `// IBAN validation per ISO 13616. The checksum is mod-97,
// a scheme designed before anyone asked "but why".

const IBAN_LENGTHS: Record<string, number> = {
  DE: 22, FR: 27, GB: 22, NL: 18, ES: 24, IT: 27, PL: 28, KZ: 20,
};

export function isValidIban(iban: string): boolean {
  const clean = iban.replace(/\\s+/g, '').toUpperCase();
  const country = clean.slice(0, 2);

  if (!IBAN_LENGTHS[country] || clean.length !== IBAN_LENGTHS[country]) {
    return false;
  }

  // move first 4 chars to the end, convert letters to numbers (A=10..Z=35)
  const rearranged = clean.slice(4) + clean.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const val = ch >= 'A' ? String(ch.charCodeAt(0) - 55) : ch;
    for (const digit of val) {
      remainder = (remainder * 10 + Number(digit)) % 97;
    }
  }
  return remainder === 1;
}
`;

const BK_AUDIT = `import { Injectable, Logger } from '@nestjs/common';

// Append-only audit trail. Regulators love it. So do we, quietly.

@Injectable()
export class AuditLogger {
  private readonly logger = new Logger(AuditLogger.name);

  async record(event: string, subjectId: string, meta: Record<string, unknown> = {}) {
    const entry = {
      event,
      subjectId,
      meta,
      at: new Date().toISOString(),
    };
    // ships to the WORM store; local log is just a courtesy copy
    this.logger.log(event + ' ' + subjectId);
    await this.ship(entry);
  }

  private async ship(entry: Record<string, unknown>): Promise<void> {
    // fire-and-forget is illegal here. we wait for the ack.
    return Promise.resolve();
  }
}
`;

const BK_TYPES = `export type Direction = 'debit' | 'credit';

export interface LedgerEntry {
  accountId: string;
  amountMinor: number;
  direction: Direction;
  counterpartyIban?: string;
}

export interface PostingRequest {
  idempotencyKey: string;
  entries: LedgerEntry[];
  reference: string;
}

export interface PostingResult {
  transactionId: string;
  status: 'committed' | 'rejected';
}
`;

/* ================= corpus: game development ================= */

const GD_PARTICLE = `import { Vec2 } from '../math/vec2';
import { Renderer } from '../render/renderer';

// ENG-451: particle system rewrite.
// Previous version allocated 40k objects per frame. It is in a better place now.

const MAX_PARTICLES = 4096;

interface Particle {
  x: number; y: number;
  vx: number; vy: number;
  life: number; maxLife: number;
  size: number; hue: number;
}

export class ParticleSystem {
  private readonly pool: Particle[] = [];
  private alive = 0;

  constructor(private readonly gravity: Vec2) {
    // preallocate everything. the garbage collector is not invited to this party.
    for (let i = 0; i < MAX_PARTICLES; i++) {
      this.pool.push({ x: 0, y: 0, vx: 0, vy: 0, life: 0, maxLife: 0, size: 1, hue: 0 });
    }
  }

  emit(origin: Vec2, count: number, speed: number, hue: number): void {
    for (let i = 0; i < count && this.alive < MAX_PARTICLES; i++) {
      const p = this.pool[this.alive++];
      const angle = Math.random() * Math.PI * 2;
      const velocity = speed * (0.5 + Math.random() * 0.5);
      p.x = origin.x;
      p.y = origin.y;
      p.vx = Math.cos(angle) * velocity;
      p.vy = Math.sin(angle) * velocity;
      p.maxLife = 0.6 + Math.random() * 1.2;
      p.life = p.maxLife;
      p.size = 1 + Math.random() * 3;
      p.hue = hue + randistort(12);
    }
  }

  update(dt: number): void {
    let i = 0;
    while (i < this.alive) {
      const p = this.pool[i];
      p.life -= dt;
      if (p.life <= 0) {
        // swap-remove: order does not matter, speed does
        this.alive--;
        this.pool[i] = this.pool[this.alive];
        this.pool[this.alive] = p;
        continue;
      }
      p.vx += this.gravity.x * dt;
      p.vy += this.gravity.y * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      i++;
    }
  }

  render(renderer: Renderer): void {
    for (let i = 0; i < this.alive; i++) {
      const p = this.pool[i];
      const fade = p.life / p.maxLife;
      renderer.drawPoint(p.x, p.y, p.size * fade, p.hue, fade);
    }
  }
}

function randistort(range: number): number {
  return (Math.random() - 0.5) * 2 * range;
}
`;

const GD_PHYSICS = `import { Vec2 } from '../math/vec2';

// Fixed-timestep physics. Gravity tuned by feel.
// Do not consult real physicists; they have opinions.

const FIXED_DT = 1 / 120;
const MAX_STEPS = 8;

export interface Body {
  pos: Vec2;
  vel: Vec2;
  halfW: number;
  halfH: number;
  grounded: boolean;
  isStatic: boolean;
}

export class PhysicsWorld {
  private readonly bodies: Body[] = [];
  private accumulator = 0;

  constructor(private readonly gravity = new Vec2(0, 980)) {}

  add(body: Body): void {
    this.bodies.push(body);
  }

  tick(frameDt: number): void {
    this.accumulator += Math.min(frameDt, 0.25); // spiral-of-death insurance
    let steps = 0;
    while (this.accumulator >= FIXED_DT && steps < MAX_STEPS) {
      this.step(FIXED_DT);
      this.accumulator -= FIXED_DT;
      steps++;
    }
  }

  private step(dt: number): void {
    for (const body of this.bodies) {
      if (body.isStatic) continue;
      body.vel.y += this.gravity.y * dt;
      body.pos.x += body.vel.x * dt;
      body.pos.y += body.vel.y * dt;
      body.grounded = false;
    }
    this.resolveCollisions();
  }

  private resolveCollisions(): void {
    for (let a = 0; a < this.bodies.length; a++) {
      for (let b = a + 1; b < this.bodies.length; b++) {
        const first = this.bodies[a];
        const second = this.bodies[b];
        if (first.isStatic && second.isStatic) continue;

        const dx = second.pos.x - first.pos.x;
        const dy = second.pos.y - first.pos.y;
        const overlapX = first.halfW + second.halfW - Math.abs(dx);
        const overlapY = first.halfH + second.halfH - Math.abs(dy);
        if (overlapX <= 0 || overlapY <= 0) continue;

        // resolve along the shallow axis; the deep axis is lying to you
        if (overlapX < overlapY) {
          this.separate(first, second, Math.sign(dx) * overlapX, 0);
        } else {
          this.separate(first, second, 0, Math.sign(dy) * overlapY);
          if (dy > 0) first.grounded = true;
          else second.grounded = true;
        }
      }
    }
  }

  private separate(a: Body, b: Body, dx: number, dy: number): void {
    const mover = a.isStatic ? b : a;
    const sign = a.isStatic ? 1 : -1;
    mover.pos.x += dx * sign;
    mover.pos.y += dy * sign;
    if (dx !== 0) mover.vel.x = 0;
    if (dy !== 0) mover.vel.y = 0;
  }
}
`;

const GD_SHADER = `// fire.frag — particle fire shader.
// Cranked the glow until the art director smiled. Do not lower it.

precision mediump float;

uniform sampler2D u_noise;
uniform float u_time;
uniform vec2 u_resolution;

varying vec2 v_uv;

float noiseLayer(vec2 uv, float speed, float scale) {
  vec2 offset = vec2(0.0, u_time * speed);
  return texture2D(u_noise, uv * scale + offset).r;
}

void main() {
  vec2 uv = v_uv;

  // stack three noise octaves; fire is just spicy clouds
  float n = 0.0;
  n += noiseLayer(uv, 0.35, 1.0) * 0.5;
  n += noiseLayer(uv, 0.55, 2.3) * 0.3;
  n += noiseLayer(uv, 0.90, 4.7) * 0.2;

  // shape: hotter at the bottom, wispy at the top
  float shape = pow(1.0 - uv.y, 1.6);
  float intensity = clamp(n * shape * 2.2, 0.0, 1.0);

  vec3 cold = vec3(0.05, 0.02, 0.02);
  vec3 mid = vec3(0.9, 0.35, 0.05);
  vec3 hot = vec3(1.0, 0.9, 0.55);

  vec3 color = mix(cold, mid, smoothstep(0.15, 0.6, intensity));
  color = mix(color, hot, smoothstep(0.75, 0.95, intensity));

  gl_FragColor = vec4(color, intensity);
}
`;

const GD_LEVEL = `import { PhysicsWorld } from '../physics/physics.world';
import { Vec2 } from '../math/vec2';

// Level loader. Levels are JSON because the level editor is a spreadsheet.

interface LevelData {
  name: string;
  gravity: number;
  tiles: number[][];
  spawns: { x: number; y: number; kind: string }[];
}

const TILE_SIZE = 32;

export class LevelLoader {
  async load(url: string, world: PhysicsWorld): Promise<LevelData> {
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error('level not found: ' + url);
    }
    const data = (await res.json()) as LevelData;
    this.buildColliders(data, world);
    return data;
  }

  private buildColliders(data: LevelData, world: PhysicsWorld): void {
    // greedy horizontal merge: 40 tiles become 3 colliders and the
    // physics thread sends a thank-you card
    for (let row = 0; row < data.tiles.length; row++) {
      let runStart = -1;
      for (let col = 0; col <= data.tiles[row].length; col++) {
        const solid = col < data.tiles[row].length && data.tiles[row][col] === 1;
        if (solid && runStart < 0) {
          runStart = col;
        }
        if (!solid && runStart >= 0) {
          const width = col - runStart;
          world.add({
            pos: new Vec2((runStart + width / 2) * TILE_SIZE, (row + 0.5) * TILE_SIZE),
            vel: new Vec2(0, 0),
            halfW: (width * TILE_SIZE) / 2,
            halfH: TILE_SIZE / 2,
            grounded: false,
            isStatic: true,
          });
          runStart = -1;
        }
      }
    }
  }
}
`;

const GD_ENEMY = `import { Vec2 } from '../math/vec2';

// Enemy AI: a tiny state machine.
// "Smart enough to be fun, dumb enough to be beatable" — design doc, page 1.

type AiState = 'patrol' | 'chase' | 'attack' | 'flee';

const SIGHT_RANGE = 260;
const ATTACK_RANGE = 48;
const FLEE_HEALTH = 0.25;

export class EnemyBrain {
  private state: AiState = 'patrol';
  private patrolDir = 1;

  think(self: { pos: Vec2; health: number }, player: { pos: Vec2 }, dt: number): Vec2 {
    const toPlayer = player.pos.sub(self.pos);
    const distance = toPlayer.length();

    if (self.health < FLEE_HEALTH) {
      this.state = 'flee';
    } else if (distance < ATTACK_RANGE) {
      this.state = 'attack';
    } else if (distance < SIGHT_RANGE) {
      this.state = 'chase';
    } else {
      this.state = 'patrol';
    }

    switch (this.state) {
      case 'patrol':
        // walk until bored, then walk the other way
        if (Math.random() < 0.005) this.patrolDir *= -1;
        return new Vec2(this.patrolDir * 40, 0);
      case 'chase':
        return toPlayer.normalize().scale(90);
      case 'attack':
        return new Vec2(0, 0); // stop and swing
      case 'flee':
        return toPlayer.normalize().scale(-120); // courage is a resource
    }
  }
}
`;

const GD_RENDERER = `export class Renderer {
  private readonly ctx: CanvasRenderingContext2D;

  constructor(canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2d context unavailable');
    this.ctx = ctx;
  }

  clear(width: number, height: number): void {
    this.ctx.clearRect(0, 0, width, height);
  }

  drawPoint(x: number, y: number, size: number, hue: number, alpha: number): void {
    this.ctx.globalAlpha = alpha;
    this.ctx.fillStyle = 'hsl(' + hue + ', 90%, 60%)';
    this.ctx.fillRect(x - size / 2, y - size / 2, size, size);
    this.ctx.globalAlpha = 1;
  }
}
`;

const GD_INPUT = `const PRESSED = new Set<string>();

export function initInput(): void {
  window.addEventListener('keydown', (e) => PRESSED.add(e.code));
  window.addEventListener('keyup', (e) => PRESSED.delete(e.code));
  window.addEventListener('blur', () => PRESSED.clear()); // alt-tab forgiveness
}

export function isDown(code: string): boolean {
  return PRESSED.has(code);
}

export function axis(negative: string, positive: string): number {
  return (isDown(positive) ? 1 : 0) - (isDown(negative) ? 1 : 0);
}
`;

const GD_VEC2 = `export class Vec2 {
  constructor(public x: number, public y: number) {}

  add(o: Vec2): Vec2 { return new Vec2(this.x + o.x, this.y + o.y); }
  sub(o: Vec2): Vec2 { return new Vec2(this.x - o.x, this.y - o.y); }
  scale(s: number): Vec2 { return new Vec2(this.x * s, this.y * s); }

  length(): number {
    return Math.hypot(this.x, this.y);
  }

  normalize(): Vec2 {
    const len = this.length();
    return len > 0 ? new Vec2(this.x / len, this.y / len) : new Vec2(0, 0);
  }
}
`;

const GD_MANIFEST = `{
  "atlas": "atlas_main.png",
  "tileSize": 32,
  "sprites": {
    "player_idle": { "frames": 4, "fps": 8 },
    "player_run": { "frames": 8, "fps": 14 },
    "slime": { "frames": 6, "fps": 10 },
    "torch": { "frames": 5, "fps": 12 },
    "coin": { "frames": 8, "fps": 16 }
  },
  "audio": {
    "jump": "sfx/jump.ogg",
    "coin": "sfx/coin.ogg",
    "music_forest": "music/forest_loop.ogg"
  }
}
`;

/* ================= corpus: data & ML ================= */

const ML_TRAIN = `import argparse
import torch
import torch.nn as nn
from torch.utils.data import DataLoader

from pipeline.feature_builder import ChurnDataset
from pipeline.model_registry import register_run

# ML-88: churn prediction v3.
# If the loss goes up we call it "exploration".

EPOCHS = 20
BATCH_SIZE = 256
LEARNING_RATE = 3e-4  # the Karpathy constant, do not question it


class ChurnNet(nn.Module):
    def __init__(self, n_features: int):
        super().__init__()
        self.net = nn.Sequential(
            nn.Linear(n_features, 128),
            nn.ReLU(),
            nn.Dropout(0.2),
            nn.Linear(128, 64),
            nn.ReLU(),
            nn.Linear(64, 1),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.net(x).squeeze(-1)


def train(data_path: str) -> None:
    dataset = ChurnDataset(data_path)
    loader = DataLoader(dataset, batch_size=BATCH_SIZE, shuffle=True, num_workers=4)

    model = ChurnNet(dataset.n_features)
    optimizer = torch.optim.AdamW(model.parameters(), lr=LEARNING_RATE)
    criterion = nn.BCEWithLogitsLoss()

    for epoch in range(EPOCHS):
        model.train()
        total_loss = 0.0
        for features, labels in loader:
            optimizer.zero_grad()
            logits = model(features)
            loss = criterion(logits, labels.float())
            loss.backward()
            # gradient clipping: seatbelts for optimizers
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            optimizer.step()
            total_loss += loss.item()

        avg = total_loss / len(loader)
        print(f_epoch_line(epoch, avg))

    register_run(model, {"epochs": EPOCHS, "lr": LEARNING_RATE})


def f_epoch_line(epoch: int, loss: float) -> str:
    return "epoch " + str(epoch + 1) + "/" + str(EPOCHS) + "  loss=" + str(round(loss, 5))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", default="data/churn_features.parquet")
    args = parser.parse_args()
    train(args.data)
`;

const ML_FEATURES = `import pandas as pd
import torch
from torch.utils.data import Dataset

# Feature engineering. 80% of the job, 0% of the conference talks.

CATEGORICAL = ["plan_tier", "region", "signup_channel"]
NUMERIC = [
    "days_since_signup",
    "sessions_last_30d",
    "avg_session_minutes",
    "support_tickets_90d",
    "invoices_overdue",
]


def build_features(raw: pd.DataFrame) -> pd.DataFrame:
    df = raw.copy()

    # nulls are not missing data, they are data about missingness
    df["avg_session_minutes"] = df["avg_session_minutes"].fillna(0.0)
    df["support_tickets_90d"] = df["support_tickets_90d"].fillna(0)

    df["engagement_ratio"] = df["sessions_last_30d"] / df["days_since_signup"].clip(lower=1)
    df["ticket_rate"] = df["support_tickets_90d"] / 90.0

    for col in CATEGORICAL:
        dummies = pd.get_dummies(df[col], prefix=col, dtype=float)
        df = pd.concat([df.drop(columns=[col]), dummies], axis=1)

    for col in NUMERIC:
        std = df[col].std() or 1.0
        df[col] = (df[col] - df[col].mean()) / std

    return df


class ChurnDataset(Dataset):
    def __init__(self, path: str):
        raw = pd.read_parquet(path)
        self.labels = torch.tensor(raw.pop("churned").values)
        features = build_features(raw)
        self.features = torch.tensor(features.values, dtype=torch.float32)
        self.n_features = self.features.shape[1]

    def __len__(self) -> int:
        return len(self.labels)

    def __getitem__(self, idx: int):
        return self.features[idx], self.labels[idx]
`;

const ML_EVAL = `import numpy as np
import torch
from sklearn.metrics import roc_auc_score, precision_recall_curve

# Evaluation. Where optimism goes to be measured.

THRESHOLD_TARGET_PRECISION = 0.75


def evaluate(model, loader) -> dict:
    model.eval()
    scores, labels = [], []

    with torch.no_grad():
        for features, batch_labels in loader:
            logits = model(features)
            scores.append(torch.sigmoid(logits).numpy())
            labels.append(batch_labels.numpy())

    y_score = np.concatenate(scores)
    y_true = np.concatenate(labels)

    auc = roc_auc_score(y_true, y_score)
    threshold = pick_threshold(y_true, y_score)

    predicted = (y_score >= threshold).astype(int)
    recall = (predicted[y_true == 1] == 1).mean()

    return {
        "auc": round(float(auc), 4),
        "threshold": round(float(threshold), 4),
        "recall_at_precision": round(float(recall), 4),
    }


def pick_threshold(y_true, y_score) -> float:
    # highest recall while precision stays presentable in the slide deck
    precision, recall, thresholds = precision_recall_curve(y_true, y_score)
    viable = [t for p, t in zip(precision[:-1], thresholds) if p >= THRESHOLD_TARGET_PRECISION]
    return min(viable) if viable else 0.5
`;

const ML_SQL = `-- churn_dataset.sql
-- Builds the training snapshot. Runs nightly. Watched closely.

WITH activity AS (
    SELECT
        user_id,
        COUNT(*) AS sessions_last_30d,
        AVG(duration_minutes) AS avg_session_minutes
    FROM sessions
    WHERE started_at > now() - INTERVAL '30 days'
    GROUP BY user_id
),
tickets AS (
    SELECT user_id, COUNT(*) AS support_tickets_90d
    FROM support_tickets
    WHERE created_at > now() - INTERVAL '90 days'
    GROUP BY user_id
)
SELECT
    u.user_id,
    u.plan_tier,
    u.region,
    u.signup_channel,
    EXTRACT(day FROM now() - u.created_at) AS days_since_signup,
    COALESCE(a.sessions_last_30d, 0) AS sessions_last_30d,
    COALESCE(a.avg_session_minutes, 0) AS avg_session_minutes,
    COALESCE(t.support_tickets_90d, 0) AS support_tickets_90d,
    u.invoices_overdue,
    u.churned
FROM users u
LEFT JOIN activity a ON a.user_id = u.user_id
LEFT JOIN tickets t ON t.user_id = u.user_id
WHERE u.created_at < now() - INTERVAL '30 days';
`;

const ML_REGISTRY = `import json
import hashlib
from pathlib import Path

import torch

# Tiny model registry. Like MLflow, minus the meetings about MLflow.

REGISTRY_DIR = Path("artifacts/registry")


def register_run(model, params: dict) -> str:
    REGISTRY_DIR.mkdir(parents=True, exist_ok=True)

    blob = json.dumps(params, sort_keys=True).encode()
    run_id = hashlib.sha256(blob).hexdigest()[:12]

    torch.save(model.state_dict(), REGISTRY_DIR / (run_id + ".pt"))
    with open(REGISTRY_DIR / (run_id + ".json"), "w") as fh:
        json.dump({"run_id": run_id, "params": params}, fh, indent=2)

    print("registered run", run_id)
    return run_id


def latest_run() -> dict:
    runs = sorted(REGISTRY_DIR.glob("*.json"))
    if not runs:
        raise FileNotFoundError("no runs registered yet; train something first")
    with open(runs[-1]) as fh:
        return json.load(fh)
`;

const ML_CONFIG = `# pipeline configuration
# Change values here, not in the code. (We know. We have seen the git blame.)

data:
  source: warehouse.analytics.churn_snapshot
  snapshot_path: data/churn_features.parquet
  refresh_cron: "0 3 * * *"

training:
  epochs: 20
  batch_size: 256
  learning_rate: 0.0003
  device: auto

evaluation:
  target_precision: 0.75
  holdout_fraction: 0.2

registry:
  dir: artifacts/registry
  keep_last: 10
`;

const ML_REQS = `torch==2.3.1
pandas==2.2.2
numpy==1.26.4
scikit-learn==1.5.0
pyarrow==16.1.0
mlflow==2.13.1
pytest==8.2.0
ruff==0.4.8
`;

const ML_EXPORT = `import argparse
import torch

from pipeline.model_registry import latest_run
from pipeline.train_model import ChurnNet

# Export the latest registered model.
# ONNX: because production speaks a slightly different dialect.


def export_onnx(out_path: str) -> None:
    run = latest_run()
    model = ChurnNet(run["params"].get("n_features", 47))
    state_path = "artifacts/registry/" + run["run_id"] + ".pt"
    model.load_state_dict(torch.load(state_path))
    model.eval()

    example = torch.zeros(1, 47)
    torch.onnx.export(model, example, out_path, opset_version=17)
    print("exported", out_path)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--format", default="onnx")
    parser.add_argument("--out", default="artifacts/churn_v3.onnx")
    args = parser.parse_args()
    export_onnx(args.out)
`;

const ML_MAKE = `# insight-pipeline — common entry points.
# "make watch" is what you want 90% of the time.

.PHONY: watch train test lint snapshot

watch:
	watchmedo shell-command --patterns="*.py;*.sql" --command "make test" pipeline/ sql/ configs/

train:
	python -m pipeline.train_model --data data/churn_features.parquet

test:
	python -m pytest -q

lint:
	ruff check pipeline/ tests/

snapshot:
	python -m pipeline.snapshot --refresh
`;

const TOPICS = {

  webapp: {
    id: 'webapp',
    label: 'Application development',
    stack: 'React · NestJS · TypeScript',
    desc: 'Full-stack web app: backend services, a React dashboard, CI and deploys.',
    project: 'web-platform',
    version: '3.1.0',
    branch: 'feature/APP-2841-retry-logic',
    remote: 'gitlab.internal.corp:platform/web-platform',
    image: 'registry.internal.corp/platform/backend',
    deployName: 'backend',
    namespace: 'platform-staging',
    dbLine: 'postgres://platform-staging:5432/platform',
    migrateLines: ['20260807_add_retry_count_to_sync_jobs', '20260811_backfill_user_revisions'],
    lintFiles: [
      ['frontend/src/components/UsageChart.tsx', '14:47  Unexpected magic number: 90', 'no-magic-numbers'],
      ['backend/gateways/upstream.gateway.ts', '12:9   Missing return type on function', '@typescript-eslint/explicit-function-return-type'],
    ],
    suites: [
      ['backend/src/__tests__/user.service.spec.ts', 9, 14],
      ['backend/src/__tests__/retry.strategy.spec.ts', 6, 11],
      ['frontend/src/__tests__/Dashboard.spec.tsx', 5, 9],
    ],
    checkFiles: 231,
    termproc: 'node — web-platform',
    hmrPath: '/frontend/src/Dashboard.tsx',
    jobs: ['typecheck', 'jest', 'vitebuild', 'eslint', 'npminstall', 'docker', 'gitfetch', 'migrate', 'hmr', 'k8s'],
    bootLines: [
      '<span class="mag">$</span> npm run dev',
      '<span class="dim">&gt; web-platform@3.1.0 dev</span>',
      '<span class="dim">&gt; vite --host</span>',
      '',
      '  <span class="ok">VITE v5.2.8</span>  <span class="dim">ready in 743 ms</span>',
      '',
      '  <span class="ok">➜</span>  <span class="dim">Local:</span>   <span class="info">http://localhost:5173/</span>',
      '  <span class="dim">watching for file changes...</span>',
    ],
    fileList: () => [
      ['backend/src/user.service.ts', genLargeTsClass(WA_USER, 'UserService', 'user sync', ['validatePayload', 'normalizeIdentity', 'hydrateProfile', 'persistSnapshot', 'publishAuditEvent', 'reconcileState'], 1200), true],
      ['backend/src/retry.strategy.ts', WA_RETRY, true],
      ['frontend/src/Dashboard.tsx', WA_DASH, true],
      ['scripts/cache_manager.py', WA_CACHE, true],
      ['infra/deploy.pipeline.yml', WA_DEPLOY, true],
      ['backend/src/auth.controller.ts', WA_AUTH],
      ['backend/src/auth.service.ts', WA_AUTHSVC],
      ['backend/src/metrics.service.ts', WA_METRICS],
      ['backend/gateways/upstream.gateway.ts', WA_GATEWAY],
      ['backend/types/user.types.ts', WA_TYPES],
      ['backend/types/auth.types.ts', WA_AUTHTYPES],
      ['backend/Dockerfile', genDockerfile('node:20-alpine', ['npm ci --omit=dev', 'npm run build'], '["node", "dist/main.js"]')],
      ['backend/src/__tests__/user.service.spec.ts', genSpec('UserService', '../user.service', ['syncs a user after transient upstream failures', 'gives up after five attempts', 'rejects suspicious user ids'])],
      ['backend/src/__tests__/retry.strategy.spec.ts', genSpec('RetryStrategy', '../retry.strategy', ['returns jittered exponential delays', 'marks timeouts as retryable', 'opens the circuit after repeated failures'])],
      ['backend/package.json', genPackageJson('web-platform-backend', '3.1.0', [['@nestjs/common', '^10.3.0'], ['@nestjs/axios', '^3.0.1'], ['typeorm', '^0.3.20'], ['hot-shots', '^10.0.0']])],
      ['backend/tsconfig.json', genTsconfig()],
      ['frontend/src/App.tsx', WA_APP],
      ['frontend/src/components/Layout.tsx', WA_LAYOUT],
      ['frontend/src/components/StatCard.tsx', WA_STATCARD],
      ['frontend/src/components/UsageChart.tsx', WA_CHART],
      ['frontend/src/api.client.ts', WA_APICLIENT],
      ['frontend/src/types.ts', WA_FTYPES],
      ['frontend/src/__tests__/Dashboard.spec.tsx', genSpec('Dashboard', '../Dashboard', ['renders stats after loading', 'shows the error state politely', 'refreshes every thirty seconds'])],
      ['frontend/package.json', genPackageJson('web-platform-frontend', '3.1.0', [['react', '^18.3.0'], ['react-dom', '^18.3.0'], ['react-router-dom', '^6.23.0']])],
      ['frontend/vite.config.ts', WA_VITE],
      ['scripts/seed_data.py', WA_SEED],
      ['infra/docker-compose.yml', WA_COMPOSE],
      ['package.json', genPackageJson('web-platform', '3.1.0', [['npm-run-all', '^4.1.5']])],
      ['.github/ci.yml', genCi('web-platform')],
      ['.env.example', genEnv([['DATABASE_URL', 'postgres://localhost:5432/platform'], ['REDIS_URL', 'redis://localhost:6379'], ['UPSTREAM_URL', 'https://api.upstream.internal'], ['STATSD_HOST', 'localhost']])],
      ['README.md', genReadme('web-platform', 'Internal platform: user sync services and the operations dashboard.', ['NestJS backend (TypeScript)', 'React 18 + Vite frontend', 'PostgreSQL 16, Redis 7', 'GitLab CI, Kubernetes'])],
    ],
    tree: () => [
      d('.github', [fnode('.github/ci.yml')]),
      d('backend', [
        d('src', [
          d('__tests__', [fnode('backend/src/__tests__/user.service.spec.ts'), fnode('backend/src/__tests__/retry.strategy.spec.ts')]),
          fnode('backend/src/user.service.ts'), fnode('backend/src/retry.strategy.ts'),
          fnode('backend/src/auth.controller.ts'), fnode('backend/src/auth.service.ts'),
          fnode('backend/src/metrics.service.ts'),
        ], true),
        d('gateways', [fnode('backend/gateways/upstream.gateway.ts')]),
        d('types', [fnode('backend/types/user.types.ts'), fnode('backend/types/auth.types.ts')]),
        fnode('backend/Dockerfile'), fnode('backend/package.json'), fnode('backend/tsconfig.json'),
      ], true),
      d('frontend', [
        d('src', [
          d('__tests__', [fnode('frontend/src/__tests__/Dashboard.spec.tsx')]),
          d('components', [fnode('frontend/src/components/Layout.tsx'), fnode('frontend/src/components/StatCard.tsx'), fnode('frontend/src/components/UsageChart.tsx')]),
          fnode('frontend/src/Dashboard.tsx'), fnode('frontend/src/App.tsx'),
          fnode('frontend/src/api.client.ts'), fnode('frontend/src/types.ts'),
        ], true),
        fnode('frontend/package.json'), fnode('frontend/vite.config.ts'),
      ], true),
      d('scripts', [fnode('scripts/cache_manager.py'), fnode('scripts/seed_data.py')], true),
      d('infra', [fnode('infra/deploy.pipeline.yml'), fnode('infra/docker-compose.yml')], true),
      d('node_modules', [d('@nestjs', []), d('react', []), d('typescript', []), d('left-pad', [])]),
      fnode('.env.example'), fnode('package.json'), fnode('README.md'),
    ],
  },

  banking: {
    id: 'banking',
    label: 'Banking service',
    stack: 'NestJS · PostgreSQL · TypeScript + SQL',
    desc: 'Core ledger: double-entry postings, fraud rules, migrations, compliance.',
    project: 'core-ledger',
    version: '5.8.2',
    branch: 'feature/BANK-1337-double-entry',
    remote: 'gitlab.internal.corp:banking/core-ledger',
    image: 'registry.internal.corp/banking/core-ledger',
    deployName: 'core-ledger',
    namespace: 'banking-staging',
    dbLine: 'postgres://ledger-staging:5432/ledger',
    migrateLines: ['002_add_ledger_tables', '003_backfill_balance_after'],
    lintFiles: [
      ['src/accounts/account.repository.ts', '14:101 Line exceeds maximum length of 100', 'max-len'],
      ['src/ledger/interest.calculator.ts', '26:1   Missing JSDoc comment', 'jsdoc/require-jsdoc'],
    ],
    suites: [
      ['src/ledger/__tests__/ledger.service.spec.ts', 11, 16],
      ['src/ledger/__tests__/transaction.validator.spec.ts', 8, 13],
      ['src/accounts/__tests__/iban.utils.spec.ts', 6, 9],
    ],
    checkFiles: 184,
    termproc: 'node — core-ledger',
    hmrPath: null,
    jobs: ['typecheck', 'jest', 'eslint', 'npminstall', 'docker', 'gitfetch', 'migrate', 'k8s', 'reconcile', 'compliance'],
    bootLines: [
      '<span class="mag">$</span> npm run start:dev',
      '<span class="dim">&gt; core-ledger@5.8.2 start:dev</span>',
      '<span class="dim">&gt; nest start --watch</span>',
      '',
      '<span class="ok">[Nest]</span> <span class="dim">LedgerModule dependencies initialized</span>',
      '<span class="ok">[Nest]</span> <span class="dim">AccountsModule dependencies initialized</span>',
      '<span class="ok">[Nest]</span> <span class="dim">Application successfully started on port 3000</span>',
      '  <span class="dim">watching for file changes...</span>',
    ],
    fileList: () => [
      ['src/ledger/ledger.service.ts', genLargeTsClass(BK_LEDGER, 'LedgerService', 'ledger posting', ['validatePosting', 'lockAccounts', 'calculateBalances', 'writeJournal', 'publishPostingEvent', 'reconcilePosting'], 545), true],
      ['src/ledger/transaction.validator.ts', BK_VALIDATOR, true],
      ['risk/fraud_rules.py', BK_FRAUD, true],
      ['src/ledger/interest.calculator.ts', BK_INTEREST, true],
      ['migrations/002_add_ledger_tables.sql', BK_MIGRATION, true],
      ['src/ledger/ledger.types.ts', BK_TYPES],
      ['src/accounts/account.repository.ts', BK_REPO],
      ['src/accounts/iban.utils.ts', BK_IBAN],
      ['src/audit/audit.logger.ts', BK_AUDIT],
      ['src/ledger/__tests__/ledger.service.spec.ts', genSpec('LedgerService', '../ledger.service', ['commits balanced postings atomically', 'rejects postings that do not sum to zero', 'refuses overdrafts on plain accounts', 'is idempotent per idempotency key'])],
      ['src/ledger/__tests__/transaction.validator.spec.ts', genSpec('TransactionValidator', '../transaction.validator', ['rejects floating point amounts', 'rejects invalid IBANs', 'enforces the single-posting limit'])],
      ['src/accounts/__tests__/iban.utils.spec.ts', genSpec('isValidIban', '../iban.utils', ['accepts a valid German IBAN', 'rejects a mangled checksum', 'ignores whitespace and case'])],
      ['Dockerfile', genDockerfile('node:20-alpine', ['npm ci --omit=dev', 'npm run build'], '["node", "dist/main.js"]')],
      ['package.json', genPackageJson('core-ledger', '5.8.2', [['@nestjs/common', '^10.3.0'], ['typeorm', '^0.3.20'], ['pg', '^8.11.5']], [['start:dev', 'nest start --watch'], ['build', 'nest build'], ['test', 'jest --colors'], ['lint', 'eslint src']])],
      ['tsconfig.json', genTsconfig()],
      ['.github/ci.yml', genCi('core-ledger')],
      ['.env.example', genEnv([['DATABASE_URL', 'postgres://localhost:5432/ledger'], ['AUDIT_WORM_ENDPOINT', 'https://worm.internal.corp'], ['FRAUD_THRESHOLD', '0.8']])],
      ['README.md', genReadme('core-ledger', 'Double-entry ledger service. Money in, money out, always balanced.', ['NestJS (TypeScript)', 'PostgreSQL 16 with SERIALIZABLE transactions', 'Python risk rules', 'Nightly reconciliation'])],
    ],
    tree: () => [
      d('.github', [fnode('.github/ci.yml')]),
      d('src', [
        d('ledger', [
          d('__tests__', [fnode('src/ledger/__tests__/ledger.service.spec.ts'), fnode('src/ledger/__tests__/transaction.validator.spec.ts')]),
          fnode('src/ledger/ledger.service.ts'), fnode('src/ledger/transaction.validator.ts'),
          fnode('src/ledger/interest.calculator.ts'), fnode('src/ledger/ledger.types.ts'),
        ], true),
        d('accounts', [
          d('__tests__', [fnode('src/accounts/__tests__/iban.utils.spec.ts')]),
          fnode('src/accounts/account.repository.ts'), fnode('src/accounts/iban.utils.ts'),
        ], true),
        d('audit', [fnode('src/audit/audit.logger.ts')], true),
      ], true),
      d('risk', [fnode('risk/fraud_rules.py')], true),
      d('migrations', [fnode('migrations/002_add_ledger_tables.sql')], true),
      d('node_modules', [d('@nestjs', []), d('typeorm', []), d('pg', []), d('left-pad', [])]),
      fnode('Dockerfile'), fnode('package.json'), fnode('tsconfig.json'), fnode('.env.example'), fnode('README.md'),
    ],
  },

  gamedev: {
    id: 'gamedev',
    label: 'Game development',
    stack: 'WebGL engine · TypeScript + GLSL',
    desc: 'A 2D engine: particles, physics, enemy AI, shaders and an asset pipeline.',
    project: 'ember-engine',
    version: '0.9.4',
    branch: 'feature/ENG-451-particles',
    remote: 'github.internal.corp:studio/ember-engine',
    image: 'registry.internal.corp/studio/ember-engine',
    deployName: 'ember-playtest',
    namespace: 'playtest',
    dbLine: null,
    migrateLines: [],
    lintFiles: [
      ['src/render/renderer.ts', '17:33  Unexpected magic number: 90', 'no-magic-numbers'],
      ['src/particles/particle.system.ts', '23:91  Line exceeds maximum length of 90', 'max-len'],
    ],
    suites: [
      ['src/physics/__tests__/physics.world.spec.ts', 8, 12],
      ['src/particles/__tests__/particle.system.spec.ts', 6, 10],
    ],
    checkFiles: 96,
    termproc: 'node — ember-engine',
    hmrPath: '/src/particles/particle.system.ts',
    jobs: ['typecheck', 'jest', 'vitebuild', 'eslint', 'npminstall', 'gitfetch', 'hmr', 'atlas', 'shaderc', 'fps'],
    bootLines: [
      '<span class="mag">$</span> npm run dev',
      '<span class="dim">&gt; ember-engine@0.9.4 dev</span>',
      '<span class="dim">&gt; vite --host</span>',
      '',
      '  <span class="ok">VITE v5.2.8</span>  <span class="dim">ready in 512 ms</span>',
      '',
      '  <span class="ok">➜</span>  <span class="dim">Local:</span>   <span class="info">http://localhost:5173/playtest</span>',
      '  <span class="dim">watching for file changes...</span>',
    ],
    fileList: () => [
      ['src/particles/particle.system.ts', genLargeTsClass(GD_PARTICLE, 'ParticleSystem', 'particle simulation', ['validateEmitter', 'normalizeBurst', 'allocateParticles', 'integrateFrame', 'reclaimParticles', 'publishMetrics'], 530), true],
      ['src/physics/physics.world.ts', GD_PHYSICS, true],
      ['shaders/fire.frag', GD_SHADER, true],
      ['src/levels/level.loader.ts', GD_LEVEL, true],
      ['src/ai/enemy.ai.ts', GD_ENEMY, true],
      ['src/render/renderer.ts', GD_RENDERER],
      ['src/input/input.manager.ts', GD_INPUT],
      ['src/math/vec2.ts', GD_VEC2],
      ['assets/assets.manifest.json', GD_MANIFEST],
      ['src/physics/__tests__/physics.world.spec.ts', genSpec('PhysicsWorld', '../physics.world', ['resolves overlaps along the shallow axis', 'marks bodies grounded on floor contact', 'survives a spiral-of-death frame'])],
      ['src/particles/__tests__/particle.system.spec.ts', genSpec('ParticleSystem', '../particle.system', ['never exceeds the particle pool', 'swap-removes dead particles', 'fades particles by remaining life'])],
      ['package.json', genPackageJson('ember-engine', '0.9.4', [['vite', '^5.2.8'], ['typescript', '^5.4.0']])],
      ['tsconfig.json', genTsconfig()],
      ['.github/ci.yml', genCi('ember-engine')],
      ['README.md', genReadme('ember-engine', 'In-house 2D engine for the untitled roguelike. Runs at 143 fps out of spite.', ['TypeScript + WebGL', 'GLSL shaders', 'Fixed-timestep physics', 'JSON levels (the editor is a spreadsheet)'])],
    ],
    tree: () => [
      d('.github', [fnode('.github/ci.yml')]),
      d('assets', [fnode('assets/assets.manifest.json')], true),
      d('shaders', [fnode('shaders/fire.frag')], true),
      d('src', [
        d('ai', [fnode('src/ai/enemy.ai.ts')], true),
        d('input', [fnode('src/input/input.manager.ts')]),
        d('levels', [fnode('src/levels/level.loader.ts')], true),
        d('math', [fnode('src/math/vec2.ts')]),
        d('particles', [
          d('__tests__', [fnode('src/particles/__tests__/particle.system.spec.ts')]),
          fnode('src/particles/particle.system.ts'),
        ], true),
        d('physics', [
          d('__tests__', [fnode('src/physics/__tests__/physics.world.spec.ts')]),
          fnode('src/physics/physics.world.ts'),
        ], true),
        d('render', [fnode('src/render/renderer.ts')], true),
      ], true),
      d('node_modules', [d('vite', []), d('typescript', []), d('left-pad', [])]),
      fnode('package.json'), fnode('tsconfig.json'), fnode('README.md'),
    ],
  },

  ml: {
    id: 'ml',
    label: 'Data & Machine Learning',
    stack: 'PyTorch · pandas · Python + SQL',
    desc: 'Churn prediction pipeline: features, training runs, evaluation, registry.',
    project: 'insight-pipeline',
    version: '2.4.0',
    branch: 'feature/ML-88-churn-model',
    remote: 'gitlab.internal.corp:data/insight-pipeline',
    image: 'registry.internal.corp/data/insight-pipeline',
    deployName: 'insight-batch',
    namespace: 'data-staging',
    dbLine: 'postgres://warehouse-replica:5432/analytics',
    migrateLines: [],
    lintFiles: [
      ['pipeline/feature_builder.py', '22:89  Line too long (90 > 88)', 'E501'],
      ['pipeline/evaluate.py', '41:16  Local variable "recall" is assigned to but never used', 'F841'],
    ],
    suites: [
      ['tests/test_features.py', 7, 11],
      ['tests/test_evaluate.py', 5, 8],
    ],
    checkFiles: 58,
    termproc: 'python — insight-pipeline',
    hmrPath: null,
    jobs: ['pytest', 'ruff', 'pipinstall', 'gitfetch', 'dataset', 'train', 'onnx', 'docker'],
    bootLines: [
      '<span class="mag">$</span> source .venv/bin/activate',
      '<span class="mag">$</span> make watch',
      '<span class="dim">watchdog: observing pipeline/, sql/, configs/</span>',
      '<span class="dim">mlflow: tracking uri set to http://mlflow.internal:5000</span>',
      '  <span class="dim">watching for file changes...</span>',
    ],
    fileList: () => [
      ['pipeline/train_model.py', genLargePythonModule(ML_TRAIN, 'TrainingRunAuditor', 'training run', ['validate_batch', 'normalize_features', 'record_metric', 'persist_checkpoint', 'publish_artifact', 'reconcile_run'], 1200), true],
      ['pipeline/feature_builder.py', ML_FEATURES, true],
      ['pipeline/evaluate.py', ML_EVAL, true],
      ['sql/churn_dataset.sql', ML_SQL, true],
      ['pipeline/model_registry.py', ML_REGISTRY],
      ['pipeline/export.py', ML_EXPORT],
      ['configs/config.yml', ML_CONFIG],
      ['requirements.txt', ML_REQS],
      ['Makefile', ML_MAKE],
      ['Dockerfile', genDockerfile('python:3.11-slim', ['pip install -r requirements.txt'], '["python", "-m", "pipeline.train_model"]')],
      ['tests/test_features.py', genPyTest('pipeline.feature_builder', ['fills_missing_session_minutes', 'one_hot_encodes_categoricals', 'normalizes_numeric_columns'])],
      ['tests/test_evaluate.py', genPyTest('pipeline.evaluate', ['auc_is_between_zero_and_one', 'threshold_respects_target_precision'])],
      ['.env.example', genEnv([['WAREHOUSE_DSN', 'postgres://warehouse-replica:5432/analytics'], ['MLFLOW_TRACKING_URI', 'http://mlflow.internal:5000'], ['DEVICE', 'auto']])],
      ['README.md', genReadme('insight-pipeline', 'Churn prediction pipeline. The model is fine. The data is a journey.', ['PyTorch 2.3', 'pandas + pyarrow', 'Nightly snapshot from the warehouse', 'MLflow-adjacent homegrown registry'])],
    ],
    tree: () => [
      d('configs', [fnode('configs/config.yml')], true),
      d('pipeline', [
        fnode('pipeline/train_model.py'), fnode('pipeline/feature_builder.py'),
        fnode('pipeline/evaluate.py'), fnode('pipeline/model_registry.py'),
        fnode('pipeline/export.py'),
      ], true),
      d('sql', [fnode('sql/churn_dataset.sql')], true),
      d('tests', [fnode('tests/test_features.py'), fnode('tests/test_evaluate.py')], true),
      d('.venv', [d('lib', []), d('bin', [])]),
      fnode('Dockerfile'), fnode('Makefile'), fnode('requirements.txt'), fnode('.env.example'), fnode('README.md'),
    ],
  },
};

/* ================= terminal job library ================= */
/* every job: async (t, gen) — t is the topic, gen the topic generation guard */

const JOBLIB = {

  async typecheck(t, gen) {
    stamp('<span class="mag">$</span> npx tsc --noEmit --incremental');
    await gs(rand(1200, 2400), gen);
    tline('<span class="dim">' + t.project + ': checking ' + t.checkFiles + ' files...</span>');
    await gs(rand(1800, 3200), gen);
    tline('<span class="ok">✓</span> Found 0 errors. Watching for file changes.');
  },

  async jest(t, gen) {
    stamp('<span class="mag">$</span> npm test');
    await gs(700, gen);
    tline('<span class="dim">&gt; ' + t.project + '@' + t.version + ' test</span>');
    tline('<span class="dim">&gt; jest --runInBand --colors</span>');
    await gs(rand(1000, 1800), gen);
    let total = 0;
    for (const [name, lo, hi] of t.suites) {
      await gs(rand(500, 1400), gen);
      const count = rand(lo, hi);
      total += count;
      tline('<span class="ok"> PASS </span> ' + name + ' <span class="dim">(' + (rand(80, 900) / 100).toFixed(2) + ' s)</span>');
    }
    await gs(600, gen);
    tline('');
    tline('<span class="dim">Test Suites:</span> <span class="ok">' + t.suites.length + ' passed</span>, ' + t.suites.length + ' total');
    tline('<span class="dim">Tests:</span>       <span class="ok">' + total + ' passed</span>, ' + total + ' total');
  },

  async pytest(t, gen) {
    stamp('<span class="mag">$</span> python -m pytest -q');
    await gs(rand(900, 1600), gen);
    for (const [name, lo, hi] of t.suites) {
      await gs(rand(500, 1200), gen);
      tline(name + ' <span class="ok">' + '.'.repeat(rand(lo, hi)) + '</span>');
    }
    await gs(500, gen);
    const total = t.suites.reduce((acc, s) => acc + rand(s[1], s[2]), 0);
    tline('<span class="ok">' + total + ' passed</span><span class="dim">, 0 failed, 2 warnings in ' + (rand(200, 900) / 100).toFixed(2) + 's</span>');
  },

  async vitebuild(t, gen) {
    stamp('<span class="mag">$</span> npm run build');
    await gs(600, gen);
    tline('<span class="dim">&gt; vite build</span>');
    await gs(rand(600, 1200), gen);
    tline('<span class="info">vite v5.2.8</span> <span class="dim">building for production...</span>');
    await progressBar('<span class="dim">transforming</span>', rand(3000, 6000), ' <span class="dim">(' + rand(300, 900) + ' modules)</span>', gen);
    await gs(400, gen);
    tline('<span class="dim">dist/assets/index-a4f81c2e.js   </span>' + rand(180, 420) + '.42 kB <span class="dim">│ gzip: ' + rand(48, 120) + '.11 kB</span>');
    tline('<span class="ok">✓ built in ' + (rand(200, 700) / 100).toFixed(2) + 's</span>');
  },

  async eslint(t, gen) {
    stamp('<span class="mag">$</span> npx eslint . --max-warnings 20');
    await gs(rand(1500, 3000), gen);
    for (const [file, msg, rule] of t.lintFiles) {
      tline('<span class="dim">' + file + '</span>');
      tline('  <span class="warn">warning</span>  ' + msg + '  <span class="dim">' + rule + '</span>');
    }
    await gs(500, gen);
    tline('<span class="warn">✖ ' + t.lintFiles.length + ' problems (0 errors, ' + t.lintFiles.length + ' warnings)</span>');
  },

  async ruff(t, gen) {
    stamp('<span class="mag">$</span> ruff check pipeline/ tests/');
    await gs(rand(700, 1400), gen);
    for (const [file, msg, rule] of t.lintFiles) {
      tline('<span class="dim">' + file + '</span>:' + msg.trim().split(/\s+/)[0] + ' <span class="warn">' + rule + '</span> ' + msg.replace(/^[\d:]+\s+/, ''));
    }
    await gs(400, gen);
    tline('Found ' + t.lintFiles.length + ' warnings. <span class="dim">No fixes applied (coward mode).</span>');
  },

  async npminstall(t, gen) {
    stamp('<span class="mag">$</span> npm ci --prefer-offline');
    await progressBar('<span class="dim">reify:esbuild</span>', rand(2500, 5000), '', gen);
    await gs(400, gen);
    tline('added ' + rand(400, 1400) + ' packages, and audited ' + rand(1400, 1900) + ' packages in ' + rand(4, 18) + 's');
    tline(rand(2, 4) + ' <span class="warn">moderate</span> severity vulnerabilities');
    tline('<span class="dim">  npm audit fix --force   (do not run npm audit fix --force)</span>');
  },

  async pipinstall(t, gen) {
    stamp('<span class="mag">$</span> pip install -r requirements.txt');
    await gs(rand(800, 1500), gen);
    tline('<span class="dim">Requirement already satisfied: torch==2.3.1</span>');
    tline('<span class="dim">Requirement already satisfied: pandas==2.2.2</span>');
    await progressBar('<span class="dim">Downloading pyarrow-16.1.0</span>', rand(2000, 4000), '', gen);
    tline('<span class="ok">Successfully installed</span> pyarrow-16.1.0');
  },

  async docker(t, gen) {
    stamp('<span class="mag">$</span> docker build -t ' + t.image + ':dev .');
    await gs(800, gen);
    const steps = ['[1/6] FROM base image', '[2/6] WORKDIR /app', '[3/6] COPY manifests', '[4/6] RUN install dependencies', '[5/6] COPY . .', '[6/6] RUN build'];
    for (const s of steps) {
      await gs(rand(500, s.includes('RUN') ? 3500 : 1000), gen);
      tline('<span class="info">=&gt;</span> ' + esc(s) + ' <span class="dim">' + (rand(1, 60) / 10).toFixed(1) + 's</span>');
    }
    await gs(600, gen);
    tline('<span class="ok">✓</span> naming to ' + t.image + ':dev');
  },

  async gitfetch(t, gen) {
    stamp('<span class="mag">$</span> git fetch origin');
    await gs(rand(1200, 2500), gen);
    tline('<span class="dim">remote: Enumerating objects: ' + rand(20, 200) + ', done.</span>');
    tline('From ' + t.remote);
    tline('   <span class="dim">a41f2c8..' + rand(100000, 999999).toString(16) + '</span>  main       -&gt; origin/main');
    await gs(500, gen);
    tline('<span class="dim">Your branch is up to date with origin/' + t.branch + '.</span>');
  },

  async migrate(t, gen) {
    if (!t.migrateLines.length) return;
    stamp('<span class="mag">$</span> npm run db:migrate:dry-run');
    await gs(rand(1000, 2000), gen);
    tline('<span class="dim">Connecting to ' + t.dbLine + '...</span>');
    await gs(800, gen);
    for (const m of t.migrateLines) tline('<span class="info">pending</span>  ' + m);
    await gs(600, gen);
    tline('<span class="ok">✓</span> dry run complete. ' + t.migrateLines.length + ' migrations would be applied. <span class="dim">(nothing was harmed)</span>');
  },

  async hmr(t, gen) {
    if (!t.hmrPath) return;
    stamp('<span class="dim">[vite]</span> hmr update <span class="dim">' + t.hmrPath + '</span>');
    await gs(rand(200, 500), gen);
    tline('<span class="dim">[vite]</span> <span class="ok">✓</span> compiled in ' + rand(120, 900) + 'ms');
  },

  async k8s(t, gen) {
    stamp('<span class="mag">$</span> kubectl -n ' + t.namespace + ' rollout status deploy/' + t.deployName);
    await gs(rand(1000, 1800), gen);
    tline('Waiting for deployment "' + t.deployName + '" rollout to finish: 1 of 3 updated replicas are available...');
    await gs(rand(1500, 3000), gen);
    tline('Waiting for deployment "' + t.deployName + '" rollout to finish: 2 of 3 updated replicas are available...');
    await gs(rand(1500, 3000), gen);
    tline('<span class="ok">deployment "' + t.deployName + '" successfully rolled out</span>');
  },

  async reconcile(t, gen) {
    stamp('<span class="mag">$</span> npm run reconcile:nightly -- --dry-run');
    await gs(rand(1000, 2000), gen);
    tline('<span class="dim">loading ledger entries since last checkpoint...</span>');
    await progressBar('<span class="dim">reconciling accounts</span>', rand(3000, 5000), '', gen);
    tline('checked ' + rand(4000, 9000) + ' accounts, ' + rand(60000, 140000) + ' entries');
    tline('<span class="ok">✓ reconciliation complete: 0 discrepancies</span> <span class="dim">(this time)</span>');
  },

  async compliance(t, gen) {
    stamp('<span class="mag">$</span> npx compliance-scan --profile psd2');
    await gs(rand(1500, 2800), gen);
    tline('<span class="dim">scanning endpoints for auth coverage...</span>');
    tline('<span class="dim">scanning logs for PII leakage...</span>');
    await gs(rand(1500, 2500), gen);
    tline('<span class="ok">✓ 0 violations</span>, 1 advisory: <span class="dim">"consider rotating the rotation policy"</span>');
  },

  async atlas(t, gen) {
    stamp('<span class="mag">$</span> npm run assets:pack');
    await gs(600, gen);
    tline('<span class="dim">packing 214 sprites into atlas_main.png...</span>');
    await progressBar('<span class="dim">bin packing</span>', rand(2500, 4500), '', gen);
    tline('atlas_main.png  2048x2048  <span class="dim">(94.1% occupancy — the packer is showing off)</span>');
    tline('<span class="ok">✓ atlas rebuilt</span>, 3 sprites resized, 0 lost');
  },

  async shaderc(t, gen) {
    stamp('<span class="mag">$</span> npm run shaders:compile');
    await gs(rand(600, 1200), gen);
    await gs(rand(250, 700), gen);
    tline('<span class="ok">✓</span> fire.frag <span class="dim">compiled, ' + rand(40, 200) + ' instructions</span>');
    tline('<span class="dim">1 compiled, 3 unchanged (cache hit), 0 failed. art director satisfaction: unverified</span>');
  },

  async fps(t, gen) {
    stamp('<span class="mag">$</span> npm run bench:frame');
    await gs(rand(1200, 2200), gen);
    tline('<span class="dim">simulating 4096 particles (pool max) + 800 bodies for 10s...</span>');
    await gs(rand(2500, 4000), gen);
    const avg = rand(138, 152);
    tline('avg <span class="ok">' + avg + ' fps</span>, 1% low ' + (avg - rand(18, 30)) + ' fps, worst frame ' + (rand(90, 140) / 10).toFixed(1) + 'ms');
    tline('<span class="dim">verdict: smooth. ship it before someone adds a feature.</span>');
  },

  async dataset(t, gen) {
    stamp('<span class="mag">$</span> python -m pipeline.snapshot --refresh');
    await gs(rand(900, 1600), gen);
    tline('<span class="dim">querying ' + t.dbLine + '...</span>');
    await progressBar('<span class="dim">fetching churn_snapshot</span>', rand(3000, 5500), '', gen);
    tline('wrote data/churn_features.parquet  <span class="dim">(' + rand(120, 480) + ' MB, ' + rand(800, 2400) + 'k rows)</span>');
    tline('<span class="ok">✓ snapshot refreshed</span>, schema drift: <span class="dim">none detected</span>');
  },

  async train(t, gen) {
    stamp('<span class="mag">$</span> python -m pipeline.train_model --data data/churn_features.parquet');
    await gs(rand(1200, 2200), gen);
    tline('<span class="dim">device: cuda:0 | features: 47 | rows: 1.2M</span>');
    let loss = 0.6931 - Math.random() * 0.05;
    const epochs = rand(6, 9);
    for (let e = 1; e <= epochs; e++) {
      await gs(rand(1500, 2800), gen);
      loss = Math.max(0.18, loss * (0.86 + Math.random() * 0.07));
      const line = 'epoch ' + e + '/' + 20 + '  <span class="info">loss=' + loss.toFixed(5) + '</span>  <span class="dim">val_auc=' + (0.79 + (0.6931 - loss) * 0.2).toFixed(4) + '</span>';
      tline(line);
    }
    tline('<span class="dim">checkpoint saved. training continues in background...</span>');
  },

  async onnx(t, gen) {
    stamp('<span class="mag">$</span> python -m pipeline.export --format onnx');
    await gs(rand(1200, 2400), gen);
    tline('<span class="dim">tracing model with example batch...</span>');
    await gs(rand(1000, 2000), gen);
    tline('<span class="ok">✓ exported</span> artifacts/churn_v3.onnx <span class="dim">(1.8 MB, opset 17)</span>');
    tline('<span class="dim">parity check: max delta 3.1e-7 (close enough for finance)</span>');
  },
};

/* ================= file metadata ================= */

const EXTMETA = {
  ts:   { lang: 'ts',   mode: 'TypeScript',     icon: 'TS',  cls: 'ts'  },
  tsx:  { lang: 'ts',   mode: 'TypeScript JSX', icon: 'TSX', cls: 'tsx' },
  py:   { lang: 'py',   mode: 'Python',         icon: 'PY',  cls: 'py'  },
  yml:  { lang: 'yml',  mode: 'YAML',           icon: 'YML', cls: 'yml' },
  json: { lang: 'json', mode: 'JSON',           icon: '{}',  cls: 'json'},
  sql:  { lang: 'sql',  mode: 'SQL',            icon: 'SQL', cls: 'sql' },
  frag: { lang: 'glsl', mode: 'GLSL',           icon: 'GL',  cls: 'frag'},
  md:   { lang: 'plain',mode: 'Markdown',       icon: 'M↓',  cls: 'md'  },
  txt:  { lang: 'plain',mode: 'Plain Text',     icon: '≡',   cls: 'txt' },
  env:  { lang: 'plain',mode: 'Properties',     icon: '⚙',   cls: 'env' },
};

function extOf(path) {
  const name = path.split('/').pop();
  if (name.startsWith('.env')) return 'env';
  return name.split('.').pop().toLowerCase();
}

/* ================= global state ================= */

let TOPIC = null;
let REG = {};
let rotation = [];
let rotIdx = 0;
let openTabs = [];
let ap = '';
let TREE = [];
let DIRS = {};
let didCounter = 0;
let topicGen = 0;
let fileSwitchPending = false;
let lastKey = Date.now();

const doneEl   = document.getElementById('done');
const curlnEl  = document.getElementById('curln');
const curlcEl  = document.getElementById('curlc');
const codewrap = document.getElementById('codewrap');
const mapEl    = document.getElementById('minimap');
const lncolEl  = document.getElementById('lncol');
const tabsEl   = document.getElementById('tabs');
const crumbsEl = document.getElementById('breadcrumbs');
const langEl   = document.getElementById('langmode');
const titleEl  = document.getElementById('wintitle');
const treeEl   = document.getElementById('tree');
const termEl   = document.getElementById('term');
const errEl    = document.getElementById('errcount');
const branchEl = document.getElementById('branch');
const welcomeEl = document.getElementById('welcome');

function lineCountOf(f) {
  return f.content.endsWith('\n') ? f.lines.length - 1 : f.lines.length;
}

function resetTyped(f) {
  f.st = { pos: 0, lineNo: 1, curText: '', doneHtml: '' };
}

/* ================= tree ================= */

function d(name, children, open) {
  const node = { dir: true, id: didCounter++, name, children: children || [], open: !!open };
  DIRS[node.id] = node;
  return node;
}
function fnode(path) { return { path }; }

function renderTree() {
  let html = '';
  (function walk(nodes, depth) {
    for (const n of nodes) {
      const pad = 10 + depth * 14;
      if (n.dir) {
        html += '<div class="item dir" data-did="' + n.id + '" style="padding-left:' + pad + 'px">' +
                '<span class="arrow">' + (n.open ? '▾' : '▸') + '</span>' + esc(n.name) + '</div>';
        if (n.open) walk(n.children, depth + 1);
      } else {
        const f = REG[n.path];
        if (!f) continue;
        html += '<div class="item' + (n.path === ap ? ' active' : '') + '" data-path="' + n.path + '" style="padding-left:' + (pad + 12) + 'px">' +
                '<span class="fico ' + f.cls + '">' + esc(f.icon) + '</span>' + esc(f.name) + '</div>';
      }
    }
  })(TREE, 0);
  treeEl.innerHTML = html;
}

treeEl.addEventListener('click', e => {
  const dirEl = e.target.closest('.item.dir');
  if (dirEl) {
    const node = DIRS[Number(dirEl.dataset.did)];
    node.open = !node.open;
    renderTree();
    return;
  }
  const fileEl = e.target.closest('.item[data-path]');
  if (fileEl) openPath(fileEl.dataset.path);
});

/* ================= editor rendering ================= */

function renderTabs() {
  tabsEl.innerHTML = openTabs.map(p => {
    const f = REG[p];
    const dirty = f.typed && f.st.pos > 0 && f.st.pos < f.content.length;
    return '<div class="tab' + (p === ap ? ' active' : '') + (dirty ? ' dirty' : '') + '" data-path="' + p + '">' +
           '<span class="fico ' + f.cls + '">' + esc(f.icon) + '</span>' + esc(f.name) + '<span class="dot">•</span></div>';
  }).join('');
}

tabsEl.addEventListener('click', e => {
  const t = e.target.closest('.tab');
  if (t) openPath(t.dataset.path);
});

function renderCrumbs() {
  crumbsEl.innerHTML = ap.split('/').map(esc).join('<span class="sep">›</span>');
}

function cacheFor(f) {
  if (!f.cache) {
    let html = '';
    const n = lineCountOf(f);
    for (let i = 0; i < n; i++) {
      html += '<div class="line"><span class="ln">' + (i + 1) + '</span><span class="lc">' + hl(f.lines[i], f.lang) + '</span></div>';
    }
    f.cache = html;
  }
  return f.cache;
}

function mapHtmlFor(f) {
  const total = lineCountOf(f);
  const committed = f.typed ? f.st.lineNo - 1 : total;
  let html = '';
  for (let i = 0; i < total; i++) {
    const text = f.lines[i] || '';
    const trimmed = text.trim();
    const w = Math.min(96, Math.max(4, Math.round(text.length * 1.4)));
    let cls = 'mbar';
    if (i < committed) {
      cls += ' on';
      if (trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('--')) cls += ' c';
    }
    if (f.typed && i === committed) cls += ' cur';
    html += '<div class="' + cls + '" style="width:' + w + '%"></div>';
  }
  return html;
}

function refreshCurrentLine() {
  const f = REG[ap];
  if (!f.typed) return;
  curlnEl.textContent = f.st.lineNo;
  curlcEl.innerHTML = hl(f.st.curText, f.lang);
  lncolEl.textContent = 'Ln ' + f.st.lineNo + ', Col ' + (f.st.curText.length + 1);
}

function rebuildEditor() {
  const f = REG[ap];
  clearBug();
  if (f.typed) {
    codewrap.classList.remove('static');
    doneEl.innerHTML = f.st.doneHtml;
    refreshCurrentLine();
  } else {
    codewrap.classList.add('static');
    doneEl.innerHTML = cacheFor(f);
    lncolEl.textContent = 'Ln 1, Col 1';
  }
  mapEl.innerHTML = mapHtmlFor(f);
  renderTabs();
  renderCrumbs();
  renderTree();
  langEl.textContent = f.mode;
  titleEl.textContent = f.name + ' — ' + TOPIC.project + ' — Visual Studio Code';
  document.title = titleEl.textContent;
  codewrap.scrollTop = f.typed ? codewrap.scrollHeight : 0;
}

function openPath(p) {
  if (!REG[p]) return;
  if (REG[p].typed) rotIdx = rotation.indexOf(p);
  if (p === ap && openTabs.includes(p)) return;
  if (!openTabs.includes(p)) {
    openTabs.push(p);
    if (openTabs.length > 7) {
      const evict = openTabs.find(x => x !== p && x !== ap);
      if (evict) openTabs.splice(openTabs.indexOf(evict), 1);
    }
  }
  ap = p;
  rebuildEditor();
}

/* ================= typing engine ================= */

function ensureRotActive() {
  const p = rotation[rotIdx];
  if (ap !== p) openPath(p);
}

function commitLine(f) {
  const idx = f.st.lineNo - 1;
  const trimmed = f.st.curText.trim();
  const bp = bpMap[ap] && bpMap[ap].has(f.st.lineNo) ? ' bp' : '';
  const lineHtml = '<div class="line"><span class="ln' + bp + '">' + f.st.lineNo + '</span><span class="lc">' + hl(f.st.curText, f.lang) + '</span></div>';
  f.st.doneHtml += lineHtml;
  doneEl.insertAdjacentHTML('beforeend', lineHtml);
  const bars = mapEl.children;
  if (bars[idx]) {
    let cls = 'mbar on';
    if (trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('--')) cls += ' c';
    bars[idx].className = cls;
  }
  if (bars[idx + 1]) bars[idx + 1].classList.add('cur');
  f.st.curText = '';
  f.st.lineNo += 1;
}

function advance(n) {
  if (fileSwitchPending || !TOPIC) return;
  ensureRotActive();
  const f = REG[ap];
  const c = f.content;
  for (let i = 0; i < n && f.st.pos < c.length; i++) {
    const ch = c[f.st.pos++];
    if (ch === '\n') commitLine(f);
    else f.st.curText += ch;
  }
  refreshCurrentLine();
  codewrap.scrollTop = codewrap.scrollHeight;
  if (f.st.pos >= c.length) fileDone();
}

function backspace() {
  if (fileSwitchPending || !TOPIC) return;
  ensureRotActive();
  const f = REG[ap];
  const remove = Math.min(3, f.st.curText.length);
  if (remove === 0) return;
  f.st.curText = f.st.curText.slice(0, -remove);
  f.st.pos -= remove;
  refreshCurrentLine();
}

function fileDone() {
  fileSwitchPending = true;
  const gen = topicGen;
  renderTabs();
  termSaveSequence(REG[ap].name, gen);
  setTimeout(() => {
    if (gen !== topicGen) return;
    fileSwitchPending = false;
    rotIdx = (rotIdx + 1) % rotation.length;
    const next = rotation[rotIdx];
    resetTyped(REG[next]);
    if (ap === next) rebuildEditor();
    else openPath(next);
  }, 900);
}

/* ================= keyboard + speed ================= */

const SPEEDS = [
  { label: 1, min: 1, max: 1 },
  { label: 2, min: 1, max: 2 },
  { label: 4, min: 3, max: 4 },
];
let speedIdx = 1;
const spacesEl = document.getElementById('spaces');
spacesEl.addEventListener('click', () => {
  speedIdx = (speedIdx + 1) % SPEEDS.length;
  spacesEl.textContent = 'Spaces: ' + SPEEDS[speedIdx].label;
});

document.addEventListener('keydown', e => {
  const tag = e.target && e.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return; // real inputs (search, commit box) type normally
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
  if (welcomeEl.classList.contains('show')) return;
  const handled = e.key.length === 1 || ['Backspace', 'Tab', 'Enter'].includes(e.key);
  if (!handled) return;
  e.preventDefault();
  lastKey = Date.now();
  if (e.key === 'Backspace') backspace();
  else advance(rand(SPEEDS[speedIdx].min, SPEEDS[speedIdx].max));
});

/* ================= autopilot ================= */

let autopilot = false;
let autopause = 0;
branchEl.addEventListener('click', () => {
  chooseBranch();
});
setInterval(() => {
  if (!autopilot || welcomeEl.classList.contains('show')) return;
  if (autopause > 0) { autopause--; return; }
  if (Math.random() < 0.06) { autopause = 6 + Math.floor(Math.random() * 14); return; }
  advance(1 + Math.floor(Math.random() * 3));
}, 220);

/* ================= terminal ================= */

function nowStr() {
  const dt = new Date();
  return [dt.getHours(), dt.getMinutes(), dt.getSeconds()].map(x => String(x).padStart(2, '0')).join(':');
}

function tline(html) {
  const div = document.createElement('div');
  div.className = 'tl';
  div.innerHTML = html;
  termEl.appendChild(div);
  while (termEl.children.length > 400) termEl.removeChild(termEl.firstChild);
  termEl.scrollTop = termEl.scrollHeight;
  return div;
}

function stamp(html) {
  return tline('<span class="dim">' + nowStr() + '</span>  ' + html);
}

async function gs(ms, gen) {
  await sleep(ms);
  if (gen !== topicGen) throw new Error('topic switched');
}

async function progressBar(prefix, ms, suffix, gen) {
  const row = tline('');
  const steps = 24;
  for (let i = 0; i <= steps; i++) {
    const pct = Math.round(i / steps * 100);
    row.innerHTML = prefix + ' <span class="info">' + '█'.repeat(i) + '░'.repeat(steps - i) + '</span> ' + pct + '%' + (suffix || '');
    termEl.scrollTop = termEl.scrollHeight;
    await gs(ms / steps, gen);
  }
}

function termSaveSequence(fname, gen) {
  const checker = TOPIC.checker || 'tsc';
  stamp('<span class="dim">[watch]</span> ' + fname + ' changed');
  setTimeout(() => { if (gen === topicGen) stamp('<span class="dim">[' + checker + ']</span> incremental compile...'); }, 300);
  setTimeout(() => { if (gen === topicGen) stamp('<span class="dim">[' + checker + ']</span> <span class="ok">✓</span> 0 errors, 2 warnings. watching for changes...'); }, 850);
}

function bootTerminal() {
  termEl.innerHTML = '';
  for (const line of TOPIC.bootLines) tline(line);
}

async function termLoop() { /* Session-aware scheduler lives in workbench.js. */ }

/* ================= toasts ================= */

const toastEl = document.getElementById('toast');
let toastTimer = null;
function showToast(msg, src) {
  document.getElementById('toastmsg').textContent = msg;
  document.getElementById('toastsrc').textContent = 'Source: ' + src;
  toastEl.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 5000);
}

function toastPool() {
  return [
    ['Formatted ' + REG[rotation[0]].name + ' on save.', 'Prettier'],
    ['Settings Sync: synchronized successfully.', 'Settings Sync'],
    ['Language server restarted.', TOPIC.termproc.startsWith('python') ? 'Pylance' : 'TypeScript'],
    ['Fetched latest changes from origin.', 'GitLens'],
    ['Indexing complete: ' + TOPIC.checkFiles + ' files.', 'IntelliSense'],
    ['2 extensions updated in the background.', 'Extensions'],
  ];
}

async function toastLoop() {
  while (true) {
    await sleep(rand(150, 340) * 1000);
    if (welcomeEl.classList.contains('show')) continue;
    const [m, s] = pick(toastPool());
    showToast(m, s);
  }
}

/* ================= bug-squash minigame ================= */

let activeBug = null;
let bugTimer = null;
let bugData = loadBugs();

function loadBugs() {
  const today = new Date().toISOString().slice(0, 10);
  try {
    const raw = JSON.parse(localStorage.getItem('wb.bugs') || 'null');
    if (raw && raw.d === today) return raw;
  } catch (e) {}
  return { d: today, c: 0 };
}
function saveBugs() { try { localStorage.setItem('wb.bugs', JSON.stringify(bugData)); } catch (e) {} }
function updateBugUI() { document.getElementById('bugs').textContent = '⚡ ' + bugData.c; }

function clearBug() {
  if (activeBug) { activeBug.classList.remove('squig'); activeBug = null; }
  if (bugTimer) { clearTimeout(bugTimer); bugTimer = null; }
  errEl.textContent = 'ⓧ 0';
}

async function bugLoop() {
  while (true) {
    await sleep(rand(18, 45) * 1000);
    if (welcomeEl.classList.contains('show') || activeBug) continue;
    const spans = doneEl.querySelectorAll('.kw, .fn, .str, .dec, .key');
    if (!spans.length) continue;
    const el = pick(Array.from(spans).slice(-160));
    el.classList.add('squig');
    activeBug = el;
    errEl.textContent = 'ⓧ 1';
    bugTimer = setTimeout(() => { if (activeBug === el) clearBug(); }, 45000);
  }
}

codewrap.addEventListener('click', e => {
  const sq = e.target.closest('.squig');
  if (sq) {
    sq.classList.remove('squig');
    sq.classList.add('fixflash');
    setTimeout(() => sq.classList.remove('fixflash'), 700);
    activeBug = null;
    if (bugTimer) { clearTimeout(bugTimer); bugTimer = null; }
    errEl.textContent = 'ⓧ 0';
    bugData.c += 1;
    saveBugs();
    updateBugUI();
    if ([5, 10, 25, 50, 100, 250].includes(bugData.c)) {
      showToast('DevMetrics: ' + bugData.c + ' issues resolved today. Keep shipping!', 'DevMetrics');
    }
    return;
  }
  const line = e.target.closest('.line');
  if (line && line.id !== 'curline') {
    doneEl.querySelectorAll('.cursorline').forEach(x => x.classList.remove('cursorline'));
    line.classList.add('cursorline');
    const ln = line.querySelector('.ln');
    if (ln) lncolEl.textContent = 'Ln ' + ln.textContent + ', Col 1';
  }
});

/* ================= decorative clicks ================= */

document.getElementById('activitybar').addEventListener('click', e => {
  const icon = e.target.closest('.aicon');
  if (!icon || !icon.dataset.view) return; // gear/accounts open overlays, they don't own the highlight
  document.querySelectorAll('#activitybar .aicon').forEach(x => x.classList.remove('active'));
  icon.classList.add('active');
});

document.getElementById('paneltabs').addEventListener('click', e => {
  const tab = e.target.closest('.ptab');
  if (!tab) return;
  document.querySelectorAll('#paneltabs .ptab').forEach(x => x.classList.remove('on'));
  tab.classList.add('on');
});

/* ================= profile picker ================= */

function renderCards() {
  document.getElementById('wcards').innerHTML = Object.values(TOPICS).map(t =>
    '<div class="wcard' + (TOPIC && TOPIC.id === t.id ? ' sel' : '') + '" data-topic="' + t.id + '">' +
    '<div class="wname">' + esc(t.label) + '</div><div class="wstack">' + esc(t.stack) + '</div>' +
    '<div class="wdesc">' + esc(t.desc) + '</div></div>'
  ).join('');
}

document.getElementById('wcards').addEventListener('click', e => {
  const card = e.target.closest('.wcard');
  if (!card) return;
  welcomeEl.classList.remove('show');
  loadTopic(card.dataset.topic);
});

document.getElementById('gear').addEventListener('click', () => {
  renderCards();
  welcomeEl.classList.toggle('show');
});

/* ================= topic loading ================= */

function loadTopic(id) {
  topicGen += 1;
  TOPIC = TOPICS[id];
  fileSwitchPending = false;
  REG = {};
  for (const entry of TOPIC.fileList()) {
    const path = entry[0];
    const meta = EXTMETA[extOf(path)] || EXTMETA.txt;
    const f = {
      path,
      name: path.split('/').pop(),
      lang: meta.lang, mode: meta.mode, icon: meta.icon, cls: meta.cls,
      content: entry[1],
      lines: entry[1].split('\n'),
      typed: !!entry[2],
      st: null, cache: null,
    };
    if (f.typed) resetTyped(f);
    REG[path] = f;
  }
  rotation = Object.values(REG).filter(f => f.typed).map(f => f.path);
  rotIdx = 0;
  openTabs = rotation.slice(0, 3);
  ap = rotation[0];
  DIRS = {}; didCounter = 0;
  TREE = TOPIC.tree();
  branchEl.innerHTML = '⑂ ' + esc(TOPIC.branch) + '<span id="autodot"> ●</span>';
  document.getElementById('projname').textContent = '▾ ' + TOPIC.project.toUpperCase();

  rebuildEditor();
  advance(rand(180, 300));
  bootTerminal();
  lastKey = Date.now() - 60000; // idle until the first real keystroke
  try { localStorage.setItem('wb.topic', id); } catch (e) {}
}

/* ================= clock + boot ================= */

function tickClock() {
  const dt = new Date();
  document.getElementById('clock').textContent =
    String(dt.getHours()).padStart(2, '0') + ':' + String(dt.getMinutes()).padStart(2, '0');
}
setInterval(tickClock, 1000);
tickClock();

/* ================= desktop app (pywebview) integration ================= */
/* Only activates inside the FauxCode desktop wrapper; inert in a browser. */

window.addEventListener('pywebviewready', () => {
  document.body.classList.add('desktop-shell');
  // the fake title bar becomes the real draggable title bar
  const titleCenter = document.querySelector('#titlebar .title');
  if (titleCenter) titleCenter.classList.add('pywebview-drag-region');
  // the fake window buttons become real window buttons
  const btns = document.querySelectorAll('#titlebar .winbtns div');
  if (btns.length === 3 && window.pywebview && window.pywebview.api) {
    btns[0].addEventListener('click', () => window.pywebview.api.minimize());
    btns[1].addEventListener('click', () => window.pywebview.api.toggle_max());
    btns[2].addEventListener('click', () => window.pywebview.api.close());
  }
});


/* ================= sidebar views ================= */

const VIEWS = ['explorer', 'search', 'scm', 'debug', 'ext'];
const searchInput = document.getElementById('searchinput');

document.getElementById('activitybar').addEventListener('click', e => {
  const icon = e.target.closest('.aicon');
  if (!icon || !icon.dataset.view) return;
  const view = icon.dataset.view;
  VIEWS.forEach(v => document.getElementById('view-' + v).classList.toggle('hidden', v !== view));
  if (view === 'scm') renderScm();
  if (view === 'debug') renderDebug();
  if (view === 'ext') renderExt();
  if (view === 'search') setTimeout(() => searchInput.focus(), 50);
});

/* ================= search that actually searches ================= */

let searchTimer = null;
searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 180);
});

function runSearch() {
  const q = searchInput.value.trim().toLowerCase();
  const resEl = document.getElementById('searchresults');
  const sumEl = document.getElementById('searchsummary');
  if (q.length < 2) { resEl.innerHTML = ''; sumEl.textContent = ''; return; }

  let total = 0, fileCount = 0, html = '';
  for (const path in REG) {
    const f = REG[path];
    const n = lineCountOf(f);
    let rows = '';
    let count = 0;
    for (let i = 0; i < n && count < 20; i++) {
      const line = f.lines[i];
      const idx = line.toLowerCase().indexOf(q);
      if (idx < 0) continue;
      count++;
      const start = Math.max(0, idx - 30);
      const before = (start > 0 ? '…' : '') + line.slice(start, idx);
      const match = line.slice(idx, idx + q.length);
      const after = line.slice(idx + q.length, idx + q.length + 70);
      rows += '<div class="srow" data-path="' + path + '" data-line="' + (i + 1) + '">' +
              '<span class="sln">' + (i + 1) + '</span>' +
              esc(before) + '<mark>' + esc(match) + '</mark>' + esc(after) + '</div>';
    }
    if (!count) continue;
    fileCount++;
    total += count;
    html += '<div class="sfile" data-path="' + path + '"><span class="fico ' + f.cls + '">' + esc(f.icon) + '</span>' +
            esc(f.name) + '<span class="scount">' + count + '</span></div>' + rows;
    if (total > 200) break;
  }
  sumEl.textContent = total ? total + ' results in ' + fileCount + ' files' : 'No results found. It compiles anyway.';
  resEl.innerHTML = html;
}

document.getElementById('searchresults').addEventListener('click', e => {
  const row = e.target.closest('.srow');
  if (row) { jumpTo(row.dataset.path, Number(row.dataset.line)); return; }
  const fileHead = e.target.closest('.sfile');
  if (fileHead) openPath(fileHead.dataset.path);
});

function jumpTo(path, line) {
  openPath(path);
  const f = REG[path];
  if (!f) return;
  line = Math.max(1, Math.min(lineCountOf(f), line));
  if (f.typed && f.st.lineNo <= line) {
    const visible = f.lines.slice(0, line);
    f.st = {pos: visible.join('\n').length + 1, lineNo: line + 1, curText: '', doneHtml: visible.map((text, i) => '<div class="line"><span class="ln">' + (i + 1) + '</span><span class="lc">' + hl(text, f.lang) + '</span></div>').join('')};
    rebuildEditor();
  }
  const target = doneEl.children[line - 1];
  if (target) {
    target.scrollIntoView({ block: 'center' });
    target.classList.add('searchhit');
    setTimeout(() => target.classList.remove('searchhit'), 1400);
  } else {
    codewrap.scrollTop = codewrap.scrollHeight; // not "written" yet — land at the caret
  }
}

/* ================= source control ================= */

const scmChanges = new Set();
let aheadCount = 0;

const COMMIT_MSGS = [
  'fix: works now, do not ask why',
  'chore: appease the linter',
  'refactor: rename things until it compiles',
  'test: make CI green again',
  'fix: off-by-one (the other one)',
  'feat: progress, trust me',
  'perf: removed a console.log, 40% faster',
];

function scmAdd(path) {
  if (!scmChanges.has(path)) {
    scmChanges.add(path);
    renderScm();
  }
}

function renderScm() {
  document.getElementById('scmcount').textContent = scmChanges.size;
  const badge = document.getElementById('scmbadge');
  badge.textContent = scmChanges.size;
  badge.classList.toggle('hidden', scmChanges.size === 0);
  const list = document.getElementById('scmlist');
  const rows = Array.from(scmChanges).filter(p => REG[p]).map(p => {
    const f = REG[p];
    return '<div class="scmrow" data-path="' + p + '"><span class="fico ' + f.cls + '">' + esc(f.icon) + '</span>' +
           esc(f.name) + '<span class="mbadge">M</span></div>';
  });
  list.innerHTML = rows.length ? rows.join('') : '<div class="scmempty">No changes. Suspicious, but no changes.</div>';
}

function renderSync() {
  const btn = document.getElementById('syncbtn');
  btn.classList.toggle('hidden', aheadCount === 0);
  document.getElementById('synccount').textContent = '↑' + aheadCount;
}

document.getElementById('scmlist').addEventListener('click', e => {
  const row = e.target.closest('.scmrow');
  if (row) openPath(row.dataset.path);
});

document.getElementById('commitbtn').addEventListener('click', () => {
  if (!scmChanges.size) {
    showToast('Nothing to commit. The working tree is as clean as your conscience.', 'Git');
    return;
  }
  const box = document.getElementById('commitmsg');
  const msg = box.value.trim() || pick(COMMIT_MSGS);
  const files = scmChanges.size;
  const hash = rand(0x100000, 0xffffff).toString(16);
  const gen = topicGen;
  stamp('<span class="mag">$</span> git add -A');
  setTimeout(() => { if (gen === topicGen) stamp('<span class="mag">$</span> git commit -m "' + esc(msg) + '"'); }, 350);
  setTimeout(() => {
    if (gen !== topicGen) return;
    tline('[' + esc(TOPIC.branch) + ' <span class="dim">' + hash + '</span>] ' + esc(msg));
    tline(' ' + files + ' file' + (files > 1 ? 's' : '') + ' changed, ' + rand(20, 260) + ' insertions(+), ' + rand(3, 80) + ' deletions(-)');
  }, 900);
  scmChanges.clear();
  box.value = '';
  aheadCount += 1;
  renderScm();
  renderSync();
});

document.getElementById('syncbtn').addEventListener('click', () => {
  if (!aheadCount) return;
  const gen = topicGen;
  const pushed = aheadCount;
  stamp('<span class="mag">$</span> git push origin ' + esc(TOPIC.branch));
  setTimeout(() => {
    if (gen !== topicGen) return;
    tline('<span class="dim">Enumerating objects: ' + rand(8, 40) + ', done.</span>');
    tline('<span class="dim">Writing objects: 100%, ' + (rand(20, 220) / 10).toFixed(1) + ' KiB | done.</span>');
    tline('To ' + esc(TOPIC.remote));
    tline('   <span class="dim">' + rand(0x100000, 0xffffff).toString(16) + '..' + rand(0x100000, 0xffffff).toString(16) + '</span>  ' + esc(TOPIC.branch) + ' -&gt; ' + esc(TOPIC.branch));
    showToast('Pushed ' + pushed + ' commit' + (pushed > 1 ? 's' : '') + ' to origin.', 'Git');
  }, 800);
  aheadCount = 0;
  renderSync();
});

/* ================= run & debug ================= */

const bpMap = {};
let debugging = false;

const DBG = {
  webapp: {
    conf: 'Debug backend (attach :9229)',
    vars: [['request', '{ userId: "u_104032" }'], ['attempt', '3'], ['delay', '412'], ['this.maxAttempts', '5']],
    watch: [['response.ok', 'true'], ['idempotent', 'probably']],
    stack: ['UserService.syncUser  user.service.ts:31', 'RetryStrategy.nextDelay  retry.strategy.ts:21', 'processTicksAndRejections  node:internal'],
  },
  banking: {
    conf: 'Debug core-ledger (attach :9229)',
    vars: [['request.entries', 'Array(2)'], ['sum', '0'], ['account.balanceMinor', '128450'], ['overdraftEnabled', 'false']],
    watch: [['sum === 0', 'true (phew)'], ['txId', '"tx_9f2e11…"']],
    stack: ['LedgerService.post  ledger.service.ts:24', 'AccountRepository.lockForUpdate  account.repository.ts:12', 'TransactionValidator.validate  transaction.validator.ts:14'],
  },
  gamedev: {
    conf: 'Launch playtest (chrome)',
    vars: [['dt', '0.0166'], ['alive', '2913'], ['gravity', '{ x: 0, y: 980 }'], ['fps', '143']],
    watch: [['pool.length', '4096'], ['player.grounded', 'true']],
    stack: ['ParticleSystem.update  particle.system.ts:44', 'PhysicsWorld.step  physics.world.ts:39', 'requestAnimationFrame  (native)'],
  },
  ml: {
    conf: 'Python: train_model.py',
    vars: [['epoch', '7'], ['loss', '0.30834'], ['batch', 'tensor(256, 47)'], ['lr', '0.0003']],
    watch: [['loss < prev_loss', 'True (today)'], ['val_auc', '0.8670']],
    stack: ['train  train_model.py:38', 'forward  train_model.py:27', '_run_module_as_main  runpy.py'],
  },
};

function dbgRow(name, val) {
  return '<div class="dbgrow"><span class="dname">' + esc(name) + '</span>: <span class="dval">' + esc(val) + '</span></div>';
}

function renderDebug() {
  const d = TOPIC.debug || DBG[TOPIC.id];
  document.getElementById('dbgconf').textContent = d.conf;
  document.getElementById('dbgvars').innerHTML = d.vars.map(v => dbgRow(v[0], v[1])).join('');
  document.getElementById('dbgwatch').innerHTML = d.watch.map(v => dbgRow(v[0], v[1])).join('');
  document.getElementById('dbgstack').innerHTML = d.stack.map(s => '<div class="dbgrow">' + esc(s) + '</div>').join('');
  renderDbgBps();
}

function renderDbgBps() {
  const rows = [];
  for (const p in bpMap) {
    if (!REG[p]) continue;
    for (const line of Array.from(bpMap[p]).sort((a, b) => a - b)) {
      rows.push('<div class="dbgrow">● ' + esc(REG[p].name) + ':' + line + '</div>');
    }
  }
  document.getElementById('dbgbps').innerHTML =
    rows.length ? rows.join('') : '<div class="dbgempty">Click a line number to set a breakpoint.</div>';
}

function applyBreakpoints() {
  doneEl.querySelectorAll('.ln.bp').forEach(el => el.classList.remove('bp'));
  const set = bpMap[ap];
  if (!set) return;
  for (const line of set) {
    const lineEl = doneEl.children[line - 1];
    if (lineEl) {
      const ln = lineEl.querySelector('.ln');
      if (ln) ln.classList.add('bp');
    }
  }
}

codewrap.addEventListener('click', e => {
  const ln = e.target.closest('.ln');
  if (!ln || ln.id === 'curln') return;
  e.stopPropagation();
  const line = Number(ln.textContent);
  if (!bpMap[ap]) bpMap[ap] = new Set();
  if (bpMap[ap].has(line)) bpMap[ap].delete(line);
  else bpMap[ap].add(line);
  ln.classList.toggle('bp');
  renderDbgBps();
}, true);

document.getElementById('dbgstart').addEventListener('click', () => {
  if (debugging) return;
  debugging = true;
  const btn = document.getElementById('dbgstart');
  btn.textContent = '■';
  const gen = topicGen;
  stamp('<span class="ok">Debugger attached.</span> <span class="dim">' + (TOPIC.debug || DBG[TOPIC.id]).conf + '</span>');
  let bpPath = null, bpLine = 0;
  for (const p in bpMap) { if (REG[p] && bpMap[p].size) { bpPath = p; bpLine = Math.min(...bpMap[p]); break; } }
  if (bpPath) {
    setTimeout(() => {
      if (gen !== topicGen) return;
      tline('<span class="warn">Paused on breakpoint</span>  ' + esc(REG[bpPath].name) + ':' + bpLine);
      jumpTo(bpPath, bpLine);
    }, 1300);
    setTimeout(() => { if (gen === topicGen) tline('<span class="dim">Continued.</span>'); }, 4600);
  } else {
    setTimeout(() => { if (gen === topicGen) tline('<span class="dim">No breakpoints set. Running at full speed, like an optimist.</span>'); }, 1300);
  }
  setTimeout(() => {
    if (gen === topicGen) stamp('<span class="dim">Debugger disconnected.</span>');
    debugging = false;
    btn.textContent = '▶';
  }, 7000);
});

/* ================= extensions ================= */

const EXTS = [
  ['PR', '#56b3b4', 'Prettier — Code formatter', 'Opinionated. Especially about your opinions.', '52.1M', true],
  ['ES', '#4b32c3', 'ESLint', 'Finds problems. Creates character.', '48.7M', true],
  ['GL', '#f05033', 'GitLens', 'Shows exactly who wrote that line. Handle with care.', '39.4M', true],
  ['DM', '#3b9eff', 'DevMetrics', 'Tracks issues resolved per day. You are on fire.', '2.3M', true],
  ['PY', '#ffcb3d', 'Python', 'IntelliSense, linting, and gentle judgement.', '121.8M', false],
  ['DK', '#2496ed', 'Docker', 'It worked in the container. It will work in the container.', '38.2M', false],
  ['RB', '#c678dd', 'Rainbow Brackets', 'For when the nesting gets emotional.', '7.9M', false],
  ['LP', '#8bc34a', 'left-pad Enterprise', 'Eleven characters of mission-critical infrastructure.', '11.1M', false],
  ['AI', '#e5c07b', 'AI Autocomplete', 'Writes TODO comments so you do not have to.', '9.6M', false],
];
const installedExts = new Set(EXTS.filter(x => x[5]).map(x => x[2]));

function renderExt() {
  const q = document.getElementById('extsearch').value.trim().toLowerCase();
  document.getElementById('extlist').innerHTML = EXTS
    .filter(x => !q || x[2].toLowerCase().includes(q))
    .map(x => {
      const inst = installedExts.has(x[2]);
      return '<div class="extrow"><div class="exticon" style="background:' + x[1] + '">' + x[0] + '</div>' +
        '<div class="extmeta"><div class="extname">' + esc(x[2]) + '</div>' +
        '<div class="extdesc">' + esc(x[3]) + '</div>' +
        '<div class="extfoot"><span>⤓ ' + x[4] + '</span><span>★ ' + (rand(38, 50) / 10).toFixed(1) + '</span>' +
        '<button class="extbtn' + (inst ? ' inst' : '') + '" data-ext="' + esc(x[2]) + '">' + (inst ? 'Installed' : 'Install') + '</button>' +
        '</div></div></div>';
    }).join('');
}

document.getElementById('extsearch').addEventListener('input', renderExt);

document.getElementById('extlist').addEventListener('click', e => {
  const btn = e.target.closest('.extbtn');
  if (!btn || btn.classList.contains('inst')) return;
  const name = btn.dataset.ext;
  btn.textContent = 'Installing…';
  setTimeout(() => {
    installedExts.add(name);
    renderExt();
    showToast('Installed "' + name + '". A reload is required (it is not).', 'Extensions');
  }, 1400);
});

/* ================= color themes ================= */

function applyTheme(theme) {
  document.body.classList.toggle('theme-darcula', theme === 'darcula');
  document.querySelectorAll('.wtheme').forEach(el => el.classList.toggle('sel', el.dataset.theme === theme));
  try { localStorage.setItem('wb.theme', theme); } catch (e) {}
}

document.getElementById('wthemes').addEventListener('click', e => {
  const card = e.target.closest('.wtheme');
  if (card) applyTheme(card.dataset.theme);
});

/* ================= wiring into the engine ================= */

rebuildEditor = (function (base) {
  return function () { base(); applyBreakpoints(); };
})(rebuildEditor);

advance = (function (base) {
  return function (n) {
    const p = TOPIC ? rotation[rotIdx] : null;
    base(n);
    if (p) scmAdd(p);
  };
})(advance);

loadTopic = (function (base) {
  return function (id) {
    scmChanges.clear(); // before base: its internal advance() must not render stale paths against the new REG
    base(id);
    scmChanges.clear();
    aheadCount = 0;
    for (const k in bpMap) delete bpMap[k];
    debugging = false;
    document.getElementById('dbgstart').textContent = '▶';
    document.getElementById('commitmsg').value = '';
    renderScm();
    renderSync();
    renderDebug();
    searchInput.value = '';
    document.getElementById('searchresults').innerHTML = '';
    document.getElementById('searchsummary').textContent = '';
  };
})(loadTopic);
