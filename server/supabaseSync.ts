import { randomUUID } from 'crypto';
import { SUPABASE_URL, getSupabaseRestHeaders } from './supabaseConfig';

const REST_BASE = `${SUPABASE_URL}/rest/v1`;

export async function fetchSupabaseDoc(
  idToken: string,
  tableName: string,
  docId: string
): Promise<Record<string, any> | null> {
  const resp = await fetch(`${REST_BASE}/${tableName}?id=eq.${encodeURIComponent(docId)}&limit=1`, {
    headers: getSupabaseRestHeaders(idToken),
  });
  if (resp.status === 404) return null;
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`Erro ao consultar ${tableName}/${docId}: ${txt}`);
  }
  const rows = (await resp.json()) as any[];
  if (!Array.isArray(rows) || rows.length === 0) return null;
  return rows[0];
}

export async function patchSupabaseFields(
  idToken: string,
  tableName: string,
  docId: string,
  payload: Record<string, any>,
  throwOnError: boolean = false
): Promise<void> {
  const cleanPayload: Record<string, any> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (v !== undefined) cleanPayload[k] = v;
  }
  if (Object.keys(cleanPayload).length === 0) return;

  // Use upsert on id so both inserts and updates succeed cleanly
  const resp = await fetch(`${REST_BASE}/${tableName}?on_conflict=id`, {
    method: 'POST',
    headers: getSupabaseRestHeaders(idToken, 'resolution=merge-duplicates,return=minimal'),
    body: JSON.stringify({ id: docId, ...cleanPayload }),
  });

  if (!resp.ok) {
    // Fallback to PATCH if POST upsert hits missing required insert columns
    const patchResp = await fetch(`${REST_BASE}/${tableName}?id=eq.${encodeURIComponent(docId)}`, {
      method: 'PATCH',
      headers: getSupabaseRestHeaders(idToken, 'return=minimal'),
      body: JSON.stringify(cleanPayload),
    });
    if (!patchResp.ok) {
      const errText = await patchResp.text();
      if (throwOnError) {
        throw new Error(`Supabase PATCH ${tableName}/${docId} falhou: ${errText}`);
      }
      console.warn(`Supabase PATCH warning (${tableName}/${docId}):`, errText);
    }
  }
}

export async function createSupabaseDoc(
  idToken: string,
  tableName: string,
  payload: Record<string, any>,
  customDocId?: string,
  throwOnError: boolean = false
): Promise<string> {
  const docId = customDocId || randomUUID();
  const fullPayload = { id: docId, ...payload };
  const resp = await fetch(`${REST_BASE}/${tableName}`, {
    method: 'POST',
    headers: getSupabaseRestHeaders(idToken, 'resolution=merge-duplicates,return=minimal'),
    body: JSON.stringify(fullPayload),
  });
  if (!resp.ok) {
    const errText = await resp.text();
    if (throwOnError) {
      throw new Error(`Supabase CREATE ${tableName}/${docId} falhou: ${errText}`);
    }
    console.warn(`Supabase CREATE warning (${tableName}/${docId}):`, errText);
  }
  return docId;
}

export async function deleteSupabaseDoc(
  idToken: string,
  tableName: string,
  docId: string
): Promise<void> {
  try {
    await fetch(`${REST_BASE}/${tableName}?id=eq.${encodeURIComponent(docId)}`, {
      method: 'DELETE',
      headers: getSupabaseRestHeaders(idToken),
    });
  } catch (e) {
    console.warn(`Supabase DELETE warning (${tableName}/${docId}):`, e);
  }
}

export async function listSupabaseUsers(idToken: string): Promise<any[]> {
  const resp = await fetch(`${REST_BASE}/users?select=*&limit=1000`, {
    headers: getSupabaseRestHeaders(idToken),
  });
  if (!resp.ok) {
    throw new Error(`Falha ao consultar tabela users no Supabase (HTTP ${resp.status}).`);
  }
  const rows = (await resp.json()) as any[];
  return Array.isArray(rows) ? rows : [];
}

export async function getFreshSupabaseBalanceCents(idToken: string, uid: string): Promise<number> {
  const resp = await fetch(`${REST_BASE}/users?id=eq.${encodeURIComponent(uid)}&select=balance&limit=1`, {
    headers: getSupabaseRestHeaders(idToken),
  });
  if (!resp.ok) {
    throw new Error('Não foi possível consultar o saldo do utilizador no Supabase.');
  }
  const rows = (await resp.json()) as any[];
  const row = Array.isArray(rows) ? rows[0] : null;
  const bal = Number(row?.balance || 0);
  return Math.max(0, Math.round(bal * 100));
}

