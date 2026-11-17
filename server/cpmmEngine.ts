import { randomUUID } from 'crypto';
import type { AmmDatabase } from './db';
import { ensureMarketRecord, markUserBalanceSynced } from './clobEngine';
import { SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_URL, getSupabaseRestHeaders } from './supabaseConfig';
import {
  createSupabaseDoc,
  fetchSupabaseDoc,
  patchSupabaseFields,
  recordSupabaseLedgerEntry,
} from './supabaseSync';
import {
  INITIAL_LP_PAIRS,
  MARKET_CREATION_LIQUIDITY_KZ,
  SHARE_SETTLEMENT_KZ,
  WITHDRAWAL_FEE_RATE,
  getCpmmSpotPricesKz,
  normalizeOutcomeSide,
  quoteCpmmBuy,
  quoteCpmmSell,
  round2,
  round4,
} from '../src/lib/cpmm-math';

const REST_BASE = `${SUPABASE_URL}/rest/v1`;

export class CpmmEngineError extends Error {
  code: string;
  statusCode: number;
  expectedPrice?: number;
  currentPrice?: number;

  constructor(
    message: string,
    code: string = 'CPMM_ERROR',
    statusCode: number = 400,
    extra?: { expectedPrice?: number; currentPrice?: number }
  ) {
    super(message);
    this.name = 'CpmmEngineError';
    this.code = code;
    this.statusCode = statusCode;
    this.expectedPrice = extra?.expectedPrice;
    this.currentPrice = extra?.currentPrice;
  }
}

function parsePriceChangedMessage(message: string): { expectedPrice?: number; currentPrice?: number } {
  // Matches: "PRICE_CHANGED: O preço mudou de 54.00 para 57.20. Confirme a nova cotação."
  const m = message.match(/mudou de\s+([0-9]+(?:[.,][0-9]+)?)\s+para\s+([0-9]+(?:[.,][0-9]+)?)/i);
  if (!m) return {};
  return {
    expectedPrice: Number(m[1].replace(',', '.')),
    currentPrice: Number(m[2].replace(',', '.')),
  };
}

function parseRpcError(errJson: any, rawText: string, status: number): CpmmEngineError | 'RPC_MISSING' {
  const code = String(errJson?.code || '');
  const msg = String(errJson?.message || errJson?.error_description || rawText || `Erro RPC (${status})`);
  const lower = `${code} ${msg}`.toLowerCase();

  if (
    status === 404 ||
    code === 'PGRST202' ||
    code === '42883' ||
    lower.includes('could not find the function') ||
    lower.includes('does not exist')
  ) {
    return 'RPC_MISSING';
  }

  if (msg.includes('PRICE_CHANGED')) {
    const parsed = parsePriceChangedMessage(msg);
    return new CpmmEngineError(msg, 'PRICE_CHANGED', 409, parsed);
  }
  if (msg.includes('INSUFFICIENT_BALANCE')) return new CpmmEngineError(msg, 'INSUFFICIENT_BALANCE', 400);
  if (msg.includes('INSUFFICIENT_SHARES')) return new CpmmEngineError(msg, 'INSUFFICIENT_SHARES', 400);
  if (msg.includes('MARKET_CLOSED') || msg.includes('MARKET_EXPIRED')) return new CpmmEngineError(msg, 'MARKET_CLOSED', 400);
  if (msg.includes('ALREADY_RESOLVED')) return new CpmmEngineError(msg, 'ALREADY_RESOLVED', 409);
  if (msg.includes('FORBIDDEN')) return new CpmmEngineError(msg, 'FORBIDDEN', 403);
  if (msg.includes('UNAUTHORIZED')) return new CpmmEngineError(msg, 'UNAUTHORIZED', 401);

  return new CpmmEngineError(msg, code || 'RPC_ERROR', status >= 400 ? status : 400);
}

