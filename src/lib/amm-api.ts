import { getSupabaseAccessToken, isSupabaseConfigured, supabase } from '../supabase';

export interface CpmmTypedError extends Error {
  code?: string;
  isPriceChanged?: boolean;
  expectedPrice?: number;
  currentPrice?: number;
}

function parsePriceChangedDetails(msg: string): { expectedPrice?: number; currentPrice?: number } {
  const m = msg.match(/mudou de\s+([0-9]+(?:[.,][0-9]+)?)\s+para\s+([0-9]+(?:[.,][0-9]+)?)/i);
  if (!m) return {};
  return {
    expectedPrice: Number(m[1].replace(',', '.')),
    currentPrice: Number(m[2].replace(',', '.')),
  };
}

function createCpmmTypedError(
  message: string,
  code?: string,
  expectedPrice?: number,
  currentPrice?: number
): CpmmTypedError {
  const err = new Error(message) as CpmmTypedError;
  err.code = code;
  const isPrice = code === 'PRICE_CHANGED' || message.includes('PRICE_CHANGED');
  if (isPrice) {
    err.code = 'PRICE_CHANGED';
    err.isPriceChanged = true;
    const parsed = parsePriceChangedDetails(message);
    err.expectedPrice = expectedPrice ?? parsed.expectedPrice;
    err.currentPrice = currentPrice ?? parsed.currentPrice;
  }
  return err;
}

function isRpcMissingError(err: any): boolean {
  const code = String(err?.code || '');
  const msg = String(err?.message || '').toLowerCase();
  return (
    code === 'PGRST202' ||
    code === '42883' ||
    msg.includes('could not find the function') ||
    msg.includes('does not exist')
  );
}

async function getAuthHeaders(includeIdempotency = false): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  const token = await getSupabaseAccessToken();
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  if (includeIdempotency) {
    headers['X-Idempotency-Key'] =
      typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
  return headers;
}

function isHtmlOrWarmupPayload(text: string, contentType?: string | null): boolean {
  const lowerType = (contentType || '').toLowerCase();
  if (lowerType.includes('text/html')) return true;
  const trimmed = text.trim().toLowerCase();
  return (
    trimmed.startsWith('<!doctype html') ||
    trimmed.startsWith('<html') ||
    trimmed.includes('<title>starting server') ||
    trimmed.includes('please wait while your application starts')
  );
}

function formatReadableHttpError(text: string, status: number, contentType?: string | null): string {
  if (status === 502 || status === 503 || status === 504 || isHtmlOrWarmupPayload(text, contentType)) {
    return 'O servidor ainda está a iniciar ou temporariamente indisponível. Clique em "Tentar Novamente" dentro de instantes.';
  }
  const clean = text.trim();
  if (!clean) {
    return `Erro HTTP ${status}`;
  }
  return clean.length > 260 ? `${clean.slice(0, 260)}...` : clean;
}

const RETRY_DELAYS_MS = [900, 1800];

async function fetchResilient(url: string, init?: RequestInit, retryWarmup = false): Promise<Response> {
  let lastError: any = null;
  const maxAttempts = retryWarmup ? RETRY_DELAYS_MS.length + 1 : 1;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const resp = await fetch(url, init);
      const contentType = resp.headers.get('content-type');
      const isTransientGateway = resp.status === 502 || resp.status === 503 || resp.status === 504;

      if (retryWarmup && attempt < maxAttempts - 1) {
        if (isTransientGateway) {
          await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
          continue;
        }
        if ((contentType || '').toLowerCase().includes('text/html')) {
          const cloneText = await resp.clone().text().catch(() => '');
          if (isHtmlOrWarmupPayload(cloneText, contentType)) {
            await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
            continue;
          }
        }
      }
      return resp;
    } catch (err) {
      lastError = err;
      if (retryWarmup && attempt < maxAttempts - 1) {
        await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
        continue;
      }
      throw err;
    }
  }

  throw lastError || new Error('Não foi possível contactar o servidor.');
}