export async function updateSupabaseUserBalanceCents(
  idToken: string,
  uid: string,
  newBalanceCents: number
): Promise<void> {
  const balanceKz = Number((newBalanceCents / 100).toFixed(2));
  const resp = await fetch(`${REST_BASE}/users?id=eq.${encodeURIComponent(uid)}`, {
    method: 'PATCH',
    headers: getSupabaseRestHeaders(idToken, 'return=minimal'),
    body: JSON.stringify({ balance: balanceKz }),
  });
  if (!resp.ok) {
    console.warn(`Supabase balance PATCH warning (${uid}):`, await resp.text());
  }
}

export async function recordSupabaseLedgerEntry(
  idToken: string,
  params: {
    userId: string;
    type: string;
    amountKz: number;
    balanceBeforeKz: number;
    balanceAfterKz: number;
    reference: string;
  }
): Promise<void> {
  try {
    await createSupabaseDoc(idToken, 'ledger', {
      user_id: params.userId,
      type: params.type,
      amount: Number(params.amountKz.toFixed(2)),
      balanceBefore: Number(params.balanceBeforeKz.toFixed(2)),
      balanceAfter: Number(params.balanceAfterKz.toFixed(2)),
      reference: params.reference,
      createdAt: new Date().toISOString(),
    });
  } catch (e) {
    console.warn('Supabase ledger sync warning:', e);
  }
}

export async function mirrorAmmStateToSupabase(
  idToken: string,
  tableName: string,
  docId: string,
  payload: Record<string, string | number | boolean | null>
): Promise<void> {
  try {
    await patchSupabaseFields(idToken, tableName, docId, payload, false);
  } catch (e) {
    console.warn(`Supabase mirror (${tableName}/${docId}) warning:`, e);
  }
}

export async function syncUserPositionToSupabase(
  idToken: string,
  uid: string,
  marketId: string,
  positionRows: Array<{ outcome: 'Yes' | 'No'; available_shares: number; reserved_shares: number; avg_price_cents: number }>
): Promise<void> {
  await deleteSupabaseDoc(idToken, 'positions', `${uid}_${marketId}`);

  for (const outcome of ['Yes', 'No'] as const) {
    const posDocId = `${uid}_${marketId}_${outcome}`;
    const row = positionRows.find((r) => r.outcome === outcome);
    const totalShares = (row?.available_shares || 0) + (row?.reserved_shares || 0);
    if (totalShares <= 0) {
      await deleteSupabaseDoc(idToken, 'positions', posDocId);
    } else {
      await patchSupabaseFields(
        idToken,
        'positions',
        posDocId,
        {
          id: posDocId,
          userId: uid,
          user_id: uid,
          marketId,
          market_id: marketId,
          outcome,
          shares: totalShares,
          available_shares: row?.available_shares || 0,
          reserved_shares: row?.reserved_shares || 0,
          avg_price: Number(((row?.avg_price_cents || 0) / 100).toFixed(2)),
          updated_at: new Date().toISOString(),
        },
        false
      );
    }
  }
}

