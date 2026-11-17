export type Outcome = string; // Mudado de 'Yes' | 'No' para string para suportar multi-opção

export interface MarketOutcome {
  id: string;
  name: string;
  price: number; // 0 to 1
  pool: number;
  image_url?: string;
  change_24h?: number;
}

export interface Category {
  id: string;
  name: string;
  icon?: string;
  order?: number;
  status?: 'active' | 'blocked' | 'hidden';
}

export interface Market {
  id: string;
  question: string;
  subtitle?: string;
  description?: string;
  additional_context?: string;
  additional_context_updated_at?: string;
  resolver_name?: string;
  resolver_address?: string;
  category: string;
  image_url: string;
  volume: number;
  end_date: string;
  created_at?: string;
  yes_price: number; // Probabilidade normalizada 0.01..0.99
  no_price: number; // Probabilidade normalizada 0.01..0.99
  yes_price_kz?: number; // Preço em Kz (1.00..99.00)
  no_price_kz?: number; // Preço em Kz (1.00..99.00)
  pool_yes: number; // Reserva SIM (shares)
  pool_no: number; // Reserva NÃO (shares)
  liquidity_vault_kz?: number; // Cofre em Kz (lastro = pares * 100 Kz)
  k_constant?: number; // Invariante x * y = k
  outcomes?: MarketOutcome[]; // Novo: para multi-opção
  is_multi?: boolean; // Novo: flag para identificar tipo de mercado
  resolved?: boolean;
  resolution_outcome?: Outcome;
  tags: string[];
  status?: 'active' | 'closed' | 'resolved' | 'blocked' | 'hidden';
  probability?: number; // Added for UI calculations
  b?: number; // Liquidez inicial / parâmetro
  q_yes?: number;
  q_no?: number;
  showGraph?: boolean;
  showCandlestick?: boolean;
  showOrderBook?: boolean;
  showCountdown?: boolean;
  showComments?: boolean;
  showStatistics?: boolean;
  graphType?: string;
  type?: string;
  creator_id?: string;
  creator_fee_earned?: number;
  admin_fee_earned?: number;
}

export interface Trade {
  id: string;
  market_id: string;
  user_id: string;
  side: 'Buy' | 'Sell';
  outcome: Outcome;
  amount: number; // Valor bruto em Kz
  net_amount_kz?: number; // Valor líquido (99%) que entrou/saiu do AMM
  shares: number;
  price: number;
  price_before?: number;
  price_after?: number;
  expected_price?: number;
  slippage_pct?: number;
  idempotency_key?: string;
  engine?: string;
  timestamp: string;
  fee?: number;
}

export interface User {
  id: string;
  name: string;
  full_name?: string; // Added for compatibility
  email?: string;
  avatar_url?: string; // Added for compatibility
  wallet_address?: string;
  balance: number;
  pending_balance?: number;
  invested_balance?: number;
  positions: Position[];
  is_admin?: boolean;
  role?: string;
  is_verified?: boolean;
  verification_status?: 'none' | 'pending' | 'verified' | 'rejected'; // Added
  status?: 'active' | 'blocked' | 'pending_verification';
  blocked_markets?: string[]; // Added
  created_at?: string;
  updated_at?: string;
}

export interface Position {
  market_id: string;
  outcome: Outcome;
  shares: number;
  avg_price: number;
  total_cost_kz?: number;
  is_lp?: boolean;
}

export interface MarketPosition {
  id: string;
  market_id: string;
  user_id: string;
  user_name?: string;
  outcome: 'Yes' | 'No' | string;
  shares_amount: number;
  avg_entry_price: number;
  total_cost_kz: number;
  is_lp: boolean;
  updated_at: string;
}

export interface Comment {
  id: string;
  market_id: string;
  user_id: string;
  user_name: string;
  user_avatar?: string | null;
  parent_id?: string | null;
  outcome_tag?: string | null;
  text: string;
  timestamp: string;
  likes: number;
}

export interface PriceHistory {
  timestamp: string;
  yes_price: number;
  no_price: number;
}

export interface Post {
  id: string;
  title: string;
  content: string;
  category: string;
  image_url: string;
  created_at: string;
  status: 'published' | 'blocked';
}