async function handleResponse<T>(resp: Response): Promise<T> {
  const contentType = resp.headers.get('content-type');
  const text = await resp.text();

  if (isHtmlOrWarmupPayload(text, contentType)) {
    throw new Error(formatReadableHttpError(text, resp.status, contentType));
  }

  let data: any = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(formatReadableHttpError(text, resp.status, contentType));
  }
  if (!resp.ok) {
    throw createCpmmTypedError(
      data.error || formatReadableHttpError('', resp.status, contentType),
      data.code,
      data.expectedPrice,
      data.currentPrice
    );
  }
  return data as T;
}

export const ammApi = {
  // --- CLOB Public & User ---
  getOrderBook: async (marketId: string) => {
    const resp = await fetchResilient(`/api/clob/book/${encodeURIComponent(marketId)}`, undefined, true);
    return handleResponse<any>(resp);
  },

  quoteClobOrder: async (params: {
    marketId: string;
    side: 'Buy' | 'Sell';
    outcome: 'Yes' | 'No';
    orderType: 'LIMIT' | 'MARKET';
    budgetKz?: number;
    quantity?: number;
    limitPriceCents?: number;
  }) => {
    const headers = await getAuthHeaders(false);
    const qs = new URLSearchParams({
      marketId: params.marketId,
      side: params.side,
      outcome: params.outcome,
      orderType: params.orderType,
    });
    if (params.budgetKz !== undefined) qs.set('budgetKz', String(params.budgetKz));
    if (params.quantity !== undefined) qs.set('quantity', String(params.quantity));
    if (params.limitPriceCents !== undefined) qs.set('limitPriceCents', String(params.limitPriceCents));

    const resp = await fetchResilient(`/api/clob/quote?${qs.toString()}`, { headers }, true);
    return handleResponse<{
      marketId: string;
      side: 'Buy' | 'Sell';
      outcome: 'Yes' | 'No';
      orderType: 'LIMIT' | 'MARKET';
      executableShares: number;
      avgPriceCents: number;
      worstFillPriceCents: number;
      estimatedNotionalCents: number;
      estimatedFeeCents: number;
      estimatedTotalCents: number;
      hasLiquidity: boolean;
      referencePriceCents: number;
    }>(resp);
  },

  getMarketExecutions: async (marketId: string, limitCount: number = 50) => {
    const resp = await fetchResilient(
      `/api/clob/executions/${encodeURIComponent(marketId)}?limit=${limitCount}`,
      undefined,
      true
    );
    return handleResponse<{ executions: any[] }>(resp);
  },

  getMarketClobPositions: async (marketId: string) => {
    const resp = await fetchResilient(`/api/clob/positions/${encodeURIComponent(marketId)}`, undefined, true);
    return handleResponse<{ positions: any[] }>(resp);
  },

  getMyClobOrders: async (marketId?: string) => {
    const headers = await getAuthHeaders(false);
    const qs = marketId ? `?marketId=${encodeURIComponent(marketId)}` : '';
    const resp = await fetchResilient(`/api/clob/orders/my${qs}`, { headers }, true);
    return handleResponse<{ orders: any[]; positions: any[]; account: any }>(resp);
  },

  placeClobOrder: async (payload: {
    marketId: string;
    side: 'Buy' | 'Sell';
    outcome: 'Yes' | 'No';
    orderType: 'LIMIT' | 'MARKET';
    priceCents?: number;
    quantity?: number;
    budgetKz?: number;
  }) => {
    const headers = await getAuthHeaders(true);
    const resp = await fetchResilient('/api/clob/order', {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    return handleResponse<any>(resp);
  },

  cancelClobOrder: async (orderId: string) => {
    const headers = await getAuthHeaders(true);
    const resp = await fetchResilient(`/api/clob/order/${encodeURIComponent(orderId)}/cancel`, {
      method: 'POST',
      headers,
    });
    return handleResponse<any>(resp);
  },

  resolveClobMarket: async (marketId: string, winningOutcome: 'Yes' | 'No', motive?: string) => {
    const headers = await getAuthHeaders(true);
    const resp = await fetchResilient(`/api/clob/market/${encodeURIComponent(marketId)}/resolve`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ winningOutcome, motive }),
    });
    return handleResponse<any>(resp);
  },

  // --- Admin Finance & Balance Synchronization ---
  processFinanceRequest: async (requestId: string, status: 'approved' | 'rejected') => {
    const headers = await getAuthHeaders(true);
    const resp = await fetchResilient('/api/finance/process', {
      method: 'POST',
      headers,
      body: JSON.stringify({ requestId, status }),
    });
    return handleResponse<any>(resp);
  },

  adminUpdateUserBalance: async (userId: string, newBalanceKz: number, reason?: string) => {
    const headers = await getAuthHeaders(true);
    const resp = await fetchResilient(`/api/admin/users/${encodeURIComponent(userId)}/balance`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ newBalanceKz, reason }),
    });
    return handleResponse<any>(resp);
  },

  getUsersReconciliation: async () => {
    const headers = await getAuthHeaders(false);
    const resp = await fetchResilient('/api/amm/reconciliation/users', { headers }, true);
    return handleResponse<{ accounts: any[]; positions: any[] }>(resp);
  },

  executeBotSandboxLiquidity: async (payload: {
    marketId: string;
    botId?: string;
    outcome: 'Yes' | 'No';
    amountKz: number;
  }) => {
    const headers = await getAuthHeaders(true);
    const resp = await fetchResilient('/api/amm/sandbox/bot-liquidity', {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    return handleResponse<any>(resp);
  },

  // --- AMM Control Center ---
  getOverview: async () => {
    const headers = await getAuthHeaders(false);
    const resp = await fetchResilient('/api/amm/overview', { headers }, true);
    return handleResponse<any>(resp);
  },

  getMarketDetails: async (marketId: string) => {
    const headers = await getAuthHeaders(false);
    const resp = await fetchResilient(`/api/amm/markets/${encodeURIComponent(marketId)}`, { headers }, true);
    return handleResponse<any>(resp);
  },

  getLedger: async () => {
    const headers = await getAuthHeaders(false);
    const resp = await fetchResilient('/api/amm/ledger', { headers }, true);
    return handleResponse<any>(resp);
  },

  requestAllocation: async (payload: {
    marketId: string;
    marketQuestion: string;
    allocatedCapitalKz: number;
    yesPriceCents?: number;
    noPriceCents?: number;
    justification: string;
  }) => {
    const headers = await getAuthHeaders(true);
    const resp = await fetchResilient('/api/amm/allocations/request', {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    return handleResponse<any>(resp);
  },

  decideAllocation: async (
    marketId: string,
    payload: {
      decision: 'APPROVED' | 'REJECTED' | 'SUSPENDED';
      allocatedCapitalKz?: number;
      justification: string;
    }
  ) => {
    const headers = await getAuthHeaders(true);
    const resp = await fetchResilient(`/api/amm/allocations/${encodeURIComponent(marketId)}/decide`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    return handleResponse<any>(resp);
  },

  toggleAmm: async (enable: boolean, justification: string) => {
    const headers = await getAuthHeaders(true);
    const resp = await fetchResilient('/api/amm/toggle', {
      method: 'POST',
      headers,
      body: JSON.stringify({ enable, justification }),
    });
    return handleResponse<any>(resp);
  },

  emergencyStop: async (justification: string) => {
    const headers = await getAuthHeaders(true);
    const resp = await fetchResilient('/api/amm/emergency-stop', {
      method: 'POST',
      headers,
      body: JSON.stringify({ justification }),
    });
    return handleResponse<any>(resp);
  },

  resumeAfterInvestigation: async (payload: {
    marketId?: string;
    investigationFindings: string;
    justification: string;
  }) => {
    const headers = await getAuthHeaders(true);
    const resp = await fetchResilient('/api/amm/resume', {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    return handleResponse<any>(resp);
  },

  updateLimits: async (payload: {
    warningPct: number;
    protectionPct: number;
    haltPct: number;
    maxAllocationBudgetKz: number;
    justification: string;
  }) => {
    const headers = await getAuthHeaders(true);
    const resp = await fetchResilient('/api/amm/limits', {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    return handleResponse<any>(resp);
  },

  triggerStrategyTick: async (marketId?: string) => {
    const headers = await getAuthHeaders(true);
    const resp = await fetchResilient('/api/amm/strategy/tick', {
      method: 'POST',
      headers,
      body: JSON.stringify({ marketId }),
    });
    return handleResponse<any>(resp);
  },

  runSandboxTests: async () => {
    const headers = await getAuthHeaders(true);
    const resp = await fetchResilient('/api/amm/sandbox/run-tests', {
      method: 'POST',
      headers,
    });
    return handleResponse<any>(resp);
  },

  // --- Executive Dashboard, CLOB Control, Candles, PnL, Reconciliation & System Health ---
  getAdminActor: async () => {
    const headers = await getAuthHeaders(false);
    const resp = await fetchResilient('/api/admin/actor', { headers }, true);
    return handleResponse<{ uid: string; email: string; role: 'MASTER_ADMIN' | 'OPERATIONAL_ADMIN' | 'USER'; isMasterAdmin: boolean }>(resp);
  },

  getClobCandles: async (marketId: string, interval: '5m' | '15m' | '1h' | '4h' | '1d' = '1h', outcome: 'Yes' | 'No' = 'Yes') => {
    const qs = new URLSearchParams({ interval, outcome });
    const resp = await fetchResilient(`/api/clob/candles/${encodeURIComponent(marketId)}?${qs.toString()}`, undefined, true);
    return handleResponse<{
      marketId: string;
      outcome: 'Yes' | 'No';
      interval: string;
      candles: Array<{
        timestamp: string;
        time: string;
        open: number;
        high: number;
        low: number;
        close: number;
        volumeKz: number;
        trades: number;
        isUp: boolean;
      }>;
    }>(resp);
  },

  getDashboardOverview: async (params: { period: string; from?: string; to?: string }) => {
    const headers = await getAuthHeaders(false);
    const qs = new URLSearchParams({ period: params.period });
    if (params.from) qs.set('from', params.from);
    if (params.to) qs.set('to', params.to);
    const resp = await fetchResilient(`/api/admin/dashboard/overview?${qs.toString()}`, { headers }, true);
    return handleResponse<any>(resp);
  },

  getClobOverview: async (params: {
    period: string;
    from?: string;
    to?: string;
    marketId?: string;
    status?: string;
    side?: string;
    search?: string;
    page?: number;
    limit?: number;
  }) => {
    const headers = await getAuthHeaders(false);
    const qs = new URLSearchParams({ period: params.period });
    if (params.from) qs.set('from', params.from);
    if (params.to) qs.set('to', params.to);
    if (params.marketId) qs.set('marketId', params.marketId);
    if (params.status) qs.set('status', params.status);
    if (params.side) qs.set('side', params.side);
    if (params.search) qs.set('search', params.search);
    if (params.page) qs.set('page', String(params.page));
    if (params.limit) qs.set('limit', String(params.limit));
    const resp = await fetchResilient(`/api/admin/clob/overview?${qs.toString()}`, { headers }, true);
    return handleResponse<any>(resp);
  },

  getProfitAndLoss: async (params: { period: string; from?: string; to?: string; marketId?: string; source?: string }) => {
    const headers = await getAuthHeaders(false);
    const qs = new URLSearchParams({ period: params.period });
    if (params.from) qs.set('from', params.from);
    if (params.to) qs.set('to', params.to);
    if (params.marketId) qs.set('marketId', params.marketId);
    if (params.source) qs.set('source', params.source);
    const resp = await fetchResilient(`/api/admin/pnl?${qs.toString()}`, { headers }, true);
    return handleResponse<any>(resp);
  },

  getReconciliationOverview: async () => {
    const headers = await getAuthHeaders(false);
    const resp = await fetchResilient('/api/admin/reconciliation/overview', { headers }, true);
    return handleResponse<any>(resp);
  },

  runAuditedReconciliation: async (justification: string) => {
    const headers = await getAuthHeaders(true);
    const resp = await fetchResilient('/api/admin/reconciliation/run', {
      method: 'POST',
      headers,
      body: JSON.stringify({ justification }),
    });
    return handleResponse<any>(resp);
  },

  getSystemHealth: async () => {
    const headers = await getAuthHeaders(false);
    const resp = await fetchResilient('/api/admin/system-health', { headers }, true);
    return handleResponse<any>(resp);
  },

  getGlobalAudit: async (action?: string, limit = 100) => {
    const headers = await getAuthHeaders(false);
    const qs = new URLSearchParams({ limit: String(limit) });
    if (action) qs.set('action', action);
    const resp = await fetchResilient(`/api/admin/audit-global?${qs.toString()}`, { headers }, true);
    return handleResponse<any>(resp);
  },

  updateUserAdminRole: async (uid: string, grantOperationalAdmin: boolean, justification: string) => {
    const headers = await getAuthHeaders(true);
    const resp = await fetchResilient(`/api/admin/users/${encodeURIComponent(uid)}/role`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ grantOperationalAdmin, justification }),
    });
    return handleResponse<any>(resp);
  },

  updateMasterPlatformSettings: async (payload: {
    tradingFee: number;
    minDeposit: number;
    minWithdrawal: number;
    maintenanceMode: boolean;
    platformName: string;
    justification: string;
  }) => {
    const headers = await getAuthHeaders(true);
    const resp = await fetchResilient('/api/admin/platform-settings', {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    return handleResponse<any>(resp);
  },

  // --- Admin User Control (Details, Edit, Block/Unblock, KYC, Delete) ---
  getAdminUserDetails: async (uid: string) => {
    const headers = await getAuthHeaders(false);
    const resp = await fetchResilient(`/api/admin/users/${encodeURIComponent(uid)}/details`, { headers }, true);
    return handleResponse<{
      profile: any;
      authMeta: {
        emailConfirmedAt: string | null;
        lastSignInAt: string | null;
        createdAt: string | null;
        providers: string[];
        bannedUntil: string | null;
      } | null;
      clobAccount: any;
      clobPositions: any[];
      clobOrders: any[];
      clobStats: { executionsCount: number; executedVolumeKz: number };
      financeRequests: any[];
      trades: any[];
      ledger: any[];
      securityAudits: any[];
    }>(resp);
  },

  updateAdminUser: async (
    uid: string,
    payload: {
      name?: string;
      email?: string;
      wallet_address?: string | null;
      status?: 'active' | 'blocked' | 'pending_verification';
      verification_status?: 'none' | 'pending' | 'verified' | 'rejected';
      is_verified?: boolean;
      role?: string;
      is_admin?: boolean;
      justification?: string;
    }
  ) => {
    const headers = await getAuthHeaders(true);
    const resp = await fetchResilient(`/api/admin/users/${encodeURIComponent(uid)}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify(payload),
    });
    return handleResponse<{ updated: boolean; user: any; cancelledOrders: number }>(resp);
  },

  updateAdminUserStatus: async (uid: string, status: 'active' | 'blocked' | 'pending_verification', reason?: string) => {
    const headers = await getAuthHeaders(true);
    const resp = await fetchResilient(`/api/admin/users/${encodeURIComponent(uid)}/status`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ status, reason }),
    });
    return handleResponse<{ updated: boolean; status: string; user: any; cancelledOrders: number }>(resp);
  },

  updateAdminUserKyc: async (uid: string, decision: 'verified' | 'rejected' | 'pending' | 'none', reason?: string) => {
    const headers = await getAuthHeaders(true);
    const resp = await fetchResilient(`/api/admin/users/${encodeURIComponent(uid)}/kyc`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ decision, reason }),
    });
    return handleResponse<{ updated: boolean; verification_status: string; is_verified: boolean; user: any }>(resp);
  },

  deleteAdminUser: async (uid: string, reason?: string) => {
    const headers = await getAuthHeaders(true);
    const resp = await fetchResilient(`/api/admin/users/${encodeURIComponent(uid)}`, {
      method: 'DELETE',
      headers,
      body: JSON.stringify({ reason }),
    });
    return handleResponse<{ deleted: boolean; uid: string; cancelledOrders: number; authDeleted: boolean }>(resp);
  },

  // --- Market Interactions, Bookmarks, Proposals, FAQs & Multi-Outcome Trading ---
  getMarketInteractions: async (marketId: string) => {
    const headers = await getAuthHeaders(false);
    const resp = await fetchResilient(
      `/api/markets/${encodeURIComponent(marketId)}/interactions`,
      { headers },
      true
    );
    return handleResponse<{
      bookmarked: boolean;
      bookmarkCount: number;
      metadata: {
        additional_context?: string | null;
        additional_context_updated_at?: string | null;
        resolver_name?: string | null;
        resolver_address?: string | null;
        description_override?: string | null;
      } | null;
      proposals: Array<{
        id: string;
        market_id: string;
        user_id: string;
        user_name?: string;
        proposed_outcome: string;
        evidence_url?: string | null;
        rationale: string;
        status: 'pending' | 'accepted' | 'rejected';
        created_at: string;
      }>;
      faqs: Array<{
        id: string;
        market_id: string;
        question: string;
        answer: string;
        sort_order: number;
      }>;
      commentLikes: Record<string, { count: number; likedByMe: boolean }>;
      outcomeHistory: Array<{
        id: string;
        market_id: string;
        outcome_id: string;
        outcome_name: string;
        price: number;
        timestamp: string;
      }>;
      multiPositions: Array<{
        id: string;
        userId: string;
        userLabel: string;
        outcome: string;
        binarySide: 'Yes' | 'No';
        shares: number;
        avg_price: number;
        updatedAt: string;
      }>;
      myMultiPositions: Array<{
        id: string;
        userId: string;
        userLabel: string;
        outcome: string;
        binarySide: 'Yes' | 'No';
        shares: number;
        avg_price: number;
        updatedAt: string;
      }>;
    }>(resp);
  },

  toggleMarketBookmark: async (marketId: string) => {
    const headers = await getAuthHeaders(false);
    const resp = await fetchResilient(`/api/markets/${encodeURIComponent(marketId)}/bookmark`, {
      method: 'POST',
      headers,
    });
    return handleResponse<{ bookmarked: boolean; bookmarkCount: number }>(resp);
  },

  toggleCommentLike: async (marketId: string, commentId: string) => {
    const headers = await getAuthHeaders(false);
    const resp = await fetchResilient(
      `/api/markets/${encodeURIComponent(marketId)}/comments/${encodeURIComponent(commentId)}/like`,
      { method: 'POST', headers }
    );
    return handleResponse<{ commentId: string; liked: boolean; count: number }>(resp);
  },

  deleteMarketComment: async (marketId: string, commentId: string) => {
    const headers = await getAuthHeaders(false);
    const resp = await fetchResilient(
      `/api/markets/${encodeURIComponent(marketId)}/comments/${encodeURIComponent(commentId)}`,
      { method: 'DELETE', headers }
    );
    return handleResponse<{ deleted: boolean; commentId: string }>(resp);
  },

  submitResolutionProposal: async (
    marketId: string,
    payload: { proposedOutcome: string; evidenceUrl?: string; rationale: string }
  ) => {
    const headers = await getAuthHeaders(true);
    const resp = await fetchResilient(
      `/api/markets/${encodeURIComponent(marketId)}/resolution-proposals`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      }
    );
    return handleResponse<{ proposal: any }>(resp);
  },

  updateMarketMetadata: async (
    marketId: string,
    payload: {
      additionalContext?: string;
      description?: string;
      resolverName?: string;
      resolverAddress?: string;
    }
  ) => {
    const headers = await getAuthHeaders(false);
    const resp = await fetchResilient(`/api/markets/${encodeURIComponent(marketId)}/metadata`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify(payload),
    });
    return handleResponse<{ updated: boolean; metadata: any }>(resp);
  },

  addMarketFaq: async (marketId: string, payload: { question: string; answer: string }) => {
    const headers = await getAuthHeaders(true);
    const resp = await fetchResilient(`/api/markets/${encodeURIComponent(marketId)}/faqs`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    return handleResponse<{ faq: any }>(resp);
  },

  deleteMarketFaq: async (marketId: string, faqId: string) => {
    const headers = await getAuthHeaders(false);
    const resp = await fetchResilient(
      `/api/markets/${encodeURIComponent(marketId)}/faqs/${encodeURIComponent(faqId)}`,
      { method: 'DELETE', headers }
    );
    return handleResponse<{ deleted: boolean; faqId: string }>(resp);
  },

  reviewResolutionProposal: async (
    marketId: string,
    proposalId: string,
    status: 'accepted' | 'rejected'
  ) => {
    const headers = await getAuthHeaders(true);
    const resp = await fetchResilient(
      `/api/markets/${encodeURIComponent(marketId)}/resolution-proposals/${encodeURIComponent(proposalId)}`,
      {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ status }),
      }
    );
    return handleResponse<{ updated: boolean; proposalId: string; status: string }>(resp);
  },

  resolveMultiMarket: async (marketId: string, winningOutcome: string, motive: string) => {
    const headers = await getAuthHeaders(true);
    const resp = await fetchResilient(`/api/markets/${encodeURIComponent(marketId)}/multi-resolve`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ winningOutcome, motive }),
    });
    return handleResponse<{
      resolved: boolean;
      marketId: string;
      winningOutcome: string;
      payoutsCount: number;
      totalPaidKz: number;
    }>(resp);
  },

  placeMultiOutcomeTrade: async (
    marketId: string,
    payload: {
      outcomeName: string;
      side: 'Buy' | 'Sell';
      binarySide: 'Yes' | 'No';
      amountKz?: number;
      shares?: number;
    }
  ) => {
    const headers = await getAuthHeaders(true);
    const resp = await fetchResilient(`/api/markets/${encodeURIComponent(marketId)}/multi-trade`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    return handleResponse<{
      executed: boolean;
      side: 'Buy' | 'Sell';
      binarySide: 'Yes' | 'No';
      outcomeName: string;
      filledShares: number;
      execPrice: number;
      grossNotionalKz: number;
      feeKz: number;
      balanceKz: number;
      outcomes: any[];
      volume: number;
    }>(resp);
  },

  // --- CPMM (x * y = k) AMM Engine (Supabase RPC primary + Express fallback) ---
  cpmmBuyShares: async (payload: {
    marketId: string;
    outcome: 'Yes' | 'No';
    grossAmountKz: number;
    expectedPriceKz: number;
    maxSlippagePct?: number;
    idempotencyKey?: string;
  }) => {
    const idempotencyKey =
      payload.idempotencyKey ||
      (typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

    if (isSupabaseConfigured) {
      try {
        const { data, error } = await supabase.rpc('buy_shares', {
          p_market_id: payload.marketId,
          p_outcome: payload.outcome,
          p_gross_amount_kz: payload.grossAmountKz,
          p_expected_price: payload.expectedPriceKz,
          p_max_slippage_pct: payload.maxSlippagePct ?? 1.0,
          p_idempotency_key: idempotencyKey,
        });
        if (!error && data) {
          return { ...data, viaRpc: true, idempotencyKey };
        }
        if (error && !isRpcMissingError(error)) {
          throw createCpmmTypedError(error.message || 'Erro ao comprar shares.', (error as any).code);
        }
      } catch (err: any) {
        if (!isRpcMissingError(err)) {
          throw createCpmmTypedError(err?.message || 'Erro ao comprar shares.', err?.code, err?.expectedPrice, err?.currentPrice);
        }
      }
    }

    const headers = await getAuthHeaders(false);
    headers['X-Idempotency-Key'] = idempotencyKey;
    const resp = await fetchResilient('/api/cpmm/buy', {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...payload, idempotencyKey }),
    });
    const res = await handleResponse<any>(resp);
    return { ...res, idempotencyKey };
  },

  cpmmSellShares: async (payload: {
    marketId: string;
    outcome: 'Yes' | 'No';
    sharesToSell: number;
    expectedPriceKz: number;
    maxSlippagePct?: number;
    idempotencyKey?: string;
  }) => {
    const idempotencyKey =
      payload.idempotencyKey ||
      (typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

    if (isSupabaseConfigured) {
      try {
        const { data, error } = await supabase.rpc('sell_shares', {
          p_market_id: payload.marketId,
          p_outcome: payload.outcome,
          p_shares_to_sell: payload.sharesToSell,
          p_expected_price: payload.expectedPriceKz,
          p_max_slippage_pct: payload.maxSlippagePct ?? 1.0,
          p_idempotency_key: idempotencyKey,
        });
        if (!error && data) {
          return { ...data, viaRpc: true, idempotencyKey };
        }
        if (error && !isRpcMissingError(error)) {
          throw createCpmmTypedError(error.message || 'Erro ao vender shares.', (error as any).code);
        }
      } catch (err: any) {
        if (!isRpcMissingError(err)) {
          throw createCpmmTypedError(err?.message || 'Erro ao vender shares.', err?.code, err?.expectedPrice, err?.currentPrice);
        }
      }
    }

    const headers = await getAuthHeaders(false);
    headers['X-Idempotency-Key'] = idempotencyKey;
    const resp = await fetchResilient('/api/cpmm/sell', {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...payload, idempotencyKey }),
    });
    const res = await handleResponse<any>(resp);
    return { ...res, idempotencyKey };
  },

  cpmmResolveMarket: async (marketId: string, winningOutcome: 'Yes' | 'No', motive: string) => {
    if (isSupabaseConfigured) {
      try {
        const { data, error } = await supabase.rpc('resolve_market', {
          p_market_id: marketId,
          p_winning_outcome: winningOutcome,
          p_motive: motive,
        });
        if (!error && data) {
          return { ...data, viaRpc: true };
        }
        if (error && !isRpcMissingError(error)) {
          throw createCpmmTypedError(error.message || 'Erro ao liquidar mercado.', (error as any).code);
        }
      } catch (err: any) {
        if (!isRpcMissingError(err)) {
          throw err;
        }
      }
    }

    const headers = await getAuthHeaders(true);
    const resp = await fetchResilient('/api/cpmm/resolve', {
      method: 'POST',
      headers,
      body: JSON.stringify({ marketId, winningOutcome, motive }),
    });
    return handleResponse<any>(resp);
  },

  getCpmmMarketState: async (marketId: string) => {
    const headers = await getAuthHeaders(false);
    const resp = await fetchResilient(`/api/cpmm/market/${encodeURIComponent(marketId)}/state`, { headers }, true);
    return handleResponse<{
      marketId: string;
      usesCpmmTable: boolean;
      poolYes: number;
      poolNo: number;
      liquidityVaultKz: number;
      yesPriceKz: number;
      noPriceKz: number;
      positions: any[];
      myPositions: any[];
    }>(resp);
  },

  getCpmmRevenue: async () => {
    const headers = await getAuthHeaders(false);
    const resp = await fetchResilient('/api/cpmm/revenue', { headers }, true);
    return handleResponse<{ rows: any[]; totalFeeKz: number }>(resp);
  },
};