export async function syncClobTradeToSupabase(
  idToken: string,
  params: {
    marketId: string;
    side: 'Buy' | 'Sell';
    outcome: 'Yes' | 'No';
    uid: string;
    filledQuantity: number;
    avgExecutionPriceCents: number | null;
    yesPriceCents: number;
    noPriceCents: number;
    executions: Array<{ executionId: string; notionalCents: number; feeCents: number; priceCents: number; quantity: number }>;
    positionRows: Array<{ outcome: 'Yes' | 'No'; available_shares: number; reserved_shares: number; avg_price_cents: number }>;
  }
): Promise<void> {
  const {
    marketId,
    side,
    outcome,
    uid,
    filledQuantity,
    avgExecutionPriceCents,
    yesPriceCents,
    noPriceCents,
    executions,
    positionRows,
  } = params;

  const totalNotionalCents = executions.reduce((s, e) => s + e.notionalCents, 0);
  const totalFeeCents = executions.reduce((s, e) => s + e.feeCents, 0);
  const volumeAddedKz = Number((totalNotionalCents / 100).toFixed(2));
  const now = new Date().toISOString();

  if (filledQuantity > 0) {
    let currentVol = 0;
    try {
      const mDoc = await fetchSupabaseDoc(idToken, 'markets', marketId);
      currentVol = Number(mDoc?.volume || 0);
    } catch {
      currentVol = 0;
    }
    const yesPrice = Number((yesPriceCents / 100).toFixed(2));
    const noPrice = Number((noPriceCents / 100).toFixed(2));

    await fetch(`${REST_BASE}/markets?id=eq.${encodeURIComponent(marketId)}`, {
      method: 'PATCH',
      headers: getSupabaseRestHeaders(idToken, 'return=minimal'),
      body: JSON.stringify({
        yes_price: yesPrice,
        no_price: noPrice,
        volume: Number((currentVol + volumeAddedKz).toFixed(2)),
      }),
    }).catch(() => {});

    await createSupabaseDoc(idToken, 'trades', {
      market_id: marketId,
      user_id: uid,
      side,
      outcome,
      amount: volumeAddedKz,
      shares: filledQuantity,
      price: Number(((avgExecutionPriceCents || (outcome === 'Yes' ? yesPriceCents : noPriceCents)) / 100).toFixed(2)),
      fee: Number((totalFeeCents / 100).toFixed(2)),
      engine: 'CLOB_AMM',
      timestamp: now,
    });

    await createSupabaseDoc(idToken, 'price_history', {
      market_id: marketId,
      yes_price: yesPrice,
      no_price: noPrice,
      timestamp: now,
    });
  }

  await syncUserPositionToSupabase(idToken, uid, marketId, positionRows);
}

export async function syncMarketSettlementToSupabase(
  idToken: string,
  params: {
    marketId: string;
    winningOutcome: 'Yes' | 'No';
    motive: string;
    resolvedBy: string;
    settledUsers: Array<{
      userId: string;
      payoutCents: number;
      refundCents: number;
      losingShares: number;
      newAvailableCents: number;
    }>;
  }
): Promise<void> {
  const { marketId, winningOutcome, motive, resolvedBy, settledUsers } = params;
  const now = new Date().toISOString();

  await fetch(`${REST_BASE}/markets?id=eq.${encodeURIComponent(marketId)}`, {
    method: 'PATCH',
    headers: getSupabaseRestHeaders(idToken, 'return=minimal'),
    body: JSON.stringify({
      resolved: true,
      resolution_outcome: winningOutcome,
      status: 'resolved',
      resolved_at: now,
      resolution_motive: motive,
      resolved_by: resolvedBy,
    }),
  });

  await createSupabaseDoc(idToken, 'audit_logs', {
    action: 'MARKET_RESOLUTION',
    admin_id: resolvedBy,
    details: `Admin ${resolvedBy} resolveu o mercado "${marketId}" no CLOB+AMM como "${winningOutcome}". Motivo: ${motive}`,
    created_at: now,
    timestamp: now,
  });

  for (const u of settledUsers) {
    if (u.userId.startsWith('bot_') || u.userId === 'AMM_MERCADOAO_COMPANY') {
      await deleteSupabaseDoc(idToken, 'positions', `${u.userId}_${marketId}_Yes`);
      await deleteSupabaseDoc(idToken, 'positions', `${u.userId}_${marketId}_No`);
      await deleteSupabaseDoc(idToken, 'positions', `${u.userId}_${marketId}`);
      continue;
    }

    const newBalanceKz = Number((u.newAvailableCents / 100).toFixed(2));
    await updateSupabaseUserBalanceCents(idToken, u.userId, u.newAvailableCents);

    if (u.payoutCents > 0) {
      const payoutKz = Number((u.payoutCents / 100).toFixed(2));
      const beforeKz = Number(Math.max(0, newBalanceKz - payoutKz).toFixed(2));
      await recordSupabaseLedgerEntry(idToken, {
        userId: u.userId,
        type: 'PREMIACAO_MERCADO',
        amountKz: payoutKz,
        balanceBeforeKz: beforeKz,
        balanceAfterKz: newBalanceKz,
        reference: marketId,
      });
      await createSupabaseDoc(idToken, 'audit_logs', {
        action: 'WINNER_PAYOUT',
        details: `Pago ${payoutKz.toFixed(2)} KZ para utilizador ${u.userId} no mercado ${marketId} (Motor CLOB+AMM).`,
        created_at: now,
        timestamp: now,
      });
    }

    await deleteSupabaseDoc(idToken, 'positions', `${u.userId}_${marketId}_Yes`);
    await deleteSupabaseDoc(idToken, 'positions', `${u.userId}_${marketId}_No`);
    await deleteSupabaseDoc(idToken, 'positions', `${u.userId}_${marketId}`);
  }
}

