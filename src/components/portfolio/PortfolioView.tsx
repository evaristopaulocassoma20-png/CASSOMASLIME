import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  ArrowDownToLine,
  ArrowUpDown,
  ArrowUpFromLine,
  Copy,
  Download,
  Eye,
  EyeOff,
  Loader2,
  Lock,
  Pencil,
  Search,
  Share,
} from 'lucide-react';
import {
  Area,
  AreaChart,
  ResponsiveContainer,
  Tooltip,
  YAxis,
} from 'recharts';
import { supabase, isSupabaseConfigured } from '../../supabase';
import { ammApi } from '../../lib/amm-api';
import { SHARE_SETTLEMENT_KZ, WITHDRAWAL_FEE_RATE } from '../../lib/cpmm-math';
import { formatKz, sanitizeHttpUrl, sanitizePlainText } from '../../lib/sanitize';
import { Market, User } from '../../types';

interface PortfolioPositionRow {
  id: string;
  market_id: string;
  market_question: string;
  market_image_url: string | null;
  outcome: string;
  shares_amount: number;
  reserved_shares: number;
  avg_entry_price_kz: number;
  current_price_kz: number;
  total_cost_kz: number;
  current_value_kz: number;
  profit_kz: number;
  roi_pct: number;
  max_payout_kz: number;
  is_clob: boolean;
  is_resolved: boolean;
  has_won: boolean;
}

interface PortfolioTradeRow {
  id: string;
  market_id: string;
  market_question: string;
  side: string;
  outcome: string;
  shares: number;
  price_kz: number;
  amount_kz: number;
  is_clob: boolean;
  timestamp: string;
  ts: number;
}

type TimeframeKey = '1D' | '1W' | '1M' | '1Y' | 'YTD' | 'ALL';

export interface PortfolioViewProps {
  user: User | null;
  trades: any[];
  markets: Market[];
  addToast: (msg: string, type?: 'success' | 'error' | 'info') => void;
  onRefreshAll?: () => Promise<void> | void;
}

function escapeCsvCell(val: unknown): string {
  let str = sanitizePlainText(val, 300);
  if (/^[=+\-@\t\r]/.test(str)) {
    str = `'${str}`;
  }
  return `"${str.replace(/"/g, '""')}"`;
}

function formatJoinedLabel(createdAt?: string): string {
  if (!createdAt) return 'Membro MarketPay';
  const dt = new Date(createdAt);
  if (Number.isNaN(dt.getTime())) return 'Membro MarketPay';
  try {
    const formatted = new Intl.DateTimeFormat('pt-PT', {
      month: 'long',
      year: 'numeric',
    }).format(dt);
    return `Ingressou em ${formatted}.`;
  } catch {
    return 'Membro MarketPay';
  }
}

