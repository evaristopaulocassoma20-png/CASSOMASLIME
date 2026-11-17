import type { Request, Response, NextFunction } from 'express';
import { AmmDatabase } from './db';
import { reconcileAccounts } from './accounting';
import { SUPABASE_ANON_KEY, SUPABASE_URL, getSupabaseRestHeaders } from './supabaseConfig';

export interface ApiMetricSample {
  id: string;
  timestamp: string;
  tsMs: number;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  errorMessage?: string;
}

const MAX_METRICS = 400;
const MAX_ERRORS = 100;
const metricBuffer: ApiMetricSample[] = [];
const errorBuffer: ApiMetricSample[] = [];
const serverStartedAt = new Date().toISOString();

export function recordApiError(pathStr: string, method: string, status: number, errorMessage: string, durationMs = 0) {
  const now = Date.now();
  const sample: ApiMetricSample = {
    id: `${now}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date(now).toISOString(),
    tsMs: now,
    method,
    path: pathStr,
    status,
    durationMs: Number(durationMs.toFixed(2)),
    errorMessage,
  };
  errorBuffer.unshift(sample);
  if (errorBuffer.length > MAX_ERRORS) {
    errorBuffer.length = MAX_ERRORS;
  }
}

export function apiMetricsMiddleware(req: Request, res: Response, next: NextFunction) {
  if (!req.path.startsWith('/api')) {
    next();
    return;
  }
  const startNs = process.hrtime.bigint();
  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startNs) / 1_000_000;
    const now = Date.now();
    const sample: ApiMetricSample = {
      id: `${now}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: new Date(now).toISOString(),
      tsMs: now,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs: Number(durationMs.toFixed(2)),
    };
    metricBuffer.push(sample);
    if (metricBuffer.length > MAX_METRICS) {
      metricBuffer.shift();
    }
    if (res.statusCode >= 500) {
      recordApiError(req.path, req.method, res.statusCode, `HTTP ${res.statusCode} em ${req.method} ${req.path}`, durationMs);
    }
  });
  next();
}

export function getLatencySeries(fromMs?: number, toMs?: number) {
  const filtered = metricBuffer.filter((m) => {
    if (fromMs !== undefined && m.tsMs < fromMs) return false;
    if (toMs !== undefined && m.tsMs > toMs) return false;
    return true;
  });

  if (filtered.length === 0) return [];

  const buckets = new Map<string, { label: string; sumMs: number; maxMs: number; count: number; errors: number; ts: number }>();
  for (const m of filtered) {
    const d = new Date(m.tsMs);
    const key = `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}-${d.getUTCHours()}:${String(Math.floor(d.getUTCMinutes() / 5) * 5).padStart(2, '0')}`;
    const label = `${String(d.getHours()).padStart(2, '0')}:${String(Math.floor(d.getMinutes() / 5) * 5).padStart(2, '0')}`;
    const existing = buckets.get(key) || { label, sumMs: 0, maxMs: 0, count: 0, errors: 0, ts: m.tsMs };
    existing.sumMs += m.durationMs;
    existing.maxMs = Math.max(existing.maxMs, m.durationMs);
    existing.count += 1;
    if (m.status >= 500) existing.errors += 1;
    buckets.set(key, existing);
  }

  return Array.from(buckets.values())
    .sort((a, b) => a.ts - b.ts)
    .map((b) => ({
      time: b.label,
      avgLatencyMs: Number((b.sumMs / b.count).toFixed(2)),
      maxLatencyMs: Number(b.maxMs.toFixed(2)),
      requests: b.count,
      errors: b.errors,
    }));
}

export function getRecentErrors(limit = 30) {
  return errorBuffer.slice(0, limit);
}