export async function syncFinanceProcessToSupabase(
  idToken: string,
  params: {
    requestId: string;
    status: 'approved' | 'rejected';
    adminUid: string;
    userId: string;
    type: 'deposit' | 'withdrawal';
    amountCents: number;
    beforeCents: number;
    afterCents: number;
  }
): Promise<void> {
  const now = new Date().toISOString();
  const { requestId, status, adminUid, userId, type, amountCents, beforeCents, afterCents } = params;

  await fetch(`${REST_BASE}/finance_requests?id=eq.${encodeURIComponent(requestId)}`, {
    method: 'PATCH',
    headers: getSupabaseRestHeaders(idToken, 'return=minimal'),
    body: JSON.stringify({
      status,
      processed_at: now,
      processed_by: adminUid,
    }),
  });

  const amountKz = Number((amountCents / 100).toFixed(2));
  const beforeKz = Number((beforeCents / 100).toFixed(2));
  const afterKz = Number((afterCents / 100).toFixed(2));

  if (status === 'approved') {
    await updateSupabaseUserBalanceCents(idToken, userId, afterCents);
    await recordSupabaseLedgerEntry(idToken, {
      userId,
      type: type === 'deposit' ? 'DEPOSITO' : 'SAQUE',
      amountKz: type === 'deposit' ? amountKz : -amountKz,
      balanceBeforeKz: beforeKz,
      balanceAfterKz: afterKz,
      reference: requestId,
    });
    await createSupabaseDoc(idToken, 'audit_logs', {
      action: type === 'deposit' ? 'DEPOSIT_APPROVED' : 'WITHDRAWAL_APPROVED',
      admin_id: adminUid,
      details: `Admin ${adminUid} aprovou ${type === 'deposit' ? 'depósito' : 'saque'} de ${amountKz} KZ para ${userId}. Saldo: ${beforeKz} KZ -> ${afterKz} KZ.`,
      created_at: now,
      timestamp: now,
    });
  } else {
    await createSupabaseDoc(idToken, 'audit_logs', {
      action: type === 'deposit' ? 'DEPOSIT_REJECTED' : 'WITHDRAWAL_REJECTED',
      admin_id: adminUid,
      details: `Admin ${adminUid} rejeitou ${type === 'deposit' ? 'depósito' : 'saque'} de ${amountKz} KZ para ${userId}.`,
      created_at: now,
      timestamp: now,
    });
  }
}

export async function syncAdminBalanceToSupabase(
  idToken: string,
  params: {
    userId: string;
    beforeCents: number;
    afterCents: number;
    adminUid: string;
    reason: string;
  }
): Promise<void> {
  const now = new Date().toISOString();
  const beforeKz = Number((params.beforeCents / 100).toFixed(2));
  const afterKz = Number((params.afterCents / 100).toFixed(2));
  const deltaKz = Number((afterKz - beforeKz).toFixed(2));

  await updateSupabaseUserBalanceCents(idToken, params.userId, params.afterCents);
  await recordSupabaseLedgerEntry(idToken, {
    userId: params.userId,
    type: 'AJUSTE_ADMIN',
    amountKz: deltaKz,
    balanceBeforeKz: beforeKz,
    balanceAfterKz: afterKz,
    reference: `ADMIN:${params.adminUid}`,
  });
  await createSupabaseDoc(idToken, 'audit_logs', {
    action: 'ADMIN_BALANCE_ADJUST',
    admin_id: params.adminUid,
    details: `Admin ${params.adminUid} ajustou saldo de ${params.userId}: ${beforeKz} KZ -> ${afterKz} KZ. Motivo: ${params.reason}`,
    created_at: now,
    timestamp: now,
  });
}

