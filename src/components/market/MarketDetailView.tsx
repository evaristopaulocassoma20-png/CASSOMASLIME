import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  Bookmark,
  Link2,
  Code,
  ChevronDown,
  ChevronUp,
  ChevronLeft,
  MessageSquare,
  Heart,
  SlidersHorizontal,
  ShieldCheck,
  Copy,
  Check,
  AlertTriangle,
  Loader2,
  Lock,
  Trash2,
  Plus,
  Edit3,
  BarChart3,
  Bitcoin,
  CheckCircle2,
  ArrowUpDown,
  X,
} from 'lucide-react';
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  BarChart,
  Bar,
  Cell,
  ReferenceLine,
} from 'recharts';
import { formatDistanceToNow } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { Market, MarketPosition, User, Outcome, PriceHistory, Category } from '../../types';
import { supabaseService as firebaseService } from '../../lib/supabase-service';
import { ammApi } from '../../lib/amm-api';
import {
  INITIAL_LP_PAIRS,
  SHARE_SETTLEMENT_KZ,
  WITHDRAWAL_FEE_RATE,
  getCpmmSpotPricesKz,
  quoteCpmmBuy,
  quoteCpmmSell,
} from '../../lib/cpmm-math';
import { formatKz, parsePositiveFinite, sanitizeHttpUrl, sanitizePlainText } from '../../lib/sanitize';

const SERIES_COLORS = ['#2d8cff', '#4cc3ff', '#e5a93c', '#f97316', '#a855f7', '#10b981'];

function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ');
}

const LocalThumb: React.FC<{
  src?: string;
  alt?: string;
  className?: string;
  isCrypto?: boolean;
  fallbackLabel?: string;
}> = ({ src, alt = '', className = 'w-10 h-10 rounded-xl', isCrypto = false, fallbackLabel }) => {
  const [failed, setFailed] = useState(false);

  if (isCrypto) {
    return (
      <div
        className={cx(
          'bg-[#1e2631] border border-[#2b3544] flex items-center justify-center shrink-0',
          className
        )}
      >
        <Bitcoin className="w-5 h-5 text-[#F7931A]" />
      </div>
    );
  }

  if (!src || failed) {
    const initials = (fallbackLabel || alt || '')
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase() || '')
      .join('');
    return (
      <div
        className={cx(
          'bg-[#1e2631] border border-[#2b3544] flex items-center justify-center shrink-0 text-[#9aa8b8] font-bold text-xs',
          className
        )}
      >
        {initials || <BarChart3 className="w-4 h-4" />}
      </div>
    );
  }

  return (
    <img
      src={src}
      alt={alt}
      onError={() => setFailed(true)}
      className={cx('object-cover border border-[#2b3544] shrink-0', className)}
      referrerPolicy="no-referrer"
    />
  );
};

export interface MarketDetailViewProps {
  market: Market | undefined;
  markets: Market[];
  user: User | null;
  trades: any[];
  categories: Category[];
  addToast: (msg: string, type?: 'success' | 'error' | 'info') => void;
  onRefreshAll?: () => Promise<void> | void;
  onBalanceUpdate?: (newBalanceKz: number) => void;
  OrderBookComponent: React.ComponentType<any>;
  RecentTradesComponent: React.ComponentType<{ trades: any[] }>;
  CandlestickComponent: React.ComponentType<any>;
}

