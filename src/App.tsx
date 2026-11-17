import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { BrowserRouter as Router, Routes, Route, Link, useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { 
  Search, 
  Wallet, 
  TrendingUp, 
  ChevronRight, 
  ChevronLeft,
  Link2,
  BarChart3, 
  Clock, 
  ArrowUpRight, 
  ArrowDownRight,
  Menu,
  X,
  Loader2,
  LayoutGrid,
  History,
  User as UserIcon,
  Info,
  Flame,
  Zap,
  Star,
  Globe,
  Shield,
  Coins,
  Trophy,
  Landmark,
  Cpu,
  Music,
  Cloud,
  Vote,
  Bell,
  Share2,
  Bookmark,
  MessageSquare,
  ArrowRight,
  Newspaper,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  ArrowDownToLine,
  ArrowUpFromLine,
  Percent,
  Lock,
  Unlock,
  Plus,
  Edit,
  Trash2,
  RefreshCw,
  Gift,
  ArrowUp,
  ArrowDown,
  LineChart as LineChartIcon,
  PieChart as PieChartIcon,
  ChevronDown,
  ChevronUp,
  Code,
  Activity,
  Bitcoin,
  CandlestickChart,
  ScrollText,
  Users,
  Eye,
  EyeOff,
  Database,
  Copy,
  ExternalLink,
  ShieldCheck
} from 'lucide-react';
import { 
  ResponsiveContainer, 
  LineChart, 
  Line, 
  XAxis, 
  YAxis, 
  CartesianGrid, 
  Tooltip, 
  Legend,
  AreaChart,
  Area,
  BarChart,
  Bar,
  Cell,
  ReferenceLine
} from 'recharts';
import { motion, AnimatePresence } from 'motion/react';
import { format, formatDistanceToNow } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { Market, Trade, User, Position, Outcome, Comment, PriceHistory, Category } from './types';
import { CATEGORIES } from './constants';

import { 
  supabaseService as firebaseService, 
  calculatePrices, 
  calculateShares 
} from './lib/supabase-service';
import {
  quoteCpmmBuy,
  getCpmmSpotPricesKz,
  SHARE_SETTLEMENT_KZ,
  WITHDRAWAL_FEE_RATE,
  INITIAL_LP_PAIRS,
  MARKET_CREATION_LIQUIDITY_KZ,
} from './lib/cpmm-math';
import { ammApi } from './lib/amm-api';
import { formatKz, sanitizePlainText } from './lib/sanitize';
import {
  supabase,
  isSupabaseConfigured,
  translateSupabaseAuthError,
  validatePasswordStrength,
  processOAuthCallbackParams,
  logoutAllDevices,
} from './supabase';

import { LoginPage } from './components/LoginPage';
import { UserProfile } from './components/UserProfile';
import { AdminDashboard } from './components/AdminDashboard';
import { CreateMarketPage } from './components/CreateMarketPage';
import { MarketDetailView } from './components/market/MarketDetailView';
import { PortfolioView } from './components/portfolio/PortfolioView';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// --- Components ---

const MarketThumb = ({
  src,
  alt = '',
  className = 'w-9 h-9 rounded-lg',
  isCrypto = false,
}: {
  src?: string;
  alt?: string;
  className?: string;
  isCrypto?: boolean;
}) => {
  const [failed, setFailed] = useState(false);

  if (isCrypto) {
    return (
      <div className={cn('bg-market-card-lighter border border-market-border flex items-center justify-center shrink-0', className)}>
        <Bitcoin className="w-5 h-5 text-[#F7931A]" />
      </div>
    );
  }

  if (!src || failed) {
    return (
      <div className={cn('bg-market-card-lighter border border-market-border flex items-center justify-center shrink-0 text-market-text-muted', className)}>
        <BarChart3 className="w-4 h-4" />
      </div>
    );
  }

  return (
    <img
      src={src}
      alt={alt}
      onError={() => setFailed(true)}
      className={cn('object-cover border border-market-border shrink-0', className)}
      referrerPolicy="no-referrer"
    />
  );
};

const SearchModal = ({
  isOpen,
  onClose,
  onSearch,
  markets,
  categories,
}: {
  isOpen: boolean;
  onClose: () => void;
  onSearch: (val: string) => void;
  markets: Market[];
  categories: Category[];
}) => {
  const [query, setQuery] = useState('');
  const navigate = useNavigate();

  if (!isOpen) return null;

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    onSearch(query);
    onClose();
    navigate('/');
  };

  const quickResults = query.trim()
    ? markets
        .filter(
          (m) =>
            m.status !== 'hidden' &&
            ((m.question || '').toLowerCase().includes(query.toLowerCase()) ||
              (m.category || '').toLowerCase().includes(query.toLowerCase()))
        )
        .slice(0, 5)
    : [];

  const activeCategoryNames = categories
    .filter((c) => c.status !== 'hidden')
    .map((c) => c.name);
  const topicList = activeCategoryNames.length > 0 ? activeCategoryNames.slice(0, 8) : CATEGORIES.slice(0, 8);

  return (
    <div className="fixed inset-0 z-[100] flex items-start justify-center pt-20 px-4">
      <div onClick={onClose} className="absolute inset-0 bg-market-bg/85 backdrop-blur-sm" />
      <div className="relative w-full max-w-xl bg-market-card border border-market-border rounded-2xl shadow-2xl overflow-hidden">
        <form onSubmit={handleSearch} className="p-4 border-b border-market-border flex items-center gap-3">
          <Search className="w-5 h-5 text-market-text-muted shrink-0" />
          <input
            autoFocus
            type="text"
            placeholder="Pesquisar mercados..."
            className="flex-1 bg-transparent border-none outline-none text-base text-white font-medium"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              className="text-xs text-market-text-muted hover:text-white px-2 py-1"
            >
              Limpar
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 hover:bg-market-card-lighter rounded-lg transition-colors"
            aria-label="Fechar"
          >
            <X className="w-5 h-5 text-market-text-muted" />
          </button>
        </form>

        <div className="p-5 space-y-5 max-h-[65vh] overflow-y-auto no-scrollbar">
          {quickResults.length > 0 && (
            <div className="space-y-2">
              <div className="text-xs font-semibold text-market-text-muted">Resultados</div>
              <div className="divide-y divide-market-border/50 border border-market-border rounded-xl overflow-hidden">
                {quickResults.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => {
                      onClose();
                      navigate(`/market/${m.id}`);
                    }}
                    className="w-full flex items-center justify-between gap-3 p-3 bg-market-bg/40 hover:bg-market-card-lighter text-left transition-colors"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <MarketThumb src={m.image_url} className="w-8 h-8 rounded-md" isCrypto={m.category === 'Cripto'} />
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-white truncate">{m.question}</div>
                        <div className="text-xs text-market-text-muted">{m.category}</div>
                      </div>
                    </div>
                    <span className="text-sm font-semibold text-market-green tabular-nums shrink-0">
                      {Math.round(m.yes_price * 100)}%
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="space-y-2.5">
            <div className="text-xs font-semibold text-market-text-muted">Categorias</div>
            <div className="flex flex-wrap gap-2">
              {topicList.map((topic) => (
                <button
                  key={topic}
                  type="button"
                  onClick={() => {
                    onSearch(topic);
                    onClose();
                    navigate('/');
                  }}
                  className="px-3 py-1.5 bg-market-card-lighter hover:bg-market-border rounded-lg text-xs font-medium text-white transition-colors border border-market-border"
                >
                  {topic}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

const Navbar = ({
  user,
  onOpenSearch,
}: {
  user: User | null;
  onOpenSearch: () => void;
}) => {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const navLinks = [
    { to: '/', label: 'Mercados' },
    { to: '/portfolio', label: 'Portfólio' },
    { to: '/activity', label: 'Atividade' },
    { to: '/leaderboard', label: 'Classificação' },
    { to: '/learn', label: 'Aprender' },
    ...(user ? [{ to: '/criar-mercado', label: 'Criar Mercado' }] : []),
    ...(user?.is_admin ? [{ to: '/admin', label: 'Admin' }] : []),
  ];

  return (
    <header className="sticky top-0 z-50 bg-market-bg/95 backdrop-blur-sm border-b border-market-border">
      <nav className="max-w-7xl mx-auto h-16 px-4 md:px-8 flex items-center justify-between gap-4">
        <div className="flex items-center gap-6 min-w-0">
          <Link to="/" className="flex items-center gap-2.5 shrink-0">
            <div className="w-8 h-8 bg-market-green rounded-lg flex items-center justify-center text-market-bg font-bold text-base">
              MP
            </div>
            <span className="font-bold text-lg tracking-tight text-white">MarketPay</span>
          </Link>

          <div className="hidden lg:flex items-center gap-1">
            {navLinks.map((item) => (
              <Link
                key={item.to}
                to={item.to}
                className={cn(
                  'px-3 py-1.5 rounded-lg text-sm font-medium transition-colors whitespace-nowrap',
                  item.to === '/criar-mercado'
                    ? 'text-market-green hover:bg-market-green/10'
                    : 'text-market-text-muted hover:text-white hover:bg-market-card-lighter'
                )}
              >
                {item.label}
              </Link>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-3 shrink-0">
          <button
            type="button"
            onClick={onOpenSearch}
            className="flex items-center gap-2 px-3 py-1.5 bg-market-card border border-market-border rounded-lg text-sm text-market-text-muted hover:text-white hover:border-market-green/50 transition-colors"
            title="Pesquisar mercados"
          >
            <Search className="w-4 h-4" />
            <span className="hidden sm:inline">Pesquisar</span>
          </button>

          {!user ? (
            <Link to="/login" className="market-button-primary flex items-center gap-2 text-sm">
              <UserIcon className="w-4 h-4" />
              Entrar
            </Link>
          ) : (
            <Link
              to="/profile"
              className="flex items-center gap-2.5 pl-3 pr-1.5 py-1 bg-market-card border border-market-border rounded-full hover:border-market-green/50 transition-colors"
            >
              <span className="text-xs font-semibold text-market-green tabular-nums">
                {user.balance.toLocaleString('pt-AO')} KZ
              </span>
              <span className="hidden sm:inline text-xs font-medium text-white max-w-[110px] truncate">
                {user.name}
              </span>
              <div className="w-7 h-7 bg-market-card-lighter rounded-full flex items-center justify-center">
                <UserIcon className="w-4 h-4 text-market-text-muted" />
              </div>
            </Link>
          )}

          <button
            type="button"
            onClick={() => setMobileMenuOpen((v) => !v)}
            className="lg:hidden p-2 bg-market-card border border-market-border rounded-lg text-market-text-muted hover:text-white"
            aria-label="Menu"
          >
            {mobileMenuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
          </button>
        </div>
      </nav>

      {mobileMenuOpen && (
        <div className="lg:hidden border-t border-market-border bg-market-card px-4 py-3 flex flex-wrap gap-2">
          {navLinks.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              onClick={() => setMobileMenuOpen(false)}
              className="px-3 py-1.5 rounded-lg text-sm font-medium text-market-text-muted hover:text-white hover:bg-market-card-lighter"
            >
              {item.label}
            </Link>
          ))}
        </div>
      )}
    </header>
  );
};

const MarketCard: React.FC<{ market: Market; addToast: any }> = ({ market, addToast }) => {
  const navigate = useNavigate();
  const yesPct = Math.round((market.yes_price || 0.5) * 100);
  const noPct = Math.max(0, 100 - yesPct);

  return (
    <div className="market-card p-5 flex flex-col justify-between gap-4 hover:border-market-green/40 transition-colors">
      <div className="space-y-4">
        {/* Header */}
        <div
          className="flex items-start gap-3 cursor-pointer group"
          onClick={() => navigate(`/market/${market.id}`)}
        >
          <MarketThumb src={market.image_url} className="w-10 h-10 rounded-lg mt-0.5" />
          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-semibold text-white line-clamp-2 leading-snug group-hover:text-market-green transition-colors">
              {market.question}
            </h3>
          </div>
        </div>

        {/* Outcomes */}
        <div className="space-y-2">
          {market.is_multi && market.outcomes?.length ? (
            market.outcomes.slice(0, 2).map((outcome) => (
              <div key={outcome.id} className="flex items-center justify-between gap-2 text-sm">
                <span className="text-market-text-muted truncate flex-1">{outcome.name}</span>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="font-semibold text-white tabular-nums w-10 text-right">
                    {Math.round(outcome.price * 100)}%
                  </span>
                  <Link
                    to={`/market/${market.id}?outcome=${encodeURIComponent(outcome.name)}&side=Yes&type=buy`}
                    className="px-2.5 py-1 bg-market-green/10 text-market-green hover:bg-market-green hover:text-market-bg text-xs font-semibold rounded-md transition-colors"
                  >
                    Sim
                  </Link>
                </div>
              </div>
            ))
          ) : (
            <div className="grid grid-cols-2 gap-2.5">
              <Link
                to={`/market/${market.id}?outcome=Yes&type=buy`}
                className="flex items-center justify-between px-3 py-2 rounded-lg bg-market-green/10 hover:bg-market-green/20 border border-market-green/20 transition-colors"
              >
                <span className="text-xs font-semibold text-market-green">Sim</span>
                <span className="text-sm font-bold text-white tabular-nums">{yesPct}%</span>
              </Link>
              <Link
                to={`/market/${market.id}?outcome=No&type=buy`}
                className="flex items-center justify-between px-3 py-2 rounded-lg bg-market-red/10 hover:bg-market-red/20 border border-market-red/20 transition-colors"
              >
                <span className="text-xs font-semibold text-market-red">Não</span>
                <span className="text-sm font-bold text-white tabular-nums">{noPct}%</span>
              </Link>
            </div>
          )}
        </div>
      </div>

      {/* Footer */}
      <div className="pt-3 border-t border-market-border/60 flex items-center justify-between gap-2 text-xs text-market-text-muted">
        <div className="truncate tabular-nums">
          <span>{market.category || 'Geral'}</span>
          <span className="mx-1.5 opacity-40">·</span>
          <span>{(market.volume || 0).toLocaleString('pt-AO')} KZ vol.</span>
        </div>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            navigator.clipboard.writeText(`${window.location.origin}/market/${market.id}`);
            addToast('Link do mercado copiado!', 'success');
          }}
          className="p-1.5 hover:bg-market-card-lighter rounded-lg hover:text-white transition-colors shrink-0"
          title="Partilhar mercado"
        >
          <Share2 className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
};

// --- Pages ---

const ActivityPage = ({ trades, markets }: { trades: any[]; markets: Market[] }) => {
  return (
    <div className="max-w-4xl mx-auto space-y-6 py-8 px-4 md:px-8">
      <div>
        <h1 className="text-2xl font-bold text-white">Atividade Recente</h1>
        <p className="text-sm text-market-text-muted mt-1">Últimas negociações executadas nos mercados.</p>
      </div>

      <div className="market-card divide-y divide-market-border">
        {trades.map((trade) => {
          const market = markets.find((m) => m.id === trade.market_id);
          const isBuy = trade.side === 'Buy' || trade.side === 'Compra';
          const isYes = trade.outcome === 'Yes' || trade.outcome === 'Sim';
          return (
            <Link
              key={trade.id}
              to={market ? `/market/${market.id}` : '/'}
              className="p-4 md:p-5 flex items-center gap-4 hover:bg-market-card-lighter transition-colors"
            >
              <div
                className={cn(
                  'w-9 h-9 rounded-full flex items-center justify-center shrink-0',
                  isBuy ? 'bg-market-green/10 text-market-green' : 'bg-market-red/10 text-market-red'
                )}
              >
                {isBuy ? <ArrowUpRight className="w-4 h-4" /> : <ArrowDownRight className="w-4 h-4" />}
              </div>
              <div className="flex-1 min-w-0 space-y-1">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm text-white truncate">
                    <span className="font-semibold">{trade.user_id?.slice(0, 6) || 'Trader'}</span>{' '}
                    <span className="text-market-text-muted">{isBuy ? 'comprou' : 'vendeu'}</span>{' '}
                    <span className={cn('font-semibold', isYes ? 'text-market-green' : 'text-market-red')}>
                      {isYes ? 'Sim' : 'Não'}
                    </span>{' '}
                    <span className="text-market-text-muted">por</span>{' '}
                    <span className="font-semibold tabular-nums">
                      {Number(trade.amount || 0).toLocaleString('pt-AO')} KZ
                    </span>
                  </p>
                  <span className="text-xs text-market-text-muted shrink-0">{trade.time}</span>
                </div>
                <p className="text-xs text-market-text-muted truncate">
                  {market?.question || 'Mercado'}
                </p>
              </div>
            </Link>
          );
        })}
        {trades.length === 0 && (
          <div className="p-12 text-center text-sm text-market-text-muted">Nenhuma atividade recente.</div>
        )}
      </div>
    </div>
  );
};

const LearnPage = () => {
  const [simPoolYes, setSimPoolYes] = useState<number>(INITIAL_LP_PAIRS);
  const [simPoolNo, setSimPoolNo] = useState<number>(INITIAL_LP_PAIRS);
  const [simAmount, setSimAmount] = useState<number>(500);
  const [simOutcome, setSimOutcome] = useState<'Yes' | 'No'>('Yes');

  const simQuote = useMemo(
    () =>
      quoteCpmmBuy({
        poolYes: simPoolYes > 0 ? simPoolYes : INITIAL_LP_PAIRS,
        poolNo: simPoolNo > 0 ? simPoolNo : INITIAL_LP_PAIRS,
        outcome: simOutcome,
        grossAmountKz: Math.max(1, simAmount),
      }),
    [simPoolYes, simPoolNo, simAmount, simOutcome]
  );

  const spotsAfter = useMemo(
    () => getCpmmSpotPricesKz(simQuote.newPoolYes, simQuote.newPoolNo),
    [simQuote.newPoolYes, simQuote.newPoolNo]
  );

  const priceBeforeKz = simQuote.spotPriceBeforeKz;
  const priceAfterKz = simQuote.spotPriceAfterKz;
  const priceImpactKz = priceAfterKz - priceBeforeKz;

  return (
    <div className="max-w-5xl mx-auto space-y-10 py-10 px-4 md:px-8">
      <div className="space-y-2">
        <h1 className="text-2xl md:text-3xl font-bold text-white">Como Funciona o MarketPay</h1>
        <p className="text-sm text-market-text-muted max-w-2xl">
          Negocie previsões em Kwanza (KZ) com motor AMM CPMM (x · y = k). Cada share vencedora vale exatamente {SHARE_SETTLEMENT_KZ.toLocaleString('pt-AO')},00 KZ brutos ({(SHARE_SETTLEMENT_KZ * (1 - WITHDRAWAL_FEE_RATE)).toFixed(2)} KZ líquidos após 1%) no encerramento.
        </p>
      </div>

      {/* Interactive CPMM Simulator */}
      <section className="market-card p-6 md:p-8 space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="space-y-1">
            <h2 className="text-lg font-bold text-white">Simulador de Preço (AMM CPMM: x · y = k)</h2>
            <p className="text-xs text-market-text-muted">
              Cada mercado nasce com {MARKET_CREATION_LIQUIDITY_KZ.toLocaleString('pt-AO')},00 KZ no cofre ({INITIAL_LP_PAIRS} pares SIM + NÃO a 50,00 KZ cada). Taxa operacional de 1%.
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              setSimPoolYes(INITIAL_LP_PAIRS);
              setSimPoolNo(INITIAL_LP_PAIRS);
              setSimAmount(500);
            }}
            className="px-3 py-1.5 rounded-lg bg-market-bg border border-market-border text-xs font-semibold text-market-text-muted hover:text-white transition-colors"
          >
            Repor 20 / 20
          </button>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          <div className="lg:col-span-5 space-y-4 bg-market-bg/60 border border-market-border p-5 rounded-xl">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-market-text-muted block">Pool SIM (Shares)</label>
                <input
                  type="number"
                  min="1"
                  step="any"
                  value={simPoolYes}
                  onChange={(e) => setSimPoolYes(Math.max(1, Number(e.target.value)))}
                  className="market-input font-mono tabular-nums"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-market-text-muted block">Pool NÃO (Shares)</label>
                <input
                  type="number"
                  min="1"
                  step="any"
                  value={simPoolNo}
                  onChange={(e) => setSimPoolNo(Math.max(1, Number(e.target.value)))}
                  className="market-input font-mono tabular-nums"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2.5 pt-1">
              <button
                type="button"
                onClick={() => setSimOutcome('Yes')}
                className={cn(
                  'py-2.5 rounded-lg font-semibold text-xs border transition-colors',
                  simOutcome === 'Yes'
                    ? 'bg-market-green/15 border-market-green text-market-green'
                    : 'bg-market-bg border-market-border text-market-text-muted hover:text-white'
                )}
              >
                Comprar Sim
              </button>
              <button
                type="button"
                onClick={() => setSimOutcome('No')}
                className={cn(
                  'py-2.5 rounded-lg font-semibold text-xs border transition-colors',
                  simOutcome === 'No'
                    ? 'bg-market-red/15 border-market-red text-market-red'
                    : 'bg-market-bg border-market-border text-market-text-muted hover:text-white'
                )}
              >
                Comprar Não
              </button>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-market-text-muted block">Valor Bruto da Compra (KZ)</label>
              <input
                type="number"
                min="10"
                step="50"
                value={simAmount}
                onChange={(e) => setSimAmount(Math.max(1, Number(e.target.value)))}
                className="market-input font-mono tabular-nums"
              />
              <div className="flex justify-between text-[11px] text-market-text-muted tabular-nums pt-0.5">
                <span>Taxa (1%): {simQuote.feeKz.toFixed(2)} KZ</span>
                <span>Líquido no AMM: {simQuote.netAmountKz.toFixed(2)} KZ</span>
              </div>
            </div>
          </div>

          <div className="lg:col-span-7 space-y-5 flex flex-col justify-between">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="bg-market-bg/60 border border-market-border p-4 rounded-xl">
                <span className="text-xs text-market-text-muted block">Preço Spot Anterior</span>
                <div className="text-xl font-bold text-white font-mono tabular-nums mt-1">
                  {priceBeforeKz.toFixed(2)} KZ
                </div>
                <span className="text-[11px] text-market-text-muted tabular-nums">
                  {Math.round(priceBeforeKz)}% prob. implícita
                </span>
              </div>
              <div className="bg-market-bg/60 border border-market-border p-4 rounded-xl">
                <span className="text-xs text-market-text-muted block">Novo Preço Spot</span>
                <div className="text-xl font-bold text-market-green font-mono tabular-nums mt-1">
                  {priceAfterKz.toFixed(2)} KZ
                </div>
                <span className="text-xs text-market-green tabular-nums">
                  {priceImpactKz >= 0 ? '+' : ''}{priceImpactKz.toFixed(2)} KZ impacto
                </span>
              </div>
              <div className="bg-market-bg/60 border border-market-border p-4 rounded-xl">
                <span className="text-xs text-market-text-muted block">Shares Recebidas</span>
                <div className="text-xl font-bold text-[#0095FF] font-mono tabular-nums mt-1">
                  {simQuote.sharesReceived.toLocaleString('pt-AO', { maximumFractionDigits: 4 })}
                </div>
                <span className="text-[11px] text-market-text-muted tabular-nums">
                  Média {simQuote.avgExecPriceKz.toFixed(2)} KZ · Prémio {simQuote.netPayoutIfWinKz.toFixed(0)} KZ
                </span>
              </div>
            </div>

            <div className="space-y-3 bg-market-bg/60 border border-market-border p-4 rounded-xl">
              <div className="space-y-1">
                <div className="flex justify-between text-xs font-medium">
                  <span className="text-market-green">Pool SIM ({spotsAfter.yesPriceKz.toFixed(2)} KZ pós-ordem)</span>
                  <span className="text-white font-mono tabular-nums">
                    {simPoolYes.toFixed(2)} → {simQuote.newPoolYes.toFixed(2)}
                  </span>
                </div>
                <div className="w-full bg-market-card-lighter h-2.5 rounded-full overflow-hidden">
                  <div
                    className="bg-market-green h-full transition-all"
                    style={{ width: `${Math.min(100, (simQuote.newPoolYes / (simQuote.newPoolYes + simQuote.newPoolNo || 1)) * 100)}%` }}
                  />
                </div>
              </div>

              <div className="space-y-1">
                <div className="flex justify-between text-xs font-medium">
                  <span className="text-market-red">Pool NÃO ({spotsAfter.noPriceKz.toFixed(2)} KZ pós-ordem)</span>
                  <span className="text-white font-mono tabular-nums">
                    {simPoolNo.toFixed(2)} → {simQuote.newPoolNo.toFixed(2)}
                  </span>
                </div>
                <div className="w-full bg-market-card-lighter h-2.5 rounded-full overflow-hidden">
                  <div
                    className="bg-market-red h-full transition-all"
                    style={{ width: `${Math.min(100, (simQuote.newPoolNo / (simQuote.newPoolYes + simQuote.newPoolNo || 1)) * 100)}%` }}
                  />
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="grid grid-cols-1 md:grid-cols-3 gap-5">
        <div className="market-card p-6 space-y-2">
          <div className="text-sm font-bold text-market-green">1. Preço = Probabilidade (1–99 KZ)</div>
          <p className="text-xs text-market-text-muted leading-relaxed">
            Os preços variam entre 1,00 KZ e 99,00 KZ (ex: 54,00 KZ = 54%). Cada par completo (1 SIM + 1 NÃO) mantém lastro exato de 100,00 KZ no cofre.
          </p>
        </div>
        <div className="market-card p-6 space-y-2">
          <div className="text-sm font-bold text-[#0095FF]">2. Proteção Atómica & Slippage</div>
          <p className="text-xs text-market-text-muted leading-relaxed">
            Compras simultâneas são serializadas na base de dados com bloqueio pessimista (FOR UPDATE) e proteção contra alteração de preço no clique.
          </p>
        </div>
        <div className="market-card p-6 space-y-2">
          <div className="text-sm font-bold text-white">3. Liquidação em 100,00 KZ (-1%)</div>
          <p className="text-xs text-market-text-muted leading-relaxed">
            No encerramento, cada share vencedora liquida 100,00 KZ brutos (99,00 KZ líquidos após taxa de 1% de retirada) diretamente na carteira.
          </p>
        </div>
      </section>

      <div className="market-card p-8 flex flex-col sm:flex-row items-center justify-between gap-4">
        <div>
          <h3 className="text-lg font-bold text-white">Pronto para negociar?</h3>
          <p className="text-sm text-market-text-muted">Explore os mercados ativos e faça a sua previsão.</p>
        </div>
        <Link to="/" className="market-button-primary px-6 py-2.5">
          Explorar Mercados
        </Link>
      </div>
    </div>
  );
};

const HomePage = ({
  markets,
  search,
  activeCategory,
  onCategoryChange,
  categories,
  posts,
  onSearchChange,
  addToast,
  user,
}: {
  markets: Market[];
  search: string;
  activeCategory: string;
  onCategoryChange: (cat: string) => void;
  categories: Category[];
  posts: any[];
  trades: any[];
  onSearchChange: (val: string) => void;
  addToast: any;
  user: User | null;
}) => {
  const [visibleMarketsCount, setVisibleMarketsCount] = useState(9);
  const [selectedPost, setSelectedPost] = useState<any | null>(null);
  const [homeSearchParams] = useSearchParams();

  useEffect(() => {
    const catParam = homeSearchParams.get('category');
    if (catParam) {
      onCategoryChange(catParam);
    }
  }, [homeSearchParams]);

  const categoryTabs = useMemo(() => {
    const dbNames = (categories || [])
      .filter((c) => c.status !== 'hidden')
      .map((c) => c.name);
    const base = ['Todos', 'Em Alta', 'Angola', 'Economia', 'Finanças', 'Política', 'Crypto', 'Desporto', 'Tech'];
    return Array.from(new Set([...base, ...dbNames]));
  }, [categories]);

  const filteredMarkets = useMemo(() => {
    let result = [...(markets || [])];
    const hiddenCategoryNames = (categories || [])
      .filter((c) => c.status === 'hidden')
      .map((c) => c.name);
    result = result.filter((m) => m.status !== 'hidden' && !hiddenCategoryNames.includes(m.category));

    if (activeCategory === 'Em Alta') {
      result.sort((a, b) => (b.volume || 0) - (a.volume || 0));
    } else if (activeCategory !== 'Todos') {
      result = result.filter(
        (m) => m.category === activeCategory || (m.tags || []).includes(activeCategory)
      );
    }

    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter(
        (m) =>
          (m.question || '').toLowerCase().includes(q) ||
          (m.category || '').toLowerCase().includes(q) ||
          (m.tags || []).some((t) => t.toLowerCase().includes(q))
      );
    }

    return result;
  }, [markets, activeCategory, search, categories]);

  return (
    <div className="max-w-7xl mx-auto px-4 md:px-8 py-8 space-y-8">
      {/* Page Header + Direct Search */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white">Mercados de Previsão</h1>
          <p className="text-sm text-market-text-muted mt-0.5">
            Preveja resultados reais e negocie quotas em Kwanza (KZ).
          </p>
        </div>

        <div className="flex items-center gap-3">
          <div className="relative w-full md:w-72">
            <Search className="w-4 h-4 text-market-text-muted absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={search}
              onChange={(e) => onSearchChange(e.target.value)}
              placeholder="Filtrar mercados..."
              className="market-input pl-9 pr-8 py-2"
            />
            {search && (
              <button
                type="button"
                onClick={() => onSearchChange('')}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-market-text-muted hover:text-white"
                aria-label="Limpar pesquisa"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>
          {user && (
            <Link to="/criar-mercado" className="market-button-primary text-sm flex items-center gap-1.5">
              <Plus className="w-4 h-4" />
              Criar
            </Link>
          )}
        </div>
      </div>

      {/* Category Filter Tabs */}
      <div className="flex items-center gap-2 overflow-x-auto no-scrollbar pb-1 border-b border-market-border">
        {categoryTabs.map((tab) => {
          const active = activeCategory === tab;
          return (
            <button
              key={tab}
              type="button"
              onClick={() => {
                onCategoryChange(tab);
                setVisibleMarketsCount(9);
              }}
              className={cn(
                'px-3.5 py-2 text-sm font-medium whitespace-nowrap border-b-2 -mb-[1px] transition-colors',
                active
                  ? 'border-market-green text-white'
                  : 'border-transparent text-market-text-muted hover:text-white'
              )}
            >
              {tab}
            </button>
          );
        })}
      </div>

      {/* Markets Grid */}
      <section className="space-y-6">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
          {filteredMarkets.slice(0, visibleMarketsCount).map((market) => (
            <MarketCard key={market.id} market={market} addToast={addToast} />
          ))}
        </div>

        {filteredMarkets.length === 0 && (
          <div className="market-card p-12 text-center space-y-3">
            <Search className="w-8 h-8 text-market-text-muted mx-auto" />
            <h3 className="text-base font-semibold text-white">Nenhum mercado encontrado</h3>
            <p className="text-sm text-market-text-muted">Ajuste a pesquisa ou selecione outra categoria.</p>
            <button
              type="button"
              onClick={() => {
                onSearchChange('');
                onCategoryChange('Todos');
              }}
              className="market-button-outline text-sm"
            >
              Mostrar Todos
            </button>
          </div>
        )}

        {visibleMarketsCount < filteredMarkets.length && (
          <div className="flex justify-center pt-2">
            <button
              type="button"
              onClick={() => setVisibleMarketsCount((prev) => prev + 9)}
              className="market-button-outline text-sm flex items-center gap-2"
            >
              Carregar mais mercados <ArrowRight className="w-4 h-4" />
            </button>
          </div>
        )}
      </section>

      {/* Optional News Section (only when posts exist in Supabase) */}
      {posts.length > 0 && (
        <section className="pt-4 border-t border-market-border space-y-4">
          <h2 className="text-lg font-bold text-white">Notícias e Análises</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
            {posts.slice(0, 3).map((post) => (
              <button
                key={post.id}
                type="button"
                onClick={() => setSelectedPost(post)}
                className="market-card p-5 text-left space-y-2.5 hover:border-market-green/40 transition-colors flex flex-col justify-between"
              >
                <div className="space-y-2">
                  <div className="text-xs text-market-green font-medium">
                    {post.category || 'Mercado'} · {new Date(post.created_at).toLocaleDateString('pt-AO')}
                  </div>
                  <h3 className="text-sm font-semibold text-white line-clamp-2">{post.title}</h3>
                  <p className="text-xs text-market-text-muted line-clamp-3 leading-relaxed">{post.content}</p>
                </div>
                <span className="text-xs font-semibold text-market-green inline-flex items-center gap-1 pt-1">
                  Ler análise <ChevronRight className="w-3.5 h-3.5" />
                </span>
              </button>
            ))}
          </div>
        </section>
      )}

      {/* Simple Post Reader Modal */}
      {selectedPost && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
          <div onClick={() => setSelectedPost(null)} className="absolute inset-0 bg-market-bg/85 backdrop-blur-sm" />
          <div className="relative w-full max-w-xl bg-market-card border border-market-border rounded-2xl p-6 space-y-4 max-h-[80vh] overflow-y-auto">
            <div className="flex items-start justify-between gap-4">
              <div>
                <span className="text-xs font-medium text-market-green">
                  {selectedPost.category} · {new Date(selectedPost.created_at).toLocaleDateString('pt-AO')}
                </span>
                <h3 className="text-lg font-bold text-white mt-1">{selectedPost.title}</h3>
              </div>
              <button
                type="button"
                onClick={() => setSelectedPost(null)}
                className="p-1.5 hover:bg-market-card-lighter rounded-lg text-market-text-muted hover:text-white"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <p className="text-sm text-market-text-muted leading-relaxed whitespace-pre-line">
              {selectedPost.content}
            </p>
          </div>
        </div>
      )}
    </div>
  );
};

const OrderBook = ({ 
  market, 
  outcome, 
  onOutcomeChange,
  trades = [],
  user = null,
  onOrderChange,
  refreshKey = 0,
  onSelectOrder,
  addToast,
}: { 
  market: Market; 
  outcome: string; 
  onOutcomeChange: (o: 'Yes' | 'No') => void; 
  trades?: any[];
  user?: User | null;
  onOrderChange?: () => void;
  refreshKey?: number;
  onSelectOrder?: (sel: { outcome: 'Yes' | 'No'; side: 'Buy' | 'Sell'; priceCents: number }) => void;
  addToast?: (msg: string, type?: 'success' | 'error' | 'info') => void;
}) => {
  const isYesSelected = outcome !== 'No';
  const [clobBook, setClobBook] = useState<any | null>(null);
  const [myOrders, setMyOrders] = useState<any[]>([]);
  const [cancellingId, setCancellingId] = useState<string | null>(null);

  const isMountedRef = useRef(true);
  const activeMarketIdRef = useRef<string | undefined>(market?.id);
  const loadSeqRef = useRef(0);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    activeMarketIdRef.current = market?.id;
    loadSeqRef.current += 1;
    setClobBook(null);
    setMyOrders([]);
  }, [market?.id]);

  const loadBook = useCallback(async () => {
    const targetMarketId = market?.id;
    if (!targetMarketId) return;
    const reqSeq = ++loadSeqRef.current;

    const bookPromise = ammApi.getOrderBook(targetMarketId).catch(() => null);
    const ordersPromise = user?.id
      ? ammApi.getMyClobOrders(targetMarketId).catch(() => ({ orders: [] }))
      : Promise.resolve({ orders: [] });

    const [book, myRes] = await Promise.all([bookPromise, ordersPromise]);
    if (!isMountedRef.current || activeMarketIdRef.current !== targetMarketId || reqSeq !== loadSeqRef.current) {
      return;
    }

    if (book) {
      setClobBook(book);
    }
    if (user?.id) {
      setMyOrders(
        (myRes?.orders || []).filter(
          (o: any) =>
            (o.status === 'OPEN' || o.status === 'PARTIAL') &&
            Number.isFinite(Number(o.price_cents)) &&
            Number(o.price_cents) >= 1 &&
            Number(o.price_cents) <= 99 &&
            Number(o.remaining_quantity) > 0
        )
      );
    } else {
      setMyOrders([]);
    }
  }, [market?.id, user?.id]);

  useEffect(() => {
    loadBook();
    const timer = setInterval(loadBook, 5000);
    return () => clearInterval(timer);
  }, [loadBook, trades.length, refreshKey]);

  const sideBook = useMemo(() => {
    if (!clobBook) return { bids: [], asks: [] };
    return isYesSelected ? (clobBook.yes || { bids: [], asks: [] }) : (clobBook.no || { bids: [], asks: [] });
  }, [clobBook, isYesSelected]);

  const bids = useMemo(() => {
    return (sideBook.bids || [])
      .map((b: any) => {
        const priceCents = Math.round(Number(b.price_cents));
        const size = Number(b.total_shares);
        if (!Number.isFinite(priceCents) || priceCents < 1 || priceCents > 99 || !Number.isFinite(size) || size <= 0) {
          return null;
        }
        return {
          priceCents,
          priceKz: priceCents / 100,
          size,
          ammShares: Math.max(0, Number(b.amm_shares || 0)),
          orderCount: Math.max(1, Number(b.order_count || 1)),
          totalKz: Number(((size * priceCents) / 100).toFixed(2)),
        };
      })
      .filter(Boolean)
      .sort((a: any, b: any) => b.priceCents - a.priceCents);
  }, [sideBook.bids]);

  const asks = useMemo(() => {
    return (sideBook.asks || [])
      .map((a: any) => {
        const priceCents = Math.round(Number(a.price_cents));
        const size = Number(a.total_shares);
        if (!Number.isFinite(priceCents) || priceCents < 1 || priceCents > 99 || !Number.isFinite(size) || size <= 0) {
          return null;
        }
        return {
          priceCents,
          priceKz: priceCents / 100,
          size,
          ammShares: Math.max(0, Number(a.amm_shares || 0)),
          orderCount: Math.max(1, Number(a.order_count || 1)),
          totalKz: Number(((size * priceCents) / 100).toFixed(2)),
        };
      })
      .filter(Boolean)
      .sort((a: any, b: any) => b.priceCents - a.priceCents);
  }, [sideBook.asks]);

  const fallbackPriceCents = Math.max(
    1,
    Math.min(99, Math.round((isYesSelected ? Number(market.yes_price || 0.5) : Number(market.no_price || 0.5)) * 100))
  );
  const hasRealClobBook = Boolean(clobBook?.hasMarketRecord || bids.length > 0 || asks.length > 0);
  const displayPriceCents = hasRealClobBook
    ? Number((isYesSelected ? clobBook?.yesPriceCents : clobBook?.noPriceCents) ?? fallbackPriceCents)
    : fallbackPriceCents;
  const displayPriceKz = Math.max(0.01, Math.min(0.99, displayPriceCents / 100));

  const bestAskCents = asks.length > 0 ? asks[asks.length - 1].priceCents : null;
  const bestBidCents = bids.length > 0 ? bids[0].priceCents : null;
  const spreadKz = bestAskCents !== null && bestBidCents !== null ? Math.max(0, bestAskCents - bestBidCents) / 100 : null;

  const maxAskSize = useMemo(() => Math.max(...asks.map((a: any) => a.size), 1), [asks]);
  const maxBidSize = useMemo(() => Math.max(...bids.map((b: any) => b.size), 1), [bids]);

  const handleCancelOrder = async (orderId: string) => {
    if (!orderId || cancellingId) return;
    setCancellingId(orderId);
    try {
      await ammApi.cancelClobOrder(orderId);
      await loadBook();
      addToast?.('Ordem cancelada e saldo/quotas libertados.', 'success');
      if (onOrderChange) onOrderChange();
    } catch (err: any) {
      addToast?.(err?.message || 'Erro ao cancelar ordem CLOB.', 'error');
    } finally {
      if (isMountedRef.current) setCancellingId(null);
    }
  };

  return (
    <div dir="ltr" className="market-card overflow-hidden bg-market-card border-market-border">
      {/* Tabs & Status */}
      <div className="px-5 py-3.5 border-b border-market-border flex flex-row items-center justify-between gap-4">
        <div className="flex flex-row items-center gap-5">
          <button
            type="button"
            onClick={() => onOutcomeChange('Yes')}
            className={cn(
              'text-sm font-semibold pb-1 border-b-2 transition-colors',
              isYesSelected ? 'border-market-green text-market-green' : 'border-transparent text-market-text-muted hover:text-white'
            )}
          >
            Livro Sim
          </button>
          <button
            type="button"
            onClick={() => onOutcomeChange('No')}
            className={cn(
              'text-sm font-semibold pb-1 border-b-2 transition-colors',
              !isYesSelected ? 'border-market-red text-market-red' : 'border-transparent text-market-text-muted hover:text-white'
            )}
          >
            Livro Não
          </button>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => loadBook()}
            className="p-1 text-market-text-muted hover:text-white rounded transition-colors"
            title="Atualizar livro de ordens"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
          <span className="text-xs text-market-text-muted">CLOB + AMM (Kz)</span>
        </div>
      </div>

      {/* Table Header */}
      <div className="px-5 py-2.5 grid grid-cols-4 text-xs font-medium text-market-text-muted border-b border-market-border/60 bg-market-bg/40">
        <div>{isYesSelected ? 'Sim' : 'Não'}</div>
        <div className="text-right">Preço (Kz)</div>
        <div className="text-right">Quotas</div>
        <div className="text-right">Total (Kz)</div>
      </div>

      {/* Order Book Content */}
      <div className="p-0">
        {/* Asks (Sellers) */}
        <div className="space-y-[1px]">
          {asks.length > 0 ? asks.map((ask: any, i: number) => {
            const barWidth = Math.max(0, Math.min(100, (ask.size / maxAskSize) * 100));
            return (
              <button
                type="button"
                key={`ask-${ask.priceCents}-${i}`}
                onClick={() => onSelectOrder?.({ outcome: isYesSelected ? 'Yes' : 'No', side: 'Buy', priceCents: ask.priceCents })}
                title={`Clique para preencher ordem de Compra a ${formatKz(ask.priceKz)}`}
                className="w-full text-left relative group cursor-pointer hover:bg-white/5 transition-colors block"
              >
                <div
                  className="absolute right-0 top-0 bottom-0 bg-market-red/10 transition-all duration-500"
                  style={{ width: `${barWidth}%` }}
                />
                <div className="relative px-5 py-2.5 grid grid-cols-4 items-center text-[10px] md:text-[11px] font-bold">
                  <div className="flex items-center gap-1.5">
                    {i === asks.length - 1 && (
                      <span className="bg-market-red/20 border border-market-red/40 text-market-red text-[7px] md:text-[8px] px-1.5 py-0.5 rounded font-black uppercase">Venda</span>
                    )}
                    {ask.ammShares > 0 && (
                      <span className="bg-sky-500/20 border border-sky-500/30 text-sky-400 text-[7px] px-1.5 py-0.5 rounded font-black uppercase">AMM</span>
                    )}
                  </div>
                  <div className="text-right text-market-red text-xs md:text-sm font-black tabular-nums">{formatKz(ask.priceKz)}</div>
                  <div className="text-right text-white font-mono tabular-nums">{ask.size.toLocaleString('pt-AO')}</div>
                  <div className="text-right text-white font-mono tabular-nums">{formatKz(ask.totalKz)}</div>
                </div>
              </button>
            );
          }) : (
            <div className="px-6 py-4 text-center text-[10px] text-market-text-muted font-bold uppercase tracking-wider">
              Sem Ordens de Venda no CLOB
            </div>
          )}
        </div>

        {/* Spread Info */}
        <div className="px-5 py-2 flex items-center justify-between gap-4 border-y border-market-border/30 bg-white/[0.02]">
          <div className="flex items-center gap-6">
            <div className="text-[9px] md:text-[10px] font-bold text-market-text-muted uppercase tracking-widest font-mono tabular-nums">
              Último: <span className="text-white">{formatKz(displayPriceKz)}</span>
            </div>
            <div className="text-[9px] md:text-[10px] font-bold text-market-text-muted uppercase tracking-widest font-mono tabular-nums">
              Spread: <span className="text-white">{spreadKz !== null ? formatKz(spreadKz) : '—'}</span>
            </div>
          </div>
          {(asks.length > 0 || bids.length > 0) && (
            <span className="text-[10px] text-market-text-muted hidden sm:inline">Clique numa linha para negociar</span>
          )}
        </div>

        {/* Bids (Buyers) */}
        <div className="space-y-[1px]">
          {bids.length > 0 ? bids.map((bid: any, i: number) => {
            const barWidth = Math.max(0, Math.min(100, (bid.size / maxBidSize) * 100));
            return (
              <button
                type="button"
                key={`bid-${bid.priceCents}-${i}`}
                onClick={() => onSelectOrder?.({ outcome: isYesSelected ? 'Yes' : 'No', side: 'Sell', priceCents: bid.priceCents })}
                title={`Clique para preencher ordem de Venda a ${formatKz(bid.priceKz)}`}
                className="w-full text-left relative group cursor-pointer hover:bg-white/5 transition-colors block"
              >
                <div
                  className="absolute left-0 top-0 bottom-0 bg-market-green/10 transition-all duration-500"
                  style={{ width: `${barWidth}%` }}
                />
                <div className="relative px-5 py-2.5 grid grid-cols-4 items-center text-[10px] md:text-[11px] font-bold">
                  <div className="flex items-center gap-1.5">
                    {i === 0 && (
                      <span className="bg-market-green/20 border border-market-green/40 text-market-green text-[7px] md:text-[8px] px-1.5 py-0.5 rounded font-black uppercase">Compra</span>
                    )}
                    {bid.ammShares > 0 && (
                      <span className="bg-sky-500/20 border border-sky-500/30 text-sky-400 text-[7px] px-1.5 py-0.5 rounded font-black uppercase">AMM</span>
                    )}
                  </div>
                  <div className="text-right text-market-green text-xs md:text-sm font-black tabular-nums">{formatKz(bid.priceKz)}</div>
                  <div className="text-right text-white font-mono tabular-nums">{bid.size.toLocaleString('pt-AO')}</div>
                  <div className="text-right text-white font-mono tabular-nums">{formatKz(bid.totalKz)}</div>
                </div>
              </button>
            );
          }) : (
            <div className="px-6 py-4 text-center text-[10px] text-market-text-muted font-bold uppercase tracking-wider">
              Sem Ordens de Compra no CLOB
            </div>
          )}
        </div>

        {/* User Active CLOB Orders */}
        {myOrders.length > 0 && (
          <div className="border-t border-market-border/50 px-5 py-3 bg-white/[0.015] space-y-2">
            <div className="text-[9px] font-black uppercase tracking-widest text-market-text-muted">
              As Suas Ordens Abertas no CLOB ({myOrders.length})
            </div>
            <div className="space-y-1.5">
              {myOrders.map((ord: any) => (
                <div key={ord.id} className="flex items-center justify-between text-[10px] bg-black/30 border border-market-border/40 rounded-lg px-3 py-2">
                  <div className="flex items-center gap-2 font-mono">
                    <span className={cn("font-black uppercase", ord.side === 'Buy' ? "text-market-green" : "text-market-red")}>
                      {ord.side === 'Buy' ? 'COMPRA' : 'VENDA'} {ord.outcome === 'Yes' ? 'SIM' : 'NÃO'}
                    </span>
                    <span className="text-white">
                      {Number(ord.remaining_quantity)}/{Number(ord.quantity)} @ {formatKz(Number(ord.price_cents) / 100)}
                    </span>
                    <span className="text-market-text-muted">({ord.status === 'OPEN' ? 'Aberta' : 'Parcial'})</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleCancelOrder(ord.id)}
                    disabled={cancellingId === ord.id}
                    className="px-2.5 py-1 bg-market-red/20 hover:bg-market-red/30 text-market-red rounded font-black uppercase text-[9px] transition-colors disabled:opacity-50"
                  >
                    {cancellingId === ord.id ? '...' : 'Cancelar'}
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

const RecentTrades = ({ trades }: { trades: any[] }) => {
  return (
    <div dir="ltr" className="market-card overflow-hidden">
      <div className="px-5 py-3.5 border-b border-market-border flex items-center justify-between">
        <h4 className="text-xs font-bold uppercase tracking-wider text-white">Negócios Recentes</h4>
        <span className="text-xs font-medium text-market-text-muted tabular-nums">{trades.length} total</span>
      </div>
      <div className="divide-y divide-market-border/40">
        <div className="px-5 py-2 grid grid-cols-4 text-[11px] font-semibold text-market-text-muted uppercase tracking-wider">
          <div>Lado / Opção</div>
          <div className="text-right">Valor (Kz)</div>
          <div className="text-right">Preço Unit. (Kz)</div>
          <div className="text-right">Tempo</div>
        </div>
        {trades.length > 0 ? trades.map((trade) => {
          const isBuySide = trade.side === 'Compra' || trade.side === 'Buy';
          const isClob = Boolean(trade.isClob || trade.engine === 'CLOB_AMM' || trade.side === 'Execução');
          const isYesOut = trade.outcome === 'Yes' || trade.outcome === 'Sim';
          const rawPrice = Number(trade.price || 0);
          const priceKz = isClob
            ? (rawPrice > 1 ? rawPrice / 100 : rawPrice)
            : (rawPrice > 1 ? rawPrice : rawPrice * 100);
          const amountKz = Number(trade.amount || 0);
          const safeTime = sanitizePlainText(trade.time || '-', 40);
          return (
            <div key={trade.id} className="px-5 py-2.5 grid grid-cols-4 items-center text-xs hover:bg-white/[0.02] transition-colors">
              <div className="flex items-center gap-1.5 min-w-0">
                <span className={cn("font-semibold", isBuySide ? "text-market-green" : isClob ? "text-[#60a5fa]" : "text-market-red")}>
                  {isClob ? 'CLOB' : isBuySide ? 'Compra' : 'Venda'}
                </span>
                <span className={cn("text-[10px] font-bold px-1.5 py-0.5 rounded truncate", isYesOut ? "bg-market-green/10 text-market-green" : "bg-market-red/10 text-market-red")}>
                  {trade.outcome === 'Yes' ? 'Sim' : trade.outcome === 'No' ? 'Não' : sanitizePlainText(trade.outcome, 24)}
                </span>
              </div>
              <div className="text-right text-white font-semibold tabular-nums">{formatKz(amountKz, 2)}</div>
              <div className="text-right text-white font-medium tabular-nums">{formatKz(priceKz, 2)}</div>
              <div className="text-right text-market-text-muted text-[11px] tabular-nums truncate">{safeTime}</div>
            </div>
          );
        }) : (
          <div className="p-8 text-center text-xs text-market-text-muted">
            Sem negócios registados neste mercado.
          </div>
        )}
      </div>
    </div>
  );
};

const Candlestick = (props: any) => {
  const { x, width, fill, payload, yAxis } = props;
  if (!payload || !yAxis) return null;
  
  const open = payload.open || 0;
  const close = payload.close || 0;
  const high = payload.high || 0;
  const low = payload.low || 0;
  
  const yOpen = yAxis.scale(open);
  const yClose = yAxis.scale(close);
  const yHigh = yAxis.scale(high);
  const yLow = yAxis.scale(low);

  const candleWidth = width * 0.7;
  const candleX = x + (width - candleWidth) / 2;
  const bodyY = Math.min(yOpen, yClose);
  const bodyHeight = Math.max(Math.abs(yOpen - yClose), 1);

  const wickX = x + width / 2;

  return (
    <g>
      <line
        x1={wickX}
        y1={yHigh}
        x2={wickX}
        y2={yLow}
        stroke={fill}
        strokeWidth={1}
      />
      <rect
        x={candleX}
        y={bodyY}
        width={candleWidth}
        height={bodyHeight}
        fill={fill}
      />
    </g>
  );
};



const MarketDetailPage = ({
  markets,
  user,
  trades,
  addToast,
  categories,
  onRefreshAll,
  onBalanceUpdate,
}: {
  markets: Market[];
  user: User | null;
  trades: any[];
  addToast: (msg: string, type?: 'success' | 'error' | 'info') => void;
  categories: Category[];
  onRefreshAll?: () => Promise<void> | void;
  onBalanceUpdate?: (newBalanceKz: number) => void;
}) => {
  const { id } = useParams();
  const market = markets.find((m) => m.id === id);
  return (
    <MarketDetailView
      market={market}
      markets={markets}
      user={user}
      trades={trades}
      categories={categories}
      addToast={addToast}
      onRefreshAll={onRefreshAll}
      onBalanceUpdate={onBalanceUpdate}
      OrderBookComponent={OrderBook}
      RecentTradesComponent={RecentTrades}
      CandlestickComponent={Candlestick}
    />
  );
};

const LeaderboardPage = () => {
  const [leaders, setLeaders] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchLeaders = async () => {
      const data = await firebaseService.getLeaderboard(20);
      if (data) {
        setLeaders(data.map((u, i) => ({
          rank: i + 1,
          user: u.name || u.email?.split('@')[0] || 'Trader',
          balance: u.balance || 0,
          positionsCount: Array.isArray(u.positions) ? u.positions.length : 0
        })));
      }
      setLoading(false);
    };
    fetchLeaders();
  }, []);

  if (loading) return <div className="flex items-center justify-center p-20"><Loader2 className="w-8 h-8 animate-spin text-market-green" /></div>;

  return (
    <div className="max-w-4xl mx-auto space-y-6 py-10 px-4">
      <div>
        <h1 className="text-2xl font-bold text-white">Classificação</h1>
        <p className="text-sm text-market-text-muted mt-1">Os maiores saldos no MarketPay Angola.</p>
      </div>

      <div className="market-card overflow-hidden">
        <div className="market-table-container">
          <table className="market-table">
            <thead>
              <tr>
                <th className="market-table-header">Posição</th>
                <th className="market-table-header">Trader</th>
                <th className="market-table-header text-center">Posições</th>
                <th className="market-table-header text-right">Saldo Total</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-market-border">
              {leaders.length > 0 ? leaders.map((leader) => (
                <tr key={leader.rank} className="hover:bg-market-card-lighter transition-colors">
                  <td className="market-table-cell">
                    <span className={cn(
                      "w-7 h-7 rounded-full inline-flex items-center justify-center font-bold text-xs tabular-nums",
                      leader.rank === 1 ? "bg-yellow-500/20 text-yellow-400" :
                      leader.rank === 2 ? "bg-slate-400/20 text-slate-300" :
                      leader.rank === 3 ? "bg-orange-500/20 text-orange-400" : "text-market-text-muted"
                    )}>
                      {leader.rank}
                    </span>
                  </td>
                  <td className="market-table-cell">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-full bg-market-card-lighter flex items-center justify-center text-market-green text-xs font-bold uppercase">
                        {leader.user[0]}
                      </div>
                      <span className="font-semibold text-white">{leader.user}</span>
                    </div>
                  </td>
                  <td className="market-table-cell text-center text-market-text-muted tabular-nums">
                    {leader.positionsCount}
                  </td>
                  <td className="market-table-cell text-right font-bold text-market-green tabular-nums">
                    {leader.balance.toLocaleString('pt-AO')} KZ
                  </td>
                </tr>
              )) : (
                <tr>
                  <td colSpan={4} className="p-8 text-center text-xs text-market-text-muted">
                    Sem registos de classificação disponíveis.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

const PortfolioPage = ({ user, trades, markets, addToast, onRefreshAll }: { user: User | null, trades: any[], markets: Market[], addToast: (msg: string, type?: 'success' | 'error' | 'info') => void, onRefreshAll?: () => Promise<void> | void }) => {
  return (
    <PortfolioView
      user={user}
      trades={trades}
      markets={markets}
      addToast={addToast}
      onRefreshAll={onRefreshAll}
    />
  );
};

const ResetPasswordPage = ({ addToast }: { addToast: (msg: string, type?: 'success' | 'error' | 'info') => void }) => {
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [recoveryEmail, setRecoveryEmail] = useState('');
  const [checkingSession, setCheckingSession] = useState(true);
  const [hasRecoverySession, setHasRecoverySession] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [infoMessage, setInfoMessage] = useState('');
  const navigate = useNavigate();

  const strength = validatePasswordStrength(password);

  useEffect(() => {
    let active = true;
    const initRecovery = async () => {
      if (!isSupabaseConfigured) {
        if (active) {
          setError('Supabase não configurado.');
          setCheckingSession(false);
        }
        return;
      }

      try {
        const search = window.location.search || '';
        const hash = window.location.hash || '';
        const sp = new URLSearchParams(search);
        const hp = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
        const urlErr = sp.get('error_description') || hp.get('error_description') || sp.get('error') || hp.get('error');

        if (urlErr) {
          if (active) {
            setError(translateSupabaseAuthError(urlErr));
            setHasRecoverySession(false);
            setCheckingSession(false);
          }
          return;
        }

        if (sp.get('code') || hp.get('access_token')) {
          const sess = await processOAuthCallbackParams(search, hash);
          if (active) {
            setHasRecoverySession(Boolean(sess?.user));
            setCheckingSession(false);
          }
          return;
        }

        const { data } = await supabase.auth.getSession();
        if (active) {
          setHasRecoverySession(Boolean(data.session?.user));
          setCheckingSession(false);
        }
      } catch (err: any) {
        if (active) {
          setError(translateSupabaseAuthError(err));
          setHasRecoverySession(false);
          setCheckingSession(false);
        }
      }
    };

    initRecovery();

    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (!active) return;
      if (event === 'PASSWORD_RECOVERY' || (event === 'SIGNED_IN' && session?.user)) {
        setHasRecoverySession(true);
        setError('');
        setCheckingSession(false);
      }
    });

    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  const handleRequestNewLink = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanEmail = recoveryEmail.trim().toLowerCase();
    if (!cleanEmail) return;
    setLoading(true);
    setError('');
    setInfoMessage('');
    try {
      const { error: resetErr } = await supabase.auth.resetPasswordForEmail(cleanEmail, {
        redirectTo: `${window.location.origin}/reset-password`,
      });
      if (resetErr) throw resetErr;
      setInfoMessage('Novo link seguro de recuperação enviado para o seu email.');
    } catch (err: any) {
      setError(translateSupabaseAuthError(err));
    } finally {
      setLoading(false);
    }
  };

  const handleReset = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isSupabaseConfigured) {
      setError('Supabase não configurado.');
      return;
    }
    if (!hasRecoverySession) {
      setError('Sessão de recuperação inválida ou expirada. Solicite um novo link.');
      return;
    }
    if (!strength.valid) {
      setError(strength.feedback);
      return;
    }
    if (password !== confirmPassword) {
      setError('As palavras-passe não coincidem.');
      return;
    }

    setLoading(true);
    setError('');
    try {
      const { error: updateErr } = await supabase.auth.updateUser({ password });
      if (updateErr) throw updateErr;
      // Por segurança, encerrar todas as sessões anteriores após recuperação de conta
      await logoutAllDevices().catch(() => {});
      addToast('Palavra-passe atualizada e sessões anteriores encerradas por segurança.', 'success');
      navigate('/login');
    } catch (err: any) {
      setError(translateSupabaseAuthError(err));
    } finally {
      setLoading(false);
    }
  };

  if (checkingSession) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-market-green" />
      </div>
    );
  }

  return (
    <div className="min-h-[65vh] flex items-center justify-center px-4 py-10">
      <div className="market-card w-full max-w-md p-6 sm:p-8 space-y-6">
        <div className="text-center space-y-1.5">
          <div className="w-11 h-11 rounded-full bg-market-green/10 border border-market-green/30 flex items-center justify-center mx-auto text-market-green">
            <ShieldCheck className="w-5 h-5" />
          </div>
          <h2 className="text-2xl font-bold text-white">Recuperação Segura de Conta</h2>
          <p className="text-xs text-market-text-muted">
            {hasRecoverySession
              ? 'Defina uma nova palavra-passe forte. Todas as sessões anteriores serão encerradas.'
              : 'O link expirou ou ainda não foi validado. Solicite um novo link abaixo.'}
          </p>
        </div>

        {hasRecoverySession ? (
          <form onSubmit={handleReset} className="space-y-4">
            <div className="space-y-1.5">
              <label className="block text-xs font-semibold text-market-text-muted">Nova Palavra-passe</label>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="market-input w-full pr-10"
                  placeholder="••••••••"
                  autoComplete="new-password"
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-market-text-muted hover:text-white"
                  tabIndex={-1}
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
              {password.length > 0 && (
                <div className="space-y-1 pt-1">
                  <div className="flex items-center gap-1.5">
                    {[1, 2, 3, 4].map((step) => (
                      <div
                        key={step}
                        className={`h-1 flex-1 rounded-full transition-colors ${
                          strength.score >= step
                            ? strength.score >= 4
                              ? 'bg-market-green'
                              : strength.score >= 3
                              ? 'bg-amber-400'
                              : 'bg-market-red'
                            : 'bg-market-border'
                        }`}
                      />
                    ))}
                    <span className="text-[11px] font-semibold text-market-text-muted ml-1">
                      {strength.label}
                    </span>
                  </div>
                  <p className="text-[11px] text-market-text-muted">{strength.feedback}</p>
                </div>
              )}
            </div>

            <div className="space-y-1.5">
              <label className="block text-xs font-semibold text-market-text-muted">Confirmar Nova Palavra-passe</label>
              <input
                type={showPassword ? 'text' : 'password'}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className="market-input w-full"
                placeholder="••••••••"
                autoComplete="new-password"
                required
              />
            </div>

            {error && (
              <p className="text-market-red text-xs font-medium bg-market-red/10 p-3 rounded-lg border border-market-red/20">
                {error}
              </p>
            )}
            <button
              type="submit"
              disabled={loading}
              className="w-full market-button-primary py-3 disabled:opacity-50"
            >
              {loading ? 'A atualizar...' : 'Atualizar Palavra-passe e Encerrar Sessões'}
            </button>
          </form>
        ) : (
          <form onSubmit={handleRequestNewLink} className="space-y-4">
            <div className="space-y-1.5">
              <label className="block text-xs font-semibold text-market-text-muted">Email da conta</label>
              <input
                type="email"
                value={recoveryEmail}
                onChange={(e) => setRecoveryEmail(e.target.value)}
                className="market-input w-full"
                placeholder="seu@email.com"
                required
              />
            </div>
            {error && (
              <p className="text-market-red text-xs font-medium bg-market-red/10 p-3 rounded-lg border border-market-red/20">
                {error}
              </p>
            )}
            {infoMessage && (
              <p className="text-market-green text-xs font-medium bg-market-green/10 p-3 rounded-lg border border-market-green/20">
                {infoMessage}
              </p>
            )}
            <button
              type="submit"
              disabled={loading}
              className="w-full market-button-primary py-3 disabled:opacity-50"
            >
              {loading ? 'A enviar...' : 'Enviar Novo Link de Recuperação'}
            </button>
            <div className="text-center">
              <Link to="/login" className="text-xs text-market-green hover:underline font-semibold">
                Voltar ao login
              </Link>
            </div>
          </form>
        )}
      </div>
    </div>
  );
};

// --- Main App ---

export default function App() {
  const navigate = useNavigate();
  const [markets, setMarkets] = useState<Market[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [posts, setPosts] = useState<any[]>([]);
  const [user, setUser] = useState<User | null>(null);
  const [search, setSearch] = useState('');
  const [activeCategory, setActiveCategory] = useState('Todos');
  const [toasts, setToasts] = useState<{ id: number, message: string, type: 'success' | 'error' | 'info' }[]>([]);
  const [trades, setTrades] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [missingTables, setMissingTables] = useState<string[]>([]);
  const [showDbSetupModal, setShowDbSetupModal] = useState(false);
  const [schemaMeta, setSchemaMeta] = useState<{
    sql: string;
    sqlEditorUrl: string;
    authProvidersUrl: string;
    authUrlConfigUrl: string;
  } | null>(null);
  const [checkingDb, setCheckingDb] = useState(false);

  const addToast = (message: string, type: 'success' | 'error' | 'info' = 'success') => {
    const id = Date.now();
    setToasts(prev => [...prev, { id, message, type }]);
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 3000);
  };

  const checkSupabaseTables = React.useCallback(async () => {
    setCheckingDb(true);
    try {
      const resp = await fetch('/api/supabase/status');
      if (!resp.ok) return [];
      const data = await resp.json();
      const missing = Object.entries(data.tables || {})
        .filter(([, st]: [string, any]) => !st?.ok)
        .map(([tbl]) => tbl);
      setMissingTables(missing);
      if (missing.length > 0 && !schemaMeta) {
        const sqlResp = await fetch('/api/supabase/schema-sql');
        if (sqlResp.ok) {
          setSchemaMeta(await sqlResp.json());
        }
      }
      return missing;
    } catch {
      return [];
    } finally {
      setCheckingDb(false);
    }
  }, [schemaMeta]);

  const fetchInitialData = async () => {
    setLoading(true);
    try {
      const missing = await checkSupabaseTables();
      let [catData, postsData] = await Promise.all([
        firebaseService.getCategories(),
        firebaseService.getPosts()
      ]);

      if (!catData || catData.length === 0) {
        const defaultNames = ['Finanças', 'Angola', 'Crypto', 'Desporto', 'Política', 'Economia', 'Tech'];
        const defaultIcons = ['TrendingUp', 'Map', 'Coins', 'Activity', 'Award', 'Globe', 'Cpu'];
        const defaultCategories = defaultNames.map((name, index) => ({
          id: `default_${index}`,
          name,
          icon: defaultIcons[index] || 'Globe',
          status: 'active' as const,
          order: index
        }));

        if (isSupabaseConfigured && missing.length === 0) {
          try {
            for (let i = 0; i < defaultNames.length; i++) {
              await firebaseService.createCategory({
                name: defaultNames[i],
                icon: defaultIcons[i],
                status: 'active',
                order: i
              });
            }
            catData = await firebaseService.getCategories();
          } catch {
            catData = defaultCategories;
          }
        } else {
          catData = defaultCategories;
        }
      }

      setCategories(catData);
      setPosts(postsData);
    } catch (error) {
      console.error('Error fetching initial data:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchInitialData();

    let unsubscribeUserProfile: (() => void) | null = null;

    const handleSessionUser = async (sbUser: any | null) => {
      try {
        if (unsubscribeUserProfile) {
          unsubscribeUserProfile();
          unsubscribeUserProfile = null;
        }

        if (sbUser) {
          unsubscribeUserProfile = firebaseService.subscribeToUser(sbUser.id, (updatedProfile) => {
            if (updatedProfile) {
              setUser(updatedProfile);
            }
          });

          try {
            const profile = await firebaseService.getUserProfile(sbUser.id);
            if (profile) {
              setUser(profile);
            } else {
              const isMasterEmail = ['evaristopaulocassoma00@gmail.com', 'evaristopaulocassoma20@gmail.com'].includes(
                (sbUser.email || '').toLowerCase()
              );
              const newProfile = await firebaseService.createUserProfile(sbUser.id, {
                name: (sbUser.user_metadata?.full_name as string) || (sbUser.user_metadata?.name as string) || sbUser.email?.split('@')[0] || 'Utilizador',
                email: sbUser.email || '',
                balance: 1000,
                is_admin: isMasterEmail,
                role: isMasterEmail ? 'MASTER_ADMIN' : 'USER',
                status: 'active',
                positions: []
              });
              setUser(newProfile);
            }
          } catch (profileErr) {
            console.warn('Perfil Supabase indisponível (tabelas em falta ou RLS):', profileErr);
            const isMasterEmail = ['evaristopaulocassoma00@gmail.com', 'evaristopaulocassoma20@gmail.com'].includes(
              (sbUser.email || '').toLowerCase()
            );
            setUser({
              id: sbUser.id,
              name: (sbUser.user_metadata?.full_name as string) || sbUser.email?.split('@')[0] || 'Utilizador',
              email: sbUser.email || '',
              balance: 1000,
              is_admin: isMasterEmail,
              role: isMasterEmail ? 'MASTER_ADMIN' : 'USER',
              status: 'active',
              positions: [],
            } as User);
          }
        } else {
          setUser(null);
        }
      } catch (error) {
        console.error('Auth state change error:', error);
      }
    };

    let authUnsubscribe: (() => void) | null = null;
    if (isSupabaseConfigured) {
      // Se voltou de redirect top-level (ex: ?code=... ou #access_token=...)
      const curSearch = window.location.search || '';
      const curHash = window.location.hash || '';
      if (curSearch.includes('code=') || curHash.includes('access_token=')) {
        processOAuthCallbackParams(curSearch, curHash)
          .then((sess) => {
            if (curHash.includes('type=recovery')) {
              navigate('/reset-password');
            } else if (sess?.user) {
              window.history.replaceState({}, document.title, window.location.pathname);
              handleSessionUser(sess.user);
            }
          })
          .catch((e) => console.warn('OAuth URL callback warning:', e));
      }

      supabase.auth.getSession().then(({ data }) => {
        handleSessionUser(data.session?.user ?? null);
      });

      const { data: authSub } = supabase.auth.onAuthStateChange((event, session) => {
        if (event === 'PASSWORD_RECOVERY') {
          navigate('/reset-password');
          return;
        }
        handleSessionUser(session?.user ?? null);
      });
      authUnsubscribe = () => authSub.subscription.unsubscribe();
    }

    const unsubscribeMarkets = firebaseService.subscribeToMarkets((updatedMarkets) => {
      setMarkets(updatedMarkets);
    });

    const unsubscribeTrades = firebaseService.subscribeToAllTrades((tradesData) => {
      setTrades(tradesData.map(t => ({
        ...t,
        time: formatDistanceToNow(new Date(t.timestamp), { addSuffix: true })
      })));
    });

    return () => {
      if (authUnsubscribe) authUnsubscribe();
      unsubscribeMarkets();
      unsubscribeTrades();
      if (unsubscribeUserProfile) {
        unsubscribeUserProfile();
      }
    };
  }, []);

  const refreshAllData = React.useCallback(async () => {
    try {
      await checkSupabaseTables();
      const [latestMarkets, catData, postsData] = await Promise.all([
        firebaseService.getMarkets(),
        firebaseService.getCategories(),
        firebaseService.getPosts(),
      ]);
      if (latestMarkets) setMarkets(latestMarkets);
      if (catData && catData.length > 0) setCategories(catData);
      if (postsData) setPosts(postsData);

      if (isSupabaseConfigured) {
        const { data: tradeRows } = await supabase
          .from('trades')
          .select('*')
          .order('timestamp', { ascending: false })
          .limit(50);
        if (tradeRows) {
          setTrades(
            tradeRows.map((t: any) => ({
              ...t,
              time: formatDistanceToNow(new Date(t.timestamp), { addSuffix: true }),
            }))
          );
        }
      }

      if (user?.id) {
        const freshProfile = await firebaseService.getUserProfile(user.id);
        if (freshProfile) setUser(freshProfile);
      }
    } catch (err) {
      console.error('Error refreshing global data:', err);
    }
  }, [user?.id, checkSupabaseTables]);

  const handleBalanceUpdate = React.useCallback((newBalanceKz: number) => {
    if (!Number.isFinite(newBalanceKz)) return;
    setUser((prev) => (prev ? { ...prev, balance: Number(newBalanceKz.toFixed(4)) } : prev));
  }, []);

  if (loading && markets.length === 0) {
    return (
      <div className="min-h-screen bg-market-bg flex flex-col items-center justify-center gap-4">
        <Loader2 className="w-12 h-12 text-market-green animate-spin" />
        <p className="text-market-text-muted font-bold animate-pulse">CARREGANDO MARKETPAY...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col bg-market-bg text-white">
        <Navbar
          user={user}
          onOpenSearch={() => setIsSearchOpen(true)}
        />

        {missingTables.length > 0 && (
          <div className="bg-amber-500/10 border-b border-amber-500/30 px-4 py-2.5">
            <div className="max-w-7xl mx-auto flex flex-wrap items-center justify-between gap-3 text-xs">
              <div className="flex items-center gap-2 text-amber-300 font-medium">
                <Database className="w-4 h-4 shrink-0" />
                <span>
                  Supabase conectado, mas faltam criar <strong>{missingTables.length}</strong> tabela(s) no banco de dados PostgreSQL.
                </span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setShowDbSetupModal(true)}
                  className="px-3 py-1 bg-amber-500 hover:bg-amber-400 text-black font-bold rounded-lg transition-colors"
                >
                  Criar Tabelas no Supabase
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    const left = await checkSupabaseTables();
                    if (left.length === 0) {
                      addToast('Todas as 14 tabelas Supabase estão ativas!', 'success');
                      await refreshAllData();
                    } else {
                      addToast(`Ainda faltam ${left.length} tabelas no Supabase.`, 'info');
                    }
                  }}
                  disabled={checkingDb}
                  className="px-3 py-1 bg-market-card border border-market-border hover:border-white/40 text-white rounded-lg flex items-center gap-1.5"
                >
                  <RefreshCw className={cn("w-3.5 h-3.5", checkingDb && "animate-spin")} />
                  Verificar
                </button>
              </div>
            </div>
          </div>
        )}

        {showDbSetupModal && (
          <div className="fixed inset-0 z-[120] flex items-center justify-center p-4">
            <div onClick={() => setShowDbSetupModal(false)} className="absolute inset-0 bg-black/80 backdrop-blur-sm" />
            <div className="relative w-full max-w-2xl bg-market-card border border-market-border rounded-2xl p-6 space-y-5 max-h-[90vh] overflow-y-auto">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h3 className="text-lg font-bold text-white flex items-center gap-2">
                    <Database className="w-5 h-5 text-market-green" />
                    Inicializar Tabelas no Supabase Conectado
                  </h3>
                  <p className="text-xs text-market-text-muted mt-1">
                    O servidor já está conectado às chaves do seu projeto Supabase, mas as tabelas ainda não existem no SQL Editor.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setShowDbSetupModal(false)}
                  className="p-1.5 text-market-text-muted hover:text-white rounded-lg"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="flex flex-wrap gap-1.5">
                {missingTables.map((t) => (
                  <span key={t} className="px-2 py-0.5 rounded bg-market-red/15 text-market-red border border-market-red/25 text-[11px] font-mono">
                    {t}
                  </span>
                ))}
              </div>

              <div className="space-y-2 text-xs text-market-text-muted bg-market-bg/60 border border-market-border rounded-xl p-4">
                <p className="font-semibold text-white">Passos rápidos (30 segundos):</p>
                <p>1. Clique em <strong>Copiar SQL Completo</strong> abaixo.</p>
                <p>2. Clique em <strong>Abrir SQL Editor no Supabase</strong>, cole o código e clique em <strong>Run</strong>.</p>
                <p>3. Volte aqui e clique em <strong>Verificar Ligação</strong>.</p>
                <p className="pt-1 text-amber-300">
                  Para o Login Google funcionar também: em <strong>Authentication → Providers → Google</strong> ative o Google e em <strong>URL Configuration → Redirect URLs</strong> adicione{' '}
                  <code className="text-white select-all">{`${window.location.origin}/auth/callback`}</code>.
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2.5">
                <button
                  type="button"
                  onClick={() => {
                    if (schemaMeta?.sql) {
                      navigator.clipboard.writeText(schemaMeta.sql);
                      addToast('SQL completo copiado para a área de transferência!', 'success');
                    }
                  }}
                  className="market-button-primary px-4 py-2 text-xs flex items-center gap-1.5"
                >
                  <Copy className="w-3.5 h-3.5" />
                  Copiar SQL Completo
                </button>
                {schemaMeta?.sqlEditorUrl && (
                  <a
                    href={schemaMeta.sqlEditorUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="market-button-outline px-4 py-2 text-xs flex items-center gap-1.5"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                    Abrir SQL Editor no Supabase
                  </a>
                )}
                {schemaMeta?.authProvidersUrl && (
                  <a
                    href={schemaMeta.authProvidersUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="market-button-outline px-4 py-2 text-xs flex items-center gap-1.5"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                    Configurar Google Auth
                  </a>
                )}
                <button
                  type="button"
                  onClick={async () => {
                    const left = await checkSupabaseTables();
                    if (left.length === 0) {
                      setShowDbSetupModal(false);
                      addToast('Banco de dados Supabase totalmente conectado!', 'success');
                      await refreshAllData();
                    } else {
                      addToast(`Ainda faltam ${left.length} tabelas. Execute o SQL no Supabase primeiro.`, 'error');
                    }
                  }}
                  className="px-4 py-2 bg-market-card-lighter hover:bg-market-border text-white text-xs font-semibold rounded-lg flex items-center gap-1.5"
                >
                  <RefreshCw className={cn("w-3.5 h-3.5", checkingDb && "animate-spin")} />
                  Verificar Ligação
                </button>
              </div>

              {schemaMeta?.sql && (
                <pre className="bg-black/60 border border-market-border rounded-xl p-3 text-[11px] font-mono text-slate-300 max-h-56 overflow-y-auto whitespace-pre-wrap select-all">
                  {schemaMeta.sql}
                </pre>
              )}
            </div>
          </div>
        )}

        <main className="flex-1">
          <AnimatePresence mode="wait">
            <Routes>
              <Route path="/" element={
                <HomePage
                  markets={markets}
                  search={search}
                  activeCategory={activeCategory}
                  onCategoryChange={setActiveCategory}
                  categories={categories}
                  posts={posts}
                  trades={trades}
                  onSearchChange={setSearch}
                  addToast={addToast}
                  user={user}
                />
              } />
              <Route path="/dashboard" element={
                user ? <PortfolioPage user={user} trades={trades} markets={markets} addToast={addToast} onRefreshAll={refreshAllData} /> : <LoginPage onLogin={setUser} />
              } />
              <Route path="/ebook" element={<LearnPage />} />
              <Route path="/market/:id" element={
                <motion.div
                  key="market-detail"
                  initial={{ opacity: 0, scale: 0.98 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.98 }}
                  transition={{ duration: 0.2 }}
                >
                  <MarketDetailPage markets={markets} user={user} trades={trades} addToast={addToast} categories={categories} onRefreshAll={refreshAllData} onBalanceUpdate={handleBalanceUpdate} />
                </motion.div>
              } />
              <Route path="/portfolio" element={
                <motion.div
                  key="portfolio"
                  initial={{ opacity: 0, x: 10 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -10 }}
                  transition={{ duration: 0.2 }}
                >
                  <PortfolioPage user={user} trades={trades} markets={markets} addToast={addToast} onRefreshAll={refreshAllData} />
                </motion.div>
              } />
              <Route path="/activity" element={
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                  transition={{ duration: 0.2 }}
                >
                  <ActivityPage trades={trades} markets={markets} />
                </motion.div>
              } />
              <Route path="/leaderboard" element={
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                  transition={{ duration: 0.2 }}
                >
                  <LeaderboardPage />
                </motion.div>
              } />
              <Route path="/learn" element={
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                  transition={{ duration: 0.2 }}
                >
                  <LearnPage />
                </motion.div>
              } />
              <Route path="/login" element={
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                  transition={{ duration: 0.2 }}
                >
                  <LoginPage onLogin={(u) => { setUser(u); addToast("Login efetuado com sucesso!"); }} />
                </motion.div>
              } />
              <Route path="/reset-password" element={
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                  transition={{ duration: 0.2 }}
                >
                  <ResetPasswordPage addToast={addToast} />
                </motion.div>
              } />
              <Route path="/profile" element={
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                  transition={{ duration: 0.2 }}
                >
                  <UserProfile user={user} onLogout={() => { setUser(null); addToast("Sessão terminada."); }} markets={markets} />
                </motion.div>
              } />
              <Route path="/criar-mercado" element={
                <motion.div
                  key="criar-mercado"
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                  transition={{ duration: 0.2 }}
                >
                  {user ? (
                    <CreateMarketPage 
                      user={user} 
                      categories={categories} 
                      markets={markets} 
                      addToast={addToast} 
                      onRefreshData={refreshAllData} 
                      onBalanceUpdate={handleBalanceUpdate}
                      setActiveTab={() => {}} 
                    />
                  ) : (
                    <LoginPage onLogin={(u) => { setUser(u); addToast("Login efetuado com sucesso!"); }} />
                  )}
                </motion.div>
              } />
              <Route path="/admin/*" element={
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                  transition={{ duration: 0.2 }}
                >
                  <AdminDashboard user={user} markets={markets} trades={trades} addToast={addToast} />
                </motion.div>
              } />
            </Routes>
          </AnimatePresence>
        </main>

        {/* Toast Container */}
        <div className="fixed bottom-6 right-6 z-[110] flex flex-col gap-2 max-w-sm">
          <AnimatePresence>
            {toasts.map(toast => (
              <motion.div
                key={toast.id}
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 12 }}
                className={cn(
                  "px-4 py-3 rounded-xl shadow-xl font-semibold text-sm flex items-center gap-2.5 border",
                  toast.type === 'success' && "bg-market-green text-market-bg border-market-green",
                  toast.type === 'error' && "bg-market-red text-white border-market-red",
                  toast.type === 'info' && "bg-market-card text-white border-market-border"
                )}
              >
                {toast.type === 'success' ? (
                  <CheckCircle2 className="w-4 h-4 shrink-0" />
                ) : toast.type === 'error' ? (
                  <XCircle className="w-4 h-4 shrink-0" />
                ) : (
                  <Info className="w-4 h-4 text-market-green shrink-0" />
                )}
                <span>{toast.message}</span>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>

        <SearchModal
          isOpen={isSearchOpen}
          onClose={() => setIsSearchOpen(false)}
          onSearch={(val) => { setSearch(val); setActiveCategory('Todos'); }}
          markets={markets}
          categories={categories}
        />

        <footer className="border-t border-market-border bg-market-card/40 py-8 px-4 md:px-8 mt-16">
          <div className="max-w-7xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-market-text-muted">
            <div className="flex items-center gap-2.5">
              <div className="w-6 h-6 bg-market-green rounded flex items-center justify-center text-market-bg font-bold text-xs">
                MP
              </div>
              <span className="font-semibold text-white">MarketPay Angola</span>
              <span>• © 2026</span>
            </div>
            <div className="flex flex-wrap items-center gap-5">
              <Link to="/" className="hover:text-white transition-colors">Mercados</Link>
              <Link to="/portfolio" className="hover:text-white transition-colors">Portfólio</Link>
              <Link to="/activity" className="hover:text-white transition-colors">Atividade</Link>
              <Link to="/leaderboard" className="hover:text-white transition-colors">Classificação</Link>
              <Link to="/learn" className="hover:text-white transition-colors">Como funciona</Link>
            </div>
          </div>
        </footer>
      </div>
  );
}