export async function probeSystemHealth(db: AmmDatabase, idToken?: string) {
  const checkedAt = new Date().toISOString();

  // 1. SQLite Live Probe
  let sqliteStatus: 'ONLINE' | 'DEGRADED' | 'ERROR' = 'ONLINE';
  let sqliteLatencyMs = 0;
  let sqliteError: string | null = null;
  let walMode = 'unknown';
  let tableCounts = {
    orders: 0,
    openOrders: 0,
    executions: 0,
    journalEntries: 0,
    usersClob: 0,
  };

  try {
    const t0 = process.hrtime.bigint();
    db.prepare(`SELECT 1 AS ok`).get();
    const journalRow = db.prepare(`PRAGMA journal_mode`).get() as any;
    walMode = String(journalRow?.journal_mode || 'unknown');
    tableCounts = {
      orders: (db.prepare(`SELECT COUNT(*) AS c FROM clob_orders`).get() as any).c,
      openOrders: (db.prepare(`SELECT COUNT(*) AS c FROM clob_orders WHERE status IN ('OPEN', 'PARTIAL')`).get() as any).c,
      executions: (db.prepare(`SELECT COUNT(*) AS c FROM clob_executions`).get() as any).c,
      journalEntries: (db.prepare(`SELECT COUNT(*) AS c FROM amm_journal_entries`).get() as any).c,
      usersClob: (db.prepare(`SELECT COUNT(*) AS c FROM user_clob_accounts`).get() as any).c,
    };
    sqliteLatencyMs = Number((Number(process.hrtime.bigint() - t0) / 1_000_000).toFixed(2));
    if (sqliteLatencyMs > 250) sqliteStatus = 'DEGRADED';
  } catch (err: any) {
    sqliteStatus = 'ERROR';
    sqliteError = err?.message || 'Erro ao consultar SQLite';
  }

  // 2. Supabase Auth Probe
  let supabaseAuthStatus: 'ONLINE' | 'DEGRADED' | 'ERROR' | 'UNCHECKED' = 'UNCHECKED';
  let supabaseAuthLatencyMs: number | null = null;
  let supabaseAuthError: string | null = null;
  if (idToken && SUPABASE_URL && SUPABASE_ANON_KEY) {
    try {
      const t0 = process.hrtime.bigint();
      const resp = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
        method: 'GET',
        headers: {
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${idToken}`,
        },
      });
      supabaseAuthLatencyMs = Number((Number(process.hrtime.bigint() - t0) / 1_000_000).toFixed(2));
      supabaseAuthStatus = resp.ok ? (supabaseAuthLatencyMs > 1500 ? 'DEGRADED' : 'ONLINE') : 'ERROR';
      if (!resp.ok) supabaseAuthError = `HTTP ${resp.status}`;
    } catch (err: any) {
      supabaseAuthStatus = 'ERROR';
      supabaseAuthError = err?.message || 'Falha na ligação Supabase Auth';
    }
  } else if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    supabaseAuthError = 'SUPABASE_URL / SUPABASE_ANON_KEY não configurados';
  }

  // 3. Supabase PostgREST Probe
  let supabaseDbStatus: 'ONLINE' | 'DEGRADED' | 'ERROR' | 'UNCHECKED' = 'UNCHECKED';
  let supabaseDbLatencyMs: number | null = null;
  let supabaseDbError: string | null = null;
  if (idToken && SUPABASE_URL && (SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY)) {
    try {
      const t0 = process.hrtime.bigint();
      const url = `${SUPABASE_URL}/rest/v1/settings?id=eq.platform&limit=1`;
      const resp = await fetch(url, { headers: getSupabaseRestHeaders(idToken) });
      supabaseDbLatencyMs = Number((Number(process.hrtime.bigint() - t0) / 1_000_000).toFixed(2));
      supabaseDbStatus = resp.ok ? (supabaseDbLatencyMs > 1500 ? 'DEGRADED' : 'ONLINE') : 'ERROR';
      if (!resp.ok) supabaseDbError = `HTTP ${resp.status}`;
    } catch (err: any) {
      supabaseDbStatus = 'ERROR';
      supabaseDbError = err?.message || 'Falha na ligação Supabase Postgres';
    }
  } else if (!SUPABASE_URL) {
    supabaseDbError = 'SUPABASE_URL não configurada';
  }

  // 4. Engines & Accounting State
  const settings = db.prepare(`SELECT * FROM amm_settings WHERE id = 1`).get() as any;
  const reconciliation = reconcileAccounts(db);
  const haltedMarketsCount = (
    db.prepare(`SELECT COUNT(*) AS c FROM amm_market_allocations WHERE risk_state = 'HALTED' AND market_resolved = 0`).get() as any
  ).c;
  const warningMarketsCount = (
    db.prepare(`SELECT COUNT(*) AS c FROM amm_market_allocations WHERE risk_state IN ('WARNING', 'PROTECTION') AND market_resolved = 0`).get() as any
  ).c;
  const pendingAllocationsCount = (
    db.prepare(`SELECT COUNT(*) AS c FROM amm_market_allocations WHERE status = 'PENDING'`).get() as any
  ).c;

  const recentWindow = metricBuffer.slice(-50);
  const avgApiLatencyMs =
    recentWindow.length > 0
      ? Number((recentWindow.reduce((s, m) => s + m.durationMs, 0) / recentWindow.length).toFixed(2))
      : null;

  return {
    checkedAt,
    serverStartedAt,
    uptimeSeconds: Math.round(process.uptime()),
    services: [
      {
        id: 'express_api',
        name: 'Express API Server',
        status: sqliteStatus === 'ERROR' ? 'DEGRADED' : 'ONLINE',
        latencyMs: avgApiLatencyMs,
        detail: `${metricBuffer.length} pedidos registados desde o arranque`,
      },
      {
        id: 'sqlite_db',
        name: 'Base de Dados SQLite (WAL)',
        status: sqliteStatus,
        latencyMs: sqliteLatencyMs,
        detail: sqliteError || `Modo ${walMode.toUpperCase()} · ${tableCounts.orders} ordens · ${tableCounts.executions} execuções`,
      },
      {
        id: 'supabase_auth',
        name: 'Supabase Authentication',
        status: supabaseAuthStatus,
        latencyMs: supabaseAuthLatencyMs,
        detail: supabaseAuthError || 'Validação de identidade e tokens Bearer',
      },
      {
        id: 'supabase_sync',
        name: 'Supabase Postgres & Sync',
        status: supabaseDbStatus,
        latencyMs: supabaseDbLatencyMs,
        detail: supabaseDbError || SUPABASE_URL,
      },
      {
        id: 'clob_engine',
        name: 'Motor CLOB (Livro de Ofertas)',
        status: sqliteStatus === 'ONLINE' ? 'ONLINE' : 'ERROR',
        latencyMs: sqliteLatencyMs,
        detail: `${tableCounts.openOrders} ordens ativas · ${tableCounts.executions} negócios liquidados`,
      },
      {
        id: 'amm_engine',
        name: 'Motor AMM Empresarial',
        status: settings?.emergency_halted === 1 ? 'ERROR' : settings?.amm_enabled === 1 ? 'ONLINE' : 'DEGRADED',
        latencyMs: null,
        detail:
          settings?.emergency_halted === 1
            ? 'PARAGEM DE EMERGÊNCIA ATIVA'
            : settings?.amm_enabled === 1
              ? 'Ativo em Sandbox Controlado'
              : 'Em pausa (desativado pelo Master Admin)',
      },
      {
        id: 'risk_engine',
        name: 'Risk Engine (3% / 4% / 5%)',
        status: haltedMarketsCount > 0 ? 'ERROR' : warningMarketsCount > 0 ? 'DEGRADED' : 'ONLINE',
        latencyMs: null,
        detail:
          haltedMarketsCount > 0
            ? `${haltedMarketsCount} mercado(s) em HALTED`
            : warningMarketsCount > 0
              ? `${warningMarketsCount} mercado(s) em alerta/proteção`
              : 'Todos os mercados dentro dos limites',
      },
      {
        id: 'accounting_engine',
        name: 'Accounting (Partidas Dobradas)',
        status: reconciliation.reconciled ? 'ONLINE' : 'ERROR',
        latencyMs: null,
        detail: reconciliation.reconciled
          ? `Reconciliado · ${tableCounts.journalEntries} lançamentos · Reserva 50.000 Kz intacta`
          : `Divergência detetada: ${reconciliation.discrepancyCents} cêntimos`,
      },
    ],
    queues: {
      pendingAllocations: pendingAllocationsCount,
      openClobOrders: tableCounts.openOrders,
      haltedMarkets: haltedMarketsCount,
      warningMarkets: warningMarketsCount,
      recentServerErrors: errorBuffer.length,
    },
    tableCounts,
    latencySeries: getLatencySeries(),
    recentErrors: getRecentErrors(30),
  };
}