async function callSupabaseRpc<T>(
  fnName: string,
  params: Record<string, any>,
  userJwt?: string
): Promise<{ ok: true; data: T } | { ok: false; missing: true } | { ok: false; missing: false; error: CpmmEngineError }> {
  if (!SUPABASE_URL || (!SUPABASE_ANON_KEY && !SUPABASE_SERVICE_ROLE_KEY)) {
    return { ok: false, missing: true };
  }

  const apikey = SUPABASE_ANON_KEY || SUPABASE_SERVICE_ROLE_KEY;
  const bearer = userJwt || SUPABASE_SERVICE_ROLE_KEY || SUPABASE_ANON_KEY;

  const resp = await fetch(`${REST_BASE}/rpc/${fnName}`, {
    method: 'POST',
    headers: {
      apikey,
      Authorization: `Bearer ${bearer}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(params),
  });

  const text = await resp.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  if (resp.ok) {
    return { ok: true, data: json as T };
  }

  const parsed = parseRpcError(json, text, resp.status);
  if (parsed === 'RPC_MISSING') {
    return { ok: false, missing: true };
  }
  return { ok: false, missing: false, error: parsed };
}

function isMissingTableOrColErr(text: string, status: number): boolean {
  const lower = text.toLowerCase();
  return (
    status === 404 ||
    lower.includes('pgrst204') ||
    lower.includes('pgrst205') ||
    lower.includes('42p01') ||
    lower.includes('42703') ||
    lower.includes('schema cache') ||
    lower.includes('could not find the table') ||
    lower.includes('column')
  );
}

async function patchMarketAdaptive(
  idToken: string | undefined,
  marketId: string,
  fullPayload: Record<string, any>,
  legacyFallbackPayload: Record<string, any>
): Promise<void> {
  const resp = await fetch(`${REST_BASE}/markets?id=eq.${encodeURIComponent(marketId)}`, {
    method: 'PATCH',
    headers: getSupabaseRestHeaders(idToken, 'return=minimal'),
    body: JSON.stringify(fullPayload),
  });
  if (resp.ok) return;
  const txt = await resp.text();
  if (isMissingTableOrColErr(txt, resp.status)) {
    const resp2 = await fetch(`${REST_BASE}/markets?id=eq.${encodeURIComponent(marketId)}`, {
      method: 'PATCH',
      headers: getSupabaseRestHeaders(idToken, 'return=minimal'),
      body: JSON.stringify(legacyFallbackPayload),
    });
    if (!resp2.ok) {
      throw new Error(`Falha ao atualizar mercado ${marketId}: ${await resp2.text()}`);
    }
    return;
  }
  throw new Error(`Falha ao atualizar mercado ${marketId}: ${txt}`);
}

async function updateUserBalanceExact(
  idToken: string | undefined,
  uid: string,
  newBalanceKz: number
): Promise<void> {
  const rounded = round4(newBalanceKz);
  const resp = await fetch(`${REST_BASE}/users?id=eq.${encodeURIComponent(uid)}`, {
    method: 'PATCH',
    headers: getSupabaseRestHeaders(idToken, 'return=minimal'),
    body: JSON.stringify({ balance: rounded, updated_at: new Date().toISOString() }),
  });
  if (!resp.ok) {
    throw new Error(`Falha ao atualizar saldo do utilizador ${uid}: ${await resp.text()}`);
  }
}

async function upsertMarketPositionRow(
  idToken: string | undefined,
  row: {
    market_id: string;
    user_id: string;
    user_name?: string | null;
    outcome: 'Yes' | 'No';
    shares_amount: number;
    avg_entry_price: number;
    total_cost_kz: number;
    is_lp: boolean;
  }
): Promise<void> {
  const now = new Date().toISOString();
  const existingResp = await fetch(
    `${REST_BASE}/market_positions?market_id=eq.${encodeURIComponent(row.market_id)}&user_id=eq.${encodeURIComponent(row.user_id)}&outcome=eq.${encodeURIComponent(row.outcome)}&is_lp=eq.${row.is_lp}&limit=1`,
    { headers: getSupabaseRestHeaders(idToken) }
  );

  if (!existingResp.ok) {
    // Table might not exist yet before SQL migration — skip safely (mirror positions still works)
    return;
  }

  const existing = (await existingResp.json()) as any[];
  if (Array.isArray(existing) && existing.length > 0) {
    if (row.shares_amount <= 0.0001) {
      await fetch(`${REST_BASE}/market_positions?id=eq.${encodeURIComponent(existing[0].id)}`, {
        method: 'DELETE',
        headers: getSupabaseRestHeaders(idToken),
      }).catch(() => {});
      return;
    }
    await fetch(`${REST_BASE}/market_positions?id=eq.${encodeURIComponent(existing[0].id)}`, {
      method: 'PATCH',
      headers: getSupabaseRestHeaders(idToken, 'return=minimal'),
      body: JSON.stringify({
        user_name: row.user_name || existing[0].user_name || null,
        shares_amount: round4(row.shares_amount),
        avg_entry_price: round4(row.avg_entry_price),
        total_cost_kz: round4(row.total_cost_kz),
        updated_at: now,
      }),
    }).catch(() => {});
    return;
  }

  if (row.shares_amount <= 0.0001) return;

  await fetch(`${REST_BASE}/market_positions`, {
    method: 'POST',
    headers: getSupabaseRestHeaders(idToken, 'return=minimal'),
    body: JSON.stringify({
      id: randomUUID(),
      market_id: row.market_id,
      user_id: row.user_id,
      user_name: row.user_name || null,
      outcome: row.outcome,
      shares_amount: round4(row.shares_amount),
      avg_entry_price: round4(row.avg_entry_price),
      total_cost_kz: round4(row.total_cost_kz),
      is_lp: row.is_lp,
      updated_at: now,
    }),
  }).catch(() => {});
}

async function syncCompatibilityPosition(
  idToken: string | undefined,
  uid: string,
  marketId: string,
  outcome: 'Yes' | 'No',
  shares: number,
  avgPriceKz: number
): Promise<void> {
  const posId = `${uid}_${marketId}_${outcome}`;
  if (shares <= 0.0001) {
    await fetch(`${REST_BASE}/positions?id=eq.${encodeURIComponent(posId)}`, {
      method: 'DELETE',
      headers: getSupabaseRestHeaders(idToken),
    }).catch(() => {});
    return;
  }
  await patchSupabaseFields(
    idToken || '',
    'positions',
    posId,
    {
      id: posId,
      user_id: uid,
      userId: uid,
      market_id: marketId,
      marketId: marketId,
      outcome,
      shares: round4(shares),
      available_shares: round4(shares),
      reserved_shares: 0,
      avg_price: round4(avgPriceKz),
      updated_at: new Date().toISOString(),
    },
    false
  );
}

async function recordPlatformRevenueAndSettings(
  idToken: string | undefined,
  params: {
    marketId: string;
    userId: string;
    tradeId?: string | null;
    sourceType: 'TRADING_FEE_BUY' | 'TRADING_FEE_SELL' | 'PAYOUT_WITHDRAWAL_FEE';
    grossAmountKz: number;
    feeAmountKz: number;
  }
): Promise<void> {
  const now = new Date().toISOString();
  await fetch(`${REST_BASE}/platform_revenue`, {
    method: 'POST',
    headers: getSupabaseRestHeaders(idToken, 'return=minimal'),
    body: JSON.stringify({
      id: randomUUID(),
      market_id: params.marketId,
      user_id: params.userId,
      trade_id: params.tradeId || null,
      source_type: params.sourceType,
      gross_amount_kz: round4(params.grossAmountKz),
      fee_amount_kz: round4(params.feeAmountKz),
      created_at: now,
    }),
  }).catch(() => {});

  try {
    const existingSettings = await fetchSupabaseDoc(idToken || '', 'settings', 'platform');
    await patchSupabaseFields(
      idToken || '',
      'settings',
      'platform',
      {
        totalFees: round4(Number(existingSettings?.totalFees || 0) + params.feeAmountKz),
        siteProfit: round4(Number(existingSettings?.siteProfit || 0) + params.feeAmountKz),
        updated_at: now,
      },
      false
    );
  } catch {
    // non-blocking
  }
}

async function insertTradeAdaptive(
  idToken: string | undefined,
  tradeFull: Record<string, any>,
  tradeLegacy: Record<string, any>
): Promise<void> {
  const resp = await fetch(`${REST_BASE}/trades`, {
    method: 'POST',
    headers: getSupabaseRestHeaders(idToken, 'return=minimal'),
    body: JSON.stringify(tradeFull),
  });
  if (resp.ok) return;
  const txt = await resp.text();
  if (isMissingTableOrColErr(txt, resp.status)) {
    await fetch(`${REST_BASE}/trades`, {
      method: 'POST',
      headers: getSupabaseRestHeaders(idToken, 'return=minimal'),
      body: JSON.stringify(tradeLegacy),
    }).catch(() => {});
  }
}

function getNormalizedBinaryPools(market: any): { poolYes: number; poolNo: number; vaultKz: number } {
  let poolYes = Number(market?.pool_yes || 0);
  let poolNo = Number(market?.pool_no || 0);
  const vault = Number(market?.liquidity_vault_kz || 0);

  if (poolYes <= 0 || poolNo <= 0) {
    const spotYes = Math.max(0.01, Math.min(0.99, Number(market?.yes_price || 0.5)));
    poolYes = round4(INITIAL_LP_PAIRS * (1 - spotYes) * 2);
    poolNo = round4(INITIAL_LP_PAIRS * spotYes * 2);
  }

  return {
    poolYes: Math.max(0.0001, poolYes),
    poolNo: Math.max(0.0001, poolNo),
    vaultKz: vault > 0 ? vault : round4(((poolYes + poolNo) / 2) * SHARE_SETTLEMENT_KZ),
  };
}

export async function createBinaryMarketWithCpmm(
  db: AmmDatabase,
  idToken: string,
  uid: string,
  payload: {
    question: string;
    description: string;
    category: string;
    image_url?: string;
    end_date: string;
    tags?: string[];
    additional_context?: string | null;
    resolver_name?: string | null;
  }
): Promise<{
  marketId: string;
  balanceKz: number;
  liquidityVaultKz: number;
  poolYes: number;
  poolNo: number;
  viaRpc: boolean;
}> {
  // 1. Tentar executar via RPC atómica no PostgreSQL Supabase
  const rpcRes = await callSupabaseRpc<any>(
    'create_market_with_liquidity',
    {
      p_question: payload.question,
      p_description: payload.description,
      p_category: payload.category,
      p_image_url: payload.image_url || null,
      p_end_date: payload.end_date,
      p_additional_context: payload.additional_context || null,
      p_resolver_name: payload.resolver_name || 'MarketPay Oracle',
      p_tags: Array.isArray(payload.tags) ? payload.tags : [payload.category, 'Comunidade'],
      p_is_multi: false,
      p_outcomes: null,
    },
    idToken
  );

  if (rpcRes.ok) {
    const d = rpcRes.data || {};
    const marketId = String(d.market_id);
    const balanceKz = Number(d.new_balance_kz ?? 0);
    markUserBalanceSynced(db, uid, Math.round(balanceKz * 100));
    ensureMarketRecord(db, marketId, payload.question);
    return {
      marketId,
      balanceKz,
      liquidityVaultKz: Number(d.liquidity_vault_kz ?? MARKET_CREATION_LIQUIDITY_KZ),
      poolYes: Number(d.pool_yes ?? INITIAL_LP_PAIRS),
      poolNo: Number(d.pool_no ?? INITIAL_LP_PAIRS),
      viaRpc: true,
    };
  }

  if (rpcRes.missing === false) {
    throw rpcRes.error;
  }

  // 2. Fallback transacional Express (caso o SQL atualizado ainda não tenha sido aplicado no Supabase)
  const userRow = await fetchSupabaseDoc(idToken, 'users', uid);
  if (!userRow) {
    throw new CpmmEngineError('Utilizador não encontrado na base de dados.', 'USER_NOT_FOUND', 404);
  }
  if (userRow.status === 'blocked') {
    throw new CpmmEngineError('Conta bloqueada.', 'ACCOUNT_BLOCKED', 403);
  }

  const balBefore = Number(userRow.balance || 0);
  if (balBefore < MARKET_CREATION_LIQUIDITY_KZ) {
    throw new CpmmEngineError(
      `Saldo insuficiente. São necessários ${MARKET_CREATION_LIQUIDITY_KZ.toLocaleString('pt-AO', { minimumFractionDigits: 2 })} Kz para o cofre de liquidez inicial (20 pares). Disponível: ${balBefore.toFixed(2)} Kz.`,
      'INSUFFICIENT_BALANCE',
      400
    );
  }

  const marketId = randomUUID();
  const now = new Date().toISOString();
  const balAfter = round4(balBefore - MARKET_CREATION_LIQUIDITY_KZ);

  const baseMarket = {
    id: marketId,
    question: payload.question,
    description: payload.description,
    category: payload.category,
    image_url: payload.image_url || null,
    tags: Array.isArray(payload.tags) ? payload.tags : [payload.category, 'Comunidade'],
    end_date: payload.end_date,
    is_multi: false,
    outcomes: null,
    b: MARKET_CREATION_LIQUIDITY_KZ,
    pool_yes: INITIAL_LP_PAIRS,
    pool_no: INITIAL_LP_PAIRS,
    yes_price: 0.5,
    no_price: 0.5,
    volume: 0,
    resolved: false,
    creator_id: uid,
    creator_fee_earned: 0,
    admin_fee_earned: 0,
    status: 'active',
    created_at: now,
  };

  const extendedMarket = {
    ...baseMarket,
    yes_price_kz: 50,
    no_price_kz: 50,
    liquidity_vault_kz: MARKET_CREATION_LIQUIDITY_KZ,
    k_constant: INITIAL_LP_PAIRS * INITIAL_LP_PAIRS,
    additional_context: payload.additional_context || null,
    additional_context_updated_at: payload.additional_context ? now : null,
    resolver_name: payload.resolver_name || 'MarketPay Oracle',
    resolver_address: 'mp_oracle_v1',
  };

  try {
    await createSupabaseDoc(idToken, 'markets', extendedMarket, marketId, true);
  } catch (err: any) {
    if (isMissingTableOrColErr(String(err?.message || ''), 400)) {
      await createSupabaseDoc(idToken, 'markets', baseMarket, marketId, true);
    } else {
      throw err;
    }
  }

  await updateUserBalanceExact(idToken, uid, balAfter);
  markUserBalanceSynced(db, uid, Math.round(balAfter * 100));

  await upsertMarketPositionRow(idToken, {
    market_id: marketId,
    user_id: uid,
    user_name: userRow.name || null,
    outcome: 'Yes',
    shares_amount: INITIAL_LP_PAIRS,
    avg_entry_price: 50,
    total_cost_kz: 1000,
    is_lp: true,
  });
  await upsertMarketPositionRow(idToken, {
    market_id: marketId,
    user_id: uid,
    user_name: userRow.name || null,
    outcome: 'No',
    shares_amount: INITIAL_LP_PAIRS,
    avg_entry_price: 50,
    total_cost_kz: 1000,
    is_lp: true,
  });

  await createSupabaseDoc(idToken, 'price_history', {
    market_id: marketId,
    yes_price: 0.5,
    no_price: 0.5,
    timestamp: now,
  }).catch(() => {});

  await recordSupabaseLedgerEntry(idToken, {
    userId: uid,
    type: 'CRIACAO_MERCADO_LIQUIDEZ',
    amountKz: -MARKET_CREATION_LIQUIDITY_KZ,
    balanceBeforeKz: balBefore,
    balanceAfterKz: balAfter,
    reference: marketId,
  });

  await createSupabaseDoc(idToken, 'audit_logs', {
    action: 'MARKET_CREATION_LP',
    admin_id: uid,
    details: `Criador ${uid} abriu mercado ${marketId} com 2.000,00 Kz no cofre (20 pares SIM/NÃO a 50%).`,
    created_at: now,
    timestamp: now,
  }).catch(() => {});

  ensureMarketRecord(db, marketId, payload.question);

  return {
    marketId,
    balanceKz: balAfter,
    liquidityVaultKz: MARKET_CREATION_LIQUIDITY_KZ,
    poolYes: INITIAL_LP_PAIRS,
    poolNo: INITIAL_LP_PAIRS,
    viaRpc: false,
  };
}

export async function buyCpmmShares(
  db: AmmDatabase,
  idToken: string,
  uid: string,
  params: {
    marketId: string;
    outcome: 'Yes' | 'No' | string;
    grossAmountKz: number;
    expectedPriceKz: number;
    maxSlippagePct?: number;
    idempotencyKey?: string;
  }
) {
  const normOutcome = normalizeOutcomeSide(params.outcome);
  const grossAmountKz = round4(Number(params.grossAmountKz) || 0);
  const expectedPriceKz = round4(Number(params.expectedPriceKz) || 0);
  const maxSlippagePct = Math.max(0, Number(params.maxSlippagePct ?? 1.0));
  const idempotencyKey = params.idempotencyKey?.trim() || randomUUID();

  if (grossAmountKz < 1) {
    throw new CpmmEngineError('O valor mínimo de compra é 1,00 Kz.', 'INVALID_AMOUNT', 400);
  }

  // Idempotency check in local SQLite first
  const localIdem = db
    .prepare(`SELECT response_json, status_code FROM idempotency_keys WHERE key = ? AND user_id = ?`)
    .get(idempotencyKey, uid) as { response_json: string; status_code: number } | undefined;
  if (localIdem && localIdem.status_code < 400) {
    const cached = JSON.parse(localIdem.response_json);
    return { ...cached, idempotent_replay: true };
  }

  // 1. Tentar RPC atómica PostgreSQL com FOR UPDATE
  const rpcRes = await callSupabaseRpc<any>(
    'buy_shares',
    {
      p_market_id: params.marketId,
      p_outcome: normOutcome,
      p_gross_amount_kz: grossAmountKz,
      p_expected_price: expectedPriceKz,
      p_max_slippage_pct: maxSlippagePct,
      p_idempotency_key: idempotencyKey,
    },
    idToken
  );

  if (rpcRes.ok) {
    const resData = rpcRes.data || {};
    if (resData.new_balance_kz !== undefined) {
      markUserBalanceSynced(db, uid, Math.round(Number(resData.new_balance_kz) * 100));
    }
    db.prepare(
      `INSERT OR IGNORE INTO idempotency_keys (key, endpoint, user_id, response_json, status_code, created_at)
       VALUES (?, 'POST /api/cpmm/buy', ?, ?, 200, ?)`
    ).run(idempotencyKey, uid, JSON.stringify(resData), new Date().toISOString());
    return { ...resData, viaRpc: true };
  }

  if (rpcRes.missing === false) {
    throw rpcRes.error;
  }

  // 2. Fallback transacional sob withSerializedLock
  const market = await fetchSupabaseDoc(idToken, 'markets', params.marketId);
  if (!market) {
    throw new CpmmEngineError('Mercado não encontrado.', 'MARKET_NOT_FOUND', 404);
  }
  if (market.resolved || market.status !== 'active') {
    throw new CpmmEngineError('Este mercado já não está ativo para negociação.', 'MARKET_CLOSED', 400);
  }
  if (market.end_date && new Date(market.end_date).getTime() <= Date.now()) {
    throw new CpmmEngineError('O prazo deste mercado já encerrou.', 'MARKET_EXPIRED', 400);
  }

  const user = await fetchSupabaseDoc(idToken, 'users', uid);
  if (!user) {
    throw new CpmmEngineError('Utilizador não encontrado.', 'USER_NOT_FOUND', 404);
  }
  if (user.status === 'blocked') {
    throw new CpmmEngineError('A sua conta encontra-se bloqueada.', 'ACCOUNT_BLOCKED', 403);
  }

  const userBalBefore = Number(user.balance || 0);
  if (userBalBefore < grossAmountKz) {
    throw new CpmmEngineError(
      `Saldo insuficiente (${userBalBefore.toFixed(2)} Kz disponíveis).`,
      'INSUFFICIENT_BALANCE',
      400
    );
  }

  const pools = getNormalizedBinaryPools(market);
  const quote = quoteCpmmBuy({
    poolYes: pools.poolYes,
    poolNo: pools.poolNo,
    outcome: normOutcome,
    grossAmountKz,
  });

  if (quote.sharesReceived <= 0) {
    throw new CpmmEngineError('Montante líquido insuficiente para emitir shares.', 'ZERO_SHARES', 400);
  }

  // Slippage protection check
  if (expectedPriceKz > 0) {
    const maxAllowed = round4(expectedPriceKz * (1 + maxSlippagePct / 100));
    if (quote.spotPriceBeforeKz > maxAllowed) {
      throw new CpmmEngineError(
        `PRICE_CHANGED: O preço mudou de ${expectedPriceKz.toFixed(2)} para ${quote.spotPriceBeforeKz.toFixed(2)}. Confirme a nova cotação.`,
        'PRICE_CHANGED',
        409,
        { expectedPrice: expectedPriceKz, currentPrice: quote.spotPriceBeforeKz }
      );
    }
    if (quote.avgExecPriceKz > maxAllowed) {
      throw new CpmmEngineError(
        `PRICE_CHANGED: O preço mudou de ${expectedPriceKz.toFixed(2)} para ${quote.avgExecPriceKz.toFixed(2)}. Confirme a nova cotação.`,
        'PRICE_CHANGED',
        409,
        { expectedPrice: expectedPriceKz, currentPrice: quote.avgExecPriceKz }
      );
    }
  }

  const newBalanceKz = round4(userBalBefore - grossAmountKz);
  const newVaultKz = round4(pools.vaultKz + quote.netAmountKz);
  const afterSpots = getCpmmSpotPricesKz(quote.newPoolYes, quote.newPoolNo);
  const now = new Date().toISOString();
  const tradeId = randomUUID();

  // Persist user & market updates
  await updateUserBalanceExact(idToken, uid, newBalanceKz);
  markUserBalanceSynced(db, uid, Math.round(newBalanceKz * 100));

  await patchMarketAdaptive(
    idToken,
    params.marketId,
    {
      pool_yes: quote.newPoolYes,
      pool_no: quote.newPoolNo,
      liquidity_vault_kz: newVaultKz,
      k_constant: round4(quote.newPoolYes * quote.newPoolNo),
      yes_price: afterSpots.yesProb,
      no_price: afterSpots.noProb,
      yes_price_kz: afterSpots.yesPriceKz,
      no_price_kz: afterSpots.noPriceKz,
      volume: round4(Number(market.volume || 0) + grossAmountKz),
      admin_fee_earned: round4(Number(market.admin_fee_earned || 0) + quote.feeKz),
    },
    {
      pool_yes: quote.newPoolYes,
      pool_no: quote.newPoolNo,
      yes_price: afterSpots.yesProb,
      no_price: afterSpots.noProb,
      volume: round4(Number(market.volume || 0) + grossAmountKz),
      admin_fee_earned: round4(Number(market.admin_fee_earned || 0) + quote.feeKz),
    }
  );

  // Sync LP positions if market_positions table exists
  if (market.creator_id) {
    await upsertMarketPositionRow(idToken, {
      market_id: params.marketId,
      user_id: String(market.creator_id),
      outcome: 'Yes',
      shares_amount: quote.newPoolYes,
      avg_entry_price: 50,
      total_cost_kz: 1000,
      is_lp: true,
    });
    await upsertMarketPositionRow(idToken, {
      market_id: params.marketId,
      user_id: String(market.creator_id),
      outcome: 'No',
      shares_amount: quote.newPoolNo,
      avg_entry_price: 50,
      total_cost_kz: 1000,
      is_lp: true,
    });
  }

  // Load current user position to accumulate shares & cost
  let prevShares = 0;
  let prevCost = 0;
  try {
    const mpResp = await fetch(
      `${REST_BASE}/market_positions?market_id=eq.${encodeURIComponent(params.marketId)}&user_id=eq.${encodeURIComponent(uid)}&outcome=eq.${encodeURIComponent(normOutcome)}&is_lp=eq.false&limit=1`,
      { headers: getSupabaseRestHeaders(idToken) }
    );
    if (mpResp.ok) {
      const mpRows = (await mpResp.json()) as any[];
      if (Array.isArray(mpRows) && mpRows[0]) {
        prevShares = Number(mpRows[0].shares_amount || 0);
        prevCost = Number(mpRows[0].total_cost_kz || 0);
      }
    } else {
      const legacyPos = await fetchSupabaseDoc(idToken, 'positions', `${uid}_${params.marketId}_${normOutcome}`);
      if (legacyPos) {
        prevShares = Number(legacyPos.shares || 0);
        const rawAvg = Number(legacyPos.avg_price || 0);
        const normAvgKz = rawAvg > 1 ? rawAvg : rawAvg * 100;
        prevCost = round4(prevShares * normAvgKz);
      }
    }
  } catch {
    // ignore
  }

  const totalSharesAfter = round4(prevShares + quote.sharesReceived);
  const totalCostAfter = round4(prevCost + quote.netAmountKz);
  const avgEntryKz = totalSharesAfter > 0 ? round4(totalCostAfter / totalSharesAfter) : quote.avgExecPriceKz;

  await upsertMarketPositionRow(idToken, {
    market_id: params.marketId,
    user_id: uid,
    user_name: user.name || null,
    outcome: normOutcome,
    shares_amount: totalSharesAfter,
    avg_entry_price: avgEntryKz,
    total_cost_kz: totalCostAfter,
    is_lp: false,
  });

  await syncCompatibilityPosition(idToken, uid, params.marketId, normOutcome, totalSharesAfter, avgEntryKz);

  await insertTradeAdaptive(
    idToken,
    {
      id: tradeId,
      market_id: params.marketId,
      user_id: uid,
      side: 'Buy',
      outcome: normOutcome,
      amount: grossAmountKz,
      net_amount_kz: quote.netAmountKz,
      shares: quote.sharesReceived,
      price: quote.avgExecPriceKz,
      price_before: quote.spotPriceBeforeKz,
      price_after: quote.spotPriceAfterKz,
      expected_price: expectedPriceKz,
      slippage_pct: maxSlippagePct,
      fee: quote.feeKz,
      idempotency_key: idempotencyKey,
      engine: 'CPMM_AMM',
      timestamp: now,
    },
    {
      id: tradeId,
      market_id: params.marketId,
      user_id: uid,
      side: 'Buy',
      outcome: normOutcome,
      amount: grossAmountKz,
      shares: quote.sharesReceived,
      price: round4(quote.avgExecPriceKz / 100),
      fee: quote.feeKz,
      engine: 'CPMM_AMM',
      timestamp: now,
    }
  );

  await recordPlatformRevenueAndSettings(idToken, {
    marketId: params.marketId,
    userId: uid,
    tradeId,
    sourceType: 'TRADING_FEE_BUY',
    grossAmountKz,
    feeAmountKz: quote.feeKz,
  });

  await createSupabaseDoc(idToken, 'price_history', {
    market_id: params.marketId,
    yes_price: afterSpots.yesProb,
    no_price: afterSpots.noProb,
    timestamp: now,
  }).catch(() => {});

  await recordSupabaseLedgerEntry(idToken, {
    userId: uid,
    type: 'COMPRA_QUOTAS',
    amountKz: -grossAmountKz,
    balanceBeforeKz: userBalBefore,
    balanceAfterKz: newBalanceKz,
    reference: `${params.marketId}:${tradeId}`,
  });

  const responsePayload = {
    idempotent_replay: false,
    viaRpc: false,
    trade_id: tradeId,
    market_id: params.marketId,
    outcome: normOutcome,
    gross_amount_kz: grossAmountKz,
    net_amount_kz: quote.netAmountKz,
    fee_kz: quote.feeKz,
    shares_received: quote.sharesReceived,
    avg_exec_price_kz: quote.avgExecPriceKz,
    spot_price_before_kz: quote.spotPriceBeforeKz,
    spot_price_after_kz: quote.spotPriceAfterKz,
    yes_price_kz: afterSpots.yesPriceKz,
    no_price_kz: afterSpots.noPriceKz,
    pool_yes: quote.newPoolYes,
    pool_no: quote.newPoolNo,
    liquidity_vault_kz: newVaultKz,
    new_balance_kz: newBalanceKz,
  };

  db.prepare(
    `INSERT OR IGNORE INTO idempotency_keys (key, endpoint, user_id, response_json, status_code, created_at)
     VALUES (?, 'POST /api/cpmm/buy', ?, ?, 200, ?)`
  ).run(idempotencyKey, uid, JSON.stringify(responsePayload), now);

  return responsePayload;
}

export async function sellCpmmShares(
  db: AmmDatabase,
  idToken: string,
  uid: string,
  params: {
    marketId: string;
    outcome: 'Yes' | 'No' | string;
    sharesToSell: number;
    expectedPriceKz: number;
    maxSlippagePct?: number;
    idempotencyKey?: string;
  }
) {
  const normOutcome = normalizeOutcomeSide(params.outcome);
  const sharesToSell = round4(Number(params.sharesToSell) || 0);
  const expectedPriceKz = round4(Number(params.expectedPriceKz) || 0);
  const maxSlippagePct = Math.max(0, Number(params.maxSlippagePct ?? 1.0));
  const idempotencyKey = params.idempotencyKey?.trim() || randomUUID();

  if (sharesToSell <= 0) {
    throw new CpmmEngineError('A quantidade de shares para venda deve ser superior a zero.', 'INVALID_SHARES', 400);
  }

  const localIdem = db
    .prepare(`SELECT response_json, status_code FROM idempotency_keys WHERE key = ? AND user_id = ?`)
    .get(idempotencyKey, uid) as { response_json: string; status_code: number } | undefined;
  if (localIdem && localIdem.status_code < 400) {
    const cached = JSON.parse(localIdem.response_json);
    return { ...cached, idempotent_replay: true };
  }

  const rpcRes = await callSupabaseRpc<any>(
    'sell_shares',
    {
      p_market_id: params.marketId,
      p_outcome: normOutcome,
      p_shares_to_sell: sharesToSell,
      p_expected_price: expectedPriceKz,
      p_max_slippage_pct: maxSlippagePct,
      p_idempotency_key: idempotencyKey,
    },
    idToken
  );

  if (rpcRes.ok) {
    const resData = rpcRes.data || {};
    if (resData.new_balance_kz !== undefined) {
      markUserBalanceSynced(db, uid, Math.round(Number(resData.new_balance_kz) * 100));
    }
    db.prepare(
      `INSERT OR IGNORE INTO idempotency_keys (key, endpoint, user_id, response_json, status_code, created_at)
       VALUES (?, 'POST /api/cpmm/sell', ?, ?, 200, ?)`
    ).run(idempotencyKey, uid, JSON.stringify(resData), new Date().toISOString());
    return { ...resData, viaRpc: true };
  }

  if (rpcRes.missing === false) {
    throw rpcRes.error;
  }

  // Fallback atomic sell
  const market = await fetchSupabaseDoc(idToken, 'markets', params.marketId);
  if (!market) throw new CpmmEngineError('Mercado não encontrado.', 'MARKET_NOT_FOUND', 404);
  if (market.resolved || market.status !== 'active') {
    throw new CpmmEngineError('Este mercado já não está ativo para negociação.', 'MARKET_CLOSED', 400);
  }

  const user = await fetchSupabaseDoc(idToken, 'users', uid);
  if (!user) throw new CpmmEngineError('Utilizador não encontrado.', 'USER_NOT_FOUND', 404);
  if (user.status === 'blocked') {
    throw new CpmmEngineError('A sua conta encontra-se bloqueada.', 'ACCOUNT_BLOCKED', 403);
  }

  let heldShares = 0;
  let heldCostKz = 0;
  let heldAvgPrice = 50;
  const mpResp = await fetch(
    `${REST_BASE}/market_positions?market_id=eq.${encodeURIComponent(params.marketId)}&user_id=eq.${encodeURIComponent(uid)}&outcome=eq.${encodeURIComponent(normOutcome)}&is_lp=eq.false&limit=1`,
    { headers: getSupabaseRestHeaders(idToken) }
  );
  if (mpResp.ok) {
    const mpRows = (await mpResp.json()) as any[];
    if (Array.isArray(mpRows) && mpRows[0]) {
      heldShares = Number(mpRows[0].shares_amount || 0);
      heldCostKz = Number(mpRows[0].total_cost_kz || 0);
      heldAvgPrice = Number(mpRows[0].avg_entry_price || 50);
    }
  } else {
    const legPos = await fetchSupabaseDoc(idToken, 'positions', `${uid}_${params.marketId}_${normOutcome}`);
    if (legPos) {
      heldShares = Number(legPos.shares || 0);
      const rawAvg = Number(legPos.avg_price || 0);
      heldAvgPrice = rawAvg > 1 ? rawAvg : rawAvg * 100;
      heldCostKz = round4(heldShares * heldAvgPrice);
    }
  }

  if (heldShares < sharesToSell) {
    throw new CpmmEngineError(
      `Possui apenas ${heldShares.toFixed(4)} shares disponíveis para vender.`,
      'INSUFFICIENT_SHARES',
      400
    );
  }

  const pools = getNormalizedBinaryPools(market);
  const quote = quoteCpmmSell({
    poolYes: pools.poolYes,
    poolNo: pools.poolNo,
    outcome: normOutcome,
    sharesToSell,
  });

  if (quote.grossReturnKz <= 0) {
    throw new CpmmEngineError('Liquidez insuficiente para fechar esta venda.', 'ZERO_RETURN', 400);
  }

  if (expectedPriceKz > 0) {
    const minAllowed = round4(expectedPriceKz * Math.max(0.01, 1 - maxSlippagePct / 100));
    if (quote.spotPriceBeforeKz < minAllowed) {
      throw new CpmmEngineError(
        `PRICE_CHANGED: O preço mudou de ${expectedPriceKz.toFixed(2)} para ${quote.spotPriceBeforeKz.toFixed(2)}. Confirme a nova cotação.`,
        'PRICE_CHANGED',
        409,
        { expectedPrice: expectedPriceKz, currentPrice: quote.spotPriceBeforeKz }
      );
    }
    if (quote.avgExecPriceKz < minAllowed) {
      throw new CpmmEngineError(
        `PRICE_CHANGED: O preço mudou de ${expectedPriceKz.toFixed(2)} para ${quote.avgExecPriceKz.toFixed(2)}. Confirme a nova cotação.`,
        'PRICE_CHANGED',
        409,
        { expectedPrice: expectedPriceKz, currentPrice: quote.avgExecPriceKz }
      );
    }
  }

  const userBalBefore = Number(user.balance || 0);
  const newBalanceKz = round4(userBalBefore + quote.netReturnKz);
  const newVaultKz = Math.max(0, round4(pools.vaultKz - quote.grossReturnKz));
  const afterSpots = getCpmmSpotPricesKz(quote.newPoolYes, quote.newPoolNo);
  const now = new Date().toISOString();
  const tradeId = randomUUID();

  await updateUserBalanceExact(idToken, uid, newBalanceKz);
  markUserBalanceSynced(db, uid, Math.round(newBalanceKz * 100));

  await patchMarketAdaptive(
    idToken,
    params.marketId,
    {
      pool_yes: quote.newPoolYes,
      pool_no: quote.newPoolNo,
      liquidity_vault_kz: newVaultKz,
      k_constant: round4(quote.newPoolYes * quote.newPoolNo),
      yes_price: afterSpots.yesProb,
      no_price: afterSpots.noProb,
      yes_price_kz: afterSpots.yesPriceKz,
      no_price_kz: afterSpots.noPriceKz,
      volume: round4(Number(market.volume || 0) + quote.grossReturnKz),
      admin_fee_earned: round4(Number(market.admin_fee_earned || 0) + quote.feeKz),
    },
    {
      pool_yes: quote.newPoolYes,
      pool_no: quote.newPoolNo,
      yes_price: afterSpots.yesProb,
      no_price: afterSpots.noProb,
      volume: round4(Number(market.volume || 0) + quote.grossReturnKz),
      admin_fee_earned: round4(Number(market.admin_fee_earned || 0) + quote.feeKz),
    }
  );

  if (market.creator_id) {
    await upsertMarketPositionRow(idToken, {
      market_id: params.marketId,
      user_id: String(market.creator_id),
      outcome: 'Yes',
      shares_amount: quote.newPoolYes,
      avg_entry_price: 50,
      total_cost_kz: 1000,
      is_lp: true,
    });
    await upsertMarketPositionRow(idToken, {
      market_id: params.marketId,
      user_id: String(market.creator_id),
      outcome: 'No',
      shares_amount: quote.newPoolNo,
      avg_entry_price: 50,
      total_cost_kz: 1000,
      is_lp: true,
    });
  }

  const remainingShares = round4(heldShares - sharesToSell);
  const remainingCost = heldShares > 0 ? round4(heldCostKz * (remainingShares / heldShares)) : 0;

  await upsertMarketPositionRow(idToken, {
    market_id: params.marketId,
    user_id: uid,
    user_name: user.name || null,
    outcome: normOutcome,
    shares_amount: remainingShares,
    avg_entry_price: heldAvgPrice,
    total_cost_kz: remainingCost,
    is_lp: false,
  });

  await syncCompatibilityPosition(idToken, uid, params.marketId, normOutcome, remainingShares, heldAvgPrice);

  await insertTradeAdaptive(
    idToken,
    {
      id: tradeId,
      market_id: params.marketId,
      user_id: uid,
      side: 'Sell',
      outcome: normOutcome,
      amount: quote.grossReturnKz,
      net_amount_kz: quote.netReturnKz,
      shares: sharesToSell,
      price: quote.avgExecPriceKz,
      price_before: quote.spotPriceBeforeKz,
      price_after: quote.spotPriceAfterKz,
      expected_price: expectedPriceKz,
      slippage_pct: maxSlippagePct,
      fee: quote.feeKz,
      idempotency_key: idempotencyKey,
      engine: 'CPMM_AMM',
      timestamp: now,
    },
    {
      id: tradeId,
      market_id: params.marketId,
      user_id: uid,
      side: 'Sell',
      outcome: normOutcome,
      amount: quote.grossReturnKz,
      shares: sharesToSell,
      price: round4(quote.avgExecPriceKz / 100),
      fee: quote.feeKz,
      engine: 'CPMM_AMM',
      timestamp: now,
    }
  );

  await recordPlatformRevenueAndSettings(idToken, {
    marketId: params.marketId,
    userId: uid,
    tradeId,
    sourceType: 'TRADING_FEE_SELL',
    grossAmountKz: quote.grossReturnKz,
    feeAmountKz: quote.feeKz,
  });

  await createSupabaseDoc(idToken, 'price_history', {
    market_id: params.marketId,
    yes_price: afterSpots.yesProb,
    no_price: afterSpots.noProb,
    timestamp: now,
  }).catch(() => {});

  await recordSupabaseLedgerEntry(idToken, {
    userId: uid,
    type: 'VENDA_QUOTAS',
    amountKz: quote.netReturnKz,
    balanceBeforeKz: userBalBefore,
    balanceAfterKz: newBalanceKz,
    reference: `${params.marketId}:${tradeId}`,
  });

  const responsePayload = {
    idempotent_replay: false,
    viaRpc: false,
    trade_id: tradeId,
    market_id: params.marketId,
    outcome: normOutcome,
    shares_sold: sharesToSell,
    gross_return_kz: quote.grossReturnKz,
    net_return_kz: quote.netReturnKz,
    fee_kz: quote.feeKz,
    avg_exec_price_kz: quote.avgExecPriceKz,
    spot_price_before_kz: quote.spotPriceBeforeKz,
    spot_price_after_kz: quote.spotPriceAfterKz,
    yes_price_kz: afterSpots.yesPriceKz,
    no_price_kz: afterSpots.noPriceKz,
    pool_yes: quote.newPoolYes,
    pool_no: quote.newPoolNo,
    liquidity_vault_kz: newVaultKz,
    new_balance_kz: newBalanceKz,
  };

  db.prepare(
    `INSERT OR IGNORE INTO idempotency_keys (key, endpoint, user_id, response_json, status_code, created_at)
     VALUES (?, 'POST /api/cpmm/sell', ?, ?, 200, ?)`
  ).run(idempotencyKey, uid, JSON.stringify(responsePayload), now);

  return responsePayload;
}

export async function resolveCpmmMarket(
  db: AmmDatabase,
  idToken: string,
  adminUid: string,
  params: {
    marketId: string;
    winningOutcome: 'Yes' | 'No' | string;
    motive: string;
  }
) {
  const normWinner = normalizeOutcomeSide(params.winningOutcome);
  const motive = String(params.motive || 'Resolução oficial pelo administrador').trim();

  const rpcRes = await callSupabaseRpc<any>(
    'resolve_market',
    {
      p_market_id: params.marketId,
      p_winning_outcome: normWinner,
      p_motive: motive,
    },
    idToken
  );

  if (rpcRes.ok) {
    return { ...(rpcRes.data || {}), viaRpc: true };
  }

  if (rpcRes.missing === false) {
    throw rpcRes.error;
  }

  // Express fallback settlement
  const market = await fetchSupabaseDoc(idToken, 'markets', params.marketId);
  if (!market) throw new CpmmEngineError('Mercado não encontrado.', 'MARKET_NOT_FOUND', 404);
  if (market.resolved) throw new CpmmEngineError('Este mercado já foi resolvido.', 'ALREADY_RESOLVED', 409);

  let winningRows: Array<{ user_id: string; shares_amount: number; is_lp: boolean }> = [];
  const mpResp = await fetch(
    `${REST_BASE}/market_positions?market_id=eq.${encodeURIComponent(params.marketId)}&outcome=eq.${encodeURIComponent(normWinner)}&shares_amount=gt.0`,
    { headers: getSupabaseRestHeaders(idToken) }
  );

  if (mpResp.ok) {
    const rows = (await mpResp.json()) as any[];
    winningRows = (rows || []).map((r) => ({
      user_id: String(r.user_id),
      shares_amount: Number(r.shares_amount || 0),
      is_lp: Boolean(r.is_lp),
    }));
  } else {
    // Legacy positions table fallback
    const legResp = await fetch(
      `${REST_BASE}/positions?or=(market_id.eq.${encodeURIComponent(params.marketId)},marketId.eq.${encodeURIComponent(params.marketId)})&outcome=eq.${encodeURIComponent(normWinner)}`,
      { headers: getSupabaseRestHeaders(idToken) }
    );
    if (legResp.ok) {
      const legRows = (await legResp.json()) as any[];
      winningRows = (legRows || [])
        .filter((r) => Number(r.shares || 0) > 0)
        .map((r) => ({
          user_id: String(r.user_id || r.userId),
          shares_amount: Number(r.shares || 0),
          is_lp: false,
        }));
    }
  }

  let totalGrossKz = 0;
  let totalFeesKz = 0;
  let totalNetKz = 0;
  let payoutsCount = 0;
  const now = new Date().toISOString();

  for (const row of winningRows) {
    if (!row.user_id || row.shares_amount <= 0) continue;
    const userRow = await fetchSupabaseDoc(idToken, 'users', row.user_id);
    if (!userRow) continue;

    const balBefore = Number(userRow.balance || 0);
    const grossPayout = round4(row.shares_amount * SHARE_SETTLEMENT_KZ);
    const feeKz = round4(grossPayout * WITHDRAWAL_FEE_RATE);
    const netPayout = round4(grossPayout - feeKz);
    const balAfter = round4(balBefore + netPayout);

    await updateUserBalanceExact(idToken, row.user_id, balAfter);
    markUserBalanceSynced(db, row.user_id, Math.round(balAfter * 100));

    await recordPlatformRevenueAndSettings(idToken, {
      marketId: params.marketId,
      userId: row.user_id,
      tradeId: null,
      sourceType: 'PAYOUT_WITHDRAWAL_FEE',
      grossAmountKz: grossPayout,
      feeAmountKz: feeKz,
    });

    await recordSupabaseLedgerEntry(idToken, {
      userId: row.user_id,
      type: row.is_lp ? 'LIQUIDACAO_LP' : 'PREMIACAO_MERCADO',
      amountKz: netPayout,
      balanceBeforeKz: balBefore,
      balanceAfterKz: balAfter,
      reference: params.marketId,
    });

    totalGrossKz = round4(totalGrossKz + grossPayout);
    totalFeesKz = round4(totalFeesKz + feeKz);
    totalNetKz = round4(totalNetKz + netPayout);
    payoutsCount++;
  }

  await patchMarketAdaptive(
    idToken,
    params.marketId,
    {
      resolved: true,
      resolution_outcome: normWinner,
      status: 'resolved',
      resolved_at: now,
      resolution_motive: motive,
      resolved_by: adminUid,
      yes_price: normWinner === 'Yes' ? 1 : 0,
      no_price: normWinner === 'No' ? 1 : 0,
      yes_price_kz: normWinner === 'Yes' ? 100 : 0,
      no_price_kz: normWinner === 'No' ? 100 : 0,
      liquidity_vault_kz: 0,
      admin_fee_earned: round4(Number(market.admin_fee_earned || 0) + totalFeesKz),
    },
    {
      resolved: true,
      resolution_outcome: normWinner,
      status: 'resolved',
      resolved_at: now,
      resolution_motive: motive,
      resolved_by: adminUid,
      yes_price: normWinner === 'Yes' ? 1 : 0,
      no_price: normWinner === 'No' ? 1 : 0,
      admin_fee_earned: round4(Number(market.admin_fee_earned || 0) + totalFeesKz),
    }
  );

  // Clean positions
  await fetch(`${REST_BASE}/market_positions?market_id=eq.${encodeURIComponent(params.marketId)}`, {
    method: 'DELETE',
    headers: getSupabaseRestHeaders(idToken),
  }).catch(() => {});
  await fetch(
    `${REST_BASE}/positions?or=(market_id.eq.${encodeURIComponent(params.marketId)},marketId.eq.${encodeURIComponent(params.marketId)})`,
    {
      method: 'DELETE',
      headers: getSupabaseRestHeaders(idToken),
    }
  ).catch(() => {});

  await createSupabaseDoc(idToken, 'audit_logs', {
    action: 'MARKET_RESOLUTION_CPMM',
    admin_id: adminUid,
    details: `Mercado ${params.marketId} resolvido como ${normWinner}. Pagamentos: ${payoutsCount}, Bruto: ${round2(totalGrossKz)} Kz, Líquido: ${round2(totalNetKz)} Kz, Taxa 1%: ${round2(totalFeesKz)} Kz.`,
    created_at: now,
    timestamp: now,
  }).catch(() => {});

  return {
    resolved: true,
    viaRpc: false,
    market_id: params.marketId,
    winning_outcome: normWinner,
    payouts_count: payoutsCount,
    total_gross_kz: totalGrossKz,
    total_fees_kz: totalFeesKz,
    total_net_kz: totalNetKz,
  };
}

export async function getCpmmMarketState(marketId: string, viewerUid?: string) {
  let market: any = null;
  let positions: any[] = [];
  let myPositions: any[] = [];
  let usesCpmmTable = false;

  const mResp = await fetch(`${REST_BASE}/markets?id=eq.${encodeURIComponent(marketId)}&limit=1`, {
    headers: getSupabaseRestHeaders(),
  });
  if (mResp.ok) {
    const mRows = (await mResp.json()) as any[];
    market = mRows?.[0] || null;
  }

  const mpResp = await fetch(
    `${REST_BASE}/market_positions?market_id=eq.${encodeURIComponent(marketId)}&shares_amount=gt.0&order=shares_amount.desc&limit=100`,
    { headers: getSupabaseRestHeaders() }
  );

  if (mpResp.ok) {
    usesCpmmTable = true;
    const rows = (await mpResp.json()) as any[];
    positions = Array.isArray(rows) ? rows : [];
  } else {
    const legResp = await fetch(
      `${REST_BASE}/positions?or=(market_id.eq.${encodeURIComponent(marketId)},marketId.eq.${encodeURIComponent(marketId)})&shares=gt.0&order=shares.desc&limit=100`,
      { headers: getSupabaseRestHeaders() }
    );
    if (legResp.ok) {
      const rows = (await legResp.json()) as any[];
      positions = (rows || []).map((r) => ({
        id: r.id,
        market_id: marketId,
        user_id: r.user_id || r.userId,
        user_name: null,
        outcome: r.outcome,
        shares_amount: Number(r.shares || 0),
        avg_entry_price: Number(r.avg_price || 0) > 1 ? Number(r.avg_price || 0) : Number(r.avg_price || 0) * 100,
        total_cost_kz: Number(r.shares || 0) * (Number(r.avg_price || 0) > 1 ? Number(r.avg_price || 0) : Number(r.avg_price || 0) * 100),
        is_lp: false,
        updated_at: r.updated_at || '',
      }));
    }
  }

  // Enrich user names if missing
  const missingNames = Array.from(
    new Set(positions.filter((p) => !p.user_name && p.user_id).map((p) => String(p.user_id)))
  );
  if (missingNames.length > 0) {
    const uResp = await fetch(
      `${REST_BASE}/users?id=in.(${missingNames.map((id) => encodeURIComponent(id)).join(',')})&select=id,name,email`,
      { headers: getSupabaseRestHeaders() }
    ).catch(() => null);
    if (uResp && uResp.ok) {
      const users = (await uResp.json()) as any[];
      const uMap = new Map((users || []).map((u) => [u.id, u.name || u.email?.split('@')[0] || 'Trader']));
      positions = positions.map((p) => ({
        ...p,
        user_name: p.user_name || uMap.get(p.user_id) || `Trader #${String(p.user_id || '').slice(0, 6)}`,
      }));
    }
  }

  if (viewerUid) {
    myPositions = positions.filter((p) => p.user_id === viewerUid && !p.is_lp);
  }

  const pools = getNormalizedBinaryPools(market);
  const spots = getCpmmSpotPricesKz(pools.poolYes, pools.poolNo);

  return {
    marketId,
    usesCpmmTable,
    poolYes: pools.poolYes,
    poolNo: pools.poolNo,
    liquidityVaultKz: pools.vaultKz,
    yesPriceKz: spots.yesPriceKz,
    noPriceKz: spots.noPriceKz,
    positions,
    myPositions,
  };
}
