import { supabase, isSupabaseConfigured } from '../supabase';
import { Market, Trade, User, Position, MarketPosition, Category, Comment, PriceHistory } from '../types';
import { sanitizePlainText } from './sanitize';

export const calculateCost = (q_yes: number, q_no: number, b: number) => {
  return b * Math.log(Math.exp(q_yes / b) + Math.exp(q_no / b));
};

export const calculateShares = (amount: number, q_yes: number, q_no: number, b: number, outcome: 'Yes' | 'No') => {
  const q = outcome === 'Yes' ? q_yes : q_no;
  const q_other = outcome === 'Yes' ? q_no : q_yes;

  const exp_A_b = Math.exp(amount / b);
  const exp_q_b = Math.exp(q / b);
  const exp_q_other_b = Math.exp(q_other / b);

  return b * Math.log((exp_A_b * (exp_q_b + exp_q_other_b) - exp_q_other_b) / exp_q_b);
};

export const calculatePrices = (q_yes: number, q_no: number, b: number) => {
  const exp_yes = Math.exp(q_yes / b);
  const exp_no = Math.exp(q_no / b);
  const sum_exp = exp_yes + exp_no;
  return {
    yes: exp_yes / sum_exp,
    no: exp_no / sum_exp,
  };
};

function genId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function normalizePosition(p: any): Position {
  return {
    ...p,
    market_id: p.market_id || p.marketId || '',
    marketId: p.market_id || p.marketId || '',
    user_id: p.user_id || p.userId || '',
    userId: p.user_id || p.userId || '',
    shares: Number(p.shares || 0),
    avg_price: Number(p.avg_price || 0),
  } as any as Position;
}