export async function updateSupabaseUserRow(
  idToken: string,
  uid: string,
  payload: Record<string, any>
): Promise<Record<string, any>> {
  const cleanPayload: Record<string, any> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (v !== undefined) cleanPayload[k] = v;
  }
  cleanPayload.updated_at = new Date().toISOString();

  const resp = await fetch(`${REST_BASE}/users?id=eq.${encodeURIComponent(uid)}`, {
    method: 'PATCH',
    headers: getSupabaseRestHeaders(idToken, 'return=representation'),
    body: JSON.stringify(cleanPayload),
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Falha ao atualizar utilizador no Supabase: ${errText}`);
  }
  const rows = (await resp.json()) as any[];
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error('Utilizador não encontrado na base de dados Supabase.');
  }
  return rows[0];
}

export async function fetchSupabaseRowsForUser(
  idToken: string,
  table: string,
  userColumn: string,
  uid: string,
  orderBy?: string,
  limit = 50
): Promise<any[]> {
  try {
    const orderPart = orderBy ? `&order=${encodeURIComponent(orderBy)}.desc` : '';
    const resp = await fetch(
      `${REST_BASE}/${table}?${encodeURIComponent(userColumn)}=eq.${encodeURIComponent(uid)}&select=*${orderPart}&limit=${limit}`,
      { headers: getSupabaseRestHeaders(idToken) }
    );
    if (!resp.ok) return [];
    const rows = (await resp.json()) as any[];
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

export async function getSupabaseAuthAdminUser(uid: string): Promise<{
  emailConfirmedAt: string | null;
  lastSignInAt: string | null;
  createdAt: string | null;
  providers: string[];
  bannedUntil: string | null;
} | null> {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!serviceKey) return null;
  try {
    const resp = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${encodeURIComponent(uid)}`, {
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
      },
    });
    if (!resp.ok) return null;
    const u = (await resp.json()) as any;
    const providers = Array.isArray(u?.app_metadata?.providers)
      ? u.app_metadata.providers
      : u?.app_metadata?.provider
        ? [String(u.app_metadata.provider)]
        : [];
    return {
      emailConfirmedAt: u?.email_confirmed_at || u?.confirmed_at || null,
      lastSignInAt: u?.last_sign_in_at || null,
      createdAt: u?.created_at || null,
      providers,
      bannedUntil: u?.banned_until || null,
    };
  } catch {
    return null;
  }
}

export async function updateSupabaseAuthAdminUser(
  uid: string,
  body: Record<string, any>
): Promise<void> {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!serviceKey) return;
  try {
    await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${encodeURIComponent(uid)}`, {
      method: 'PUT',
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.warn(`Supabase auth admin update warning (${uid}):`, err);
  }
}

export async function deleteSupabaseUserComplete(idToken: string, uid: string): Promise<{ authDeleted: boolean }> {
  // Clean related tables without foreign key cascades first
  await fetch(`${REST_BASE}/positions?or=(user_id.eq.${encodeURIComponent(uid)},userId.eq.${encodeURIComponent(uid)})`, {
    method: 'DELETE',
    headers: getSupabaseRestHeaders(idToken),
  }).catch(() => {});

  await fetch(`${REST_BASE}/ledger?user_id=eq.${encodeURIComponent(uid)}`, {
    method: 'DELETE',
    headers: getSupabaseRestHeaders(idToken),
  }).catch(() => {});

  await fetch(`${REST_BASE}/finance_requests?user_id=eq.${encodeURIComponent(uid)}`, {
    method: 'DELETE',
    headers: getSupabaseRestHeaders(idToken),
  }).catch(() => {});

  await fetch(`${REST_BASE}/trades?user_id=eq.${encodeURIComponent(uid)}`, {
    method: 'DELETE',
    headers: getSupabaseRestHeaders(idToken),
  }).catch(() => {});

  const userDelResp = await fetch(`${REST_BASE}/users?id=eq.${encodeURIComponent(uid)}`, {
    method: 'DELETE',
    headers: getSupabaseRestHeaders(idToken),
  });
  if (!userDelResp.ok) {
    const errText = await userDelResp.text();
    throw new Error(`Falha ao apagar utilizador no Supabase: ${errText}`);
  }

  let authDeleted = false;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (serviceKey) {
    try {
      const authDelResp = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${encodeURIComponent(uid)}`, {
        method: 'DELETE',
        headers: {
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ should_soft_delete: false }),
      });
      authDeleted = authDelResp.ok || authDelResp.status === 404;
    } catch {
      authDeleted = false;
    }
  }

  return { authDeleted };
}