export const MarketDetailView: React.FC<MarketDetailViewProps> = ({
  market,
  markets,
  user,
  trades,
  categories,
  addToast,
  onRefreshAll,
  onBalanceUpdate,
  OrderBookComponent,
  RecentTradesComponent,
  CandlestickComponent,
}) => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const tradePanelRef = useRef<HTMLDivElement | null>(null);
  const amountInputRef = useRef<HTMLInputElement | null>(null);

  // Selected outcome in multi-outcome market (or 'Yes'/'No' in binary)
  const [outcome, setOutcome] = useState<Outcome>('Yes');
  // For multi-outcome markets: whether user is buying/selling Yes vs No on the chosen option
  const [binarySide, setBinarySide] = useState<'Yes' | 'No'>('Yes');
  const [isBuying, setIsBuying] = useState(true);
  const [orderType, setOrderType] = useState<'Market' | 'Limit'>('Market');
  const [amount, setAmount] = useState<string>('500');
  const [limitPrice, setLimitPrice] = useState<string>('');
  const [maxSlippagePct, setMaxSlippagePct] = useState<number>(1.0);
  const [isPending, setIsPending] = useState(false);
  const [lastTradeSuccess, setLastTradeSuccess] = useState<any | null>(null);
  const [priceChangedAlert, setPriceChangedAlert] = useState<{
    oldPrice: number;
    newPrice: number;
    message: string;
  } | null>(null);
  const pendingIdempotencyKeyRef = useRef<string | null>(null);

  // Realtime single-market override & live trades + CPMM positions
  const [liveMarketPatch, setLiveMarketPatch] = useState<Partial<Market> | null>(null);
  const [liveMarketTrades, setLiveMarketTrades] = useState<any[]>([]);
  const [cpmmPositions, setCpmmPositions] = useState<MarketPosition[]>([]);

  // CLOB / Binary state
  const [clobPositions, setClobPositions] = useState<any[]>([]);
  const [clobQuote, setClobQuote] = useState<any | null>(null);
  const [clobVersion, setClobVersion] = useState(0);
  const [marketExecutions, setMarketExecutions] = useState<any[]>([]);
  const [realClobCandles, setRealClobCandles] = useState<any[]>([]);
  const [priceHistory, setPriceHistory] = useState<PriceHistory[]>([]);
  const [marketPositions, setMarketPositions] = useState<any[]>([]);
  const [loadingPositions, setLoadingPositions] = useState(false);

  // Interactions (Bookmarks, Metadata Overrides, Proposals, FAQs, Multi-Positions, Comment Likes)
  const [interactions, setInteractions] = useState<Awaited<ReturnType<typeof ammApi.getMarketInteractions>> | null>(
    null
  );
  const [bookmarkLoading, setBookmarkLoading] = useState(false);

  // Comments
  const [comments, setComments] = useState<any[]>([]);
  const [newComment, setNewComment] = useState('');
  const [submittingComment, setSubmittingComment] = useState(false);
  const [replyingToId, setReplyingToId] = useState<string | null>(null);
  const [commentSort, setCommentSort] = useState<'newest' | 'liked'>('newest');
  const [holdersOnlyComments, setHoldersOnlyComments] = useState(false);
  const [visibleCommentsCount, setVisibleCommentsCount] = useState(10);

  // Chart & UI state
  const [timeRange, setTimeRange] = useState<'1H' | '6H' | '1D' | '1W' | '1M' | 'TUDO'>('1D');
  const [chartType, setChartType] = useState<'probability' | 'price' | 'candlestick'>('probability');
  const [showGridLines, setShowGridLines] = useState(true);
  const [showLegend, setShowLegend] = useState(true);
  const [showChartSettings, setShowChartSettings] = useState(false);

  // Outcome table controls
  const [outcomeSort, setOutcomeSort] = useState<'price_desc' | 'volume_desc'>('price_desc');
  const [showAllOutcomes, setShowAllOutcomes] = useState(false);

  // Rules & Context section
  const [rulesTab, setRulesTab] = useState<'rules' | 'context'>('rules');
  const [expandRules, setExpandRules] = useState(false);
  const [showEditMetadata, setShowEditMetadata] = useState(false);
  const [editContextText, setEditContextText] = useState('');
  const [editDescriptionText, setEditDescriptionText] = useState('');
  const [editResolverName, setEditResolverName] = useState('');
  const [editResolverAddress, setEditResolverAddress] = useState('');
  const [savingMetadata, setSavingMetadata] = useState(false);

  // Resolution Proposal form
  const [showProposalForm, setShowProposalForm] = useState(false);
  const [proposalOutcome, setProposalOutcome] = useState('');
  const [proposalEvidence, setProposalEvidence] = useState('');
  const [proposalRationale, setProposalRationale] = useState('');
  const [submittingProposal, setSubmittingProposal] = useState(false);

  // Bottom community tabs (strict order: Livro de Ordens -> Posições -> Maiores Detentores -> Atividade -> Comentários)
  const [communityTab, setCommunityTab] = useState<'orderbook' | 'positions' | 'holders' | 'activity' | 'comments'>(
    !market?.is_multi ? 'orderbook' : 'positions'
  );
  const [holderOutcomeFilter, setHolderOutcomeFilter] = useState<string>('Todos');

  // Async race-condition & unmount safety refs
  const isMountedRef = useRef(true);
  const activeMarketIdRef = useRef<string | undefined>(market?.id);
  const interactionsReqSeqRef = useRef(0);
  const clobReqSeqRef = useRef(0);
  const candlesReqSeqRef = useRef(0);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // FAQ state
  const [openFaqIdx, setOpenFaqIdx] = useState<number | null>(null);
  const [showAllFaqs, setShowAllFaqs] = useState(false);
  const [showAddFaq, setShowAddFaq] = useState(false);
  const [newFaqQuestion, setNewFaqQuestion] = useState('');
  const [newFaqAnswer, setNewFaqAnswer] = useState('');

  // Related markets & Embed modal & Admin resolution
  const [relatedFilter, setRelatedFilter] = useState<string>('Todos');
  const [showEmbedModal, setShowEmbedModal] = useState(false);
  const [resolutionMotive, setResolutionMotive] = useState('');
  const [confirmResolveOutcome, setConfirmResolveOutcome] = useState<string | null>(null);

  const isMulti = Boolean(market?.is_multi && market?.outcomes && market.outcomes.length > 0);
  const isMarketBlocked = market?.status === 'blocked';
  const categoryObj = categories?.find((c) => c.name === (market?.category || ''));
  const isCategoryBlocked = categoryObj?.status === 'blocked';
  const isTradingBlocked = isMarketBlocked || isCategoryBlocked;
  const isCrypto =
    market?.category === 'Cripto' || market?.category === 'Crypto' || market?.category === 'Finanças';

  // Sync URL params (when clicked from HomePage card)
  useEffect(() => {
    const outcomeParam = searchParams.get('outcome');
    const sideParam = searchParams.get('side');
    const typeParam = searchParams.get('type');
    if (outcomeParam) setOutcome(outcomeParam);
    if (sideParam === 'No' || sideParam === 'Yes') setBinarySide(sideParam);
    if (typeParam) setIsBuying(typeParam !== 'sell');
  }, [searchParams]);

  // Default outcome on market change
  useEffect(() => {
    if (!market) return;
    if (market.graphType && market.graphType !== 'none') {
      setChartType(market.graphType as any);
    } else {
      setChartType('probability');
    }
    const outcomeParam = searchParams.get('outcome');
    if (!outcomeParam) {
      if (market.is_multi && market.outcomes?.length) {
        const sorted = [...market.outcomes].sort((a, b) => (b.price || 0) - (a.price || 0));
        setOutcome(sorted[0].name);
        setBinarySide('Yes');
      } else {
        setOutcome('Yes');
        setBinarySide('Yes');
      }
    }
  }, [market?.id]);

  // Effective market merging Realtime updates instantly
  const effectiveMarket: Market | undefined = useMemo(() => {
    if (!market) return undefined;
    if (!liveMarketPatch || liveMarketPatch.id !== market.id) return market;
    return { ...market, ...liveMarketPatch };
  }, [market, liveMarketPatch]);

  // Reset per-market local overrides and stale state immediately when switching markets
  useEffect(() => {
    activeMarketIdRef.current = market?.id;
    interactionsReqSeqRef.current += 1;
    clobReqSeqRef.current += 1;
    candlesReqSeqRef.current += 1;
    setLiveMarketPatch(null);
    setLiveMarketTrades([]);
    setCpmmPositions([]);
    setClobPositions([]);
    setMarketPositions([]);
    setMarketExecutions([]);
    setRealClobCandles([]);
    setInteractions(null);
    setComments([]);
    setPriceHistory([]);
    setPriceChangedAlert(null);
    pendingIdempotencyKeyRef.current = null;
    setCommunityTab(!market?.is_multi ? 'orderbook' : 'positions');
  }, [market?.id]);

  // Ensure multi-outcome markets never stay on binary-only OrderBook tab
  useEffect(() => {
    if (isMulti && communityTab === 'orderbook') {
      setCommunityTab('positions');
    }
  }, [isMulti, communityTab]);

  // Subscribe to comments, binary price history, Realtime market updates, trades & market_positions
  useEffect(() => {
    const targetMarketId = market?.id;
    if (!targetMarketId) return;
    const unsubComments = firebaseService.subscribeToComments(targetMarketId, (rows) => {
      if (activeMarketIdRef.current === targetMarketId) setComments(rows);
    });
    const unsubHistory = firebaseService.subscribeToPriceHistory(targetMarketId, (rows) => {
      if (activeMarketIdRef.current === targetMarketId) setPriceHistory(rows);
    });
    const unsubMarket = firebaseService.subscribeToMarketDetail(targetMarketId, (updated) => {
      if (activeMarketIdRef.current === targetMarketId && updated?.id === targetMarketId) {
        setLiveMarketPatch(updated);
      }
    });
    const unsubTrades = firebaseService.subscribeToMarketTrades(targetMarketId, (rows) => {
      if (activeMarketIdRef.current === targetMarketId) setLiveMarketTrades(rows);
    });
    const unsubPos = firebaseService.subscribeToMarketPositions(targetMarketId, () => {
      if (activeMarketIdRef.current === targetMarketId) setClobVersion((v) => v + 1);
    });
    return () => {
      unsubComments();
      unsubHistory();
      unsubMarket();
      unsubTrades();
      unsubPos();
    };
  }, [market?.id]);

  // Fetch Market Interactions
  const refreshInteractions = React.useCallback(async () => {
    const targetMarketId = market?.id;
    if (!targetMarketId) return;
    const reqSeq = ++interactionsReqSeqRef.current;
    try {
      const data = await ammApi.getMarketInteractions(targetMarketId);
      if (
        !isMountedRef.current ||
        activeMarketIdRef.current !== targetMarketId ||
        reqSeq !== interactionsReqSeqRef.current
      ) {
        return;
      }
      setInteractions(data);
    } catch {
      // silent fallback
    }
  }, [market?.id, user?.id]);

  useEffect(() => {
    refreshInteractions();
  }, [refreshInteractions, clobVersion, market?.volume, trades.length]);

  // Fetch CLOB & CPMM positions / holders / executions
  const refreshClobData = React.useCallback(async () => {
    const targetMarketId = market?.id;
    if (!targetMarketId) return;
    const reqSeq = ++clobReqSeqRef.current;
    setLoadingPositions(true);
    try {
      const [cpmmStateRes, sbCpmmPos, clobHoldersRes, sbHoldersRes, execRes, myRes] = await Promise.all([
        ammApi.getCpmmMarketState(targetMarketId).catch(() => null),
        firebaseService.getMarketCpmmPositions(targetMarketId).catch(() => []),
        ammApi.getMarketClobPositions(targetMarketId).catch(() => ({ positions: [] })),
        firebaseService.getMarketPositions(targetMarketId).catch(() => []),
        ammApi.getMarketExecutions(targetMarketId, 50).catch(() => ({ executions: [] })),
        user?.id
          ? ammApi.getMyClobOrders(targetMarketId).catch(() => ({ positions: [] }))
          : Promise.resolve({ positions: [] }),
      ]);

      if (
        !isMountedRef.current ||
        activeMarketIdRef.current !== targetMarketId ||
        reqSeq !== clobReqSeqRef.current
      ) {
        return;
      }

      const cpmmRows: MarketPosition[] =
        sbCpmmPos.length > 0
          ? sbCpmmPos
          : ((cpmmStateRes?.positions || []) as MarketPosition[]);
      setCpmmPositions(cpmmRows);

      const merged = new Map<string, any>();
      for (const mp of cpmmRows) {
        const key = `${mp.user_id}_${mp.outcome}_${mp.is_lp ? 'LP' : 'TR'}`;
        merged.set(key, {
          id: mp.id,
          userId: mp.user_id,
          userLabel: sanitizePlainText(mp.user_name, 60) || `Trader #${String(mp.user_id || '').slice(0, 6)}`,
          outcome: mp.outcome,
          shares: Number(mp.shares_amount || 0),
          avg_price: Number(mp.avg_entry_price || 50),
          total_cost_kz: Number(mp.total_cost_kz || 0),
          is_lp: Boolean(mp.is_lp),
          updated_at: mp.updated_at,
        });
      }

      if (merged.size === 0) {
        for (const p of sbHoldersRes || []) {
          const uid = p.user_id || p.userId;
          const key = `${uid}_${p.outcome}`;
          const rawAvg = Number(p.avg_price || 0);
          merged.set(key, {
            ...p,
            userId: uid,
            userLabel: sanitizePlainText(p.profiles?.name, 60) || `Trader #${String(uid || '').slice(0, 6)}`,
            shares: Number(p.shares || 0),
            avg_price: rawAvg > 1 ? rawAvg : rawAvg * 100,
            is_lp: false,
          });
        }
        for (const cp of clobHoldersRes.positions || []) {
          const key = `${cp.userId}_${cp.outcome}`;
          const existing = merged.get(key);
          merged.set(key, {
            ...(existing || {}),
            ...cp,
            userLabel:
              sanitizePlainText(existing?.profiles?.name || existing?.userLabel || cp.userLabel, 60) ||
              `Trader #${String(cp.userId || '').slice(0, 6)}`,
            shares: Number(cp.shares || 0),
            avg_price: Number(cp.avg_price || 0) > 1 ? Number(cp.avg_price || 0) : Number(cp.avg_price || 0) * 100,
            is_lp: false,
          });
        }
      }

      setMarketPositions(Array.from(merged.values()).filter((p) => (p.shares || 0) > 0));
      setMarketExecutions(execRes.executions || []);
      setClobPositions(user?.id ? myRes.positions || [] : []);
    } catch (e) {
      console.error('Error loading market positions:', e);
    } finally {
      if (
        isMountedRef.current &&
        activeMarketIdRef.current === targetMarketId &&
        reqSeq === clobReqSeqRef.current
      ) {
        setLoadingPositions(false);
      }
    }
  }, [market?.id, user?.id]);

  useEffect(() => {
    refreshClobData();
  }, [refreshClobData, trades.length, clobVersion]);

  // Fetch binary CLOB candles
  useEffect(() => {
    const targetMarketId = market?.id;
    if (!targetMarketId || isMulti) return;
    const reqSeq = ++candlesReqSeqRef.current;
    const interval = timeRange === '1H' ? '5m' : timeRange === '6H' ? '15m' : timeRange === '1D' ? '1h' : '1d';
    ammApi
      .getClobCandles(targetMarketId, interval, outcome === 'No' ? 'No' : 'Yes')
      .then((res) => {
        if (
          isMountedRef.current &&
          activeMarketIdRef.current === targetMarketId &&
          reqSeq === candlesReqSeqRef.current
        ) {
          setRealClobCandles(res.candles || []);
        }
      })
      .catch(() => {
        if (
          isMountedRef.current &&
          activeMarketIdRef.current === targetMarketId &&
          reqSeq === candlesReqSeqRef.current
        ) {
          setRealClobCandles([]);
        }
      });
  }, [market?.id, isMulti, timeRange, outcome, clobVersion]);

  // Quote binary LIMIT CLOB orders only (Market orders use deterministic client-side CPMM math)
  useEffect(() => {
    if (!market || isMulti || orderType !== 'Limit' || (outcome !== 'Yes' && outcome !== 'No')) {
      setClobQuote(null);
      return;
    }
    const parsedAmt = parseFloat(amount) || 0;
    const parsedLim = Math.round(parseFloat(limitPrice) || 0);
    if (parsedAmt <= 0 || parsedLim < 1 || parsedLim > 99) {
      setClobQuote(null);
      return;
    }

    let cancelled = false;
    const timer = setTimeout(() => {
      const qtyForOrder = isBuying
        ? Math.floor((parsedAmt * 100) / (parsedLim * 1.01))
        : Math.floor(parsedAmt);

      if (!qtyForOrder || qtyForOrder <= 0) {
        setClobQuote(null);
        return;
      }

      ammApi
        .quoteClobOrder({
          marketId: market.id,
          side: isBuying ? 'Buy' : 'Sell',
          outcome: outcome as 'Yes' | 'No',
          orderType: 'LIMIT',
          quantity: qtyForOrder,
          limitPriceCents: parsedLim,
        })
        .then((q) => {
          if (!cancelled) setClobQuote(q);
        })
        .catch(() => {
          if (!cancelled) setClobQuote(null);
        });
    }, 180);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [market?.id, isMulti, outcome, amount, limitPrice, isBuying, orderType, clobVersion]);

  // Sorted Outcomes for multi-outcome markets
  const sortedOutcomes = useMemo(() => {
    if (!market?.outcomes) return [];
    const list = [...market.outcomes];
    if (outcomeSort === 'volume_desc') {
      return list.sort((a, b) => (b.pool || 0) - (a.pool || 0));
    }
    return list.sort((a, b) => (b.price || 0) - (a.price || 0));
  }, [market?.outcomes, outcomeSort]);

  const topChartOutcomes = useMemo(() => sortedOutcomes.slice(0, 5), [sortedOutcomes]);

  // Selected Outcome metadata
  const selectedOutcomeObj = useMemo(() => {
    if (!isMulti || !market?.outcomes?.length) return null;
    return market.outcomes.find((o) => o.name === outcome) || sortedOutcomes[0] || null;
  }, [isMulti, market?.outcomes, outcome, sortedOutcomes]);

  // Current user's CPMM or legacy position for the selected outcome
  const myAllCpmmPositions = useMemo(() => {
    if (!user || !market) return [];
    const fromTable = cpmmPositions.filter((p) => p.user_id === user.id && p.shares_amount > 0);
    if (fromTable.length > 0) return fromTable;

    // Fallback: user.positions or clobPositions
    const fallbackList: MarketPosition[] = [];
    for (const p of user.positions || []) {
      const mid = (p as any).market_id || (p as any).marketId;
      if (mid !== market.id || Number(p.shares || 0) <= 0) continue;
      const rawAvg = Number(p.avg_price || 0);
      const avgKz = rawAvg > 1 ? rawAvg : rawAvg * 100;
      fallbackList.push({
        id: `${user.id}_${market.id}_${p.outcome}`,
        market_id: market.id,
        user_id: user.id,
        user_name: user.name,
        outcome: p.outcome,
        shares_amount: Number(p.shares || 0),
        avg_entry_price: avgKz,
        total_cost_kz: p.total_cost_kz ?? Number(p.shares || 0) * avgKz,
        is_lp: Boolean(p.is_lp),
        updated_at: '',
      });
    }
    return fallbackList;
  }, [user?.id, user?.positions, market?.id, cpmmPositions]);

  const myCpmmPositions = useMemo(
    () => myAllCpmmPositions.filter((p) => !p.is_lp),
    [myAllCpmmPositions]
  );

  // Current user's position for the currently selected outcome / binary side
  const userPosition = useMemo(() => {
    if (!market) return null;
    if (isMulti) {
      const myPos = interactions?.myMultiPositions?.find(
        (p) => p.outcome === (selectedOutcomeObj?.name || outcome) && p.binarySide === binarySide
      );
      if (!myPos || myPos.shares <= 0) return null;
      return {
        outcome: `${myPos.outcome} (${myPos.binarySide === 'Yes' ? 'Sim' : 'Não'})`,
        shares: myPos.shares,
        reservedShares: 0,
        avg_price: myPos.avg_price,
      };
    }

    const cpmmMatch = myCpmmPositions.find((p) => p.outcome === outcome);
    if (cpmmMatch && cpmmMatch.shares_amount > 0) {
      return {
        outcome: cpmmMatch.outcome,
        shares: cpmmMatch.shares_amount,
        reservedShares: 0,
        avg_price: cpmmMatch.avg_entry_price,
      };
    }

    const match = clobPositions.find((p: any) => p.outcome === outcome);
    if (!match || (match.available_shares || 0) <= 0) return null;
    const rawAvg = (match.avg_price_cents || 0) / 100;
    return {
      outcome: match.outcome,
      shares: match.available_shares,
      reservedShares: match.reserved_shares || 0,
      avg_price: rawAvg > 1 ? rawAvg : rawAvg * 100,
    };
  }, [market?.id, isMulti, interactions?.myMultiPositions, selectedOutcomeObj?.name, outcome, binarySide, myCpmmPositions, clobPositions]);

  // Build Chart Series Data (supports both multi-outcome multi-line and binary area/line)
  const { chartPoints, activeLegendItems } = useMemo(() => {
    if (!market) return { chartPoints: [], activeLegendItems: [] as any[] };

    const rangeMsMap: Record<string, number> = {
      '1H': 60 * 60 * 1000,
      '6H': 6 * 60 * 60 * 1000,
      '1D': 24 * 60 * 60 * 1000,
      '1W': 7 * 24 * 60 * 60 * 1000,
      '1M': 30 * 24 * 60 * 60 * 1000,
    };
    const cutoff = timeRange === 'TUDO' ? 0 : Date.now() - (rangeMsMap[timeRange] || rangeMsMap['1D']);

    if (isMulti && topChartOutcomes.length > 0) {
      const historyRows = (interactions?.outcomeHistory || []).filter(
        (h) => new Date(h.timestamp).getTime() >= cutoff
      );

      // Group history rows by rounded timestamp bucket
      const buckets = new Map<string, Record<string, any>>();
      for (const h of historyRows) {
        const tsKey = new Date(h.timestamp).toISOString().slice(0, 16);
        if (!buckets.has(tsKey)) {
          buckets.set(tsKey, {
            ts: new Date(h.timestamp).getTime(),
            label: new Date(h.timestamp).toLocaleDateString('pt-AO', { day: '2-digit', month: 'short' }),
          });
        }
        const entry = buckets.get(tsKey)!;
        const idx = topChartOutcomes.findIndex((o) => o.name === h.outcome_name);
        if (idx !== -1) {
          entry[`series_${idx}`] = Number(h.price || 0);
        }
      }

      const points = Array.from(buckets.values()).sort((a, b) => a.ts - b.ts);
      // Forward fill gaps so every line is continuous
      const lastKnown: Record<string, number> = {};
      topChartOutcomes.forEach((o, i) => {
        lastKnown[`series_${i}`] = Number(o.price || 0);
      });
      for (const pt of points) {
        topChartOutcomes.forEach((_o, i) => {
          const k = `series_${i}`;
          if (pt[k] !== undefined) lastKnown[k] = pt[k];
          else pt[k] = lastKnown[k];
        });
      }

      // Append current live snapshot
      const nowSnapshot: Record<string, any> = {
        ts: Date.now(),
        label: new Date().toLocaleDateString('pt-AO', { day: '2-digit', month: 'short' }),
      };
      topChartOutcomes.forEach((o, i) => {
        nowSnapshot[`series_${i}`] = Number(o.price || 0);
      });

      if (points.length === 0) {
        const startSnap: Record<string, any> = {
          ...nowSnapshot,
          ts: Date.now() - 3600_000,
          label: 'Início',
        };
        points.push(startSnap, nowSnapshot);
      } else {
        points.push(nowSnapshot);
      }

      const legendItems = topChartOutcomes.slice(0, 4).map((o, i) => ({
        name: o.name,
        pct: (Number(o.price || 0) * 100).toFixed(1).replace('.0', ''),
        color: SERIES_COLORS[i % SERIES_COLORS.length],
      }));

      return { chartPoints: points, activeLegendItems: legendItems };
    }

    // Binary chart points
    const filteredHistory = priceHistory.filter((h) => new Date(h.timestamp).getTime() >= cutoff);
    let pts: any[] = [];
    if (filteredHistory.length > 0) {
      pts = filteredHistory.map((h, i) => {
        const p = outcome === 'No' ? 1 - Number(h.yes_price || 0.5) : Number(h.yes_price || 0.5);
        return {
          time: i,
          label: new Date(h.timestamp).toLocaleDateString('pt-AO', { day: '2-digit', month: 'short' }),
          price: p,
          priceKZ: Math.round(p * 100),
        };
      });
    } else if (realClobCandles.length > 0) {
      pts = realClobCandles.map((c, i) => ({
        time: i,
        label: c.time,
        price: (c.close || 50) / 100,
        priceKZ: Math.round(c.close || 50),
      }));
    }

    const mLive = effectiveMarket || market;
    const liveP = mLive.resolved
      ? mLive.resolution_outcome === outcome
        ? 1
        : 0
      : outcome === 'No'
        ? Number(mLive.no_price ?? 0.5)
        : Number(mLive.yes_price ?? 0.5);

    if (pts.length === 0) {
      pts = [
        { time: 0, label: 'Início', price: liveP, priceKZ: Math.round(liveP * 100) },
        { time: 1, label: 'Atual', price: liveP, priceKZ: Math.round(liveP * 100) },
      ];
    } else if (pts.length === 1) {
      pts.push({ time: 1, label: 'Atual', price: liveP, priceKZ: Math.round(liveP * 100) });
    }

    return {
      chartPoints: pts,
      activeLegendItems: [
        {
          name: outcome === 'No' ? 'Não' : 'Sim',
          pct: Math.round(liveP * 100).toString(),
          color: outcome === 'No' ? '#ef4444' : '#2d8cff',
        },
      ],
    };
  }, [market, effectiveMarket, isMulti, topChartOutcomes, interactions?.outcomeHistory, priceHistory, realClobCandles, timeRange, outcome]);

  const candlestickData = useMemo(() => {
    if (!market) return [];
    if (!isMulti && realClobCandles.length > 0) {
      return realClobCandles.map((c, idx) => ({
        time: idx,
        label: c.time,
        open: c.open,
        close: c.close,
        high: c.high,
        low: c.low,
        isUp: c.close >= c.open,
      }));
    }
    return chartPoints.map((d, i) => {
      const open = d.priceKZ ?? Math.round((d.series_0 ?? 0.5) * 100);
      const nextRaw = i < chartPoints.length - 1 ? chartPoints[i + 1] : d;
      const close = nextRaw.priceKZ ?? Math.round((nextRaw.series_0 ?? 0.5) * 100);
      return {
        time: i,
        label: d.label || String(i),
        open,
        close: Math.max(1, Math.min(99, close)),
        high: Math.max(1, Math.min(99, Math.max(open, close))),
        low: Math.max(1, Math.min(99, Math.min(open, close))),
        isUp: close >= open,
      };
    });
  }, [market, isMulti, realClobCandles, chartPoints]);

  // Merged Holders (CPMM market_positions + CLOB + Multi-Outcome positions)
  const mergedHolders = useMemo(() => {
    const base = isMulti ? [...(interactions?.multiPositions || []), ...marketPositions] : marketPositions;
    const dedup = new Map<string, any>();
    for (const p of base) {
      const key = `${p.userId}_${p.outcome}_${p.binarySide || ''}_${p.is_lp ? 'LP' : 'TR'}`;
      if (!dedup.has(key)) dedup.set(key, p);
    }
    const list = Array.from(dedup.values()).sort((a, b) => Number(b.shares || 0) - Number(a.shares || 0));
    if (holderOutcomeFilter === 'Todos') return list;
    return list.filter((p) => String(p.outcome || '').includes(holderOutcomeFilter));
  }, [isMulti, interactions?.multiPositions, marketPositions, holderOutcomeFilter]);

  const holderUserIdsSet = useMemo(() => new Set(mergedHolders.map((h) => h.userId)), [mergedHolders]);

  // Merged Activity (Realtime market trades + global trades + CLOB executions)
  const mergedActivity = useMemo(() => {
    if (!market) return [];
    const combinedRaw = new Map<string, any>();
    for (const t of [...liveMarketTrades, ...trades.filter((x) => x.market_id === market.id)]) {
      if (!t?.id || combinedRaw.has(t.id)) continue;
      const isClobTrade = t.engine === 'CLOB_AMM';
      const rawPrice = Number(t.price || 0);
      const normalizedPriceKz = isClobTrade
        ? rawPrice > 1
          ? rawPrice / 100
          : rawPrice
        : rawPrice > 1
          ? rawPrice
          : rawPrice * 100;
      combinedRaw.set(t.id, {
        id: t.id,
        side: t.side || 'Buy',
        outcome: t.outcome || 'Yes',
        isClob: isClobTrade,
        engine: t.engine,
        amount: Number(t.amount || 0),
        shares: Number(t.shares || 0),
        price: Number(normalizedPriceKz.toFixed(2)),
        time: t.time || (t.timestamp ? formatDistanceToNow(new Date(t.timestamp), { addSuffix: true, locale: ptBR }) : '-'),
        ts: new Date(t.timestamp || 0).getTime(),
      });
    }

    const sbTrades = Array.from(combinedRaw.values());
    const clobRows = (marketExecutions || []).map((ex) => ({
      id: `exec_${ex.id}`,
      side: 'Execução',
      isClob: true,
      outcome: ex.outcome || 'Yes',
      amount: Number(((ex.notional_cents || 0) / 100).toFixed(2)),
      shares: Number(ex.quantity || 0),
      price: Number(((ex.price_cents || 50) / 100).toFixed(2)),
      time: ex.created_at ? formatDistanceToNow(new Date(ex.created_at), { addSuffix: true, locale: ptBR }) : '-',
      ts: new Date(ex.created_at || 0).getTime(),
    }));

    const seenIds = new Set(sbTrades.map((t) => t.id));
    const combined = [...sbTrades];
    for (const ex of clobRows) {
      if (!seenIds.has(ex.id) && combined.length < 40) {
        const nearMatch = sbTrades.some(
          (st) => st.isClob && Math.abs(st.ts - ex.ts) < 2500 && Math.abs(st.price - ex.price) < 0.05
        );
        if (!nearMatch) combined.push(ex);
      }
    }
    return combined.sort((a, b) => b.ts - a.ts).slice(0, 40);
  }, [market?.id, liveMarketTrades, trades, marketExecutions]);

  // Filtered & sorted comments
  const filteredComments = useMemo(() => {
    let list = [...comments];
    if (holdersOnlyComments) {
      list = list.filter((c) => holderUserIdsSet.has(c.user_id));
    }
    if (commentSort === 'liked') {
      list.sort((a, b) => {
        const la = interactions?.commentLikes?.[a.id]?.count ?? Number(a.likes || 0);
        const lb = interactions?.commentLikes?.[b.id]?.count ?? Number(b.likes || 0);
        return lb - la;
      });
    } else {
      list.sort((a, b) => new Date(b.timestamp || 0).getTime() - new Date(a.timestamp || 0).getTime());
    }
    return list;
  }, [comments, holdersOnlyComments, holderUserIdsSet, commentSort, interactions?.commentLikes]);

  // Related Markets (for right sidebar bottom card)
  const relatedMarketsData = useMemo(() => {
    if (!market) return { chips: ['Todos'], items: [] as Market[] };
    const candidateTags = Array.from(new Set([market.category, ...(market.tags || [])].filter(Boolean)));
    const chips = ['Todos', ...candidateTags.slice(0, 4)];
    const pool = markets.filter((m) => m.id !== market.id && m.status !== 'hidden' && !m.resolved);
    const filtered =
      relatedFilter === 'Todos'
        ? [
            ...pool.filter((m) => m.category === market.category),
            ...pool.filter((m) => m.category !== market.category),
          ]
        : pool.filter(
            (m) =>
              m.category === relatedFilter ||
              (Array.isArray(m.tags) && m.tags.some((t) => t.toLowerCase() === relatedFilter.toLowerCase()))
          );
    return { chips, items: filtered.slice(0, 4) };
  }, [markets, market?.id, market?.category, market?.tags, relatedFilter]);

  if (!market) {
    return (
      <div className="max-w-3xl mx-auto p-16 text-center space-y-4">
        <p className="text-[#8b949e] text-sm">Mercado não encontrado.</p>
        <Link to="/" className="inline-flex items-center gap-2 px-4 py-2 bg-[#1b222c] border border-[#28313e] rounded-xl text-xs font-semibold text-white">
          <ChevronLeft className="w-4 h-4" /> Voltar aos mercados
        </Link>
      </div>
    );
  }

  // Live CPMM Pools & Price Calculations for Trade Panel
  const livePoolYes = Number(effectiveMarket?.pool_yes) > 0 ? Number(effectiveMarket!.pool_yes) : INITIAL_LP_PAIRS;
  const livePoolNo = Number(effectiveMarket?.pool_no) > 0 ? Number(effectiveMarket!.pool_no) : INITIAL_LP_PAIRS;
  const liveVaultKz =
    Number(effectiveMarket?.liquidity_vault_kz) > 0
      ? Number(effectiveMarket!.liquidity_vault_kz)
      : ((livePoolYes + livePoolNo) / 2) * SHARE_SETTLEMENT_KZ;
  const liveSpots = getCpmmSpotPricesKz(livePoolYes, livePoolNo);

  const optionYesProb = isMulti
    ? Math.max(0.01, Math.min(0.99, Number(selectedOutcomeObj?.price || 0.5)))
    : Number(effectiveMarket?.yes_price ?? liveSpots.yesProb);
  const optionNoProb = isMulti
    ? Number((1 - optionYesProb).toFixed(4))
    : Number(effectiveMarket?.no_price ?? liveSpots.noProb);
  const activeProb = isMulti
    ? binarySide === 'Yes'
      ? optionYesProb
      : optionNoProb
    : outcome === 'No'
      ? optionNoProb
      : optionYesProb;

  const amountValue = parsePositiveFinite(amount, 1_000_000_000);
  const parsedLimitVal = Math.min(99, Math.max(0, Math.round(parsePositiveFinite(limitPrice, 99))));

  const isBinaryCpmmMarketMode = !isMulti && orderType === 'Market';
  const isBinaryClobLimitMode = !isMulti && orderType === 'Limit';
  const selectedOutcomeSide: 'Yes' | 'No' = outcome === 'No' ? 'No' : 'Yes';
  const currentSpotPriceKz = isBinaryCpmmMarketMode
    ? selectedOutcomeSide === 'Yes'
      ? Number(effectiveMarket?.yes_price_kz || liveSpots.yesPriceKz)
      : Number(effectiveMarket?.no_price_kz || liveSpots.noPriceKz)
    : Number((activeProb * 100).toFixed(2));

  const cpmmBuyQuote = useMemo(() => {
    if (!isBinaryCpmmMarketMode || !isBuying) return null;
    return quoteCpmmBuy({
      poolYes: livePoolYes,
      poolNo: livePoolNo,
      outcome: selectedOutcomeSide,
      grossAmountKz: amountValue,
    });
  }, [isBinaryCpmmMarketMode, isBuying, livePoolYes, livePoolNo, selectedOutcomeSide, amountValue]);

  const cpmmSellQuote = useMemo(() => {
    if (!isBinaryCpmmMarketMode || isBuying) return null;
    return quoteCpmmSell({
      poolYes: livePoolYes,
      poolNo: livePoolNo,
      outcome: selectedOutcomeSide,
      sharesToSell: amountValue,
    });
  }, [isBinaryCpmmMarketMode, isBuying, livePoolYes, livePoolNo, selectedOutcomeSide, amountValue]);

  const avgExecPriceKz = isBinaryCpmmMarketMode
    ? isBuying
      ? cpmmBuyQuote?.avgExecPriceKz || currentSpotPriceKz
      : cpmmSellQuote?.avgExecPriceKz || currentSpotPriceKz
    : isBinaryClobLimitMode
      ? clobQuote?.avgPriceCents
        ? Number(clobQuote.avgPriceCents) / 100
        : parsedLimitVal > 0
          ? parsedLimitVal / 100
          : activeProb
      : activeProb * 100;

  const estimatedShares = isBinaryCpmmMarketMode
    ? isBuying
      ? cpmmBuyQuote?.sharesReceived || 0
      : amountValue
    : isBinaryClobLimitMode && clobQuote
      ? clobQuote.executableShares
      : isBinaryClobLimitMode
        ? isBuying
          ? avgExecPriceKz > 0
            ? Math.floor((amountValue * 0.99) / avgExecPriceKz)
            : 0
          : Math.floor(amountValue)
        : isBuying
          ? avgExecPriceKz > 0
            ? (amountValue * 0.99) / (avgExecPriceKz / 100)
            : 0
          : amountValue;

  const estimatedFeeKz = isBinaryCpmmMarketMode
    ? isBuying
      ? cpmmBuyQuote?.feeKz || 0
      : cpmmSellQuote?.feeKz || 0
    : isBinaryClobLimitMode && clobQuote
      ? (clobQuote.estimatedFeeCents || 0) / 100
      : isBinaryClobLimitMode
        ? isBuying
          ? amountValue * 0.01
          : estimatedShares * avgExecPriceKz * 0.01
        : isBuying
          ? amountValue * 0.01
          : estimatedShares * (avgExecPriceKz / 100) * 0.01;

  const estimatedTotalCostKz = isBinaryCpmmMarketMode
    ? amountValue
    : isBinaryClobLimitMode && clobQuote
      ? (clobQuote.estimatedTotalCents || 0) / 100
      : amountValue;

  const potentialReturnKz = isBinaryCpmmMarketMode
    ? isBuying
      ? cpmmBuyQuote?.netPayoutIfWinKz || 0
      : cpmmSellQuote?.netReturnKz || 0
    : isBinaryClobLimitMode
      ? isBuying
        ? estimatedShares * 1.0 * (1 - WITHDRAWAL_FEE_RATE)
        : Math.max(0, estimatedShares * avgExecPriceKz * 0.99)
      : isBuying
        ? estimatedShares * SHARE_SETTLEMENT_KZ * (1 - WITHDRAWAL_FEE_RATE)
        : Math.max(0, estimatedShares * (avgExecPriceKz / 100) * 0.99);

  // Resolved Metadata & Context strings
  const effectiveDescription =
    interactions?.metadata?.description_override ||
    market.description ||
    `Este mercado resolve com base em fontes públicas oficiais para: ${market.question}`;
  const effectiveAdditionalContext =
    interactions?.metadata?.additional_context || market.additional_context || '';
  const effectiveContextUpdatedAt =
    interactions?.metadata?.additional_context_updated_at ||
    market.additional_context_updated_at ||
    market.created_at;
  const effectiveResolverName =
    interactions?.metadata?.resolver_name || market.resolver_name || 'MarketPay Oracle';
  const effectiveResolverAddress =
    interactions?.metadata?.resolver_address || market.resolver_address || `mp_${market.id.slice(0, 12)}`;

  // Dynamic FAQs + DB custom FAQs
  const combinedFaqs = [
    ...(interactions?.faqs || []).map((f) => ({ id: f.id, question: f.question, answer: f.answer })),
    {
      id: 'faq-1',
      question: 'Como funciona a negociação neste mercado?',
      answer: isMulti
        ? `Este mercado multi-opção permite comprar ou vender quotas de "Sim" ou "Não" em cada candidato/opção (${market.outcomes?.map((o) => o.name).slice(0, 4).join(', ')}). A soma das probabilidades reflete o consenso em tempo real do mercado.`
        : 'Pode comprar ou vender shares de "Sim" ou "Não" instantaneamente contra o pool AMM CPMM (x · y = k) com proteção de slippage e bloqueio atómico de concorrência, ou publicar ordens no Livro de Ordens (Limite). O preço oscila entre 1,00 KZ e 99,00 KZ conforme a probabilidade implícita.',
    },
    {
      id: 'faq-2',
      question: 'Quando posso levantar ou encerrar a minha posição?',
      answer: `Pode vender as suas shares a qualquer momento antes do encerramento (${new Date(market.end_date).toLocaleDateString('pt-AO')}) diretamente ao pool AMM ao preço corrente, ou aguardar a resolução final.`,
    },
    {
      id: 'faq-3',
      question: 'Quanto paga cada share vencedora na resolução?',
      answer:
        'Cada share vencedora vale exatamente 100,00 KZ brutos na liquidação (e shares perdedoras valem 0,00 KZ). Na liquidação automática é aplicada a taxa de levantamento de 1% (99,00 KZ líquidos creditados por share diretamente na carteira).',
    },
    {
      id: 'faq-4',
      question: 'Quais são as taxas aplicadas pela MarketPay?',
      answer: 'A comissão operacional padrão é de 1,00% sobre compras, vendas e levantamentos/liquidação de prémios, exibida de forma transparente antes de confirmar.',
    },
  ];
  const visibleFaqs = showAllFaqs ? combinedFaqs : combinedFaqs.slice(0, 4);

  // Handlers
  const handleSelectMultiOutcome = (name: string, side: 'Yes' | 'No') => {
    setOutcome(name);
    setBinarySide(side);
    setIsBuying(true);
    setLastTradeSuccess(null);
    if (window.innerWidth < 1024 && tradePanelRef.current) {
      tradePanelRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    setTimeout(() => amountInputRef.current?.focus(), 120);
  };

  const handleToggleBookmark = async () => {
    if (!user) {
      addToast('Inicie sessão para guardar mercados nos favoritos.', 'info');
      navigate('/login');
      return;
    }
    setBookmarkLoading(true);
    try {
      const res = await ammApi.toggleMarketBookmark(market.id);
      setInteractions((prev) =>
        prev ? { ...prev, bookmarked: res.bookmarked, bookmarkCount: res.bookmarkCount } : prev
      );
      addToast(res.bookmarked ? 'Mercado guardado nos favoritos.' : 'Mercado removido dos favoritos.', 'success');
    } catch (err: any) {
      addToast(err?.message || 'Erro ao guardar favorito.', 'error');
    } finally {
      setBookmarkLoading(false);
    }
  };

  const handleAddComment = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!user) {
      addToast('Inicie sessão para publicar um comentário.', 'info');
      navigate('/login');
      return;
    }
    if (submittingComment) return;
    const cleanText = sanitizePlainText(newComment, 1000);
    if (!cleanText) {
      addToast('Escreva um comentário válido antes de publicar.', 'error');
      return;
    }
    const targetMarketId = market.id;
    const myHeld = mergedHolders.find((h) => h.userId === user.id);
    const tagStr = myHeld
      ? sanitizePlainText(
          `${Math.round(myHeld.shares)} ${myHeld.outcome === 'Yes' ? 'Sim' : myHeld.outcome === 'No' ? 'Não' : myHeld.outcome}`,
          48
        )
      : null;
    const safeUserName = sanitizePlainText(user.name, 80) || `Trader #${String(user.id).slice(0, 6)}`;
    setSubmittingComment(true);
    try {
      const created = await firebaseService.addComment(targetMarketId, user.id, safeUserName, cleanText, {
        userAvatar: sanitizeHttpUrl(user.avatar_url) || null,
        outcomeTag: tagStr,
        parentId: replyingToId,
      });
      if (created && activeMarketIdRef.current === targetMarketId) {
        setComments((prev) => [created, ...prev.filter((c) => c.id !== created.id)]);
      }
      setNewComment('');
      setReplyingToId(null);
      addToast('Comentário publicado na base de dados.', 'success');
    } catch (err: any) {
      addToast(err?.message || 'Erro ao publicar comentário.', 'error');
    } finally {
      if (isMountedRef.current) setSubmittingComment(false);
    }
  };

  const handleToggleLike = async (commentId: string) => {
    if (!user) {
      addToast('Inicie sessão para gostar de comentários.', 'info');
      navigate('/login');
      return;
    }
    try {
      const res = await ammApi.toggleCommentLike(market.id, commentId);
      setInteractions((prev) =>
        prev
          ? {
              ...prev,
              commentLikes: {
                ...prev.commentLikes,
                [commentId]: { count: res.count, likedByMe: res.liked },
              },
            }
          : prev
      );
    } catch (err: any) {
      addToast(err?.message || 'Erro ao reagir ao comentário.', 'error');
    }
  };

  const handleDeleteComment = async (commentId: string) => {
    try {
      await ammApi.deleteMarketComment(market.id, commentId);
      setComments((prev) => prev.filter((c) => c.id !== commentId));
      addToast('Comentário removido.', 'success');
    } catch (err: any) {
      addToast(err?.message || 'Erro ao apagar comentário.', 'error');
    }
  };

  const handleSaveMetadata = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingMetadata(true);
    try {
      await ammApi.updateMarketMetadata(market.id, {
        additionalContext: sanitizePlainText(editContextText, 2000),
        description: sanitizePlainText(editDescriptionText, 2000),
        resolverName: sanitizePlainText(editResolverName, 80),
        resolverAddress: sanitizePlainText(editResolverAddress, 120),
      });
      await refreshInteractions();
      await onRefreshAll?.();
      setShowEditMetadata(false);
      addToast('Regras e contexto atualizados na base de dados.', 'success');
    } catch (err: any) {
      addToast(err?.message || 'Erro ao atualizar regras.', 'error');
    } finally {
      setSavingMetadata(false);
    }
  };

  const handleSubmitProposal = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) {
      addToast('Inicie sessão para propor uma resolução.', 'info');
      navigate('/login');
      return;
    }
    const trimmedEvidence = proposalEvidence.trim();
    const safeEvidenceUrl = trimmedEvidence ? sanitizeHttpUrl(trimmedEvidence) : '';
    if (trimmedEvidence && !safeEvidenceUrl) {
      addToast('O link de comprovação deve começar por http:// ou https://.', 'error');
      return;
    }
    const safeRationale = sanitizePlainText(proposalRationale, 1500);
    if (!safeRationale) {
      addToast('Insira uma fundamentação oficial válida.', 'error');
      return;
    }
    setSubmittingProposal(true);
    try {
      await ammApi.submitResolutionProposal(market.id, {
        proposedOutcome: sanitizePlainText(proposalOutcome || (isMulti ? market.outcomes?.[0]?.name || 'Sim' : 'Sim'), 80),
        evidenceUrl: safeEvidenceUrl || '',
        rationale: safeRationale,
      });
      await refreshInteractions();
      setShowProposalForm(false);
      setProposalRationale('');
      setProposalEvidence('');
      addToast('Proposta de resolução submetida para validação.', 'success');
    } catch (err: any) {
      addToast(err?.message || 'Erro ao enviar proposta.', 'error');
    } finally {
      setSubmittingProposal(false);
    }
  };

  const handleAddFaq = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanQ = sanitizePlainText(newFaqQuestion, 300);
    const cleanA = sanitizePlainText(newFaqAnswer, 1500);
    if (!cleanQ || !cleanA) {
      addToast('Preencha a pergunta e resposta com texto válido.', 'error');
      return;
    }
    try {
      await ammApi.addMarketFaq(market.id, { question: cleanQ, answer: cleanA });
      await refreshInteractions();
      setNewFaqQuestion('');
      setNewFaqAnswer('');
      setShowAddFaq(false);
      addToast('Pergunta frequente guardada na base de dados.', 'success');
    } catch (err: any) {
      addToast(err?.message || 'Erro ao adicionar FAQ.', 'error');
    }
  };

  const handleDeleteFaq = async (faqId: string) => {
    try {
      await ammApi.deleteMarketFaq(market.id, faqId);
      await refreshInteractions();
      addToast('Pergunta frequente removida.', 'success');
    } catch (err: any) {
      addToast(err?.message || 'Erro ao remover FAQ.', 'error');
    }
  };

  const handleReviewProposal = async (proposalId: string, status: 'accepted' | 'rejected') => {
    try {
      await ammApi.reviewResolutionProposal(market.id, proposalId, status);
      await refreshInteractions();
      addToast(status === 'accepted' ? 'Proposta marcada como aceite.' : 'Proposta rejeitada.', 'success');
    } catch (err: any) {
      addToast(err?.message || 'Erro ao atualizar proposta.', 'error');
    }
  };

  const handleExecuteTrade = async () => {
    if (!user) {
      navigate('/login');
      return;
    }
    if (market.resolved) {
      addToast('Este mercado já está resolvido.', 'error');
      return;
    }
    if (isTradingBlocked) {
      addToast('Este mercado encontra-se temporariamente bloqueado.', 'error');
      return;
    }

    if (isMulti) {
      if (!selectedOutcomeObj) {
        addToast('Selecione uma opção válida do mercado.', 'error');
        return;
      }
      if (isBuying && user.balance < amountValue) {
        addToast('Saldo insuficiente. Redirecionando para Depósitos...', 'info');
        navigate('/profile?tab=deposit');
        return;
      }
      if (!isBuying && (!userPosition || userPosition.shares < amountValue)) {
        addToast(`Quotas insuficientes para vender (${userPosition?.shares?.toFixed(2) || 0} disponíveis).`, 'error');
        return;
      }
      setIsPending(true);
      try {
        const res = await ammApi.placeMultiOutcomeTrade(market.id, {
          outcomeName: selectedOutcomeObj.name,
          side: isBuying ? 'Buy' : 'Sell',
          binarySide,
          amountKz: isBuying ? amountValue : undefined,
          shares: !isBuying ? amountValue : undefined,
        });
        if (res.balanceKz !== undefined && Number.isFinite(Number(res.balanceKz))) {
          onBalanceUpdate?.(Number(res.balanceKz));
        }
        setLastTradeSuccess({
          outcome: `${res.outcomeName} (${res.binarySide === 'Yes' ? 'Sim' : 'Não'})`,
          amount: isBuying ? amountValue : res.grossNotionalKz,
          shares: res.filledShares,
          side: isBuying ? 'Compra' : 'Venda',
          price: res.execPrice,
        });
        addToast('Ordem multi-opção executada e registada!', 'success');
        setClobVersion((v) => v + 1);
        await Promise.all([refreshInteractions(), onRefreshAll?.()]);
      } catch (err: any) {
        addToast(err?.message || 'Erro ao executar negócio multi-opção.', 'error');
      } finally {
        setIsPending(false);
      }
      return;
    }

    // Binary Limit Order (preserves CLOB Limit Book)
    if (orderType === 'Limit') {
      const parsedLimit = Math.round(parsePositiveFinite(limitPrice, 99));
      if (!parsedLimit || parsedLimit < 1 || parsedLimit > 99) {
        addToast('Insira um preço limite válido entre 1 e 99 centavos (0,01–0,99 Kz).', 'error');
        return;
      }
      if (isBuying && user.balance < amountValue) {
        addToast('Saldo insuficiente. Redirecionando para Depósitos...', 'info');
        navigate('/profile?tab=deposit');
        return;
      }
      if (!isBuying) {
        const sellQty = Math.floor(amountValue);
        if (sellQty <= 0 || !userPosition || userPosition.shares < sellQty) {
          addToast(`Quotas insuficientes para vender (${userPosition?.shares || 0} disponíveis).`, 'error');
          return;
        }
      }
      setIsPending(true);
      try {
        const qty = isBuying ? Math.floor((amountValue * 100) / (parsedLimit * 1.01)) : Math.floor(amountValue);
        if (qty <= 0) {
          throw new Error('Montante insuficiente para 1 quota neste preço limite.');
        }
        const clobRes = await ammApi.placeClobOrder({
          marketId: market.id,
          side: isBuying ? 'Buy' : 'Sell',
          outcome: outcome as 'Yes' | 'No',
          orderType: 'LIMIT',
          priceCents: parsedLimit,
          quantity: qty,
        });
        addToast(
          clobRes.filledQuantity > 0
            ? `Ordem CLOB processada: ${clobRes.filledQuantity} quotas executadas.`
            : `Ordem Limite registada (${qty} quotas @ ${formatKz(parsedLimit / 100)}).`,
          'success'
        );
        setClobVersion((v) => v + 1);
        await refreshClobData();
        await onRefreshAll?.();
      } catch (err: any) {
        addToast(err?.message || 'Erro ao registar ordem limite.', 'error');
      } finally {
        setIsPending(false);
      }
      return;
    }

    // Binary Market Execution via CPMM AMM (x * y = k) com FOR UPDATE + Slippage Shield + Idempotência
    if (isBuying) {
      if (amountValue < 1) {
        addToast('O montante mínimo de compra é 1,00 KZ.', 'error');
        return;
      }
      if (user.balance < amountValue) {
        addToast('Saldo insuficiente. Redirecionando para Depósitos...', 'info');
        navigate('/profile?tab=deposit');
        return;
      }
    } else {
      if (amountValue <= 0 || !userPosition || userPosition.shares + 0.0001 < amountValue) {
        addToast(
          `Shares insuficientes para vender (${(userPosition?.shares || 0).toFixed(2)} disponíveis).`,
          'error'
        );
        return;
      }
    }

    if (!pendingIdempotencyKeyRef.current) {
      pendingIdempotencyKeyRef.current =
        typeof crypto !== 'undefined' && crypto.randomUUID
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }
    const idempotencyKey = pendingIdempotencyKeyRef.current;

    setIsPending(true);
    setPriceChangedAlert(null);

    try {
      if (isBuying) {
        const res = await ammApi.cpmmBuyShares({
          marketId: market.id,
          outcome: selectedOutcomeSide,
          grossAmountKz: amountValue,
          expectedPriceKz: currentSpotPriceKz,
          maxSlippagePct,
          idempotencyKey,
        });
        pendingIdempotencyKeyRef.current = null;

        const updatedBalance = res.new_balance_kz ?? res.new_balance;
        if (updatedBalance !== undefined && updatedBalance !== null && Number.isFinite(Number(updatedBalance))) {
          onBalanceUpdate?.(Number(updatedBalance));
        }

        setLiveMarketPatch((prev) => ({
          ...(prev || {}),
          id: market.id,
          pool_yes: Number(res.pool_yes ?? livePoolYes),
          pool_no: Number(res.pool_no ?? livePoolNo),
          yes_price_kz: Number(res.yes_price_kz ?? liveSpots.yesPriceKz),
          no_price_kz: Number(res.no_price_kz ?? liveSpots.noPriceKz),
          yes_price: Number((res.yes_price_kz ?? liveSpots.yesPriceKz) / 100),
          no_price: Number((res.no_price_kz ?? liveSpots.noPriceKz) / 100),
          liquidity_vault_kz: Number(res.liquidity_vault_kz ?? liveVaultKz),
        }));

        const sharesOut = Number(res.shares_received || 0);
        setLastTradeSuccess({
          outcome: selectedOutcomeSide === 'Yes' ? 'Sim' : 'Não',
          amount: Number(res.gross_amount_kz ?? amountValue),
          shares: sharesOut,
          side: 'Compra',
          price: Number(res.avg_exec_price_kz ?? avgExecPriceKz),
          fee: Number(res.fee_kz ?? estimatedFeeKz),
          grossWinKz: sharesOut * SHARE_SETTLEMENT_KZ,
          netWinKz: sharesOut * SHARE_SETTLEMENT_KZ * (1 - WITHDRAWAL_FEE_RATE),
        });
        addToast(
          `Compra executada: +${sharesOut.toFixed(2)} shares @ ${Number(res.avg_exec_price_kz || currentSpotPriceKz).toFixed(2)} KZ`,
          'success'
        );
      } else {
        const sellQty = Math.min(amountValue, userPosition?.shares || amountValue);
        const res = await ammApi.cpmmSellShares({
          marketId: market.id,
          outcome: selectedOutcomeSide,
          sharesToSell: sellQty,
          expectedPriceKz: currentSpotPriceKz,
          maxSlippagePct,
          idempotencyKey,
        });
        pendingIdempotencyKeyRef.current = null;

        const updatedBalance = res.new_balance_kz ?? res.new_balance;
        if (updatedBalance !== undefined && updatedBalance !== null && Number.isFinite(Number(updatedBalance))) {
          onBalanceUpdate?.(Number(updatedBalance));
        }

        setLiveMarketPatch((prev) => ({
          ...(prev || {}),
          id: market.id,
          pool_yes: Number(res.pool_yes ?? livePoolYes),
          pool_no: Number(res.pool_no ?? livePoolNo),
          yes_price_kz: Number(res.yes_price_kz ?? liveSpots.yesPriceKz),
          no_price_kz: Number(res.no_price_kz ?? liveSpots.noPriceKz),
          yes_price: Number((res.yes_price_kz ?? liveSpots.yesPriceKz) / 100),
          no_price: Number((res.no_price_kz ?? liveSpots.noPriceKz) / 100),
          liquidity_vault_kz: Number(res.liquidity_vault_kz ?? liveVaultKz),
        }));

        setLastTradeSuccess({
          outcome: selectedOutcomeSide === 'Yes' ? 'Sim' : 'Não',
          amount: Number(res.net_return_kz || 0),
          shares: Number(res.shares_sold || sellQty),
          side: 'Venda',
          price: Number(res.avg_exec_price_kz ?? avgExecPriceKz),
          fee: Number(res.fee_kz ?? estimatedFeeKz),
        });
        addToast(
          `Venda executada: +${Number(res.net_return_kz || 0).toFixed(2)} KZ líquidos creditados.`,
          'success'
        );
      }

      setClobVersion((v) => v + 1);
      await refreshClobData();
      await onRefreshAll?.();
    } catch (err: any) {
      if (err?.isPriceChanged || err?.code === 'PRICE_CHANGED' || String(err?.message || '').includes('PRICE_CHANGED')) {
        // Limpar idempotencyKey para que o utilizador possa confirmar explicitamente a nova cotação
        pendingIdempotencyKeyRef.current = null;
        const freshMarket = await firebaseService.getMarket(market.id).catch(() => null);
        if (freshMarket) setLiveMarketPatch(freshMarket);

        const oldP = Number(err?.expectedPrice ?? currentSpotPriceKz);
        const newP = Number(
          err?.currentPrice ??
            (freshMarket
              ? selectedOutcomeSide === 'Yes'
                ? Number(freshMarket.yes_price_kz || (freshMarket.yes_price || 0.5) * 100)
                : Number(freshMarket.no_price_kz || (freshMarket.no_price || 0.5) * 100)
              : currentSpotPriceKz)
        );
        setPriceChangedAlert({
          oldPrice: oldP,
          newPrice: newP,
          message: err?.message || `O preço mudou de ${oldP.toFixed(2)} KZ para ${newP.toFixed(2)} KZ. Confirme a nova cotação.`,
        });
        addToast('Cotação atualizada por slippage. Confirme o novo preço no painel.', 'info');
      } else {
        pendingIdempotencyKeyRef.current = null;
        addToast(err?.message || 'Erro ao executar negócio.', 'error');
      }
    } finally {
      setIsPending(false);
    }
  };

  const activeCategoryTabs = categories
    .filter((c) => c.status !== 'hidden' && c.status !== 'blocked')
    .map((c) => c.name);
  const subNavTabs = ['Trending', 'Novo', ...(activeCategoryTabs.length ? activeCategoryTabs : ['Finanças', 'Política', 'Desporto', 'Crypto', 'Tech'])];

  return (
    <div className="min-h-screen bg-[#14191f] text-[#f0f6fc]">
      {/* Top Sub-Category Strip (matching screenshot) */}
      <div className="border-b border-[#232b36] bg-[#12171d]">
        <div className="max-w-[1240px] mx-auto px-4 sm:px-6 lg:px-8 h-11 flex items-center gap-5 overflow-x-auto no-scrollbar text-[13px]">
          <Link
            to="/"
            className="text-[#8b96a6] hover:text-white inline-flex items-center gap-1 whitespace-nowrap shrink-0"
          >
            <ChevronLeft className="w-3.5 h-3.5" /> Mercados
          </Link>
          <span className="text-[#2c3644] shrink-0">|</span>
          {subNavTabs.map((tab) => {
            const isCurrent = tab.toLowerCase() === (market.category || '').toLowerCase();
            return (
              <button
                key={tab}
                type="button"
                onClick={() => navigate(tab === 'Trending' || tab === 'Novo' ? '/' : `/?category=${encodeURIComponent(tab)}`)}
                className={cx(
                  'whitespace-nowrap shrink-0 transition-colors py-2',
                  isCurrent ? 'text-white font-semibold' : 'text-[#8b96a6] hover:text-white font-medium'
                )}
              >
                {tab}
              </button>
            );
          })}
        </div>
      </div>

      {/* Main 2-Column Workspace */}
      <div className="max-w-[1240px] mx-auto px-4 sm:px-6 lg:px-8 py-7">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
          {/* LEFT COLUMN (Market Header + Chart + Outcomes + Rules + Community + FAQ) */}
          <div className="lg:col-span-8 space-y-6">
            {/* Market Header */}
            <div className="flex items-start justify-between gap-4">
              <div className="flex items-start gap-3.5 min-w-0">
                <LocalThumb
                  src={market.image_url}
                  alt={market.question}
                  isCrypto={isCrypto}
                  className="w-12 h-12 rounded-xl"
                />
                <div className="min-w-0 space-y-1">
                  <div className="text-xs text-[#8b96a6] font-medium flex flex-wrap items-center gap-1.5">
                    <span>{market.category}</span>
                    {market.tags?.length > 0 && (
                      <>
                        <span className="opacity-50">·</span>
                        <span>{market.tags[0]}</span>
                      </>
                    )}
                    {(effectiveMarket?.resolved ?? market.resolved) && (
                      <>
                        <span className="opacity-50">·</span>
                        <span className="text-[#3dd68c] font-semibold">
                          Resolvido: {(effectiveMarket?.resolution_outcome ?? market.resolution_outcome) === 'Yes' ? 'Sim' : (effectiveMarket?.resolution_outcome ?? market.resolution_outcome) === 'No' ? 'Não' : (effectiveMarket?.resolution_outcome ?? market.resolution_outcome)}
                        </span>
                      </>
                    )}
                  </div>
                  <h1 className="text-xl sm:text-2xl font-bold text-white leading-snug tracking-tight">
                    {market.question}
                  </h1>
                </div>
              </div>

              {/* Right Action Icons: Embed </>, Copy Link, Bookmark */}
              <div className="flex items-center gap-1.5 shrink-0 pt-1">
                <button
                  type="button"
                  onClick={() => setShowEmbedModal(true)}
                  className="p-2 rounded-lg text-[#8b96a6] hover:text-white hover:bg-[#1e2631] transition-colors"
                  title="Incorporar mercado"
                >
                  <Code className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  onClick={() => {
                    navigator.clipboard?.writeText(window.location.href).catch(() => {});
                    addToast('Link copiado para a área de transferência.', 'success');
                  }}
                  className="p-2 rounded-lg text-[#8b96a6] hover:text-white hover:bg-[#1e2631] transition-colors"
                  title="Copiar ligação"
                >
                  <Link2 className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  onClick={handleToggleBookmark}
                  disabled={bookmarkLoading}
                  className={cx(
                    'p-2 rounded-lg transition-colors flex items-center gap-1',
                    interactions?.bookmarked
                      ? 'text-[#2d8cff] bg-[#1e2631]'
                      : 'text-[#8b96a6] hover:text-white hover:bg-[#1e2631]'
                  )}
                  title={interactions?.bookmarked ? 'Remover dos favoritos' : 'Guardar mercado'}
                >
                  <Bookmark className={cx('w-4 h-4', interactions?.bookmarked && 'fill-current')} />
                </button>
              </div>
            </div>

            {/* Chart Block (Frameless / Seamless Polymarket style) */}
            {market.showGraph !== false && market.graphType !== 'none' && (
              <div className="space-y-3">
                {/* Chart Legend Header */}
                {showLegend && (
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs">
                      {activeLegendItems.map((item) => (
                        <div key={item.name} className="flex items-center gap-1.5">
                          <span
                            className="w-2 h-2 rounded-full shrink-0"
                            style={{ backgroundColor: item.color }}
                          />
                          <span className="text-[#9aa8b8] font-medium">{item.name}</span>
                          <span className="text-white font-semibold tabular-nums">{item.pct}%</span>
                        </div>
                      ))}
                    </div>
                    <span className="text-xs font-semibold text-[#5b6675] tracking-tight select-none">
                      MarketPay
                    </span>
                  </div>
                )}

                {/* Chart Canvas */}
                <div className="h-[300px] w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    {chartType === 'candlestick' ? (
                      <BarChart data={candlestickData} margin={{ top: 10, right: 48, left: 0, bottom: 5 }}>
                        {showGridLines && (
                          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#242c37" />
                        )}
                        <XAxis
                          dataKey="label"
                          axisLine={false}
                          tickLine={false}
                          tick={{ fill: '#6e7b8b', fontSize: 11 }}
                          minTickGap={30}
                        />
                        <YAxis
                          orientation="right"
                          domain={[0, 100]}
                          axisLine={false}
                          tickLine={false}
                          tick={{ fill: '#6e7b8b', fontSize: 11 }}
                          tickFormatter={(val) => `${val} KZ`}
                          width={48}
                        />
                        <Tooltip
                          content={(props: any) => {
                            const { active, payload } = props;
                            if (active && payload && payload.length) {
                              const d = payload[0].payload;
                              return (
                                <div className="bg-[#1b222c] border border-[#2d3745] px-3 py-2 rounded-xl shadow-xl text-xs font-mono space-y-0.5">
                                  <div className="text-[#8b96a6]">{d.label}</div>
                                  <div className="text-white">Abertura: {d.open} KZ</div>
                                  <div className="text-[#3dd68c]">Máxima: {d.high} KZ</div>
                                  <div className="text-[#f87171]">Mínima: {d.low} KZ</div>
                                  <div className="text-white font-semibold">Fecho: {d.close} KZ</div>
                                </div>
                              );
                            }
                            return null;
                          }}
                        />
                        <Bar dataKey="close" shape={(props: any) => <CandlestickComponent {...props} />}>
                          {candlestickData.map((entry, idx) => (
                            <Cell key={`cell-${idx}`} fill={entry.isUp ? '#16a34a' : '#dc2626'} />
                          ))}
                        </Bar>
                        {candlestickData.length > 0 && (
                          <ReferenceLine
                            y={candlestickData[candlestickData.length - 1].close}
                            stroke="#2d8cff"
                            strokeDasharray="3 3"
                          />
                        )}
                      </BarChart>
                    ) : (
                      <LineChart data={chartPoints} margin={{ top: 10, right: 44, left: 0, bottom: 5 }}>
                        {showGridLines && (
                          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#242c37" />
                        )}
                        <XAxis
                          dataKey="label"
                          axisLine={false}
                          tickLine={false}
                          tick={{ fill: '#6e7b8b', fontSize: 11 }}
                          minTickGap={35}
                        />
                        <YAxis
                          orientation="right"
                          domain={chartType === 'price' && !isMulti ? [0, 100] : [0, 'auto']}
                          axisLine={false}
                          tickLine={false}
                          tick={{ fill: '#6e7b8b', fontSize: 11 }}
                          tickFormatter={(val) =>
                            !isMulti && chartType === 'price'
                              ? `${Math.round(val)} KZ`
                              : `${Math.round(Number(val) * 100)}%`
                          }
                          width={44}
                        />
                        <Tooltip
                          content={(props: any) => {
                            const { active, payload, label } = props;
                            if (active && payload && payload.length) {
                              return (
                                <div className="bg-[#1b222c] border border-[#2d3745] px-3 py-2.5 rounded-xl shadow-xl text-xs space-y-1">
                                  <div className="text-[#8b96a6] font-medium mb-1">{label}</div>
                                  {payload.map((p: any, i: number) => (
                                    <div key={i} className="flex items-center justify-between gap-4 tabular-nums">
                                      <span className="flex items-center gap-1.5 text-white">
                                        <span className="w-2 h-2 rounded-full" style={{ backgroundColor: p.color }} />
                                        {p.name}
                                      </span>
                                      <span className="font-semibold text-white">
                                        {!isMulti && chartType === 'price'
                                          ? `${Math.round(Number(p.value || 0))} KZ`
                                          : `${(Number(p.value || 0) * 100).toFixed(1)}%`}
                                      </span>
                                    </div>
                                  ))}
                                </div>
                              );
                            }
                            return null;
                          }}
                        />
                        {isMulti ? (
                          topChartOutcomes.map((o, idx) => (
                            <Line
                              key={o.id || o.name}
                              type="monotone"
                              dataKey={`series_${idx}`}
                              name={o.name}
                              stroke={SERIES_COLORS[idx % SERIES_COLORS.length]}
                              strokeWidth={2}
                              dot={false}
                              activeDot={{ r: 4 }}
                            />
                          ))
                        ) : (
                          <Line
                            type="monotone"
                            dataKey={chartType === 'price' ? 'priceKZ' : 'price'}
                            name={outcome === 'No' ? 'Não' : 'Sim'}
                            stroke={outcome === 'No' ? '#ef4444' : '#2d8cff'}
                            strokeWidth={2.2}
                            dot={false}
                            activeDot={{ r: 4 }}
                          />
                        )}
                      </LineChart>
                    )}
                  </ResponsiveContainer>
                </div>

                {/* Volume + End Date + Timeframes + Settings Row */}
                <div className="flex flex-wrap items-center justify-between gap-3 pt-1 pb-2 border-b border-[#242c37]">
                  <div className="flex items-center gap-2 text-xs text-[#8b96a6] tabular-nums">
                    <span className="font-semibold text-[#c5d0de]">
                      {Number(effectiveMarket?.volume ?? market.volume ?? 0).toLocaleString('pt-AO', { maximumFractionDigits: 2 })} KZ Vol.
                    </span>
                    <span className="opacity-40">·</span>
                    <span>
                      {market.end_date
                        ? new Date(market.end_date).toLocaleDateString('pt-AO', {
                            day: '2-digit',
                            month: 'short',
                            year: 'numeric',
                          })
                        : '—'}
                    </span>
                  </div>

                  <div className="flex items-center gap-1 relative">
                    {(['1H', '6H', '1D', '1W', '1M', 'TUDO'] as const).map((range) => (
                      <button
                        key={range}
                        type="button"
                        onClick={() => setTimeRange(range)}
                        className={cx(
                          'px-2.5 py-1 rounded-md text-xs font-semibold transition-colors whitespace-nowrap',
                          timeRange === range
                            ? 'bg-[#263140] text-white'
                            : 'text-[#8b96a6] hover:text-white'
                        )}
                      >
                        {range === 'TUDO' ? 'ALL' : range}
                      </button>
                    ))}
                    <button
                      type="button"
                      onClick={() => setShowChartSettings((s) => !s)}
                      className="ml-1 p-1.5 rounded-md text-[#8b96a6] hover:text-white hover:bg-[#1e2631] transition-colors"
                      title="Definições do gráfico"
                    >
                      <SlidersHorizontal className="w-3.5 h-3.5" />
                    </button>

                    {showChartSettings && (
                      <div className="absolute right-0 bottom-9 z-30 w-52 bg-[#1b222c] border border-[#2d3745] rounded-xl shadow-2xl p-3 space-y-2.5 text-xs">
                        <div className="font-semibold text-white">Vista do Gráfico</div>
                        <div className="grid grid-cols-3 gap-1 bg-[#14191f] p-1 rounded-lg">
                          {[
                            { id: 'probability', label: '%' },
                            { id: 'price', label: 'KZ' },
                            { id: 'candlestick', label: 'Velas' },
                          ].map((opt) => (
                            <button
                              key={opt.id}
                              type="button"
                              onClick={() => setChartType(opt.id as any)}
                              className={cx(
                                'py-1 rounded text-[11px] font-semibold',
                                chartType === opt.id ? 'bg-[#2d8cff] text-white' : 'text-[#8b96a6] hover:text-white'
                              )}
                            >
                              {opt.label}
                            </button>
                          ))}
                        </div>
                        <label className="flex items-center justify-between text-[#c5d0de] cursor-pointer">
                          <span>Linhas da grelha</span>
                          <input
                            type="checkbox"
                            checked={showGridLines}
                            onChange={(e) => setShowGridLines(e.target.checked)}
                            className="accent-[#2d8cff]"
                          />
                        </label>
                        <label className="flex items-center justify-between text-[#c5d0de] cursor-pointer">
                          <span>Legenda superior</span>
                          <input
                            type="checkbox"
                            checked={showLegend}
                            onChange={(e) => setShowLegend(e.target.checked)}
                            className="accent-[#2d8cff]"
                          />
                        </label>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* Expired / Admin Resolution Banner */}
            {(() => {
              const isExpired = market.end_date ? new Date(market.end_date).getTime() <= Date.now() : false;
              if (!isExpired || market.resolved) return null;

              if (user?.is_admin) {
                return (
                  <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-5 space-y-3">
                    <div>
                      <h4 className="text-sm font-bold text-amber-400">Resolução de Administrador</h4>
                      <p className="text-xs text-[#8b96a6] mt-0.5">
                        Este mercado expirou. Indique o motivo oficial e selecione o resultado vencedor para liquidar as posições.
                      </p>
                    </div>
                    <input
                      type="text"
                      value={resolutionMotive}
                      onChange={(e) => setResolutionMotive(e.target.value)}
                      placeholder="Fonte oficial ou motivo da resolução (mín. 5 caracteres)..."
                      className="w-full bg-[#14191f] border border-[#28313e] rounded-lg px-3 py-2 text-xs text-white outline-none focus:border-amber-400"
                    />
                    <div className="flex flex-wrap items-center gap-2">
                      {isMulti && market.outcomes ? (
                        market.outcomes.map((o) =>
                          confirmResolveOutcome === o.name ? (
                            <button
                              key={o.name}
                              type="button"
                              onClick={async () => {
                                if (resolutionMotive.trim().length < 5) {
                                  addToast('Indique um motivo formal (mínimo 5 caracteres).', 'error');
                                  return;
                                }
                                try {
                                  const res = await ammApi.resolveMultiMarket(
                                    market.id,
                                    o.name,
                                    resolutionMotive.trim()
                                  );
                                  setConfirmResolveOutcome(null);
                                  setResolutionMotive('');
                                  addToast(
                                    `Mercado resolvido como "${o.name}" (${res.payoutsCount} liquidações, ${res.totalPaidKz.toFixed(2)} KZ pagos).`,
                                    'success'
                                  );
                                  setClobVersion((v) => v + 1);
                                  await Promise.all([refreshInteractions(), refreshClobData(), onRefreshAll?.()]);
                                } catch (err: any) {
                                  addToast(`Erro: ${err.message}`, 'error');
                                }
                              }}
                              className="px-3.5 py-2 bg-amber-500 text-black text-xs font-bold rounded-lg"
                            >
                              Confirmar "{o.name}"
                            </button>
                          ) : (
                            <button
                              key={o.name}
                              type="button"
                              onClick={() => setConfirmResolveOutcome(o.name)}
                              className="px-3.5 py-2 bg-[#1b222c] border border-amber-500/40 text-amber-300 text-xs font-semibold rounded-lg hover:bg-amber-500/10"
                            >
                              {o.name}
                            </button>
                          )
                        )
                      ) : (
                        <>
                          {(['Yes', 'No'] as const).map((side) =>
                            confirmResolveOutcome === side ? (
                              <button
                                key={side}
                                type="button"
                                onClick={async () => {
                                  if (resolutionMotive.trim().length < 5) {
                                    addToast('Indique um motivo formal (mínimo 5 caracteres).', 'error');
                                    return;
                                  }
                                  try {
                                    const res = await ammApi.cpmmResolveMarket(market.id, side, resolutionMotive.trim());
                                    setConfirmResolveOutcome(null);
                                    setResolutionMotive('');
                                    addToast(
                                      `Mercado resolvido como ${side === 'Yes' ? 'SIM' : 'NÃO'} (${res.winners_count} vencedores · ${Number(res.total_net_paid_kz || 0).toFixed(2)} KZ líquidos pagos).`,
                                      'success'
                                    );
                                    setClobVersion((v) => v + 1);
                                    await refreshClobData();
                                    await onRefreshAll?.();
                                  } catch (err: any) {
                                    addToast(`Erro: ${err.message}`, 'error');
                                  }
                                }}
                                className={cx(
                                  'px-4 py-2 text-xs font-bold rounded-lg',
                                  side === 'Yes' ? 'bg-[#16a34a] text-white' : 'bg-[#dc2626] text-white'
                                )}
                              >
                                Confirmar {side === 'Yes' ? 'SIM' : 'NÃO'}
                              </button>
                            ) : (
                              <button
                                key={side}
                                type="button"
                                onClick={() => setConfirmResolveOutcome(side)}
                                className={cx(
                                  'px-4 py-2 text-xs font-semibold rounded-lg border',
                                  side === 'Yes'
                                    ? 'bg-[#153e2b] border-[#256948] text-[#3dd68c]'
                                    : 'bg-[#421c21] border-[#6b2a33] text-[#f87171]'
                                )}
                              >
                                Resolver {side === 'Yes' ? 'SIM' : 'NÃO'}
                              </button>
                            )
                          )}
                          {confirmResolveOutcome && (
                            <button
                              type="button"
                              onClick={() => setConfirmResolveOutcome(null)}
                              className="px-3 py-2 text-xs text-[#8b96a6] hover:text-white"
                            >
                              Cancelar
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                );
              }

              return (
                <div className="bg-[#17212e] border border-[#243244] rounded-xl p-4 flex items-center gap-3 text-xs text-[#c5d0de]">
                  <AlertTriangle className="w-4 h-4 text-[#2d8cff] shrink-0" />
                  <span>
                    <strong className="text-white">Aguardando resolução:</strong> O prazo encerrou e o administrador está a validar o resultado oficial para liquidação (100,00 KZ brutos / 99,00 KZ líquidos por share vencedora).
                  </span>
                </div>
              );
            })()}

            {/* Multi-Outcome Candidate Rows Table (Exact Polymarket layout) */}
            {isMulti && (
              <div className="space-y-1">
                <div className="flex items-center justify-between px-2 pb-2 text-xs font-semibold text-[#6e7b8b] border-b border-[#242c37]">
                  <span>OPÇÃO</span>
                  <div className="flex items-center gap-4">
                    <button
                      type="button"
                      onClick={() => setOutcomeSort((s) => (s === 'price_desc' ? 'volume_desc' : 'price_desc'))}
                      className="inline-flex items-center gap-1 hover:text-white transition-colors"
                    >
                      CHANCE {outcomeSort === 'volume_desc' ? '(Vol.)' : ''}
                      <ArrowUpDown className="w-3 h-3" />
                    </button>
                    <span className="hidden sm:inline w-[228px]" />
                  </div>
                </div>

                <div className="divide-y divide-[#222a35]">
                  {(showAllOutcomes ? sortedOutcomes : sortedOutcomes.slice(0, 8)).map((o) => {
                    const yesCents = Math.max(1, Math.min(99, Math.round((o.price || 0) * 100)));
                    const noCents = Math.max(1, Math.min(99, 100 - yesCents));
                    const isRowSelected = outcome === o.name;
                    const delta = Number(o.change_24h || 0);

                    return (
                      <div
                        key={o.id || o.name}
                        className={cx(
                          'flex flex-wrap sm:flex-nowrap items-center justify-between gap-3 py-3.5 px-2 rounded-lg transition-colors',
                          isRowSelected ? 'bg-[#1b232e]/80' : 'hover:bg-[#18202a]/50'
                        )}
                      >
                        {/* Avatar + Name + Volume */}
                        <div className="flex items-center gap-3 min-w-0 flex-1">
                          <LocalThumb
                            src={o.image_url}
                            alt={o.name}
                            fallbackLabel={o.name}
                            className="w-10 h-10 rounded-full"
                          />
                          <div className="min-w-0">
                            <div className="text-[15px] font-semibold text-white truncate">{o.name}</div>
                            <div className="text-xs text-[#8b96a6] tabular-nums flex items-center gap-1.5">
                              <span>{(o.pool || 0).toLocaleString('pt-AO')} KZ Vol.</span>
                            </div>
                          </div>
                        </div>

                        {/* Probability + Delta + Action Buttons */}
                        <div className="flex items-center gap-4 shrink-0 ml-auto">
                          <div className="text-right min-w-[68px]">
                            <span className="text-xl font-bold text-white tabular-nums">{yesCents}%</span>
                            {Math.abs(delta) >= 0.1 && (
                              <span
                                className={cx(
                                  'ml-1.5 text-[11px] font-semibold tabular-nums',
                                  delta > 0 ? 'text-[#3dd68c]' : 'text-[#f87171]'
                                )}
                              >
                                {delta > 0 ? `▲ ${delta.toFixed(0)}%` : `▼ ${Math.abs(delta).toFixed(0)}%`}
                              </span>
                            )}
                          </div>

                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => handleSelectMultiOutcome(o.name, 'Yes')}
                              className={cx(
                                'px-3.5 py-2.5 rounded-lg text-xs font-semibold tabular-nums transition-colors whitespace-nowrap',
                                isRowSelected && binarySide === 'Yes'
                                  ? 'bg-[#16a34a] text-white'
                                  : 'bg-[#153e2b] hover:bg-[#194b34] text-[#3dd68c]'
                              )}
                            >
                              Comprar Sim {yesCents} KZ
                            </button>
                            <button
                              type="button"
                              onClick={() => handleSelectMultiOutcome(o.name, 'No')}
                              className={cx(
                                'px-3.5 py-2.5 rounded-lg text-xs font-semibold tabular-nums transition-colors whitespace-nowrap',
                                isRowSelected && binarySide === 'No'
                                  ? 'bg-[#dc2626] text-white'
                                  : 'bg-[#421c21] hover:bg-[#52232a] text-[#f87171]'
                              )}
                            >
                              Comprar Não {noCents} KZ
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>

                {sortedOutcomes.length > 8 && (
                  <button
                    type="button"
                    onClick={() => setShowAllOutcomes((s) => !s)}
                    className="mt-2 inline-flex items-center gap-1.5 text-xs font-semibold text-[#8b96a6] hover:text-white px-2 py-1.5"
                  >
                    {showAllOutcomes ? (
                      <>
                        Mostrar menos <ChevronUp className="w-3.5 h-3.5" />
                      </>
                    ) : (
                      <>
                        Mostrar mais {sortedOutcomes.length - 8} <ChevronDown className="w-3.5 h-3.5" />
                      </>
                    )}
                  </button>
                )}
              </div>
            )}

            {/* Rules / Contexto do Mercado Section */}
            <div className="pt-2 space-y-4">
              <div className="flex items-center justify-between border-b border-[#242c37]">
                <div className="flex items-center gap-6">
                  <button
                    type="button"
                    onClick={() => setRulesTab('rules')}
                    className={cx(
                      'pb-3 text-base font-semibold border-b-2 transition-colors',
                      rulesTab === 'rules'
                        ? 'text-white border-white'
                        : 'text-[#8b96a6] border-transparent hover:text-white'
                    )}
                  >
                    Regras
                  </button>
                  <button
                    type="button"
                    onClick={() => setRulesTab('context')}
                    className={cx(
                      'pb-3 text-base font-semibold border-b-2 transition-colors',
                      rulesTab === 'context'
                        ? 'text-white border-white'
                        : 'text-[#8b96a6] border-transparent hover:text-white'
                    )}
                  >
                    Contexto do Mercado
                  </button>
                </div>

                {user?.is_admin && (
                  <button
                    type="button"
                    onClick={() => {
                      setEditContextText(effectiveAdditionalContext);
                      setEditDescriptionText(effectiveDescription);
                      setEditResolverName(effectiveResolverName);
                      setEditResolverAddress(effectiveResolverAddress);
                      setShowEditMetadata((v) => !v);
                    }}
                    className="inline-flex items-center gap-1 text-xs font-medium text-[#8b96a6] hover:text-white pb-2"
                  >
                    <Edit3 className="w-3.5 h-3.5" /> Editar Regras
                  </button>
                )}
              </div>

              {showEditMetadata && user?.is_admin && (
                <form
                  onSubmit={handleSaveMetadata}
                  className="bg-[#1b222c] border border-[#2d3745] rounded-xl p-4 space-y-3 text-xs"
                >
                  <div className="font-semibold text-white">Atualizar Regras & Contexto Adicional (Admin)</div>
                  <div className="space-y-1">
                    <label className="text-[#8b96a6]">Contexto adicional</label>
                    <textarea
                      rows={2}
                      value={editContextText}
                      onChange={(e) => setEditContextText(e.target.value)}
                      placeholder="Nota ou esclarecimento adicional para os investidores..."
                      className="w-full bg-[#14191f] border border-[#28313e] rounded-lg px-3 py-2 text-white outline-none focus:border-[#2d8cff]"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[#8b96a6]">Descrição / Regras completas</label>
                    <textarea
                      rows={3}
                      value={editDescriptionText}
                      onChange={(e) => setEditDescriptionText(e.target.value)}
                      className="w-full bg-[#14191f] border border-[#28313e] rounded-lg px-3 py-2 text-white outline-none focus:border-[#2d8cff]"
                    />
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <label className="text-[#8b96a6]">Entidade Liquidadora</label>
                      <input
                        type="text"
                        value={editResolverName}
                        onChange={(e) => setEditResolverName(e.target.value)}
                        className="w-full bg-[#14191f] border border-[#28313e] rounded-lg px-3 py-2 text-white outline-none focus:border-[#2d8cff]"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-[#8b96a6]">Referência / Endereço</label>
                      <input
                        type="text"
                        value={editResolverAddress}
                        onChange={(e) => setEditResolverAddress(e.target.value)}
                        className="w-full bg-[#14191f] border border-[#28313e] rounded-lg px-3 py-2 text-white outline-none focus:border-[#2d8cff]"
                      />
                    </div>
                  </div>
                  <div className="flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setShowEditMetadata(false)}
                      className="px-3 py-1.5 text-[#8b96a6] hover:text-white"
                    >
                      Cancelar
                    </button>
                    <button
                      type="submit"
                      disabled={savingMetadata}
                      className="px-4 py-1.5 bg-[#1a73e8] text-white font-semibold rounded-lg disabled:opacity-50"
                    >
                      {savingMetadata ? 'A guardar...' : 'Guardar'}
                    </button>
                  </div>
                </form>
              )}

              {rulesTab === 'rules' ? (
                <div className="space-y-4">
                  {/* Additional Context Box (blue-tinted card like Polymarket screenshot) */}
                  <div className="bg-[#17212e] border border-[#243345] rounded-xl p-4 space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-semibold text-white">Contexto adicional</span>
                      <span className="text-xs text-[#7c8b9e]">
                        Atualizado{' '}
                        {effectiveContextUpdatedAt
                          ? new Date(effectiveContextUpdatedAt).toLocaleDateString('pt-AO', {
                              day: '2-digit',
                              month: 'short',
                              year: 'numeric',
                            })
                          : 'recentemente'}
                      </span>
                    </div>
                    <p className="text-sm text-[#c2cfde] leading-relaxed">
                      {effectiveAdditionalContext ||
                        `As shares vencedoras são liquidadas por 100,00 KZ brutos (99,00 KZ líquidos após taxa de 1%) se o critério oficial descrito nas regras se confirmar até ${
                          market.end_date ? new Date(market.end_date).toLocaleDateString('pt-AO') : 'ao encerramento'
                        }.`}
                    </p>
                  </div>

                  {/* Full Description with Show more */}
                  <div className="space-y-2">
                    <p className={cx('text-sm text-[#a6b4c4] leading-relaxed whitespace-pre-line', !expandRules && 'line-clamp-4')}>
                      {effectiveDescription}
                    </p>
                    {effectiveDescription.length > 200 && (
                      <button
                        type="button"
                        onClick={() => setExpandRules((v) => !v)}
                        className="inline-flex items-center gap-1 text-xs font-semibold text-[#8b96a6] hover:text-white"
                      >
                        {expandRules ? (
                          <>
                            Mostrar menos <ChevronUp className="w-3.5 h-3.5" />
                          </>
                        ) : (
                          <>
                            Mostrar mais <ChevronDown className="w-3.5 h-3.5" />
                          </>
                        )}
                      </button>
                    )}
                  </div>

                  {/* Market Dates + Resolver Card */}
                  <div className="border border-[#242c37] rounded-xl bg-[#161c24] divide-y divide-[#242c37]">
                    <div className="px-4 py-3 flex flex-wrap items-center justify-between gap-3 text-xs">
                      <div className="flex items-center gap-2 text-[#8b96a6]">
                        <span>Mercado aberto:</span>
                        <strong className="text-[#c5d0de] font-semibold">
                          {market.created_at
                            ? new Date(market.created_at).toLocaleDateString('pt-AO', {
                                day: '2-digit',
                                month: 'short',
                                year: 'numeric',
                              })
                            : 'Ativo'}
                        </strong>
                      </div>
                      <div className="flex items-center gap-2 text-[#8b96a6]">
                        <span>Encerramento:</span>
                        <strong className="text-[#c5d0de] font-semibold">
                          {market.end_date
                            ? new Date(market.end_date).toLocaleDateString('pt-AO', {
                                day: '2-digit',
                                month: 'short',
                                year: 'numeric',
                              })
                            : '—'}
                        </strong>
                      </div>
                    </div>

                    <div className="p-4 flex flex-wrap items-center justify-between gap-4">
                      <div className="flex items-center gap-3">
                        <div className="w-9 h-9 rounded-lg bg-[#232c38] flex items-center justify-center text-[#2d8cff]">
                          <ShieldCheck className="w-5 h-5" />
                        </div>
                        <div>
                          <div className="text-[11px] text-[#8b96a6]">Resolução por</div>
                          <div className="text-sm font-semibold text-white">{effectiveResolverName}</div>
                          <button
                            type="button"
                            onClick={() => {
                              navigator.clipboard?.writeText(effectiveResolverAddress).catch(() => {});
                              addToast('Identificador copiado.', 'info');
                            }}
                            className="inline-flex items-center gap-1 text-[11px] font-mono text-[#7c8b9e] hover:text-white"
                          >
                            {effectiveResolverAddress}
                            <Copy className="w-3 h-3" />
                          </button>
                        </div>
                      </div>

                      <button
                        type="button"
                        onClick={() => {
                          if (!user) {
                            addToast('Inicie sessão para propor uma resolução.', 'info');
                            navigate('/login');
                            return;
                          }
                          setProposalOutcome(isMulti ? market.outcomes?.[0]?.name || '' : 'Sim');
                          setShowProposalForm((v) => !v);
                        }}
                        className="px-4 py-2 rounded-lg bg-[#1e2631] hover:bg-[#283241] border border-[#2d3745] text-xs font-semibold text-white transition-colors"
                      >
                        Propor resolução
                      </button>
                    </div>

                    {/* Collapsible Resolution Proposal Drawer */}
                    {showProposalForm && (
                      <form onSubmit={handleSubmitProposal} className="p-4 bg-[#14191f] space-y-3 text-xs">
                        <div className="font-semibold text-white">Submeter Proposta de Resolução</div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                          <div className="space-y-1">
                            <label className="text-[#8b96a6]">Resultado proposto</label>
                            <select
                              value={proposalOutcome}
                              onChange={(e) => setProposalOutcome(e.target.value)}
                              className="w-full bg-[#1b222c] border border-[#28313e] rounded-lg px-3 py-2 text-white outline-none"
                            >
                              {isMulti && market.outcomes
                                ? market.outcomes.map((o) => (
                                    <option key={o.name} value={o.name}>
                                      {o.name}
                                    </option>
                                  ))
                                : ['Sim', 'Não'].map((s) => (
                                    <option key={s} value={s}>
                                      {s}
                                    </option>
                                  ))}
                            </select>
                          </div>
                          <div className="space-y-1">
                            <label className="text-[#8b96a6]">Link de comprovação (opcional)</label>
                            <input
                              type="url"
                              placeholder="https://..."
                              value={proposalEvidence}
                              onChange={(e) => setProposalEvidence(e.target.value)}
                              className="w-full bg-[#1b222c] border border-[#28313e] rounded-lg px-3 py-2 text-white outline-none"
                            />
                          </div>
                        </div>
                        <div className="space-y-1">
                          <label className="text-[#8b96a6]">Fundamentação oficial</label>
                          <textarea
                            rows={2}
                            required
                            placeholder="Explique a fonte pública que confirma este desfecho..."
                            value={proposalRationale}
                            onChange={(e) => setProposalRationale(e.target.value)}
                            className="w-full bg-[#1b222c] border border-[#28313e] rounded-lg px-3 py-2 text-white outline-none"
                          />
                        </div>
                        <div className="flex justify-end gap-2">
                          <button
                            type="button"
                            onClick={() => setShowProposalForm(false)}
                            className="px-3 py-1.5 text-[#8b96a6] hover:text-white"
                          >
                            Cancelar
                          </button>
                          <button
                            type="submit"
                            disabled={submittingProposal}
                            className="px-4 py-1.5 bg-[#1a73e8] text-white font-semibold rounded-lg disabled:opacity-50"
                          >
                            {submittingProposal ? 'A enviar...' : 'Enviar proposta'}
                          </button>
                        </div>
                      </form>
                    )}

                    {/* Submitted Proposals */}
                    {interactions?.proposals && interactions.proposals.length > 0 && (
                      <div className="p-4 space-y-2">
                        <div className="text-[11px] font-semibold text-[#8b96a6] uppercase tracking-wider">
                          Propostas Recentes ({interactions.proposals.length})
                        </div>
                        {interactions.proposals.slice(0, 5).map((p) => {
                          const safeEvidenceHref = sanitizeHttpUrl(p.evidence_url);
                          return (
                            <div key={p.id} className="text-xs flex items-start justify-between gap-3 bg-[#14191f] p-2.5 rounded-lg border border-[#232b36]">
                              <div className="space-y-0.5 min-w-0">
                                <div className="font-semibold text-white">
                                  {sanitizePlainText(p.proposed_outcome, 80)}{' '}
                                  <span className="font-normal text-[#8b96a6]">
                                    · por {sanitizePlainText(p.user_name, 60) || 'Utilizador'}
                                  </span>
                                </div>
                                <p className="text-[#a6b4c4]">{sanitizePlainText(p.rationale, 1500)}</p>
                                {safeEvidenceHref && (
                                  <a
                                    href={safeEvidenceHref}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-[11px] text-[#2d8cff] hover:underline inline-block"
                                  >
                                    Ver fonte oficial
                                  </a>
                                )}
                              </div>
                            <div className="flex flex-col items-end gap-1.5 shrink-0">
                              <span
                                className={cx(
                                  'text-[11px] font-medium',
                                  p.status === 'accepted'
                                    ? 'text-[#3dd68c]'
                                    : p.status === 'rejected'
                                      ? 'text-[#f87171]'
                                      : 'text-amber-300'
                                )}
                              >
                                {p.status === 'accepted' ? 'Aceite' : p.status === 'rejected' ? 'Rejeitada' : 'Em análise'}
                              </span>
                              {user?.is_admin && p.status === 'pending' && (
                                <div className="flex items-center gap-1.5">
                                  <button
                                    type="button"
                                    onClick={() => handleReviewProposal(p.id, 'accepted')}
                                    className="px-2 py-0.5 rounded bg-[#153e2b] text-[#3dd68c] hover:bg-[#194b34] text-[10px] font-semibold"
                                  >
                                    Aceitar
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => handleReviewProposal(p.id, 'rejected')}
                                    className="px-2 py-0.5 rounded bg-[#421c21] text-[#f87171] hover:bg-[#52232a] text-[10px] font-semibold"
                                  >
                                    Rejeitar
                                  </button>
                                </div>
                              )}
                            </div>
                          </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <div className="bg-[#1b222c] border border-[#28313e] rounded-xl p-3.5">
                    <div className="text-[11px] text-[#8b96a6]">Motor AMM</div>
                    <div className="text-sm font-semibold text-white mt-1">
                      {isMulti ? 'Multi-Pool AMM' : 'CPMM (x · y = k)'}
                    </div>
                  </div>
                  <div className="bg-[#1b222c] border border-[#28313e] rounded-xl p-3.5">
                    <div className="text-[11px] text-[#8b96a6]">Cofre de Liquidez</div>
                    <div className="text-sm font-semibold text-[#3dd68c] mt-1 tabular-nums">
                      {liveVaultKz.toLocaleString('pt-AO', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} KZ
                    </div>
                  </div>
                  <div className="bg-[#1b222c] border border-[#28313e] rounded-xl p-3.5">
                    <div className="text-[11px] text-[#8b96a6]">{isMulti ? 'Opções Ativas' : 'Pools (SIM / NÃO)'}</div>
                    <div className="text-sm font-semibold text-white mt-1 tabular-nums">
                      {isMulti ? market.outcomes?.length || 0 : `${livePoolYes.toFixed(2)} / ${livePoolNo.toFixed(2)}`}
                    </div>
                  </div>
                  <div className="bg-[#1b222c] border border-[#28313e] rounded-xl p-3.5">
                    <div className="text-[11px] text-[#8b96a6]">Liquidação / Taxa</div>
                    <div className="text-sm font-semibold text-white mt-1 tabular-nums">100,00 KZ (-1%)</div>
                  </div>
                </div>
              )}
            </div>

            {/* Community & Analytics Section (Strict order: OrderBook -> Positions -> Top Holders -> Activity -> Comments) */}
            <div dir="ltr" className="pt-2 space-y-4">
              <div
                dir="ltr"
                className="flex flex-row items-center gap-6 border-b border-[#242c37] overflow-x-auto no-scrollbar"
              >
                {[
                  ...(!isMulti ? [{ id: 'orderbook', label: 'Livro de Ordens' }] : []),
                  { id: 'positions', label: 'Posições' },
                  { id: 'holders', label: 'Maiores detentores' },
                  { id: 'activity', label: 'Atividade' },
                  { id: 'comments', label: `Comentários (${comments.length})` },
                ].map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setCommunityTab(tab.id as any)}
                    className={cx(
                      'pb-3 text-sm font-semibold whitespace-nowrap shrink-0 border-b-2 transition-colors',
                      communityTab === tab.id
                        ? 'text-white border-white'
                        : 'text-[#8b96a6] border-transparent hover:text-white'
                    )}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>

              {/* 1. ORDERBOOK TAB */}
              {communityTab === 'orderbook' && !isMulti && (
                <OrderBookComponent
                  market={market}
                  outcome={outcome}
                  onOutcomeChange={(o: 'Yes' | 'No') => setOutcome(o)}
                  trades={trades}
                  user={user}
                  refreshKey={clobVersion}
                  addToast={addToast}
                  onSelectOrder={(sel: { outcome: 'Yes' | 'No'; side: 'Buy' | 'Sell'; priceCents: number }) => {
                    const safePriceCents = Math.max(1, Math.min(99, Math.round(Number(sel.priceCents) || 50)));
                    setOutcome(sel.outcome);
                    setIsBuying(sel.side === 'Buy');
                    setOrderType('Limit');
                    setLimitPrice(String(safePriceCents));
                    addToast(`Ordem limite preenchida (${formatKz(safePriceCents / 100)}).`, 'info');
                  }}
                  onOrderChange={async () => {
                    setClobVersion((v) => v + 1);
                    await refreshClobData();
                    await onRefreshAll?.();
                  }}
                />
              )}

              {/* 2. POSITIONS TAB (Current user positions in this market) */}
              {communityTab === 'positions' && (
                <div className="bg-[#1b222c] border border-[#28313e] rounded-xl overflow-hidden">
                  {!user ? (
                    <div className="p-8 text-center text-xs text-[#8b96a6] space-y-2">
                      <p>Inicie sessão para visualizar as suas posições abertas neste mercado.</p>
                      <button
                        type="button"
                        onClick={() => navigate('/login')}
                        className="px-4 py-2 bg-[#1a73e8] text-white rounded-lg font-semibold"
                      >
                        Entrar
                      </button>
                    </div>
                  ) : isMulti ? (
                    interactions?.myMultiPositions && interactions.myMultiPositions.length > 0 ? (
                      <div className="divide-y divide-[#222a35]">
                        {interactions.myMultiPositions.map((p) => {
                          const avgPriceKz = Number(p.avg_price || 0) > 1 ? Number(p.avg_price) : Number(p.avg_price || 0) * 100;
                          return (
                            <div key={p.id} className="p-4 flex items-center justify-between gap-4">
                              <div>
                                <div className="text-sm font-semibold text-white">
                                  {sanitizePlainText(p.outcome, 80)}{' '}
                                  <span className={p.binarySide === 'Yes' ? 'text-[#3dd68c]' : 'text-[#f87171]'}>
                                    ({p.binarySide === 'Yes' ? 'Sim' : 'Não'})
                                  </span>
                                </div>
                                <div className="text-xs text-[#8b96a6] tabular-nums">
                                  {Number(p.shares || 0).toFixed(2)} quotas · Preço médio {formatKz(avgPriceKz)}
                                </div>
                              </div>
                              <button
                                type="button"
                                onClick={() => {
                                  setOutcome(p.outcome);
                                  setBinarySide(p.binarySide);
                                  setIsBuying(false);
                                  setAmount(String(p.shares));
                                }}
                                className="px-3 py-1.5 rounded-lg bg-[#421c21] text-[#f87171] hover:bg-[#52232a] text-xs font-semibold"
                              >
                                Vender
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      <div className="p-8 text-center text-xs text-[#7c8b9e]">
                        Não possui posições abertas neste mercado.
                      </div>
                    )
                  ) : myAllCpmmPositions.length > 0 || clobPositions.filter((p) => (p.available_shares || 0) + (p.reserved_shares || 0) > 0).length > 0 ? (
                    <div className="divide-y divide-[#222a35]">
                      {myAllCpmmPositions.map((p) => {
                        const isYesPos = p.outcome === 'Yes';
                        const spotKz = isYesPos
                          ? Number(effectiveMarket?.yes_price_kz || liveSpots.yesPriceKz)
                          : Number(effectiveMarket?.no_price_kz || liveSpots.noPriceKz);
                        const sharesQty = Number(p.shares_amount || 0);
                        const avgEntryKz = Number(p.avg_entry_price || 50);
                        const costBasis = Number(p.total_cost_kz || sharesQty * avgEntryKz);
                        const marketValKz = sharesQty * spotKz;
                        const pnlKz = marketValKz - costBasis;
                        const pnlPct = costBasis > 0 ? (pnlKz / costBasis) * 100 : 0;
                        const maxNetWinKz = sharesQty * SHARE_SETTLEMENT_KZ * (1 - WITHDRAWAL_FEE_RATE);
                        return (
                          <div key={p.id || `${p.outcome}_${p.is_lp ? 'lp' : 'tr'}`} className="p-4 flex flex-wrap items-center justify-between gap-4">
                            <div className="space-y-1 min-w-0">
                              <div className="flex items-center gap-2">
                                <span className={cx('text-sm font-bold', isYesPos ? 'text-[#3dd68c]' : 'text-[#f87171]')}>
                                  {isYesPos ? 'Sim' : 'Não'}
                                </span>
                                {p.is_lp && (
                                  <span className="px-1.5 py-0.5 rounded bg-[#172b45] border border-[#2d8cff]/30 text-[#60a5fa] text-[10px] font-bold">
                                    Provedor LP
                                  </span>
                                )}
                                <span className="text-xs text-white font-semibold tabular-nums">
                                  {sharesQty.toLocaleString('pt-AO', { maximumFractionDigits: 4 })} shares
                                </span>
                              </div>
                              <div className="text-xs text-[#8b96a6] tabular-nums flex flex-wrap items-center gap-x-2.5 gap-y-0.5">
                                <span>Entrada Méd: {formatKz(avgEntryKz)}</span>
                                <span>·</span>
                                <span>Atual: {formatKz(spotKz)}</span>
                                <span>·</span>
                                <span>Valor: {formatKz(marketValKz)}</span>
                                <span>·</span>
                                <span className={pnlKz >= 0 ? 'text-[#3dd68c] font-semibold' : 'text-[#f87171] font-semibold'}>
                                  PnL: {pnlKz >= 0 ? '+' : ''}{formatKz(pnlKz)} ({pnlPct >= 0 ? '+' : ''}{pnlPct.toFixed(1)}%)
                                </span>
                              </div>
                              <div className="text-[11px] text-[#6e7b8b] tabular-nums">
                                Se vencer: {formatKz(maxNetWinKz)} líquidos ({formatKz(sharesQty * SHARE_SETTLEMENT_KZ)} brutos)
                              </div>
                            </div>
                            {!p.is_lp ? (
                              <button
                                type="button"
                                onClick={() => {
                                  setOutcome(isYesPos ? 'Yes' : 'No');
                                  setIsBuying(false);
                                  setOrderType('Market');
                                  setPriceChangedAlert(null);
                                  pendingIdempotencyKeyRef.current = null;
                                  setAmount(String(Number(sharesQty.toFixed(4))));
                                  tradePanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                                }}
                                className="px-3.5 py-1.5 rounded-lg bg-[#421c21] text-[#f87171] hover:bg-[#52232a] text-xs font-semibold shrink-0"
                              >
                                Vender
                              </button>
                            ) : (
                              <span className="text-[11px] text-[#8b96a6] font-medium shrink-0">
                                Lastro AMM (Liquida no encerramento)
                              </span>
                            )}
                          </div>
                        );
                      })}

                      {clobPositions
                        .filter((p) => (p.reserved_shares || 0) > 0)
                        .map((p) => (
                          <div key={`clob_${p.outcome}`} className="p-4 flex items-center justify-between gap-4 bg-[#171e27]">
                            <div>
                              <div className="text-sm font-semibold text-white">
                                {p.outcome === 'Yes' ? 'Sim' : 'Não'}{' '}
                                <span className="text-[11px] text-amber-400 font-medium">(Ordem Limite Reservada)</span>
                              </div>
                              <div className="text-xs text-[#8b96a6] tabular-nums">
                                {p.reserved_shares} quotas em ordem limite · Méd {formatKz((p.avg_price_cents || 0) / 100)}
                              </div>
                            </div>
                          </div>
                        ))}
                    </div>
                  ) : (
                    <div className="p-8 text-center text-xs text-[#7c8b9e]">
                      Não possui posições abertas neste mercado.
                    </div>
                  )}
                </div>
              )}

              {/* 3. TOP HOLDERS TAB */}
              {communityTab === 'holders' && (
                <div className="space-y-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setHolderOutcomeFilter('Todos')}
                      className={cx(
                        'px-3 py-1 rounded-lg text-xs font-semibold border transition-colors',
                        holderOutcomeFilter === 'Todos'
                          ? 'bg-[#263140] border-[#38465a] text-white'
                          : 'bg-[#1b222c] border-[#28313e] text-[#8b96a6] hover:text-white'
                      )}
                    >
                      Todos
                    </button>
                    {isMulti
                      ? market.outcomes?.slice(0, 6).map((o) => (
                          <button
                            key={o.name}
                            type="button"
                            onClick={() => setHolderOutcomeFilter(o.name)}
                            className={cx(
                              'px-3 py-1 rounded-lg text-xs font-semibold border transition-colors',
                              holderOutcomeFilter === o.name
                                ? 'bg-[#263140] border-[#38465a] text-white'
                                : 'bg-[#1b222c] border-[#28313e] text-[#8b96a6] hover:text-white'
                            )}
                          >
                            {sanitizePlainText(o.name, 40)}
                          </button>
                        ))
                      : ['Yes', 'No'].map((side) => (
                          <button
                            key={side}
                            type="button"
                            onClick={() => setHolderOutcomeFilter(side)}
                            className={cx(
                              'px-3 py-1 rounded-lg text-xs font-semibold border transition-colors',
                              holderOutcomeFilter === side
                                ? 'bg-[#263140] border-[#38465a] text-white'
                                : 'bg-[#1b222c] border-[#28313e] text-[#8b96a6] hover:text-white'
                            )}
                          >
                            {side === 'Yes' ? 'Sim' : 'Não'}
                          </button>
                        ))}
                  </div>

                  {loadingPositions ? (
                    <div className="flex justify-center py-8">
                      <Loader2 className="w-5 h-5 animate-spin text-[#2d8cff]" />
                    </div>
                  ) : mergedHolders.length > 0 ? (
                    <div className="divide-y divide-[#222a35] bg-[#1b222c] border border-[#28313e] rounded-xl overflow-hidden">
                      {mergedHolders.map((pos, idx) => {
                        const isYes = pos.binarySide ? pos.binarySide === 'Yes' : pos.outcome === 'Yes';
                        const sharesNum = Number(pos.shares || 0);
                        const avgEntryKz = Number(pos.avg_price || 0) > 1 ? Number(pos.avg_price) : Number(pos.avg_price || 0) * 100;
                        const spotForHolderKz = isMulti
                          ? (market.outcomes?.find((o) => o.name === pos.outcome)?.price || 0.5) * 100
                          : isYes
                            ? Number(effectiveMarket?.yes_price_kz || liveSpots.yesPriceKz)
                            : Number(effectiveMarket?.no_price_kz || liveSpots.noPriceKz);
                        const currentValKz = sharesNum * spotForHolderKz;
                        const safeLabel = sanitizePlainText(pos.userLabel, 60) || `Trader #${String(pos.userId || '').slice(0, 6)}`;
                        const safeOutcome = sanitizePlainText(pos.outcome, 48);
                        return (
                          <div key={pos.id || idx} className="px-4 py-3 flex items-center justify-between gap-3">
                            <div className="flex items-center gap-3 min-w-0">
                              <span className="w-7 h-7 rounded-full bg-[#242e3b] flex items-center justify-center text-xs font-bold text-[#9aa8b8] shrink-0">
                                #{idx + 1}
                              </span>
                              <div className="min-w-0">
                                <div className="flex items-center gap-2 min-w-0">
                                  <span className="text-sm font-semibold text-white truncate">{safeLabel}</span>
                                  {pos.is_lp && (
                                    <span className="px-1.5 py-0.5 rounded bg-[#172b45] border border-[#2d8cff]/30 text-[#60a5fa] text-[10px] font-bold shrink-0">
                                      LP
                                    </span>
                                  )}
                                </div>
                                <div className="text-xs text-[#8b96a6] flex items-center gap-2 tabular-nums">
                                  <span
                                    className={cx(
                                      'font-semibold',
                                      isYes ? 'text-[#3dd68c]' : 'text-[#f87171]'
                                    )}
                                  >
                                    {pos.binarySide
                                      ? `${safeOutcome} (${pos.binarySide === 'Yes' ? 'Sim' : 'Não'})`
                                      : pos.outcome === 'Yes'
                                        ? 'Sim'
                                        : pos.outcome === 'No'
                                          ? 'Não'
                                          : safeOutcome}
                                  </span>
                                  <span>·</span>
                                  <span>
                                    Méd: {formatKz(avgEntryKz > 0 ? avgEntryKz : 50)}
                                  </span>
                                </div>
                              </div>
                            </div>
                            <div className="text-right tabular-nums shrink-0">
                              <div className="text-sm font-bold text-white">
                                {sharesNum.toLocaleString('pt-AO', { maximumFractionDigits: 2 })} shares
                              </div>
                              <div className="text-[11px] text-[#8b96a6]">
                                ≈ {formatKz(currentValKz)}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="py-10 text-center text-xs text-[#7c8b9e] bg-[#1b222c] border border-[#28313e] rounded-xl">
                      Nenhum detentor registado neste mercado até ao momento.
                    </div>
                  )}
                </div>
              )}

              {/* 4. ACTIVITY TAB */}
              {communityTab === 'activity' && <RecentTradesComponent trades={mergedActivity} />}

              {/* 5. COMMENTS TAB */}
              {communityTab === 'comments' && (
                <div className="space-y-4">
                  {/* Single-line composer */}
                  <form
                    onSubmit={handleAddComment}
                    className="flex items-center gap-2 bg-[#1b222c] border border-[#2a3442] rounded-xl p-1.5 pl-4 focus-within:border-[#2d8cff] transition-colors"
                  >
                    <input
                      type="text"
                      maxLength={1000}
                      value={newComment}
                      onChange={(e) => setNewComment(e.target.value)}
                      placeholder={
                        replyingToId ? 'Escrever uma resposta...' : 'Adicionar um comentário...'
                      }
                      className="flex-1 bg-transparent text-sm text-white placeholder-[#6e7b8b] outline-none"
                    />
                    {replyingToId && (
                      <button
                        type="button"
                        onClick={() => setReplyingToId(null)}
                        className="text-xs text-[#8b96a6] hover:text-white px-2"
                      >
                        Cancelar
                      </button>
                    )}
                    <button
                      type="submit"
                      disabled={submittingComment}
                      className="px-4 py-1.5 bg-[#1a73e8] hover:bg-[#1967d2] disabled:opacity-50 text-white text-xs font-semibold rounded-lg transition-colors whitespace-nowrap"
                    >
                      {submittingComment ? 'A publicar...' : 'Publicar'}
                    </button>
                  </form>

                  {/* Sort / Filter / Security Notice Row */}
                  <div className="flex flex-wrap items-center justify-between gap-3 text-xs">
                    <div className="flex items-center gap-3">
                      <select
                        value={commentSort}
                        onChange={(e) => setCommentSort(e.target.value as any)}
                        className="bg-[#1b222c] border border-[#28313e] rounded-lg px-3 py-1.5 text-white font-medium outline-none"
                      >
                        <option value="newest">Mais recentes</option>
                        <option value="liked">Mais gostados</option>
                      </select>

                      <label className="inline-flex items-center gap-2 text-[#a6b4c4] cursor-pointer select-none">
                        <input
                          type="checkbox"
                          checked={holdersOnlyComments}
                          onChange={(e) => setHoldersOnlyComments(e.target.checked)}
                          className="accent-[#2d8cff] rounded"
                        />
                        Detentores
                      </label>
                    </div>

                    <div className="flex items-center gap-1.5 text-[#7c8b9e]">
                      <AlertTriangle className="w-3.5 h-3.5" />
                      <span>Atenção a links externos.</span>
                    </div>
                  </div>

                  {/* Comment List */}
                  <div className="divide-y divide-[#222a35]">
                    {filteredComments.length > 0 ? (
                      filteredComments.slice(0, visibleCommentsCount).map((comment) => {
                        const likeInfo = interactions?.commentLikes?.[comment.id];
                        const likeCount = likeInfo?.count ?? Number(comment.likes || 0);
                        const likedByMe = likeInfo?.likedByMe ?? false;
                        const canDelete = user && (user.id === comment.user_id || user.is_admin);
                        const authorName =
                          sanitizePlainText(comment.user_name || comment.userName, 60) || 'Utilizador';
                        const safeCommentBody = sanitizePlainText(comment.text, 1000);
                        const safeOutcomeTag = comment.outcome_tag
                          ? sanitizePlainText(comment.outcome_tag, 48)
                          : '';
                        const initial = authorName[0]?.toUpperCase() || 'U';
                        const posForCommenter = mergedHolders.find((h) => h.userId === comment.user_id);

                        return (
                          <div key={comment.id} className="py-4 flex items-start gap-3">
                            <div className="w-8 h-8 rounded-full bg-gradient-to-br from-[#2d8cff] to-[#6366f1] flex items-center justify-center text-white text-xs font-bold shrink-0">
                              {initial}
                            </div>

                            <div className="flex-1 min-w-0 space-y-1">
                              <div className="flex items-center justify-between gap-2">
                                <div className="flex flex-wrap items-center gap-2 min-w-0">
                                  <span className="text-sm font-semibold text-white truncate">{authorName}</span>
                                  {(safeOutcomeTag || posForCommenter) && (
                                    <span className="px-2 py-0.5 rounded bg-[#153e2b] text-[#3dd68c] text-[11px] font-semibold tabular-nums">
                                      {safeOutcomeTag ||
                                        `${Number(posForCommenter.shares) >= 10 ? Math.round(posForCommenter.shares) : Number(posForCommenter.shares).toFixed(2)} ${posForCommenter.outcome === 'Yes' ? 'Sim' : posForCommenter.outcome === 'No' ? 'Não' : sanitizePlainText(posForCommenter.outcome, 32)}`}
                                    </span>
                                  )}
                                  <span className="text-xs text-[#6e7b8b]">
                                    {comment.timestamp
                                      ? formatDistanceToNow(new Date(comment.timestamp), { addSuffix: true, locale: ptBR })
                                      : ''}
                                  </span>
                                </div>

                                {canDelete && (
                                  <button
                                    type="button"
                                    onClick={() => handleDeleteComment(comment.id)}
                                    className="p-1 text-[#6e7b8b] hover:text-[#f87171] transition-colors"
                                    title="Apagar comentário"
                                  >
                                    <Trash2 className="w-3.5 h-3.5" />
                                  </button>
                                )}
                              </div>

                              <p className="text-sm text-[#d4dde7] leading-relaxed break-words">{safeCommentBody}</p>

                              <div className="flex items-center gap-4 pt-1">
                                <button
                                  type="button"
                                  onClick={() => handleToggleLike(comment.id)}
                                  className={cx(
                                    'inline-flex items-center gap-1 text-xs transition-colors tabular-nums',
                                    likedByMe ? 'text-[#f87171]' : 'text-[#7c8b9e] hover:text-white'
                                  )}
                                >
                                  <Heart className={cx('w-3.5 h-3.5', likedByMe && 'fill-current')} />
                                  <span>{likeCount}</span>
                                </button>

                                <button
                                  type="button"
                                  onClick={() => {
                                    setReplyingToId(comment.id);
                                    setNewComment(`@${authorName} `);
                                  }}
                                  className="text-xs text-[#7c8b9e] hover:text-white transition-colors"
                                >
                                  Responder
                                </button>
                              </div>
                            </div>
                          </div>
                        );
                      })
                    ) : (
                      <div className="py-10 text-center text-xs text-[#7c8b9e]">
                        {holdersOnlyComments
                          ? 'Nenhum detentor comentou ainda neste mercado.'
                          : 'Ainda sem comentários. Partilhe a sua análise acima.'}
                      </div>
                    )}
                  </div>

                  {filteredComments.length > visibleCommentsCount && (
                    <button
                      type="button"
                      onClick={() => setVisibleCommentsCount((n) => n + 10)}
                      className="text-xs font-semibold text-[#2d8cff] hover:underline"
                    >
                      Mostrar mais comentários
                    </button>
                  )}
                </div>
              )}
            </div>

            {/* Perguntas Frequentes (FAQs Accordion) */}
            <div className="pt-4 space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-bold text-white">Perguntas Frequentes</h2>
                {user?.is_admin && (
                  <button
                    type="button"
                    onClick={() => setShowAddFaq((v) => !v)}
                    className="inline-flex items-center gap-1 text-xs font-semibold text-[#2d8cff] hover:underline"
                  >
                    <Plus className="w-3.5 h-3.5" /> Adicionar FAQ
                  </button>
                )}
              </div>

              {showAddFaq && user?.is_admin && (
                <form
                  onSubmit={handleAddFaq}
                  className="bg-[#1b222c] border border-[#28313e] rounded-xl p-4 space-y-3 text-xs"
                >
                  <input
                    type="text"
                    required
                    placeholder="Pergunta..."
                    value={newFaqQuestion}
                    onChange={(e) => setNewFaqQuestion(e.target.value)}
                    className="w-full bg-[#14191f] border border-[#28313e] rounded-lg px-3 py-2 text-white outline-none"
                  />
                  <textarea
                    rows={2}
                    required
                    placeholder="Resposta objetiva..."
                    value={newFaqAnswer}
                    onChange={(e) => setNewFaqAnswer(e.target.value)}
                    className="w-full bg-[#14191f] border border-[#28313e] rounded-lg px-3 py-2 text-white outline-none"
                  />
                  <div className="flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setShowAddFaq(false)}
                      className="px-3 py-1 text-[#8b96a6]"
                    >
                      Cancelar
                    </button>
                    <button
                      type="submit"
                      className="px-4 py-1.5 bg-[#1a73e8] text-white font-semibold rounded-lg"
                    >
                      Guardar FAQ
                    </button>
                  </div>
                </form>
              )}

              <div className="divide-y divide-[#222a35] border-y border-[#222a35]">
                {visibleFaqs.map((faq, idx) => {
                  const isOpen = openFaqIdx === idx;
                  const isCustomDbFaq = !String(faq.id).startsWith('faq-');
                  return (
                    <div key={faq.id || idx} className="py-3.5">
                      <div className="flex items-center justify-between gap-3">
                        <button
                          type="button"
                          onClick={() => setOpenFaqIdx(isOpen ? null : idx)}
                          className="flex-1 flex items-center justify-between gap-4 text-left text-sm font-medium text-[#d4dde7] hover:text-white transition-colors"
                        >
                          <span>{faq.question}</span>
                          {isOpen ? (
                            <ChevronUp className="w-4 h-4 text-[#8b96a6] shrink-0" />
                          ) : (
                            <ChevronDown className="w-4 h-4 text-[#8b96a6] shrink-0" />
                          )}
                        </button>
                        {user?.is_admin && isCustomDbFaq && (
                          <button
                            type="button"
                            onClick={() => handleDeleteFaq(String(faq.id))}
                            className="p-1 text-[#6e7b8b] hover:text-[#f87171] transition-colors shrink-0"
                            title="Remover FAQ"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                      {isOpen && (
                        <p className="mt-2.5 text-xs text-[#8b96a6] leading-relaxed">{faq.answer}</p>
                      )}
                    </div>
                  );
                })}
              </div>

              {combinedFaqs.length > 4 && (
                <button
                  type="button"
                  onClick={() => setShowAllFaqs((s) => !s)}
                  className="inline-flex items-center gap-1 text-xs font-semibold text-[#8b96a6] hover:text-white"
                >
                  {showAllFaqs ? 'Ver menos' : 'Ver mais'} <ChevronDown className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          </div>

          {/* RIGHT STICKY SIDEBAR (Trade Card + Related Markets Card) */}
          <div ref={tradePanelRef} className="lg:col-span-4 lg:sticky lg:top-20 space-y-5">
            {/* TRADING CARD */}
            <div className="bg-[#1b222c] border border-[#28313e] rounded-2xl overflow-hidden shadow-xl">
              {/* Selected Option / Market Mini Header */}
              <div className="px-4 py-3.5 border-b border-[#242c37] flex items-center justify-between gap-3">
                <div className="flex items-center gap-3 min-w-0">
                  <LocalThumb
                    src={isMulti ? selectedOutcomeObj?.image_url : market.image_url}
                    alt={isMulti ? selectedOutcomeObj?.name : market.question}
                    fallbackLabel={isMulti ? selectedOutcomeObj?.name : undefined}
                    isCrypto={!isMulti && isCrypto}
                    className="w-9 h-9 rounded-full"
                  />
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-white truncate">
                      {isMulti ? selectedOutcomeObj?.name : market.question}
                    </div>
                    {user && (
                      <div className="text-[11px] text-[#8b96a6] tabular-nums">
                        Saldo: <span className="text-[#3dd68c] font-semibold">{user.balance.toLocaleString('pt-AO')} KZ</span>
                      </div>
                    )}
                  </div>
                </div>
                {isMulti && (
                  <span className="text-sm font-bold text-white tabular-nums shrink-0">
                    {Math.round(optionYesProb * 100)}%
                  </span>
                )}
              </div>

              {lastTradeSuccess ? (
                <div className="p-5 text-center space-y-4">
                  <div className="w-10 h-10 rounded-full bg-[#153e2b] text-[#3dd68c] flex items-center justify-center mx-auto">
                    <CheckCircle2 className="w-5 h-5" />
                  </div>
                  <div>
                    <h4 className="text-sm font-bold text-white">Ordem Executada</h4>
                    <p className="text-xs text-[#8b96a6] mt-0.5">{lastTradeSuccess.outcome}</p>
                  </div>
                  <div className="bg-[#14191f] rounded-xl p-3.5 text-xs space-y-2 border border-[#252d38] tabular-nums">
                    <div className="flex justify-between">
                      <span className="text-[#8b96a6]">Operação</span>
                      <span className="text-white font-semibold">{lastTradeSuccess.side}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-[#8b96a6]">{lastTradeSuccess.side === 'Compra' ? 'Total Pago' : 'Líquido Creditado'}</span>
                      <span className="text-white font-semibold">{Number(lastTradeSuccess.amount).toLocaleString('pt-AO', { maximumFractionDigits: 2 })} KZ</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-[#8b96a6]">Shares</span>
                      <span className="text-[#3dd68c] font-semibold">{Number(lastTradeSuccess.shares).toFixed(4)}</span>
                    </div>
                    {lastTradeSuccess.price !== undefined && (
                      <div className="flex justify-between">
                        <span className="text-[#8b96a6]">Preço Médio Exec.</span>
                        <span className="text-white font-semibold">{Number(lastTradeSuccess.price).toFixed(2)} KZ</span>
                      </div>
                    )}
                    {lastTradeSuccess.fee !== undefined && (
                      <div className="flex justify-between">
                        <span className="text-[#8b96a6]">Taxa (1%)</span>
                        <span className="text-[#9aa8b8] font-medium">{Number(lastTradeSuccess.fee).toFixed(2)} KZ</span>
                      </div>
                    )}
                    {lastTradeSuccess.netWinKz !== undefined && (
                      <div className="flex justify-between pt-1 border-t border-[#222a35]">
                        <span className="text-[#8b96a6]">Prémio se vencer (Líq.)</span>
                        <span className="text-[#3dd68c] font-semibold">{Number(lastTradeSuccess.netWinKz).toLocaleString('pt-AO', { maximumFractionDigits: 2 })} KZ</span>
                      </div>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => setLastTradeSuccess(null)}
                    className="w-full py-2.5 bg-[#1a73e8] hover:bg-[#1967d2] text-white font-semibold text-xs rounded-xl"
                  >
                    Nova operação
                  </button>
                </div>
              ) : (
                <>
                  {/* Buy | Sell + Market | Limit */}
                  <div className="px-4 flex items-center justify-between border-b border-[#242c37]">
                    <div className="flex items-center gap-5">
                      <button
                        type="button"
                        onClick={() => {
                          setIsBuying(true);
                          setClobQuote(null);
                          setPriceChangedAlert(null);
                          pendingIdempotencyKeyRef.current = null;
                        }}
                        className={cx(
                          'py-3 text-sm font-semibold border-b-2 transition-colors',
                          isBuying
                            ? 'text-white border-white'
                            : 'text-[#8b96a6] border-transparent hover:text-white'
                        )}
                      >
                        Comprar
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setIsBuying(false);
                          setClobQuote(null);
                          setPriceChangedAlert(null);
                          pendingIdempotencyKeyRef.current = null;
                        }}
                        className={cx(
                          'py-3 text-sm font-semibold border-b-2 transition-colors',
                          !isBuying
                            ? 'text-white border-white'
                            : 'text-[#8b96a6] border-transparent hover:text-white'
                        )}
                      >
                        Vender
                      </button>
                    </div>

                    {!isMulti && (
                      <button
                        type="button"
                        onClick={() => {
                          setPriceChangedAlert(null);
                          pendingIdempotencyKeyRef.current = null;
                          setOrderType((prev) => {
                            const next = prev === 'Market' ? 'Limit' : 'Market';
                            if (next === 'Limit' && !limitPrice) {
                              setLimitPrice(String(Math.max(1, Math.min(99, Math.round(activeProb * 100)))));
                            }
                            return next;
                          });
                        }}
                        className="inline-flex items-center gap-1 text-xs font-semibold text-[#c5d0de] hover:text-white py-2"
                      >
                        {orderType === 'Market' ? 'Mercado' : 'Limite'}
                        <ChevronDown className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>

                  <div className="p-4 space-y-4">
                    {isTradingBlocked && (
                      <div className="bg-[#421c21]/70 border border-[#6b2a33] rounded-xl p-3 flex items-start gap-2.5 text-xs text-[#f87171]">
                        <Lock className="w-4 h-4 shrink-0 mt-0.5" />
                        <span>Negociações temporariamente bloqueadas neste mercado.</span>
                      </div>
                    )}

                    {/* Yes / No Price Toggle Buttons (Polymarket proportions) */}
                    <div className="grid grid-cols-2 gap-2.5">
                      <button
                        type="button"
                        onClick={() => {
                          setPriceChangedAlert(null);
                          pendingIdempotencyKeyRef.current = null;
                          isMulti ? setBinarySide('Yes') : setOutcome('Yes');
                        }}
                        className={cx(
                          'py-3 px-3 rounded-xl text-sm font-bold tabular-nums transition-colors',
                          (isMulti ? binarySide === 'Yes' : outcome === 'Yes')
                            ? 'bg-[#16a34a] text-white'
                            : 'bg-[#26303d] text-[#9aa8b8] hover:text-white'
                        )}
                      >
                        Sim {Math.max(1, Math.min(99, Number((isMulti ? optionYesProb * 100 : (effectiveMarket?.yes_price_kz ?? liveSpots.yesPriceKz)).toFixed(1))))} KZ
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setPriceChangedAlert(null);
                          pendingIdempotencyKeyRef.current = null;
                          isMulti ? setBinarySide('No') : setOutcome('No');
                        }}
                        className={cx(
                          'py-3 px-3 rounded-xl text-sm font-bold tabular-nums transition-colors',
                          (isMulti ? binarySide === 'No' : outcome === 'No')
                            ? 'bg-[#dc2626] text-white'
                            : 'bg-[#26303d] text-[#9aa8b8] hover:text-white'
                        )}
                      >
                        Não {Math.max(1, Math.min(99, Number((isMulti ? optionNoProb * 100 : (effectiveMarket?.no_price_kz ?? liveSpots.noPriceKz)).toFixed(1))))} KZ
                      </button>
                    </div>

                    {/* Limit Price input (Binary CLOB Limit mode) */}
                    {!isMulti && orderType === 'Limit' && (
                      <div className="flex items-center justify-between gap-3 bg-[#14191f] border border-[#28313e] rounded-xl px-3.5 py-2.5">
                        <div className="flex flex-col">
                          <span className="text-xs font-medium text-[#8b96a6]">Preço limite (centavos)</span>
                          <span className="text-[11px] text-[#6e7b8b] tabular-nums">
                            = {formatKz((parsedLimitVal || 50) / 100)} / quota (0,01–0,99 Kz)
                          </span>
                        </div>
                        <input
                          type="number"
                          min={1}
                          max={99}
                          step={1}
                          value={limitPrice}
                          onChange={(e) => {
                            const raw = e.target.value.replace(/[^\d]/g, '');
                            if (!raw) {
                              setLimitPrice('');
                              return;
                            }
                            const clamped = Math.max(1, Math.min(99, parseInt(raw, 10) || 1));
                            setLimitPrice(String(clamped));
                          }}
                          placeholder="50"
                          className="w-20 bg-transparent text-right text-lg font-bold text-white outline-none tabular-nums"
                        />
                      </div>
                    )}

                    {/* Amount / Shares Input Row */}
                    <div className="space-y-2.5">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-semibold text-white">
                          {isBuying ? 'Montante' : 'Shares'}
                        </span>
                        <div className="flex items-center gap-1.5">
                          <input
                            ref={amountInputRef}
                            type="number"
                            min={0}
                            step="any"
                            value={amount}
                            onChange={(e) => {
                              const raw = e.target.value;
                              if (raw === '') {
                                setAmount('');
                              } else {
                                const parsed = parseFloat(raw);
                                if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 1_000_000_000) {
                                  setAmount(raw);
                                }
                              }
                              setPriceChangedAlert(null);
                              pendingIdempotencyKeyRef.current = null;
                            }}
                            placeholder="0"
                            className="w-32 bg-transparent text-right text-2xl font-bold text-white placeholder-[#4b5665] outline-none tabular-nums"
                          />
                          <span className="text-xs font-semibold text-[#8b96a6]">
                            {isBuying ? 'KZ' : 'sh'}
                          </span>
                        </div>
                      </div>

                      {/* Quick Chips (+100, +500, +1.000, Máx) */}
                      <div className="grid grid-cols-4 gap-1.5">
                        {isBuying
                          ? ([100, 500, 1000, 'Máx'] as const).map((chip) => (
                              <button
                                key={String(chip)}
                                type="button"
                                onClick={() => {
                                  setPriceChangedAlert(null);
                                  pendingIdempotencyKeyRef.current = null;
                                  if (chip === 'Máx') {
                                    setAmount(Math.floor(user?.balance || 0).toString());
                                  } else {
                                    setAmount((prev) => String((parseFloat(prev || '0') || 0) + chip));
                                  }
                                }}
                                className="py-1.5 bg-[#252e3a] hover:bg-[#313d4d] rounded-lg text-xs font-semibold text-[#c5d0de] hover:text-white transition-colors tabular-nums"
                              >
                                {typeof chip === 'number' ? `+${chip.toLocaleString('pt-AO')}` : chip}
                              </button>
                            ))
                          : (['25%', '50%', '75%', 'Máx'] as const).map((pctLabel) => (
                              <button
                                key={pctLabel}
                                type="button"
                                onClick={() => {
                                  setPriceChangedAlert(null);
                                  pendingIdempotencyKeyRef.current = null;
                                  const avail = userPosition?.shares || 0;
                                  if (avail <= 0) {
                                    addToast('Não possui shares disponíveis desta opção para vender.', 'info');
                                    return;
                                  }
                                  if (pctLabel === 'Máx') {
                                    setAmount(String(isBinaryCpmmMarketMode || isMulti ? Number(avail.toFixed(4)) : Math.floor(avail)));
                                  } else {
                                    const frac = parseInt(pctLabel, 10) / 100;
                                    const val = isBinaryCpmmMarketMode || isMulti ? Number((avail * frac).toFixed(4)) : Math.max(1, Math.floor(avail * frac));
                                    setAmount(String(val));
                                  }
                                }}
                                className="py-1.5 bg-[#252e3a] hover:bg-[#313d4d] rounded-lg text-xs font-semibold text-[#c5d0de] hover:text-white transition-colors tabular-nums"
                              >
                                {pctLabel}
                              </button>
                            ))}
                      </div>
                    </div>

                    {/* Slippage Tolerance Selector (Binary CPMM Market Mode) */}
                    {isBinaryCpmmMarketMode && (
                      <div className="flex items-center justify-between gap-2 pt-0.5">
                        <span className="text-[11px] font-medium text-[#8b96a6]">Tolerância Slippage</span>
                        <div className="flex items-center gap-1">
                          {[0.5, 1, 2, 5].map((pct) => (
                            <button
                              key={pct}
                              type="button"
                              onClick={() => {
                                setMaxSlippagePct(pct);
                                setPriceChangedAlert(null);
                                pendingIdempotencyKeyRef.current = null;
                              }}
                              className={cx(
                                'px-2 py-0.5 rounded text-[11px] font-semibold tabular-nums transition-colors',
                                maxSlippagePct === pct
                                  ? 'bg-[#2d8cff] text-white'
                                  : 'bg-[#14191f] text-[#8b96a6] hover:text-white border border-[#242c37]'
                              )}
                            >
                              {pct}%
                            </button>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Execution Preview */}
                    {amountValue > 0 && (
                      <div className="bg-[#14191f] border border-[#242c37] rounded-xl p-3 space-y-1.5 text-xs tabular-nums">
                        {isBinaryCpmmMarketMode && (
                          <div className="flex justify-between text-[#8b96a6]">
                            <span>Preço Spot Atual</span>
                            <span className="text-white font-medium">{currentSpotPriceKz.toFixed(2)} KZ</span>
                          </div>
                        )}
                        <div className="flex justify-between text-[#8b96a6]">
                          <span>Preço Médio Est.</span>
                          <span className="text-white font-semibold">{avgExecPriceKz.toFixed(2)} KZ</span>
                        </div>
                        <div className="flex justify-between text-[#8b96a6]">
                          <span>{isBuying ? 'Shares Estimadas' : 'Líquido a Receber (-1%)'}</span>
                          <span className="text-white font-semibold">
                            {isBuying
                              ? estimatedShares.toLocaleString('pt-AO', { maximumFractionDigits: 4 })
                              : `${potentialReturnKz.toLocaleString('pt-AO', { maximumFractionDigits: 2 })} KZ`}
                          </span>
                        </div>
                        {isBuying && (
                          <div className="flex justify-between text-[#8b96a6]">
                            <span>Retorno se Vencer (Líq. / Bruto)</span>
                            <span className="text-[#3dd68c] font-semibold">
                              {potentialReturnKz.toLocaleString('pt-AO', { maximumFractionDigits: 2 })} KZ
                            </span>
                          </div>
                        )}
                        <div className="flex justify-between text-[#6e7b8b] text-[11px] pt-1 border-t border-[#222a35]">
                          <span>Taxa Operacional (1%)</span>
                          <span>{estimatedFeeKz.toFixed(2)} KZ</span>
                        </div>
                      </div>
                    )}

                    {/* PRICE_CHANGED Slippage Confirmation Alert */}
                    {priceChangedAlert && (
                      <div className="bg-amber-500/10 border border-amber-500/40 rounded-xl p-3 space-y-2.5 text-xs">
                        <div className="flex items-start gap-2 text-amber-300">
                          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                          <div className="space-y-0.5">
                            <div className="font-bold">Cotação Atualizada ({priceChangedAlert.oldPrice.toFixed(2)} → {priceChangedAlert.newPrice.toFixed(2)} KZ)</div>
                            <p className="text-[11px] text-amber-200/80 leading-snug">
                              {priceChangedAlert.message}
                            </p>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            disabled={isPending}
                            onClick={() => {
                              setPriceChangedAlert(null);
                              handleExecuteTrade();
                            }}
                            className="flex-1 py-2 bg-amber-500 hover:bg-amber-400 text-black font-bold text-xs rounded-lg transition-colors"
                          >
                            Confirmar Nova Cotação ({currentSpotPriceKz.toFixed(2)} KZ)
                          </button>
                          <button
                            type="button"
                            onClick={() => setPriceChangedAlert(null)}
                            className="px-3 py-2 bg-[#14191f] text-[#8b96a6] hover:text-white rounded-lg text-xs font-semibold"
                          >
                            Cancelar
                          </button>
                        </div>
                      </div>
                    )}

                    {/* Primary CTA Button (Polymarket Vibrant Blue) */}
                    <button
                      type="button"
                      onClick={handleExecuteTrade}
                      disabled={
                        Boolean(effectiveMarket?.resolved ?? market.resolved) ||
                        (Boolean(user) && (isTradingBlocked || isPending || amountValue <= 0))
                      }
                      className="w-full py-3.5 bg-[#1a73e8] hover:bg-[#1967d2] disabled:bg-[#2a3442] disabled:text-[#6e7b8b] text-white font-semibold text-sm rounded-xl transition-colors flex items-center justify-center gap-2"
                    >
                      {isPending && <Loader2 className="w-4 h-4 animate-spin" />}
                      {!user
                        ? 'Entrar para Negociar'
                        : (effectiveMarket?.resolved ?? market.resolved)
                          ? 'Mercado Resolvido'
                          : isPending
                            ? 'A processar...'
                            : !isMulti && orderType === 'Limit'
                              ? 'Registar Ordem Limite'
                              : isBuying
                                ? user.balance < estimatedTotalCostKz
                                  ? 'Depositar Saldo'
                                  : `Comprar ${isMulti ? (binarySide === 'Yes' ? 'Sim' : 'Não') : outcome === 'Yes' ? 'Sim' : 'Não'}`
                                : `Vender ${isMulti ? (binarySide === 'Yes' ? 'Sim' : 'Não') : outcome === 'Yes' ? 'Sim' : 'Não'}`}
                    </button>

                    <p className="text-center text-[11px] text-[#7c8b9e]">
                      Ao negociar, concorda com os <Link to="/learn" className="underline hover:text-white">Termos de Uso</Link>.
                    </p>
                  </div>
                </>
              )}
            </div>

            {/* RELATED MARKETS CARD (Exact bottom-right sidebar widget) */}
            {relatedMarketsData.items.length > 0 && (
              <div className="bg-[#1b222c] border border-[#28313e] rounded-2xl p-4 space-y-3">
                <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar pb-1">
                  {relatedMarketsData.chips.map((chip) => (
                    <button
                      key={chip}
                      type="button"
                      onClick={() => setRelatedFilter(chip)}
                      className={cx(
                        'px-2.5 py-1 rounded-lg text-xs font-semibold whitespace-nowrap shrink-0 transition-colors',
                        relatedFilter === chip
                          ? 'bg-white text-[#14191f]'
                          : 'bg-[#242d3a] text-[#9aa8b8] hover:text-white'
                      )}
                    >
                      {chip}
                    </button>
                  ))}
                </div>

                <div className="divide-y divide-[#242c37]">
                  {relatedMarketsData.items.map((rel) => {
                    const topProb = rel.is_multi && rel.outcomes?.length
                      ? Math.round(Math.max(...rel.outcomes.map((o) => Number(o.price || 0))) * 100)
                      : Math.round(Number(rel.yes_price || 0.5) * 100);
                    return (
                      <Link
                        key={rel.id}
                        to={`/market/${rel.id}`}
                        className="py-3 flex items-center justify-between gap-3 hover:opacity-90 transition-opacity"
                      >
                        <div className="flex items-center gap-2.5 min-w-0">
                          <LocalThumb
                            src={rel.image_url}
                            alt={rel.question}
                            isCrypto={rel.category === 'Cripto' || rel.category === 'Crypto'}
                            className="w-8 h-8 rounded-lg"
                          />
                          <span className="text-xs font-medium text-[#d4dde7] line-clamp-2 leading-snug">
                            {rel.question}
                          </span>
                        </div>
                        <span className="text-sm font-bold text-white tabular-nums shrink-0">{topProb}%</span>
                      </Link>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Embed Code Modal */}
      {showEmbedModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
          <div onClick={() => setShowEmbedModal(false)} className="absolute inset-0 bg-black/75 backdrop-blur-sm" />
          <div className="relative w-full max-w-md bg-[#1b222c] border border-[#2d3745] rounded-2xl p-5 space-y-4 shadow-2xl">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-white">Incorporar Mercado</h3>
              <button
                type="button"
                onClick={() => setShowEmbedModal(false)}
                className="p-1 text-[#8b96a6] hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <p className="text-xs text-[#8b96a6]">
              Copie o código abaixo para incorporar este mercado num website ou artigo externo.
            </p>
            <pre className="bg-[#14191f] border border-[#252d38] rounded-xl p-3 text-[11px] font-mono text-[#c5d0de] overflow-x-auto">
              {`<iframe src="${window.location.origin}/market/${market.id}" width="100%" height="520" frameborder="0"></iframe>`}
            </pre>
            <button
              type="button"
              onClick={() => {
                navigator.clipboard?.writeText(
                  `<iframe src="${window.location.origin}/market/${market.id}" width="100%" height="520" frameborder="0"></iframe>`
                ).catch(() => {});
                addToast('Código de incorporação copiado.', 'success');
                setShowEmbedModal(false);
              }}
              className="w-full py-2.5 bg-[#1a73e8] text-white text-xs font-semibold rounded-xl flex items-center justify-center gap-1.5"
            >
              <Check className="w-3.5 h-3.5" /> Copiar código
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