export const supabaseService = {
  // --- Markets ---
  subscribeToMarkets: (callback: (markets: Market[]) => void) => {
    if (!isSupabaseConfigured) {
      callback([]);
      return () => {};
    }
    let active = true;
    const load = async () => {
      try {
        const { data, error } = await supabase.from('markets').select('*');
        if (!active) return;
        if (error) {
          console.warn('Markets fetch warning:', error.message);
          callback([]);
          return;
        }
        callback((data || []) as Market[]);
      } catch (err) {
        console.warn('Markets network warning:', err);
        if (active) callback([]);
      }
    };

    load();

    const channel = supabase
      .channel(`markets_sub_${genId()}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'markets' }, () => {
        load();
      })
      .subscribe();

    return () => {
      active = false;
      supabase.removeChannel(channel);
    };
  },

  getMarket: async (marketId: string) => {
    if (!isSupabaseConfigured) return null;
    try {
      const { data, error } = await supabase.from('markets').select('*').eq('id', marketId).maybeSingle();
      if (error) return null;
      return data ? (data as Market) : null;
    } catch {
      return null;
    }
  },

  getMarkets: async () => {
    if (!isSupabaseConfigured) return [];
    try {
      const { data, error } = await supabase.from('markets').select('*');
      if (error) return [];
      return (data || []) as Market[];
    } catch {
      return [];
    }
  },

  getCategories: async () => {
    if (!isSupabaseConfigured) return [];
    try {
      const { data, error } = await supabase.from('categories').select('*').order('order', { ascending: true });
      if (error) {
        console.warn('Categories fetch warning:', error.message);
        return [];
      }
      return (data || []) as Category[];
    } catch {
      return [];
    }
  },

  getPosts: async () => {
    if (!isSupabaseConfigured) return [];
    try {
      const { data, error } = await supabase
        .from('posts')
        .select('*')
        .eq('status', 'published')
        .order('created_at', { ascending: false });
      if (error) {
        console.warn('Posts fetch warning:', error.message);
        return [];
      }
      return data || [];
    } catch {
      return [];
    }
  },

  // --- Users ---
  getUserProfile: async (userId: string) => {
    if (!isSupabaseConfigured) return null;
    try {
      const { data: userData, error } = await supabase.from('users').select('*').eq('id', userId).maybeSingle();
      if (error || !userData) return null;

      try {
        const [{ data: cpmmPosRows, error: cpmmErr }, { data: posRows }] = await Promise.all([
          supabase.from('market_positions').select('*').eq('user_id', userId).gt('shares_amount', 0),
          supabase.from('positions').select('*').or(`user_id.eq.${userId},userId.eq.${userId}`),
        ]);

        const mergedMap = new Map<string, Position>();
        for (const row of posRows || []) {
          const norm = normalizePosition(row);
          if (norm.shares > 0) {
            mergedMap.set(`${norm.market_id}:${norm.outcome}:TR`, norm);
          }
        }
        if (!cpmmErr && Array.isArray(cpmmPosRows)) {
          for (const row of cpmmPosRows) {
            const sharesVal = Number(row.shares_amount || 0);
            if (sharesVal <= 0) continue;
            const key = `${row.market_id}:${row.outcome}:${row.is_lp ? 'LP' : 'TR'}`;
            mergedMap.set(key, {
              market_id: row.market_id,
              outcome: row.outcome,
              shares: sharesVal,
              avg_price: Number(row.avg_entry_price || 50),
              total_cost_kz: Number(row.total_cost_kz || 0),
              is_lp: Boolean(row.is_lp),
            });
          }
        }

        return {
          ...(userData as User),
          balance: Number((userData as any).balance || 0),
          positions: Array.from(mergedMap.values()),
        };
      } catch (e) {
        console.warn('Error loading positions for user profile:', e);
        return {
          ...(userData as User),
          balance: Number((userData as any).balance || 0),
          positions: [],
        };
      }
    } catch {
      return null;
    }
  },

  createUserProfile: async (userId: string, data: Partial<User>) => {
    // 1. Verificar se o trigger on_auth_user_created já criou o perfil
    const existing = await supabaseService.getUserProfile(userId);
    if (existing) {
      return existing;
    }

    const { data: authData } = await supabase.auth.getUser();
    const authUser = authData?.user;
    const lowerEmail = authUser?.email?.toLowerCase() || '';
    const isConfirmed = Boolean(authUser?.email_confirmed_at);
    const isMaster =
      ['evaristopaulocassoma00@gmail.com', 'evaristopaulocassoma20@gmail.com'].includes(lowerEmail) &&
      isConfirmed;
    const isDesignatedAdmin = false;

    const avatarUrl =
      (data as any).avatar_url ||
      (authUser?.user_metadata?.avatar_url as string) ||
      (authUser?.user_metadata?.picture as string) ||
      null;

    const dbPayload = {
      id: userId,
      name:
        data.name ||
        (authUser?.user_metadata?.full_name as string) ||
        (authUser?.user_metadata?.name as string) ||
        authUser?.email?.split('@')[0] ||
        'Utilizador',
      email: data.email || authUser?.email || '',
      balance: data.balance ?? 1000,
      is_admin: isMaster || isDesignatedAdmin,
      role: isMaster ? 'MASTER_ADMIN' : isDesignatedAdmin ? 'OPERATIONAL_ADMIN' : 'USER',
      status: data.status || 'active',
      verification_status: 'none',
      is_verified: Boolean(authUser?.email_confirmed_at),
      avatar_url: avatarUrl,
      created_at: new Date().toISOString(),
    };

    const { error } = await supabase
      .from('users')
      .upsert(dbPayload, { onConflict: 'id', ignoreDuplicates: true });
    if (error) {
      // Se já existir por condição de corrida, tentar ler novamente antes de falhar
      const retryExisting = await supabaseService.getUserProfile(userId);
      if (retryExisting) return retryExisting;
      console.error('Supabase createUserProfile error:', error);
      throw new Error(error.message);
    }

    const created = await supabaseService.getUserProfile(userId);
    return (
      created ||
      ({
        ...dbPayload,
        positions: data.positions || [],
      } as User)
    );
  },

  subscribeToUser: (userId: string, callback: (user: User) => void) => {
    if (!isSupabaseConfigured) return () => {};
    let active = true;
    const load = async () => {
      const profile = await supabaseService.getUserProfile(userId);
      if (active && profile) {
        callback(profile);
      }
    };

    load();

    const channel = supabase
      .channel(`user_sub_${userId}_${genId()}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'users', filter: `id=eq.${userId}` }, () => {
        load();
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'positions' }, () => {
        load();
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'market_positions', filter: `user_id=eq.${userId}` }, () => {
        load();
      })
      .subscribe();

    return () => {
      active = false;
      supabase.removeChannel(channel);
    };
  },

  // --- Trades (Motor principal = Express/SQLite CLOB + AMM) ---
  placeTrade: async (
    _userId: string,
    _marketId: string,
    _outcome: 'Yes' | 'No',
    _amount: number,
    _side: 'Buy' | 'Sell'
  ): Promise<{ shares: number; price: number }> => {
    throw new Error(
      'Motor LMSR direto desativado. Todas as ordens reais executam exclusivamente no motor principal Express/SQLite CLOB + AMM.'
    );
  },

  // --- History ---
  getTradeHistory: (userId: string, callback: (trades: Trade[]) => void) => {
    if (!isSupabaseConfigured) {
      callback([]);
      return () => {};
    }
    let active = true;
    const load = async () => {
      try {
        const { data, error } = await supabase
          .from('trades')
          .select('*')
          .eq('user_id', userId)
          .order('timestamp', { ascending: false });
        if (!active) return;
        if (error) {
          console.warn('Error getting trade history:', error.message);
          return;
        }
        callback((data || []) as Trade[]);
      } catch {
        // ignore network error when offline
      }
    };

    load();

    const channel = supabase
      .channel(`user_trades_${userId}_${genId()}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'trades', filter: `user_id=eq.${userId}` }, () => {
        load();
      })
      .subscribe();

    return () => {
      active = false;
      supabase.removeChannel(channel);
    };
  },

  subscribeToAllTrades: (callback: (trades: any[]) => void) => {
    if (!isSupabaseConfigured) {
      callback([]);
      return () => {};
    }
    let active = true;
    const load = async () => {
      try {
        const { data, error } = await supabase
          .from('trades')
          .select('*')
          .order('timestamp', { ascending: false })
          .limit(50);
        if (!active) return;
        if (error) {
          console.warn('Trades fetch warning:', error.message);
          callback([]);
          return;
        }
        callback(data || []);
      } catch {
        if (active) callback([]);
      }
    };

    load();

    const channel = supabase
      .channel(`all_trades_${genId()}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'trades' }, () => {
        load();
      })
      .subscribe();

    return () => {
      active = false;
      supabase.removeChannel(channel);
    };
  },

  getUserLedger: async (userId: string) => {
    if (!isSupabaseConfigured) return [];
    try {
      const { data, error } = await supabase
        .from('ledger')
        .select('*')
        .eq('user_id', userId)
        .order('createdAt', { ascending: false });
      if (error) {
        console.warn('Error fetching ledger entries:', error.message);
        return [];
      }
      return data || [];
    } catch {
      return [];
    }
  },

  // --- Comments & History ---
  subscribeToComments: (marketId: string, callback: (comments: Comment[]) => void) => {
    if (!isSupabaseConfigured) {
      callback([]);
      return () => {};
    }
    let active = true;
    let reqSeq = 0;
    const load = async () => {
      const seq = ++reqSeq;
      try {
        const { data, error } = await supabase
          .from('comments')
          .select('*')
          .eq('market_id', marketId)
          .order('timestamp', { ascending: false });
        if (!active || seq !== reqSeq) return;
        if (error) {
          console.warn('Error fetching comments:', error.message);
          return;
        }
        callback((data || []) as Comment[]);
      } catch {
        // ignore network error
      }
    };

    load();

    const channel = supabase
      .channel(`comments_${marketId}_${genId()}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'comments', filter: `market_id=eq.${marketId}` }, () => {
        load();
      })
      .subscribe();

    return () => {
      active = false;
      supabase.removeChannel(channel);
    };
  },

  subscribeToPriceHistory: (marketId: string, callback: (history: PriceHistory[]) => void) => {
    if (!isSupabaseConfigured) {
      callback([]);
      return () => {};
    }
    let active = true;
    let reqSeq = 0;
    const load = async () => {
      const seq = ++reqSeq;
      try {
        const { data, error } = await supabase
          .from('price_history')
          .select('*')
          .eq('market_id', marketId)
          .order('timestamp', { ascending: true });
        if (!active || seq !== reqSeq) return;
        if (error) {
          console.warn('Error fetching price history:', error.message);
          return;
        }
        callback((data || []) as any as PriceHistory[]);
      } catch {
        // ignore network error
      }
    };

    load();

    const channel = supabase
      .channel(`price_history_${marketId}_${genId()}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'price_history', filter: `market_id=eq.${marketId}` }, () => {
        load();
      })
      .subscribe();

    return () => {
      active = false;
      supabase.removeChannel(channel);
    };
  },

  addComment: async (
    marketId: string,
    userId: string,
    userName: string,
    text: string,
    extra?: { userAvatar?: string | null; outcomeTag?: string | null; parentId?: string | null }
  ) => {
    const cleanText = sanitizePlainText(text, 1000);
    if (!cleanText) {
      throw new Error('O comentário não pode estar vazio após validação.');
    }
    const cleanUserName = sanitizePlainText(userName, 80) || `Trader #${String(userId || '').slice(0, 6)}`;
    const cleanOutcomeTag = extra?.outcomeTag ? sanitizePlainText(extra.outcomeTag, 48) : null;

    const commentData: Record<string, any> = {
      id: genId(),
      market_id: marketId,
      user_id: userId,
      user_name: cleanUserName,
      text: cleanText,
      likes: 0,
      timestamp: new Date().toISOString(),
    };
    if (extra?.userAvatar) commentData.user_avatar = extra.userAvatar;
    if (cleanOutcomeTag) commentData.outcome_tag = cleanOutcomeTag;
    if (extra?.parentId) commentData.parent_id = extra.parentId;

    const { error } = await supabase.from('comments').insert(commentData);
    if (error) {
      // Retry without optional columns if Supabase hasn't added them yet
      const fallbackData = {
        id: commentData.id,
        market_id: marketId,
        user_id: userId,
        user_name: cleanUserName,
        text: cleanText,
        likes: 0,
        timestamp: commentData.timestamp,
      };
      const { error: fallbackErr } = await supabase.from('comments').insert(fallbackData);
      if (fallbackErr) {
        throw new Error(fallbackErr.message);
      }
      return fallbackData;
    }
    return commentData;
  },

  updateUserProfile: async (userId: string, data: Partial<User>) => {
    const { positions: _ignored, ...cleanData } = data as any;
    const { error } = await supabase.from('users').update(cleanData).eq('id', userId);
    if (error) {
      throw new Error(error.message);
    }
  },

  getLeaderboard: async (limitCount: number = 10) => {
    if (!isSupabaseConfigured) return [];
    try {
      const { data, error } = await supabase
        .from('users')
        .select('id, name, avatar_url, balance, is_verified')
        .order('balance', { ascending: false })
        .limit(limitCount);
      if (error) return [];
      return (data || []) as User[];
    } catch {
      return [];
    }
  },

  // --- Admin Operations ---
  getPlatformSettings: async () => {
    if (!isSupabaseConfigured) return null;
    try {
      const { data, error } = await supabase.from('settings').select('*').eq('id', 'platform').maybeSingle();
      if (error) {
        console.warn('Error fetching platform settings:', error.message);
        return null;
      }
      return data;
    } catch {
      return null;
    }
  },

  updatePlatformSettings: async (settings: any) => {
    const { error } = await supabase
      .from('settings')
      .upsert({ id: 'platform', ...settings, updated_at: new Date().toISOString() }, { onConflict: 'id' });
    if (error) {
      throw new Error(error.message);
    }
  },

  getAuditLogs: async (limitCount: number = 50) => {
    if (!isSupabaseConfigured) return [];
    try {
      const { data, error } = await supabase
        .from('audit_logs')
        .select('*')
        .order('timestamp', { ascending: false })
        .limit(limitCount);
      if (error) {
        console.warn('Error fetching audit logs:', error.message);
        return [];
      }
      return data || [];
    } catch {
      return [];
    }
  },

  getFinanceRequests: async () => {
    if (!isSupabaseConfigured) return [];
    try {
      const { data, error } = await supabase
        .from('finance_requests')
        .select('*')
        .order('created_at', { ascending: false });
      if (error) {
        console.warn('Error fetching finance requests:', error.message);
        return [];
      }
      return data || [];
    } catch {
      return [];
    }
  },

  addFinanceRequest: async (request: any) => {
    const id = genId();
    const { error } = await supabase.from('finance_requests').insert({
      id,
      ...request,
      created_at: new Date().toISOString(),
    });
    if (error) {
      throw new Error(error.message);
    }
    return id;
  },

  getUserFinanceRequests: async (userId: string) => {
    if (!isSupabaseConfigured) return [];
    try {
      const { data, error } = await supabase
        .from('finance_requests')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false });
      if (error) {
        console.warn('Error fetching user finance requests:', error.message);
        return [];
      }
      return data || [];
    } catch {
      return [];
    }
  },

  updateFinanceRequest: async (requestId: string, status: 'approved' | 'rejected') => {
    const { error } = await supabase.from('finance_requests').update({ status }).eq('id', requestId);
    if (error) {
      throw new Error(error.message);
    }
  },

  processFinanceRequest: async (_requestId: string, _status: 'approved' | 'rejected', _adminId: string = 'admin') => {
    throw new Error('Aprovações financeiras devem ser processadas exclusivamente via motor Express/SQLite (/api/finance/process).');
  },

  createMarket: async (marketData: any) => {
    const id = marketData.id || genId();
    const { error } = await supabase.from('markets').insert({
      ...marketData,
      id,
      created_at: new Date().toISOString(),
    });
    if (error) {
      throw new Error(error.message);
    }
    return id;
  },

  createUserMarket: async (_userId: string, marketData: any) => {
    const { data: sess } = await supabase.auth.getSession();
    const token = sess.session?.access_token;
    if (!token) {
      throw new Error('Sessão expirada. Faça login novamente para criar um mercado.');
    }

    // Fast path: Para mercados binários, tentar primeiro a RPC atómica create_market_with_liquidity no Supabase
    if (!marketData?.is_multi) {
      try {
        const { data: rpcData, error: rpcError } = await supabase.rpc('create_market_with_liquidity', {
          p_question: marketData.question,
          p_description: marketData.description || null,
          p_category: marketData.category || 'Geral',
          p_image_url: marketData.image_url || null,
          p_end_date: marketData.end_date,
          p_additional_context: marketData.additional_context || null,
          p_resolver_name: marketData.resolver_name || 'MarketPay Oracle',
          p_tags: Array.isArray(marketData.tags) ? marketData.tags : [marketData.category || 'Geral', 'Comunidade'],
          p_is_multi: false,
          p_outcomes: null,
        });
        if (!rpcError && rpcData?.market_id) {
          return String(rpcData.market_id);
        }
        if (rpcError) {
          const msg = String(rpcError.message || '');
          const code = String((rpcError as any).code || '');
          const isMissingFn =
            code === 'PGRST202' ||
            code === '42883' ||
            msg.toLowerCase().includes('could not find the function') ||
            msg.toLowerCase().includes('does not exist');
          if (!isMissingFn) {
            throw new Error(msg);
          }
        }
      } catch (rpcCatch: any) {
        const msg = String(rpcCatch?.message || '');
        if (
          !msg.toLowerCase().includes('could not find the function') &&
          !msg.toLowerCase().includes('does not exist') &&
          !msg.toLowerCase().includes('pgrst202')
        ) {
          throw rpcCatch;
        }
      }
    }

    const resp = await fetch('/api/markets/create', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(marketData),
    });
    const json = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      throw new Error(json?.error || `Erro ao criar mercado (HTTP ${resp.status}).`);
    }
    return String(json.marketId || json.market_id);
  },

  updateMarket: async (marketId: string, data: any) => {
    const { error } = await supabase.from('markets').update(data).eq('id', marketId);
    if (error) throw new Error(error.message);
  },

  deleteMarket: async (marketId: string) => {
    const { error } = await supabase.from('markets').delete().eq('id', marketId);
    if (error) throw new Error(error.message);
  },

  resolveMarket: async (marketId: string, outcome: string, motive?: string, adminId: string = 'admin') => {
    const mCheck = await supabaseService.getMarket(marketId);
    if (!mCheck) {
      throw new Error('Mercado não encontrado');
    }
    if (!mCheck.is_multi && (outcome === 'Yes' || outcome === 'No')) {
      throw new Error('Mercados binários devem ser liquidados exclusivamente via motor Express CLOB+AMM (/api/clob/market/:id/resolve).');
    }

    const now = new Date().toISOString();
    await supabase
      .from('markets')
      .update({
        resolved: true,
        resolution_outcome: outcome,
        status: 'resolved',
        resolved_at: now,
        resolution_motive: motive || 'Nenhum motivo fornecido',
        resolved_by: adminId,
      })
      .eq('id', marketId);

    await supabase.from('audit_logs').insert({
      id: genId(),
      action: 'MARKET_RESOLUTION',
      admin_id: adminId,
      details: `O administrador ${adminId} resolveu o mercado "${marketId}" como "${outcome}". Motivo: ${motive || 'Sem motivo detalhado.'}`,
      created_at: now,
      timestamp: now,
    });

    const { data: posRows } = await supabase
      .from('positions')
      .select('*')
      .or(`market_id.eq.${marketId},marketId.eq.${marketId}`);

    for (const pos of posRows || []) {
      const shares = Number(pos.shares || 0);
      const posOutcome = pos.outcome;
      const posUserId = pos.user_id || pos.userId;

      if (shares > 0 && posUserId && posOutcome === outcome) {
        const winnings = shares * 1;
        const { data: uRow } = await supabase.from('users').select('balance').eq('id', posUserId).maybeSingle();
        const balanceBefore = Number(uRow?.balance || 0);
        const balanceAfter = Number((balanceBefore + winnings).toFixed(2));

        await supabase.from('users').update({ balance: balanceAfter }).eq('id', posUserId);

        await supabase.from('ledger').insert({
          id: genId(),
          user_id: posUserId,
          type: 'PREMIACAO_MERCADO',
          amount: winnings,
          balanceBefore,
          balanceAfter,
          reference: marketId,
          createdAt: now,
        });

        await supabase.from('audit_logs').insert({
          id: genId(),
          action: 'WINNER_PAYOUT',
          details: `Pago ${winnings.toFixed(2)} KZ para o utilizador ${posUserId} por ${shares.toFixed(2)} quotas corretas no mercado ${marketId}`,
          created_at: now,
          timestamp: now,
        });
      }

      await supabase.from('positions').delete().eq('id', pos.id);
    }

    // Auto-rotation
    try {
      const mData: any = mCheck;
      let newEndDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      if (mData.created_at && mData.end_date) {
        const duration = new Date(mData.end_date).getTime() - new Date(mData.created_at).getTime();
        if (duration > 1000) {
          newEndDate = new Date(Date.now() + duration).toISOString();
        }
      }

      const newMarketId = genId();
      const b = mData.b || 1000;
      const newMarketData: any = {
        id: newMarketId,
        question: mData.question,
        description: mData.description || 'Este mercado foi reiniciado automaticamente após rodízio e encerramento anterior.',
        category: mData.category || 'Geral',
        image_url:
          mData.image_url ||
          'https://images.unsplash.com/photo-1611974789855-9c2a0a7236a3?auto=format&fit=crop&w=400&q=80',
        tags: mData.tags || [],
        volume: 0,
        end_date: newEndDate,
        created_at: now,
        yes_price: 0.5,
        no_price: 0.5,
        pool_yes: b,
        pool_no: b,
        b,
        resolved: false,
        status: 'active',
        creator_id: mData.creator_id || null,
        creator_fee_earned: 0,
        admin_fee_earned: 0,
      };

      if (mData.is_multi && mData.outcomes) {
        newMarketData.is_multi = true;
        const count = mData.outcomes.length;
        newMarketData.outcomes = mData.outcomes.map((o: any) => ({
          id: o.id,
          name: o.name,
          price: 1 / count,
          pool: b,
        }));
      }

      await supabase.from('markets').insert(newMarketData);

      await supabase.from('audit_logs').insert({
        id: genId(),
        action: 'MARKET_ROTATION',
        details: `Mercado ${marketId} resolvido. Cloned/Rotated novo mercado ativo com ID: ${newMarketId} com expiração em ${newEndDate}`,
        created_at: now,
        timestamp: now,
      });
    } catch (rotationErr) {
      console.error('Erro na auto-recreação/rotação do mercado:', rotationErr);
    }
  },

  resetMarket: async (marketId: string) => {
    const mData = await supabaseService.getMarket(marketId);
    if (!mData) throw new Error('Mercado não encontrado');
    const b = mData.b || 1000;

    await supabase
      .from('markets')
      .update({
        resolved: false,
        resolution_outcome: null,
        resolved_at: null,
        status: 'active',
        pool_yes: b,
        pool_no: b,
        yes_price: 0.5,
        no_price: 0.5,
        volume: 0,
        creator_fee_earned: 0,
        admin_fee_earned: 0,
      })
      .eq('id', marketId);

    await supabase.from('positions').delete().or(`market_id.eq.${marketId},marketId.eq.${marketId}`);
    await supabase.from('trades').delete().eq('market_id', marketId);
  },

  getUsers: async () => {
    if (!isSupabaseConfigured) return [];
    try {
      const { data, error } = await supabase.from('users').select('*');
      if (error) {
        console.warn('Error fetching users:', error.message);
        return [];
      }
      return (data || []) as User[];
    } catch {
      return [];
    }
  },

  createCategory: async (categoryData: any) => {
    const { error } = await supabase.from('categories').insert({
      id: categoryData.id || genId(),
      ...categoryData,
      order: categoryData.order ?? 0,
    });
    if (error) throw new Error(error.message);
  },

  updateCategory: async (categoryId: string, data: any) => {
    const { error } = await supabase.from('categories').update(data).eq('id', categoryId);
    if (error) throw new Error(error.message);
  },

  deleteCategory: async (categoryId: string) => {
    const { error } = await supabase.from('categories').delete().eq('id', categoryId);
    if (error) throw new Error(error.message);
  },

  logAdminAction: async (adminId: string, action: string, details: string) => {
    const now = new Date().toISOString();
    const { error } = await supabase.from('audit_logs').insert({
      id: genId(),
      admin_id: adminId,
      action,
      details,
      created_at: now,
      timestamp: now,
    });
    if (error) {
      console.error('Error logging admin action:', error);
    }
  },

  createPost: async (postData: any) => {
    const { error } = await supabase.from('posts').insert({
      id: genId(),
      ...postData,
      created_at: new Date().toISOString(),
    });
    if (error) throw new Error(error.message);
  },

  updatePost: async (postId: string, data: any) => {
    const { error } = await supabase.from('posts').update(data).eq('id', postId);
    if (error) throw new Error(error.message);
  },

  getUserPosition: async (userId: string, marketId: string) => {
    if (!isSupabaseConfigured) return null;
    try {
      const positionId = `${userId}_${marketId}`;
      const { data } = await supabase.from('positions').select('*').eq('id', positionId).maybeSingle();
      return data || null;
    } catch {
      return null;
    }
  },

  deletePost: async (postId: string) => {
    const { error } = await supabase.from('posts').delete().eq('id', postId);
    if (error) throw new Error(error.message);
  },

  getMarketPositions: async (marketId: string) => {
    if (!isSupabaseConfigured) return [];
    try {
      const { data: positions, error } = await supabase
        .from('positions')
        .select('*')
        .or(`market_id.eq.${marketId},marketId.eq.${marketId}`);
      if (error || !positions) return [];

      const userIds = Array.from(new Set(positions.map((p: any) => p.user_id || p.userId).filter(Boolean)));
      const { data: users } = userIds.length
        ? await supabase.from('users').select('id, name, avatar_url').in('id', userIds)
        : { data: [] };
      const userMap = new Map(
        (users || []).map((u: any) => [
          u.id,
          {
            id: u.id,
            name: sanitizePlainText(u.name, 60) || `Trader #${String(u.id).slice(0, 6)}`,
            avatar_url: u.avatar_url || null,
          },
        ])
      );

      return positions.map((pos: any) => ({
        ...pos,
        profiles: userMap.get(pos.user_id || pos.userId) || null,
      }));
    } catch {
      return [];
    }
  },

  getMarketCpmmPositions: async (marketId: string): Promise<MarketPosition[]> => {
    if (!isSupabaseConfigured) return [];
    try {
      const { data, error } = await supabase
        .from('market_positions')
        .select('*')
        .eq('market_id', marketId)
        .gt('shares_amount', 0)
        .order('shares_amount', { ascending: false })
        .limit(100);
      if (error || !data) {
        return [];
      }
      const missingIds = Array.from(new Set(data.filter((r: any) => !r.user_name && r.user_id).map((r: any) => r.user_id)));
      const userMap = new Map<string, string>();
      if (missingIds.length > 0) {
        const { data: users } = await supabase.from('users').select('id, name').in('id', missingIds);
        for (const u of users || []) {
          userMap.set(u.id, sanitizePlainText(u.name, 60) || `Trader #${String(u.id).slice(0, 6)}`);
        }
      }
      return (data || []).map((r: any) => ({
        id: r.id,
        market_id: r.market_id,
        user_id: r.user_id,
        user_name:
          sanitizePlainText(r.user_name, 60) ||
          userMap.get(r.user_id) ||
          `Trader #${String(r.user_id || '').slice(0, 6)}`,
        outcome: r.outcome,
        shares_amount: Number(r.shares_amount || 0),
        avg_entry_price: Number(r.avg_entry_price || 0),
        total_cost_kz: Number(r.total_cost_kz || 0),
        is_lp: Boolean(r.is_lp),
        updated_at: r.updated_at || '',
      }));
    } catch {
      return [];
    }
  },

  subscribeToMarketDetail: (marketId: string, callback: (market: Market) => void) => {
    if (!isSupabaseConfigured || !marketId) return () => {};
    let active = true;
    const channel = supabase
      .channel(`market_detail_${marketId}_${genId()}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'markets', filter: `id=eq.${marketId}` },
        (payload) => {
          if (active && payload?.new) {
            callback(payload.new as Market);
          }
        }
      )
      .subscribe();
    return () => {
      active = false;
      supabase.removeChannel(channel);
    };
  },

  subscribeToMarketTrades: (marketId: string, callback: (trades: Trade[]) => void) => {
    if (!isSupabaseConfigured || !marketId) {
      callback([]);
      return () => {};
    }
    let active = true;
    let reqSeq = 0;
    const load = async () => {
      const seq = ++reqSeq;
      try {
        const { data, error } = await supabase
          .from('trades')
          .select('*')
          .eq('market_id', marketId)
          .order('timestamp', { ascending: false })
          .limit(50);
        if (!active || seq !== reqSeq || error) return;
        callback((data || []) as Trade[]);
      } catch {
        // ignore
      }
    };
    load();
    const channel = supabase
      .channel(`market_trades_${marketId}_${genId()}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'trades', filter: `market_id=eq.${marketId}` },
        () => {
          load();
        }
      )
      .subscribe();
    return () => {
      active = false;
      supabase.removeChannel(channel);
    };
  },

  subscribeToMarketPositions: (marketId: string, callback: () => void) => {
    if (!isSupabaseConfigured || !marketId) return () => {};
    let active = true;
    const trigger = () => {
      if (active) callback();
    };
    const channel = supabase
      .channel(`market_positions_${marketId}_${genId()}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'market_positions', filter: `market_id=eq.${marketId}` },
        trigger
      )
      .on('postgres_changes', { event: '*', schema: 'public', table: 'positions' }, trigger)
      .subscribe();
    return () => {
      active = false;
      supabase.removeChannel(channel);
    };
  },

  seedMarkets: async (markets: any[]) => {
    for (const market of markets) {
      await supabase.from('markets').upsert(
        {
          ...market,
          yes_price: market.is_multi ? 0 : 0.5,
          no_price: market.is_multi ? 0 : 0.5,
          pool_yes: market.is_multi ? 0 : 1000,
          pool_no: market.is_multi ? 0 : 1000,
          volume: market.volume ?? 0,
          resolved: false,
          status: 'active',
          created_at: new Date().toISOString(),
        },
        { onConflict: 'id' }
      );
    }
  },

  getTrades: async (limitCount: number = 1000) => {
    if (!isSupabaseConfigured) return [];
    try {
      const { data, error } = await supabase
        .from('trades')
        .select('*')
        .order('timestamp', { ascending: false })
        .limit(limitCount);
      if (error) return [];
      return data || [];
    } catch {
      return [];
    }
  },

  placeLimitOrder: async (
    _userId: string,
    _marketId: string,
    _outcome: string,
    _amount: number,
    _limitPrice: number,
    _side: 'Buy' | 'Sell'
  ) => {
    throw new Error('Ordens limite diretas desativadas. Utilize o livro CLOB+AMM (/api/clob/order).');
  },

  getPendingLimitOrders: async (_marketId: string) => {
    return [];
  },

  subscribeToUserLimitOrders: (_userId: string, callback: (orders: any[]) => void) => {
    callback([]);
    return () => {};
  },

  cancelLimitOrder: async (_orderId: string) => {
    throw new Error('Cancelamento de ordens deve ser feito via motor CLOB (/api/clob/order/:id/cancel).');
  },

  executeTriggeredLimitOrders: async (_marketId: string, _currentYesPrice: number, _currentNoPrice: number) => {
    return;
  },
};