export function PortfolioView({
  user,
  trades = [],
  markets = [],
  addToast,
  onRefreshAll,
}: PortfolioViewProps) {
  const navigate = useNavigate();

  const [liveBalanceKz, setLiveBalanceKz] = useState<number>(Number(user?.balance || 0));
  const [userCreatedAt, setUserCreatedAt] = useState<string | undefined>(user?.created_at);
  const [avatarFailed, setAvatarFailed] = useState<boolean>(false);
  const [dbPositions, setDbPositions] = useState<any[]>([]);
  const [dbTrades, setDbTrades] = useState<any[]>([]);
  const [limitOrders, setLimitOrders] = useState<any[]>([]);
  const [clobPositions, setClobPositions] = useState<any[]>([]);
  const [clobAccount, setClobAccount] = useState<any>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [confirmCancelId, setConfirmCancelId] = useState<string | null>(null);
  const [cancellingId, setCancellingId] = useState<string | null>(null);

  const [hideBalances, setHideBalances] = useState<boolean>(false);
  const [timeframe, setTimeframe] = useState<TimeframeKey>('1D');
  const [mainTab, setMainTab] = useState<'positions' | 'open' | 'history'>('positions');
  const [positionStatusFilter, setPositionStatusFilter] = useState<'active' | 'closed'>('active');
  const [ordersScopeFilter, setOrdersScopeFilter] = useState<'open' | 'all'>('open');
  const [historyFilter, setHistoryFilter] = useState<'all' | 'buy' | 'sell'>('all');
  const [searchTerm, setSearchTerm] = useState<string>('');
  const [sortBy, setSortBy] = useState<'value' | 'current' | 'avg' | 'profit'>('value');
  const [sortDir, setSortDir] = useState<'desc' | 'asc'>('desc');
  const [historySortOrder, setHistorySortOrder] = useState<'recent' | 'oldest' | 'amount_desc'>('recent');

  const isMountedRef = useRef(true);
  const reqSeqRef = useRef(0);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (user?.balance !== undefined) {
      setLiveBalanceKz(Number(user.balance || 0));
    }
    if (user?.created_at) {
      setUserCreatedAt(user.created_at);
    }
    setAvatarFailed(false);
  }, [user?.balance, user?.created_at, user?.avatar_url]);

  const fetchPortfolioData = useCallback(async () => {
    if (!user?.id) {
      setLoading(false);
      return;
    }
    const seq = ++reqSeqRef.current;
    setLoading(true);

    try {
      const clobPromise = ammApi.getMyClobOrders().catch(() => ({
        orders: [],
        positions: [],
        account: null,
      }));

      const userPromise = isSupabaseConfigured
        ? supabase.from('users').select('balance, created_at').eq('id', user.id).maybeSingle()
        : Promise.resolve({ data: null });

      const posPromise = isSupabaseConfigured
        ? supabase
            .from('market_positions')
            .select(
              'id, market_id, outcome, shares_amount, avg_entry_price, total_cost_kz, is_lp, markets(question, image_url, yes_price, no_price, yes_price_kz, no_price_kz, resolved, resolution_outcome)'
            )
            .eq('user_id', user.id)
            .eq('is_lp', false)
            .gt('shares_amount', 0)
        : Promise.resolve({ data: [] });

      const tradesPromise = isSupabaseConfigured
        ? supabase
            .from('trades')
            .select('id, market_id, side, outcome, amount, net_amount_kz, shares, price, engine, timestamp, markets(question)')
            .eq('user_id', user.id)
            .order('timestamp', { ascending: false })
            .limit(250)
        : Promise.resolve({ data: [] });

      const [clobRes, userRes, posRes, tradesRes] = await Promise.all([
        clobPromise,
        userPromise,
        posPromise,
        tradesPromise,
      ]);

      if (!isMountedRef.current || seq !== reqSeqRef.current) return;

      setLimitOrders(clobRes?.orders || []);
      setClobPositions(clobRes?.positions || []);
      setClobAccount(clobRes?.account || null);

      if (userRes?.data) {
        if (Number.isFinite(Number(userRes.data.balance))) {
          setLiveBalanceKz(Number(userRes.data.balance));
        }
        if (userRes.data.created_at) {
          setUserCreatedAt(userRes.data.created_at);
        }
      }
      if (Array.isArray(posRes?.data)) {
        setDbPositions(posRes.data);
      }
      if (Array.isArray(tradesRes?.data)) {
        setDbTrades(tradesRes.data);
      }
    } catch (err) {
      console.error('Erro ao carregar portfólio:', err);
    } finally {
      if (isMountedRef.current && seq === reqSeqRef.current) {
        setLoading(false);
      }
    }
  }, [user?.id]);

  useEffect(() => {
    fetchPortfolioData();
  }, [fetchPortfolioData, trades.length]);

  const marketById = useMemo(() => {
    const map = new Map<string, Market>();
    for (const m of markets) {
      if (m?.id) map.set(m.id, m);
    }
    return map;
  }, [markets]);

  const positions = useMemo<PortfolioPositionRow[]>(() => {
    if (!user?.id) return [];
    const mergedMap = new Map<string, PortfolioPositionRow>();

    const buildSpotKz = (
      marketId: string,
      outcome: string,
      joinedMarket?: any
    ): {
      spotKz: number;
      resolved: boolean;
      won: boolean;
      question: string;
      imageUrl: string | null;
    } => {
      const m = marketById.get(marketId);
      const question = sanitizePlainText(joinedMarket?.question || m?.question || marketId, 160);
      const imageUrl = sanitizeHttpUrl(joinedMarket?.image_url || m?.image_url || '');
      const resolved = Boolean(joinedMarket?.resolved ?? m?.resolved);
      const winner = joinedMarket?.resolution_outcome ?? m?.resolution_outcome;
      const won = resolved && winner === outcome;
      const yesSpot = Number(
        joinedMarket?.yes_price_kz ??
          m?.yes_price_kz ??
          Number(joinedMarket?.yes_price ?? m?.yes_price ?? 0.5) * 100
      );
      const noSpot = Number(
        joinedMarket?.no_price_kz ??
          m?.no_price_kz ??
          Number(joinedMarket?.no_price ?? m?.no_price ?? 0.5) * 100
      );
      return {
        spotKz: outcome === 'Yes' ? yesSpot : noSpot,
        resolved,
        won,
        question,
        imageUrl,
      };
    };

    for (const p of dbPositions) {
      const shares = Number(p.shares_amount || 0);
      if (shares <= 0) continue;
      const { spotKz, resolved, won, question, imageUrl } = buildSpotKz(p.market_id, p.outcome, p.markets);
      const avgEntryKz = Number(p.avg_entry_price || spotKz || 50);
      const costBasisKz = Number(p.total_cost_kz ?? shares * avgEntryKz);
      const currentValKz = shares * spotKz;
      const profitKz = currentValKz - costBasisKz;
      const roiPct = costBasisKz > 0 ? (profitKz / costBasisKz) * 100 : 0;

      mergedMap.set(`${p.market_id}:${p.outcome}:CPMM`, {
        id: p.id || `${p.market_id}_${p.outcome}`,
        market_id: p.market_id,
        market_question: question,
        market_image_url: imageUrl,
        outcome: p.outcome,
        shares_amount: shares,
        reserved_shares: 0,
        avg_entry_price_kz: avgEntryKz,
        current_price_kz: spotKz,
        total_cost_kz: costBasisKz,
        current_value_kz: currentValKz,
        profit_kz: profitKz,
        roi_pct: roiPct,
        max_payout_kz: shares * SHARE_SETTLEMENT_KZ * (1 - WITHDRAWAL_FEE_RATE),
        is_clob: false,
        is_resolved: resolved,
        has_won: won,
      });
    }

    for (const p of user.positions || []) {
      const mid = (p as any).market_id || (p as any).marketId;
      const shares = Number(p.shares || 0);
      if (!mid || shares <= 0) continue;
      const key = `${mid}:${p.outcome}:CPMM`;
      if (mergedMap.has(key)) continue;
      const rawAvg = Number(p.avg_price || 0);
      const avgEntryKz = rawAvg > 1 ? rawAvg : rawAvg * 100;
      const { spotKz, resolved, won, question, imageUrl } = buildSpotKz(mid, p.outcome);
      const costBasisKz = p.total_cost_kz !== undefined ? Number(p.total_cost_kz) : shares * avgEntryKz;
      const currentValKz = shares * spotKz;
      const profitKz = currentValKz - costBasisKz;
      const roiPct = costBasisKz > 0 ? (profitKz / costBasisKz) * 100 : 0;

      mergedMap.set(key, {
        id: `${mid}_${p.outcome}`,
        market_id: mid,
        market_question: question,
        market_image_url: imageUrl,
        outcome: p.outcome,
        shares_amount: shares,
        reserved_shares: 0,
        avg_entry_price_kz: avgEntryKz,
        current_price_kz: spotKz,
        total_cost_kz: costBasisKz,
        current_value_kz: currentValKz,
        profit_kz: profitKz,
        roi_pct: roiPct,
        max_payout_kz: shares * SHARE_SETTLEMENT_KZ * (1 - WITHDRAWAL_FEE_RATE),
        is_clob: false,
        is_resolved: resolved,
        has_won: won,
      });
    }

    for (const cp of clobPositions) {
      const totalShares = Number(cp.available_shares || 0) + Number(cp.reserved_shares || 0);
      if (totalShares <= 0) continue;
      const key = `${cp.market_id}:${cp.outcome}:CLOB`;
      const { spotKz, resolved, won, question, imageUrl } = buildSpotKz(cp.market_id, cp.outcome);
      const currentClobPriceKz = Math.max(0.01, Math.min(0.99, spotKz / 100));
      const avgClobPriceKz = Number(cp.avg_price_cents || 50) / 100;
      const costBasisKz = totalShares * avgClobPriceKz;
      const currentValKz = totalShares * currentClobPriceKz;
      const profitKz = currentValKz - costBasisKz;
      const roiPct = costBasisKz > 0 ? (profitKz / costBasisKz) * 100 : 0;

      mergedMap.set(key, {
        id: `clob_${cp.market_id}_${cp.outcome}`,
        market_id: cp.market_id,
        market_question: question,
        market_image_url: imageUrl,
        outcome: cp.outcome,
        shares_amount: totalShares,
        reserved_shares: Number(cp.reserved_shares || 0),
        avg_entry_price_kz: avgClobPriceKz,
        current_price_kz: currentClobPriceKz,
        total_cost_kz: costBasisKz,
        current_value_kz: currentValKz,
        profit_kz: profitKz,
        roi_pct: roiPct,
        max_payout_kz: totalShares * 1.0 * (1 - WITHDRAWAL_FEE_RATE),
        is_clob: true,
        is_resolved: resolved,
        has_won: won,
      });
    }

    return Array.from(mergedMap.values());
  }, [user?.id, user?.positions, dbPositions, clobPositions, marketById]);

  const history = useMemo<PortfolioTradeRow[]>(() => {
    if (!user?.id) return [];
    const seen = new Map<string, PortfolioTradeRow>();
    const combinedRaw = [...dbTrades, ...trades.filter((t) => t.user_id === user.id)];

    for (const t of combinedRaw) {
      if (!t?.id || seen.has(t.id)) continue;
      const m = marketById.get(t.market_id);
      const isClobTrade = t.engine === 'CLOB_AMM';
      const rawPrice = Number(t.price || 0);
      const priceKz = isClobTrade
        ? rawPrice > 1
          ? rawPrice / 100
          : rawPrice
        : rawPrice > 1
          ? rawPrice
          : rawPrice * 100;
      const ts = new Date(t.timestamp || t.created_at || 0).getTime() || 0;
      seen.set(t.id, {
        id: t.id,
        market_id: t.market_id,
        market_question: sanitizePlainText(t.markets?.question || m?.question || 'Mercado', 140),
        side: t.side || 'Buy',
        outcome: t.outcome || 'Yes',
        shares: Number(t.shares || 0),
        price_kz: Number(priceKz.toFixed(2)),
        amount_kz: Number(t.amount ?? t.net_amount_kz ?? 0),
        is_clob: isClobTrade,
        timestamp: t.timestamp || t.created_at || '',
        ts,
      });
    }

    return Array.from(seen.values()).sort((a, b) => b.ts - a.ts);
  }, [user?.id, dbTrades, trades, marketById]);

  const openOrders = useMemo(
    () =>
      limitOrders.filter(
        (o) =>
          (o.status === 'OPEN' || o.status === 'PARTIAL') &&
          Number(o.remaining_quantity || 0) > 0
      ),
    [limitOrders]
  );

  // Portfolio metrics in Kz
  const reservedOrderKz = (clobAccount?.reserved_cents || 0) / 100;
  const availableCashKz = clobAccount
    ? Math.max(0, Number(clobAccount.balance_cents || 0) / 100)
    : liveBalanceKz;
  const activePositions = positions.filter((p) => !p.is_resolved);
  const totalPositionsValueKz = activePositions.reduce((acc, p) => acc + p.current_value_kz, 0);
  const totalCostBasisKz = activePositions.reduce((acc, p) => acc + p.total_cost_kz, 0);
  const unrealizedPnlKz = totalPositionsValueKz - totalCostBasisKz;

  const biggestWinKz = useMemo(() => {
    let best = 0;
    for (const p of positions) {
      if (p.profit_kz > best) best = p.profit_kz;
    }
    return best;
  }, [positions]);

  const tradedMarketsCount = useMemo(() => {
    const ids = new Set<string>();
    for (const p of positions) ids.add(p.market_id);
    for (const t of history) ids.add(t.market_id);
    return ids.size;
  }, [positions, history]);

  const totalVolumeKz = useMemo(
    () => history.reduce((acc, t) => acc + Math.max(0, Number(t.amount_kz || 0)), 0),
    [history]
  );

  const timeframeCutoff = useMemo(() => {
    const now = Date.now();
    if (timeframe === '1D') return now - 86_400_000;
    if (timeframe === '1W') return now - 7 * 86_400_000;
    if (timeframe === '1M') return now - 30 * 86_400_000;
    if (timeframe === '1Y') return now - 365 * 86_400_000;
    if (timeframe === 'YTD') return new Date(new Date().getFullYear(), 0, 1).getTime();
    return 0;
  }, [timeframe]);

  const timeframePnlKz = useMemo(() => {
    if (timeframe === 'ALL') return unrealizedPnlKz;
    const scopedTrades = history.filter((t) => t.ts >= timeframeCutoff);
    if (scopedTrades.length === 0 && positions.length === 0) return 0;
    const periodSalesKz = scopedTrades
      .filter((t) => t.side === 'Sell' || t.side === 'Venda')
      .reduce((acc, t) => acc + t.amount_kz, 0);
    const periodBuysKz = scopedTrades
      .filter((t) => t.side === 'Buy' || t.side === 'Compra')
      .reduce((acc, t) => acc + t.amount_kz, 0);
    return Number((unrealizedPnlKz + (periodSalesKz - periodBuysKz) * 0.01).toFixed(2));
  }, [timeframe, timeframeCutoff, unrealizedPnlKz, history, positions.length]);

  const pnlChartData = useMemo(() => {
    const scoped = history
      .filter((t) => t.ts >= timeframeCutoff)
      .slice()
      .sort((a, b) => a.ts - b.ts);

    if (scoped.length === 0) {
      const base = Number(timeframePnlKz.toFixed(2));
      return [
        { label: 'Início', pnl: base },
        { label: 'Meio', pnl: base },
        { label: 'Agora', pnl: base },
      ];
    }

    let running = 0;
    const points = [{ label: 'Início', pnl: 0 }];
    for (const t of scoped) {
      const isSell = t.side === 'Sell' || t.side === 'Venda';
      running += isSell ? t.amount_kz * 0.05 : -t.amount_kz * 0.01;
      points.push({
        label: t.timestamp
          ? new Date(t.timestamp).toLocaleDateString('pt-AO', { day: '2-digit', month: 'short' })
          : 'Negócio',
        pnl: Number(running.toFixed(2)),
      });
    }
    points.push({ label: 'Agora', pnl: Number(timeframePnlKz.toFixed(2)) });
    return points;
  }, [history, timeframeCutoff, timeframePnlKz]);

  const normalizedSearch = sanitizePlainText(searchTerm, 80).toLowerCase();

  const filteredPositions = useMemo(() => {
    let list = positions.filter((p) => {
      if (positionStatusFilter === 'active' && p.is_resolved) return false;
      if (positionStatusFilter === 'closed' && !p.is_resolved) return false;
      if (normalizedSearch && !p.market_question.toLowerCase().includes(normalizedSearch)) {
        return false;
      }
      return true;
    });

    const factor = sortDir === 'desc' ? 1 : -1;
    list = [...list].sort((a, b) => {
      if (sortBy === 'current') return (b.current_price_kz - a.current_price_kz) * factor;
      if (sortBy === 'avg') return (b.avg_entry_price_kz - a.avg_entry_price_kz) * factor;
      if (sortBy === 'profit') return (b.profit_kz - a.profit_kz) * factor;
      return (b.current_value_kz - a.current_value_kz) * factor;
    });

    return list;
  }, [positions, positionStatusFilter, normalizedSearch, sortBy, sortDir]);

  const filteredOrders = useMemo(() => {
    const base = ordersScopeFilter === 'open' ? openOrders : limitOrders;
    return base.filter((o) => {
      const q = sanitizePlainText(marketById.get(o.market_id)?.question || o.market_id, 140).toLowerCase();
      if (normalizedSearch && !q.includes(normalizedSearch)) return false;
      return true;
    });
  }, [ordersScopeFilter, openOrders, limitOrders, marketById, normalizedSearch]);

  const filteredHistory = useMemo(() => {
    let list = history.filter((t) => {
      if (normalizedSearch && !t.market_question.toLowerCase().includes(normalizedSearch)) {
        return false;
      }
      const isBuy = t.side === 'Buy' || t.side === 'Compra';
      if (historyFilter === 'buy') return isBuy;
      if (historyFilter === 'sell') return !isBuy;
      return true;
    });

    list = [...list].sort((a, b) => {
      if (historySortOrder === 'oldest') return a.ts - b.ts;
      if (historySortOrder === 'amount_desc') return b.amount_kz - a.amount_kz;
      return b.ts - a.ts;
    });
    return list;
  }, [history, normalizedSearch, historyFilter, historySortOrder]);

  const handleSortHeaderClick = (col: 'current' | 'value' | 'avg' | 'profit') => {
    if (sortBy === col) {
      setSortDir((prev) => (prev === 'desc' ? 'asc' : 'desc'));
    } else {
      setSortBy(col);
      setSortDir('desc');
    }
  };

  const handleCopyProfileLink = async () => {
    const refText = user?.wallet_address || `${window.location.origin}/portfolio`;
    try {
      await navigator.clipboard.writeText(refText);
      addToast('Identificador do portfólio copiado!', 'success');
    } catch {
      addToast('Não foi possível copiar para a área de transferência.', 'error');
    }
  };

  const handleSharePortfolio = async () => {
    const url = `${window.location.origin}/portfolio`;
    try {
      await navigator.clipboard.writeText(url);
      addToast('Link do portfólio copiado!', 'success');
    } catch {
      addToast('Não foi possível copiar o link.', 'error');
    }
  };

  const handleExportCsv = () => {
    try {
      const lines: string[] = [];
      if (mainTab === 'history') {
        lines.push(['Atividade', 'Mercado', 'Resultado', 'Quotas', 'Preço (Kz)', 'Valor (Kz)', 'Data'].map(escapeCsvCell).join(','));
        for (const t of filteredHistory) {
          const isBuy = t.side === 'Buy' || t.side === 'Compra';
          lines.push(
            [
              isBuy ? 'Compra' : 'Venda',
              t.market_question,
              t.outcome === 'Yes' ? 'Sim' : t.outcome === 'No' ? 'Não' : t.outcome,
              t.shares.toFixed(4),
              t.price_kz.toFixed(2),
              t.amount_kz.toFixed(2),
              t.timestamp ? new Date(t.timestamp).toISOString() : '-',
            ]
              .map(escapeCsvCell)
              .join(',')
          );
        }
      } else {
        lines.push(
          ['Mercado', 'Previsão', 'Quotas', 'Preço Médio (Kz)', 'Preço Atual (Kz)', 'Investido (Kz)', 'Valor Atual (Kz)', 'Lucro (Kz)'].map(escapeCsvCell).join(',')
        );
        for (const p of filteredPositions) {
          lines.push(
            [
              p.market_question,
              p.outcome === 'Yes' ? 'Sim' : p.outcome === 'No' ? 'Não' : p.outcome,
              p.shares_amount.toFixed(4),
              p.avg_entry_price_kz.toFixed(2),
              p.current_price_kz.toFixed(2),
              p.total_cost_kz.toFixed(2),
              p.current_value_kz.toFixed(2),
              p.profit_kz.toFixed(2),
            ]
              .map(escapeCsvCell)
              .join(',')
          );
        }
      }
      const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `marketpay-portfolio-${mainTab}.csv`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      addToast('Exportação CSV gerada com sucesso.', 'success');
    } catch {
      addToast('Erro ao exportar CSV.', 'error');
    }
  };

  if (!user) {
    return (
      <div className="max-w-3xl mx-auto p-16 text-center space-y-4">
        <p className="text-sm font-semibold text-[#8b96a6]">
          Inicie sessão para visualizar o seu portfólio.
        </p>
        <button
          type="button"
          onClick={() => navigate('/login')}
          className="px-5 py-2.5 bg-[#1d6ff2] hover:bg-[#1961d6] text-white rounded-lg text-xs font-bold"
        >
          Entrar
        </button>
      </div>
    );
  }

  const displayName = sanitizePlainText(
    user.name || user.full_name || user.email?.split('@')[0] || 'Investidor',
    40
  );
  const handleSlug = sanitizePlainText(
    user.full_name && user.full_name !== displayName
      ? user.full_name
      : `@${displayName.toLowerCase().replace(/\s+/g, '')}`,
    40
  );
  const safeAvatarUrl = sanitizeHttpUrl(user.avatar_url);
  const initials = displayName.slice(0, 2).toUpperCase();
  const maskOrKz = (val: number) => (hideBalances ? '•••••• Kz' : formatKz(val, 2));

  return (
    <div dir="ltr" className="max-w-6xl mx-auto px-4 sm:px-6 py-7 text-white space-y-6">
      {/* LINHA SUPERIOR: 2 Cartões Iguais (Perfil/Saldo & Lucro/Prejuízo) */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* CARTÃO ESQUERDO: Perfil + Métricas + Depósito / Retirar */}
        <div className="bg-[#161922] border border-[#232836] rounded-xl p-6 flex flex-col justify-between">
          <div>
            {/* Cabeçalho do Utilizador */}
            <div className="flex items-start justify-between gap-4">
              <div className="flex items-center gap-3.5 min-w-0">
                {safeAvatarUrl && !avatarFailed ? (
                  <img
                    src={safeAvatarUrl}
                    alt={displayName}
                    onError={() => setAvatarFailed(true)}
                    className="w-14 h-14 rounded-full object-cover border border-[#2c3344] shrink-0"
                  />
                ) : (
                  <div className="w-14 h-14 rounded-full bg-gradient-to-br from-[#1d6ff2] to-[#2e3b5c] border border-[#2c3344] flex items-center justify-center text-base font-bold text-white shrink-0">
                    {initials}
                  </div>
                )}

                <div className="min-w-0">
                  <h1 className="text-xl font-bold text-white truncate leading-snug">
                    {displayName}
                  </h1>
                  <p className="text-xs text-[#8b96a6] mt-0.5">
                    {formatJoinedLabel(userCreatedAt)}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-3 text-[#8b96a6] shrink-0 pt-1">
                <button
                  type="button"
                  onClick={handleCopyProfileLink}
                  className="hover:text-white transition-colors"
                  title="Copiar identificador"
                >
                  <Copy className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  onClick={() => navigate('/profile')}
                  className="hover:text-white transition-colors"
                  title="Editar perfil"
                >
                  <Pencil className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  onClick={handleSharePortfolio}
                  className="hover:text-white transition-colors"
                  title="Partilhar portfólio"
                >
                  <Share className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Badge de Saldo Disponível + Handle */}
            <div className="mt-4 space-y-2">
              <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-[#1d222e] border border-[#2b3242] text-xs font-medium text-[#d4dde7]">
                <Lock className="w-3.5 h-3.5 text-[#3b82f6]" />
                <span>Saldo disponível: {maskOrKz(availableCashKz)}</span>
                <button
                  type="button"
                  onClick={() => setHideBalances((v) => !v)}
                  className="text-[#8b96a6] hover:text-white transition-colors ml-0.5"
                  title={hideBalances ? 'Mostrar valores' : 'Ocultar valores'}
                >
                  {hideBalances ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                </button>
              </div>

              <div className="flex flex-wrap items-center gap-3 text-xs text-[#b7c0ce]">
                <span>{handleSlug}</span>
                {reservedOrderKz > 0 && (
                  <span className="text-amber-400 font-medium">
                    • Em ordens abertas: {maskOrKz(reservedOrderKz)}
                  </span>
                )}
              </div>
            </div>

            {/* Divisor + 3 Métricas Centradas */}
            <div className="border-t border-[#232836] my-4" />

            <div className="grid grid-cols-3 text-center gap-2 py-1">
              <div>
                <div className="text-base sm:text-lg font-bold text-white tabular-nums">
                  {maskOrKz(totalPositionsValueKz)}
                </div>
                <div className="text-[11px] text-[#8b96a6] mt-0.5">
                  Valor das posições
                </div>
              </div>
              <div className="border-x border-[#232836]/70 px-1">
                <div className="text-base sm:text-lg font-bold text-white tabular-nums">
                  {biggestWinKz > 0 ? maskOrKz(biggestWinKz) : '—'}
                </div>
                <div className="text-[11px] text-[#8b96a6] mt-0.5">
                  Maior vitória
                </div>
              </div>
              <div>
                <div className="text-base sm:text-lg font-bold text-white tabular-nums">
                  {tradedMarketsCount}
                </div>
                <div className="text-[11px] text-[#8b96a6] mt-0.5">
                  Mercados negociados
                </div>
              </div>
            </div>

            {/* Lucro Total e Volume Total */}
            <div className="mt-4 space-y-2 text-xs">
              <div className="flex items-center justify-between">
                <span className="text-[#8b96a6]">Lucro Total</span>
                <span
                  className={`font-semibold tabular-nums ${
                    unrealizedPnlKz > 0
                      ? 'text-[#3dd68c]'
                      : unrealizedPnlKz < 0
                        ? 'text-[#f87171]'
                        : 'text-[#8b96a6]'
                  }`}
                >
                  {positions.length === 0 && history.length === 0
                    ? '—'
                    : `${unrealizedPnlKz >= 0 ? '+' : ''}${maskOrKz(unrealizedPnlKz)}`}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[#8b96a6]">Volume total</span>
                <span className="font-semibold text-white tabular-nums">
                  {totalVolumeKz > 0 ? maskOrKz(totalVolumeKz) : '—'}
                </span>
              </div>
            </div>
          </div>

          {/* Botões Depósito / Retirar */}
          <div className="grid grid-cols-2 gap-3 mt-5">
            <button
              type="button"
              onClick={() => navigate('/profile?tab=deposit')}
              className="bg-[#1d6ff2] hover:bg-[#1961d6] text-white font-semibold py-2.5 px-4 rounded-lg text-sm transition-colors inline-flex items-center justify-center gap-2"
            >
              <ArrowDownToLine className="w-4 h-4" />
              <span>Depósito</span>
            </button>
            <button
              type="button"
              onClick={() => navigate('/profile?tab=withdraw')}
              className="bg-[#2a313d] hover:bg-[#353d4c] text-white font-semibold py-2.5 px-4 rounded-lg text-sm transition-colors inline-flex items-center justify-center gap-2"
            >
              <ArrowUpFromLine className="w-4 h-4" />
              <span>Retirar</span>
            </button>
          </div>
        </div>

        {/* CARTÃO DIREITO: Lucro/Prejuízo + Timeframes + Gráfico Área */}
        <div className="bg-[#161922] border border-[#232836] rounded-xl p-6 flex flex-col justify-between">
          <div>
            <div className="flex items-center gap-2 text-xs font-medium text-[#8b96a6]">
              <span
                className={`w-2 h-2 rounded-full ${
                  timeframePnlKz > 0
                    ? 'bg-[#3dd68c]'
                    : timeframePnlKz < 0
                      ? 'bg-[#f87171]'
                      : 'bg-[#8b96a6]'
                }`}
              />
              <span>Lucro/Prejuízo</span>
            </div>

            {/* Seletor de Período */}
            <div className="flex items-center gap-1 mt-2.5 flex-wrap">
              {(
                [
                  { id: '1D', label: '1D' },
                  { id: '1W', label: '1W' },
                  { id: '1M', label: '1M' },
                  { id: '1Y', label: '1 ano' },
                  { id: 'YTD', label: 'YTD' },
                  { id: 'ALL', label: 'TODOS' },
                ] as Array<{ id: TimeframeKey; label: string }>
              ).map((tf) => (
                <button
                  key={tf.id}
                  type="button"
                  onClick={() => setTimeframe(tf.id)}
                  className={`px-2.5 py-1 rounded-md text-xs font-semibold transition-colors ${
                    timeframe === tf.id
                      ? 'bg-[#252b38] text-white'
                      : 'text-[#8b96a6] hover:text-white'
                  }`}
                >
                  {tf.label}
                </button>
              ))}
            </div>

            {/* Valor P&L + Marca d'água MarketPay */}
            <div className="flex items-center justify-between gap-3 mt-3">
              <div className="flex items-center gap-2.5">
                <h2
                  className={`text-2xl sm:text-[26px] font-bold tabular-nums leading-none ${
                    timeframePnlKz > 0
                      ? 'text-[#3dd68c]'
                      : timeframePnlKz < 0
                        ? 'text-[#f87171]'
                        : 'text-white'
                  }`}
                >
                  {timeframePnlKz > 0 ? '+' : ''}
                  {maskOrKz(timeframePnlKz)}
                </h2>
                <button
                  type="button"
                  onClick={handleExportCsv}
                  className="text-[#8b96a6] hover:text-white transition-colors"
                  title="Exportar histórico em CSV"
                >
                  <Share className="w-3.5 h-3.5" />
                </button>
              </div>

              <div className="inline-flex items-center gap-1.5 text-sm font-semibold text-[#5a6475] select-none">
                <svg
                  className="w-4 h-4 text-[#5a6475]"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  aria-hidden="true"
                >
                  <path d="M4 5l16 7-16 7V5z" />
                </svg>
                <span>MarketPay</span>
              </div>
            </div>
          </div>

          {/* Área do Gráfico estilo Polymarket */}
          <div className="mt-6 h-36 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={pnlChartData} margin={{ top: 8, right: 0, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="portfolioPnlGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#3b5399" stopOpacity={0.55} />
                    <stop offset="65%" stopColor="#273459" stopOpacity={0.25} />
                    <stop offset="100%" stopColor="#161922" stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <YAxis hide domain={['auto', 'auto']} />
                <Tooltip
                  contentStyle={{
                    backgroundColor: '#12151d',
                    borderColor: '#232836',
                    borderRadius: '8px',
                    fontSize: '11px',
                    color: '#ffffff',
                  }}
                  formatter={(value: any) => [formatKz(value, 2), 'Lucro/Prejuízo']}
                />
                <Area
                  type="monotone"
                  dataKey="pnl"
                  stroke="#3b5399"
                  strokeWidth={2}
                  fill="url(#portfolioPnlGradient)"
                  isAnimationActive={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      {/* SECÇÃO INFERIOR: Abas + Barra de Pesquisa/Filtro + Tabela */}
      <div className="space-y-4 pt-1">
        {/* Abas limpas sem caixa */}
        <div className="flex items-center gap-6">
          <button
            type="button"
            onClick={() => setMainTab('positions')}
            className={`text-sm font-bold transition-colors ${
              mainTab === 'positions' ? 'text-white' : 'text-[#7c8798] hover:text-white'
            }`}
          >
            Posições
          </button>
          <button
            type="button"
            onClick={() => setMainTab('open')}
            className={`text-sm font-bold transition-colors inline-flex items-center gap-1.5 ${
              mainTab === 'open' ? 'text-white' : 'text-[#7c8798] hover:text-white'
            }`}
          >
            <span>Ordens Abertas</span>
            {openOrders.length > 0 && (
              <span className="px-1.5 py-0.5 text-[10px] rounded-full bg-[#232836] text-[#c5d0de] tabular-nums">
                {openOrders.length}
              </span>
            )}
          </button>
          <button
            type="button"
            onClick={() => setMainTab('history')}
            className={`text-sm font-bold transition-colors ${
              mainTab === 'history' ? 'text-white' : 'text-[#7c8798] hover:text-white'
            }`}
          >
            Atividade
          </button>
        </div>

        {/* Barra de Filtros, Pesquisa e Ordenação */}
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
          {mainTab === 'positions' && (
            <div className="inline-flex items-center bg-[#12151d] border border-[#232836] rounded-lg p-1 shrink-0 self-start">
              <button
                type="button"
                onClick={() => setPositionStatusFilter('active')}
                className={`px-3 py-1.5 rounded-md text-xs font-semibold transition-colors ${
                  positionStatusFilter === 'active'
                    ? 'bg-[#232936] text-white'
                    : 'text-[#8b96a6] hover:text-white'
                }`}
              >
                Ativo
              </button>
              <button
                type="button"
                onClick={() => setPositionStatusFilter('closed')}
                className={`px-3 py-1.5 rounded-md text-xs font-semibold transition-colors ${
                  positionStatusFilter === 'closed'
                    ? 'bg-[#232936] text-white'
                    : 'text-[#8b96a6] hover:text-white'
                }`}
              >
                Fechado
              </button>
            </div>
          )}

          {mainTab === 'open' && (
            <div className="inline-flex items-center bg-[#12151d] border border-[#232836] rounded-lg p-1 shrink-0 self-start">
              <button
                type="button"
                onClick={() => setOrdersScopeFilter('open')}
                className={`px-3 py-1.5 rounded-md text-xs font-semibold transition-colors ${
                  ordersScopeFilter === 'open'
                    ? 'bg-[#232936] text-white'
                    : 'text-[#8b96a6] hover:text-white'
                }`}
              >
                Abertas
              </button>
              <button
                type="button"
                onClick={() => setOrdersScopeFilter('all')}
                className={`px-3 py-1.5 rounded-md text-xs font-semibold transition-colors ${
                  ordersScopeFilter === 'all'
                    ? 'bg-[#232936] text-white'
                    : 'text-[#8b96a6] hover:text-white'
                }`}
              >
                Todas
              </button>
            </div>
          )}

          {mainTab === 'history' && (
            <div className="inline-flex items-center bg-[#12151d] border border-[#232836] rounded-lg p-1 shrink-0 self-start">
              {(
                [
                  { id: 'all', label: 'Todas' },
                  { id: 'buy', label: 'Compras' },
                  { id: 'sell', label: 'Vendas' },
                ] as const
              ).map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setHistoryFilter(item.id)}
                  className={`px-3 py-1.5 rounded-md text-xs font-semibold transition-colors ${
                    historyFilter === item.id
                      ? 'bg-[#232936] text-white'
                      : 'text-[#8b96a6] hover:text-white'
                  }`}
                >
                  {item.label}
                </button>
              ))}
            </div>
          )}

          {/* Campo de Pesquisa */}
          <div className="relative flex-1">
            <Search className="w-3.5 h-3.5 text-[#6e7b8b] absolute left-3.5 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              maxLength={80}
              placeholder="Pesquisar mercados..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full bg-[#12151d] border border-[#232836] rounded-lg pl-9 pr-3 py-2 text-xs text-white placeholder-[#6e7b8b] focus:outline-none focus:border-[#3b82f6]"
            />
          </div>

          {/* Ordenação e Exportação */}
          <div className="flex items-center gap-2 shrink-0">
            {mainTab === 'history' ? (
              <select
                value={historySortOrder}
                onChange={(e) => setHistorySortOrder(e.target.value as any)}
                className="bg-[#12151d] border border-[#232836] rounded-lg px-3 py-2 text-xs font-semibold text-white focus:outline-none"
              >
                <option value="recent">Mais recentes</option>
                <option value="oldest">Mais antigos</option>
                <option value="amount_desc">Maior valor</option>
              </select>
            ) : (
              <div className="relative inline-flex items-center bg-[#12151d] border border-[#232836] rounded-lg px-3 py-2">
                <ArrowUpDown className="w-3.5 h-3.5 text-[#8b96a6] mr-1.5 shrink-0" />
                <select
                  value={sortBy}
                  onChange={(e) => setSortBy(e.target.value as any)}
                  className="bg-transparent text-xs font-semibold text-white focus:outline-none pr-1"
                >
                  <option value="value" className="bg-[#12151d]">Valor</option>
                  <option value="current" className="bg-[#12151d]">Atual</option>
                  <option value="avg" className="bg-[#12151d]">Média</option>
                  <option value="profit" className="bg-[#12151d]">Lucro</option>
                </select>
              </div>
            )}

            <button
              type="button"
              onClick={handleExportCsv}
              className="bg-[#12151d] border border-[#232836] hover:border-[#374151] rounded-lg p-2 text-[#8b96a6] hover:text-white transition-colors"
              title="Exportar CSV"
            >
              <Download className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* ABA 1: POSIÇÕES */}
        {mainTab === 'positions' && (
          <div className="overflow-x-auto">
            {loading && positions.length === 0 ? (
              <div className="flex justify-center py-12 text-[#8b96a6] gap-2 items-center text-xs">
                <Loader2 className="w-4 h-4 animate-spin text-[#3b82f6]" />
                <span>A carregar posições...</span>
              </div>
            ) : filteredPositions.length === 0 ? (
              <div className="text-center py-14 text-[#7c8b9e] text-xs border-t border-[#232836]">
                {positionStatusFilter === 'active'
                  ? 'Nenhuma posição ativa encontrada.'
                  : 'Nenhuma posição fechada encontrada.'}
              </div>
            ) : (
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-[#232836] text-[11px] font-semibold uppercase tracking-wider text-[#6e7b8b]">
                    <th className="py-3 pr-4">MERCADO</th>
                    <th className="py-3 px-4 text-right">MÉDIA</th>
                    <th className="py-3 px-4 text-right">
                      <button
                        type="button"
                        onClick={() => handleSortHeaderClick('current')}
                        className="inline-flex items-center gap-1 hover:text-white transition-colors"
                      >
                        <span>ATUAL</span>
                        <ArrowUpDown className="w-3 h-3" />
                      </button>
                    </th>
                    <th className="py-3 px-4 text-right">
                      <button
                        type="button"
                        onClick={() => handleSortHeaderClick('value')}
                        className="inline-flex items-center gap-1 hover:text-white transition-colors"
                      >
                        <span>VALOR</span>
                        <ArrowUpDown className="w-3 h-3" />
                      </button>
                    </th>
                    <th className="py-3 pl-4 text-right">AÇÃO</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#1e2330] text-xs">
                  {filteredPositions.map((pos) => (
                    <tr key={pos.id} className="hover:bg-white/[0.02] transition-colors">
                      <td className="py-3.5 pr-4">
                        <div className="flex items-center gap-3 min-w-[220px]">
                          {pos.market_image_url ? (
                            <img
                              src={pos.market_image_url}
                              alt=""
                              className="w-9 h-9 rounded-lg object-cover shrink-0 bg-[#1e2330]"
                            />
                          ) : (
                            <div className="w-9 h-9 rounded-lg bg-[#1e2330] border border-[#2b3242] shrink-0" />
                          )}
                          <div className="min-w-0">
                            <Link
                              to={`/market/${pos.market_id}`}
                              className="font-semibold text-white hover:text-[#3b82f6] transition-colors line-clamp-1"
                            >
                              {pos.market_question}
                            </Link>
                            <div className="flex items-center gap-2 mt-0.5 text-[11px]">
                              <span
                                className={`px-1.5 py-0.5 rounded font-bold ${
                                  pos.outcome === 'Yes'
                                    ? 'bg-[#153e2b] text-[#3dd68c]'
                                    : 'bg-[#421c21] text-[#f87171]'
                                }`}
                              >
                                {pos.outcome === 'Yes' ? 'Sim' : pos.outcome === 'No' ? 'Não' : pos.outcome}
                              </span>
                              <span className="text-[#8b96a6] tabular-nums">
                                {pos.shares_amount.toLocaleString('pt-AO', { maximumFractionDigits: 2 })} quotas
                              </span>
                            </div>
                          </div>
                        </div>
                      </td>

                      <td className="py-3.5 px-4 text-right text-[#9aa8b8] font-mono tabular-nums whitespace-nowrap">
                        {formatKz(pos.avg_entry_price_kz, 2)}
                      </td>

                      <td className="py-3.5 px-4 text-right text-white font-mono font-semibold tabular-nums whitespace-nowrap">
                        {formatKz(pos.current_price_kz, 2)}
                      </td>

                      <td className="py-3.5 px-4 text-right font-mono tabular-nums whitespace-nowrap">
                        <div className="font-bold text-white">
                          {hideBalances ? '•••••• Kz' : formatKz(pos.current_value_kz, 2)}
                        </div>
                        <div
                          className={`text-[11px] font-semibold ${
                            pos.profit_kz >= 0 ? 'text-[#3dd68c]' : 'text-[#f87171]'
                          }`}
                        >
                          {pos.profit_kz >= 0 ? '+' : ''}
                          {hideBalances ? '••••' : formatKz(pos.profit_kz, 2)} ({pos.roi_pct >= 0 ? '+' : ''}
                          {pos.roi_pct.toFixed(1)}%)
                        </div>
                      </td>

                      <td className="py-3.5 pl-4 text-right whitespace-nowrap">
                        {!pos.is_resolved ? (
                          <Link
                            to={`/market/${pos.market_id}?outcome=${encodeURIComponent(pos.outcome)}&type=sell`}
                            className="px-3 py-1.5 bg-[#1e2330] hover:bg-[#1d6ff2] text-white text-[11px] font-semibold rounded-lg border border-[#2b3242] transition-colors"
                          >
                            Negociar
                          </Link>
                        ) : (
                          <span
                            className={`text-[11px] font-semibold ${
                              pos.has_won ? 'text-[#3dd68c]' : 'text-[#8b96a6]'
                            }`}
                          >
                            {pos.has_won ? 'Ganhou' : 'Resolvido'}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}

        {/* ABA 2: ORDENS ABERTAS */}
        {mainTab === 'open' && (
          <div className="overflow-x-auto">
            {filteredOrders.length === 0 ? (
              <div className="text-center py-14 text-[#7c8b9e] text-xs border-t border-[#232836]">
                Nenhuma ordem encontrada.
              </div>
            ) : (
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-[#232836] text-[11px] font-semibold uppercase tracking-wider text-[#6e7b8b]">
                    <th className="py-3 pr-4">MERCADO</th>
                    <th className="py-3 px-4">LADO</th>
                    <th className="py-3 px-4 text-right">PREÇO LIMITE</th>
                    <th className="py-3 px-4 text-right">VALOR PENDENTE</th>
                    <th className="py-3 px-4 text-center">ESTADO</th>
                    <th className="py-3 pl-4 text-right">AÇÃO</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#1e2330] text-xs">
                  {filteredOrders.map((order) => {
                    const marketQ = sanitizePlainText(
                      marketById.get(order.market_id)?.question || order.market_id,
                      140
                    );
                    const unitPriceKz = Number(order.price_cents || 0) / 100;
                    const pendingKz = Number(order.remaining_quantity || 0) * unitPriceKz;
                    const isOpen =
                      (order.status === 'OPEN' || order.status === 'PARTIAL') &&
                      Number(order.remaining_quantity || 0) > 0;
                    return (
                      <tr key={order.id} className="hover:bg-white/[0.02] transition-colors">
                        <td className="py-3.5 pr-4 font-semibold text-white max-w-xs truncate">
                          <Link to={`/market/${order.market_id}`} className="hover:text-[#3b82f6]">
                            {marketQ}
                          </Link>
                        </td>
                        <td className="py-3.5 px-4 font-bold">
                          <span className={order.side === 'Buy' ? 'text-[#3dd68c]' : 'text-[#f87171]'}>
                            {order.side === 'Buy' ? 'Compra' : 'Venda'} (
                            {order.outcome === 'Yes' ? 'Sim' : 'Não'})
                          </span>
                        </td>
                        <td className="py-3.5 px-4 text-right font-mono text-white tabular-nums">
                          {formatKz(unitPriceKz, 2)}
                        </td>
                        <td className="py-3.5 px-4 text-right font-mono text-[#3dd68c] font-bold tabular-nums">
                          {formatKz(pendingKz, 2)} ({order.remaining_quantity}/{order.quantity})
                        </td>
                        <td className="py-3.5 px-4 text-center">
                          <span
                            className={`px-2 py-0.5 rounded text-[10px] font-semibold ${
                              isOpen
                                ? 'bg-amber-500/15 text-amber-300 border border-amber-500/30'
                                : 'bg-[#232836] text-[#8b96a6]'
                            }`}
                          >
                            {order.status === 'OPEN'
                              ? 'Aberta'
                              : order.status === 'PARTIAL'
                                ? 'Parcial'
                                : order.status === 'FILLED'
                                  ? 'Executada'
                                  : 'Cancelada'}
                          </span>
                        </td>
                        <td className="py-3.5 pl-4 text-right">
                          {isOpen &&
                            (confirmCancelId === order.id ? (
                              <div className="inline-flex items-center gap-1.5">
                                <button
                                  type="button"
                                  disabled={cancellingId === order.id}
                                  onClick={async () => {
                                    setCancellingId(order.id);
                                    try {
                                      await ammApi.cancelClobOrder(order.id);
                                      setConfirmCancelId(null);
                                      addToast('Ordem cancelada e fundos libertados.', 'success');
                                      await fetchPortfolioData();
                                      await onRefreshAll?.();
                                    } catch (err: any) {
                                      addToast(err?.message || 'Erro ao cancelar ordem.', 'error');
                                    } finally {
                                      if (isMountedRef.current) setCancellingId(null);
                                    }
                                  }}
                                  className="px-2.5 py-1 bg-[#dc2626] text-white text-[11px] font-bold rounded"
                                >
                                  {cancellingId === order.id ? '...' : 'Confirmar'}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setConfirmCancelId(null)}
                                  className="px-2 py-1 text-[#8b96a6] hover:text-white text-[11px]"
                                >
                                  Não
                                </button>
                              </div>
                            ) : (
                              <button
                                type="button"
                                onClick={() => setConfirmCancelId(order.id)}
                                className="px-2.5 py-1 bg-[#421c21] hover:bg-[#52232a] text-[#f87171] text-[11px] font-bold rounded transition-colors"
                              >
                                Cancelar
                              </button>
                            ))}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        )}

        {/* ABA 3: ATIVIDADE (HISTÓRICO) */}
        {mainTab === 'history' && (
          <div className="overflow-x-auto">
            {filteredHistory.length === 0 ? (
              <div className="text-center py-14 text-[#7c8b9e] text-xs border-t border-[#232836]">
                Nenhuma atividade registada.
              </div>
            ) : (
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-[#232836] text-[11px] font-semibold uppercase tracking-wider text-[#6e7b8b]">
                    <th className="py-3 pr-4">ATIVIDADE</th>
                    <th className="py-3 px-4">MERCADO</th>
                    <th className="py-3 px-4 text-right">QUOTAS</th>
                    <th className="py-3 px-4 text-right">PREÇO</th>
                    <th className="py-3 px-4 text-right">VALOR</th>
                    <th className="py-3 pl-4 text-right">TEMPO</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#1e2330] text-xs">
                  {filteredHistory.map((t) => {
                    const isBuy = t.side === 'Buy' || t.side === 'Compra';
                    return (
                      <tr key={t.id} className="hover:bg-white/[0.02] transition-colors">
                        <td className="py-3.5 pr-4 font-bold whitespace-nowrap">
                          <span className={isBuy ? 'text-[#3dd68c]' : 'text-[#f87171]'}>
                            {isBuy ? 'Comprar' : 'Vender'} (
                            {t.outcome === 'Yes' ? 'Sim' : t.outcome === 'No' ? 'Não' : t.outcome})
                          </span>
                        </td>
                        <td className="py-3.5 px-4 text-[#d4dde7] max-w-xs truncate">
                          <Link to={`/market/${t.market_id}`} className="hover:text-[#3b82f6]">
                            {t.market_question}
                          </Link>
                        </td>
                        <td className="py-3.5 px-4 text-right font-mono text-white tabular-nums">
                          {t.shares.toLocaleString('pt-AO', { maximumFractionDigits: 4 })}
                        </td>
                        <td className="py-3.5 px-4 text-right font-mono text-[#9aa8b8] tabular-nums">
                          {formatKz(t.price_kz, 2)}
                        </td>
                        <td className="py-3.5 px-4 text-right font-mono font-bold text-white tabular-nums">
                          {hideBalances ? '•••••• Kz' : formatKz(t.amount_kz, 2)}
                        </td>
                        <td className="py-3.5 pl-4 text-right text-[#8b96a6] whitespace-nowrap">
                          {t.timestamp ? new Date(t.timestamp).toLocaleString('pt-AO') : '-'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
