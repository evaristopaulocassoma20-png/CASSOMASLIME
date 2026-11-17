-- MarketPay — Schema Completo para Supabase (PostgreSQL + RLS + Triggers + Realtime)
-- Execute este script no SQL Editor do seu projeto Supabase:
-- Dashboard Supabase -> SQL Editor -> New Query -> Cole tudo e clique em "Run".

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 1. Categorias
CREATE TABLE IF NOT EXISTS public.categories (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name TEXT NOT NULL UNIQUE,
  icon TEXT DEFAULT 'Globe',
  "order" INTEGER DEFAULT 0,
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'blocked', 'hidden')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO public.categories (id, name, icon, "order", status) VALUES
  ('cat_financas', 'Finanças', 'TrendingUp', 0, 'active'),
  ('cat_angola', 'Angola', 'Map', 1, 'active'),
  ('cat_crypto', 'Crypto', 'Coins', 2, 'active'),
  ('cat_desporto', 'Desporto', 'Activity', 3, 'active'),
  ('cat_politica', 'Política', 'Award', 4, 'active'),
  ('cat_economia', 'Economia', 'Globe', 5, 'active'),
  ('cat_tech', 'Tech', 'Cpu', 6, 'active')
ON CONFLICT (name) DO NOTHING;

-- 2. Utilizadores (ligado ao auth.users via id::text)
CREATE TABLE IF NOT EXISTS public.users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT UNIQUE,
  balance NUMERIC(18, 4) DEFAULT 1000.0000,
  is_admin BOOLEAN DEFAULT FALSE,
  role TEXT DEFAULT 'USER',
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'blocked', 'pending_verification')),
  verification_status TEXT DEFAULT 'none' CHECK (verification_status IN ('none', 'pending', 'verified', 'rejected')),
  is_verified BOOLEAN DEFAULT FALSE,
  wallet_address TEXT,
  avatar_url TEXT,
  blocked_markets TEXT[] DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.users ADD COLUMN IF NOT EXISTS verification_status TEXT DEFAULT 'none';
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS is_verified BOOLEAN DEFAULT FALSE;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE public.users ALTER COLUMN balance TYPE NUMERIC(18, 4);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_balance_non_negative') THEN
    UPDATE public.users SET balance = 0.0000 WHERE balance < 0;
    ALTER TABLE public.users ADD CONSTRAINT users_balance_non_negative CHECK (balance >= 0);
  END IF;
END $$;

-- Função auxiliar SECURITY DEFINER para evitar recursão infinita no RLS de users
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.users
    WHERE id = auth.uid()::text
      AND (is_admin = TRUE OR role IN ('admin', 'operational_admin', 'MASTER_ADMIN', 'OPERATIONAL_ADMIN'))
  );
$$;

-- Trigger de criação automática de perfil quando um utilizador se regista via Email ou Google OAuth
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_name TEXT;
  v_avatar TEXT;
  v_is_master BOOLEAN;
  v_is_designated_admin BOOLEAN;
BEGIN
  v_name := COALESCE(
    NULLIF(TRIM(NEW.raw_user_meta_data ->> 'full_name'), ''),
    NULLIF(TRIM(NEW.raw_user_meta_data ->> 'name'), ''),
    NULLIF(SPLIT_PART(COALESCE(NEW.email, ''), '@', 1), ''),
    'Utilizador'
  );
  v_avatar := NULLIF(TRIM(COALESCE(NEW.raw_user_meta_data ->> 'avatar_url', NEW.raw_user_meta_data ->> 'picture', '')), '');
  v_is_master := (
    LOWER(COALESCE(NEW.email, '')) IN ('evaristopaulocassoma00@gmail.com', 'evaristopaulocassoma20@gmail.com')
    AND NEW.email_confirmed_at IS NOT NULL
  );
  v_is_designated_admin := FALSE;

  INSERT INTO public.users (
    id, name, email, balance, is_admin, role, status, verification_status, is_verified, avatar_url, created_at
  ) VALUES (
    NEW.id::text,
    v_name,
    NEW.email,
    1000.00,
    (v_is_master OR v_is_designated_admin),
    CASE
      WHEN v_is_master THEN 'MASTER_ADMIN'
      WHEN v_is_designated_admin THEN 'OPERATIONAL_ADMIN'
      ELSE 'USER'
    END,
    'active',
    'none',
    COALESCE(NEW.email_confirmed_at IS NOT NULL, FALSE),
    v_avatar,
    NOW()
  )
  ON CONFLICT (id) DO UPDATE SET
    email = COALESCE(EXCLUDED.email, public.users.email),
    avatar_url = COALESCE(public.users.avatar_url, EXCLUDED.avatar_url),
    is_admin = CASE
      WHEN v_is_master OR v_is_designated_admin THEN TRUE
      ELSE public.users.is_admin
    END,
    role = CASE
      WHEN v_is_master THEN 'MASTER_ADMIN'
      WHEN v_is_designated_admin AND public.users.role = 'USER' THEN 'OPERATIONAL_ADMIN'
      ELSE public.users.role
    END,
    updated_at = NOW();

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Trigger de segurança: impede que utilizadores normais alterem saldo, papel ou privilégios de admin via API pública
CREATE OR REPLACE FUNCTION public.protect_user_sensitive_fields()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF current_setting('role', true) = 'service_role'
     OR auth.role() = 'service_role'
     OR current_setting('app.cpmm_rpc_active', true) = 'true'
     OR public.is_admin() THEN
    RETURN NEW;
  END IF;

  IF NEW.is_admin IS DISTINCT FROM OLD.is_admin
     OR NEW.role IS DISTINCT FROM OLD.role
     OR NEW.balance IS DISTINCT FROM OLD.balance
     OR NEW.is_verified IS DISTINCT FROM OLD.is_verified THEN
    RAISE EXCEPTION 'Acesso Negado: Alterações diretas no saldo ou privilégios de utilizador são estritamente proibidas.';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status <> 'pending_verification' THEN
    RAISE EXCEPTION 'Acesso Negado: alteração de estado restrita a administradores.';
  END IF;

  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_user_sensitive_fields ON public.users;
CREATE TRIGGER trg_protect_user_sensitive_fields
  BEFORE UPDATE ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.protect_user_sensitive_fields();

-- 3. Mercados
CREATE TABLE IF NOT EXISTS public.markets (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  question TEXT NOT NULL,
  description TEXT,
  category TEXT NOT NULL DEFAULT 'Geral',
  image_url TEXT,
  yes_price NUMERIC(18, 4) DEFAULT 0.5000,
  no_price NUMERIC(18, 4) DEFAULT 0.5000,
  yes_price_kz NUMERIC(18, 4) DEFAULT 50.0000,
  no_price_kz NUMERIC(18, 4) DEFAULT 50.0000,
  pool_yes NUMERIC(18, 4) DEFAULT 20.0000,
  pool_no NUMERIC(18, 4) DEFAULT 20.0000,
  liquidity_vault_kz NUMERIC(18, 4) DEFAULT 2000.0000,
  k_constant NUMERIC(36, 16) DEFAULT 400.0000,
  volume NUMERIC(18, 4) DEFAULT 0.0000,
  outcomes JSONB,
  is_multi BOOLEAN DEFAULT FALSE,
  resolved BOOLEAN DEFAULT FALSE,
  resolution_outcome TEXT,
  resolved_at TIMESTAMPTZ,
  resolution_motive TEXT,
  resolved_by TEXT,
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'closed', 'resolved', 'blocked', 'hidden', 'cancelled')),
  tags TEXT[] DEFAULT '{}',
  b NUMERIC(18, 4) DEFAULT 2000.0000,
  q_yes NUMERIC(18, 4) DEFAULT 0.0000,
  q_no NUMERIC(18, 4) DEFAULT 0.0000,
  "showGraph" BOOLEAN DEFAULT TRUE,
  "showCandlestick" BOOLEAN DEFAULT TRUE,
  "showOrderBook" BOOLEAN DEFAULT TRUE,
  "showCountdown" BOOLEAN DEFAULT TRUE,
  "showComments" BOOLEAN DEFAULT TRUE,
  "showStatistics" BOOLEAN DEFAULT TRUE,
  "graphType" TEXT,
  type TEXT,
  creator_id TEXT,
  creator_fee_earned NUMERIC(18, 4) DEFAULT 0.0000,
  admin_fee_earned NUMERIC(18, 4) DEFAULT 0.0000,
  end_date TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '7 days'),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.markets ADD COLUMN IF NOT EXISTS subtitle TEXT;
ALTER TABLE public.markets ADD COLUMN IF NOT EXISTS additional_context TEXT;
ALTER TABLE public.markets ADD COLUMN IF NOT EXISTS additional_context_updated_at TIMESTAMPTZ;
ALTER TABLE public.markets ADD COLUMN IF NOT EXISTS resolver_name TEXT DEFAULT 'MarketPay Oracle';
ALTER TABLE public.markets ADD COLUMN IF NOT EXISTS resolver_address TEXT DEFAULT 'mp_oracle_v1';
ALTER TABLE public.markets ADD COLUMN IF NOT EXISTS yes_price NUMERIC(18, 4) DEFAULT 0.5000;
ALTER TABLE public.markets ADD COLUMN IF NOT EXISTS no_price NUMERIC(18, 4) DEFAULT 0.5000;
ALTER TABLE public.markets ADD COLUMN IF NOT EXISTS pool_yes NUMERIC(18, 4) DEFAULT 20.0000;
ALTER TABLE public.markets ADD COLUMN IF NOT EXISTS pool_no NUMERIC(18, 4) DEFAULT 20.0000;
ALTER TABLE public.markets ADD COLUMN IF NOT EXISTS volume NUMERIC(18, 4) DEFAULT 0.0000;
ALTER TABLE public.markets ADD COLUMN IF NOT EXISTS b NUMERIC(18, 4) DEFAULT 2000.0000;
ALTER TABLE public.markets ADD COLUMN IF NOT EXISTS q_yes NUMERIC(18, 4) DEFAULT 0.0000;
ALTER TABLE public.markets ADD COLUMN IF NOT EXISTS q_no NUMERIC(18, 4) DEFAULT 0.0000;
ALTER TABLE public.markets ADD COLUMN IF NOT EXISTS creator_id TEXT;
ALTER TABLE public.markets ADD COLUMN IF NOT EXISTS creator_fee_earned NUMERIC(18, 4) DEFAULT 0.0000;
ALTER TABLE public.markets ADD COLUMN IF NOT EXISTS admin_fee_earned NUMERIC(18, 4) DEFAULT 0.0000;
ALTER TABLE public.markets ADD COLUMN IF NOT EXISTS yes_price_kz NUMERIC(18, 4) DEFAULT 50.0000;
ALTER TABLE public.markets ADD COLUMN IF NOT EXISTS no_price_kz NUMERIC(18, 4) DEFAULT 50.0000;
ALTER TABLE public.markets ADD COLUMN IF NOT EXISTS liquidity_vault_kz NUMERIC(18, 4) DEFAULT 2000.0000;
ALTER TABLE public.markets ADD COLUMN IF NOT EXISTS k_constant NUMERIC(36, 16) DEFAULT 400.0000;
ALTER TABLE public.markets ALTER COLUMN yes_price TYPE NUMERIC(18, 4);
ALTER TABLE public.markets ALTER COLUMN no_price TYPE NUMERIC(18, 4);
ALTER TABLE public.markets ALTER COLUMN pool_yes TYPE NUMERIC(18, 4);
ALTER TABLE public.markets ALTER COLUMN pool_no TYPE NUMERIC(18, 4);
ALTER TABLE public.markets ALTER COLUMN volume TYPE NUMERIC(18, 4);
ALTER TABLE public.markets ALTER COLUMN b TYPE NUMERIC(18, 4);
ALTER TABLE public.markets ALTER COLUMN q_yes TYPE NUMERIC(18, 4);
ALTER TABLE public.markets ALTER COLUMN q_no TYPE NUMERIC(18, 4);
ALTER TABLE public.markets ALTER COLUMN creator_fee_earned TYPE NUMERIC(18, 4);
ALTER TABLE public.markets ALTER COLUMN admin_fee_earned TYPE NUMERIC(18, 4);
ALTER TABLE public.markets ALTER COLUMN k_constant TYPE NUMERIC(36, 16);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'markets_pool_yes_positive') THEN
    UPDATE public.markets SET pool_yes = 20.0000 WHERE pool_yes IS NULL OR pool_yes <= 0;
    ALTER TABLE public.markets ADD CONSTRAINT markets_pool_yes_positive CHECK (pool_yes > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'markets_pool_no_positive') THEN
    UPDATE public.markets SET pool_no = 20.0000 WHERE pool_no IS NULL OR pool_no <= 0;
    ALTER TABLE public.markets ADD CONSTRAINT markets_pool_no_positive CHECK (pool_no > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'markets_vault_non_negative') THEN
    UPDATE public.markets SET liquidity_vault_kz = 0.0000 WHERE liquidity_vault_kz < 0;
    ALTER TABLE public.markets ADD CONSTRAINT markets_vault_non_negative CHECK (liquidity_vault_kz >= 0);
  END IF;
END $$;

-- 4. Negócios (Trades) com Idempotência Única
CREATE TABLE IF NOT EXISTS public.trades (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  market_id TEXT REFERENCES public.markets(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES public.users(id) ON DELETE CASCADE,
  side TEXT NOT NULL CHECK (side IN ('Buy', 'Sell')),
  outcome TEXT NOT NULL,
  amount NUMERIC(18, 4) NOT NULL,
  net_amount_kz NUMERIC(18, 4) DEFAULT 0.0000,
  shares NUMERIC(18, 4) NOT NULL,
  price NUMERIC(18, 4) NOT NULL,
  price_before NUMERIC(18, 4),
  price_after NUMERIC(18, 4),
  expected_price NUMERIC(18, 4),
  slippage_pct NUMERIC(18, 4),
  fee NUMERIC(18, 4) DEFAULT 0.0000,
  idempotency_key TEXT UNIQUE,
  engine TEXT DEFAULT 'CPMM_AMM',
  timestamp TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.trades ADD COLUMN IF NOT EXISTS net_amount_kz NUMERIC(18, 4) DEFAULT 0.0000;
ALTER TABLE public.trades ADD COLUMN IF NOT EXISTS price_before NUMERIC(18, 4);
ALTER TABLE public.trades ADD COLUMN IF NOT EXISTS price_after NUMERIC(18, 4);
ALTER TABLE public.trades ADD COLUMN IF NOT EXISTS expected_price NUMERIC(18, 4);
ALTER TABLE public.trades ADD COLUMN IF NOT EXISTS slippage_pct NUMERIC(18, 4);
ALTER TABLE public.trades ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
ALTER TABLE public.trades ALTER COLUMN amount TYPE NUMERIC(18, 4);
ALTER TABLE public.trades ALTER COLUMN shares TYPE NUMERIC(18, 4);
ALTER TABLE public.trades ALTER COLUMN price TYPE NUMERIC(18, 4);
ALTER TABLE public.trades ALTER COLUMN fee TYPE NUMERIC(18, 4);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'trades_idempotency_key_unique'
  ) THEN
    ALTER TABLE public.trades ADD CONSTRAINT trades_idempotency_key_unique UNIQUE (idempotency_key);
  END IF;
END $$;

-- 5. Posições (legado + espelho) & Posições CPMM (market_positions)
CREATE TABLE IF NOT EXISTS public.positions (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  "userId" TEXT,
  market_id TEXT,
  "marketId" TEXT,
  outcome TEXT NOT NULL,
  shares NUMERIC(18, 4) NOT NULL DEFAULT 0.0000,
  available_shares NUMERIC(18, 4) DEFAULT 0.0000,
  reserved_shares NUMERIC(18, 4) DEFAULT 0.0000,
  avg_price NUMERIC(18, 4) NOT NULL DEFAULT 0.0000,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.positions ALTER COLUMN shares TYPE NUMERIC(18, 4);
ALTER TABLE public.positions ALTER COLUMN available_shares TYPE NUMERIC(18, 4);
ALTER TABLE public.positions ALTER COLUMN reserved_shares TYPE NUMERIC(18, 4);
ALTER TABLE public.positions ALTER COLUMN avg_price TYPE NUMERIC(18, 4);

CREATE TABLE IF NOT EXISTS public.market_positions (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  market_id TEXT NOT NULL REFERENCES public.markets(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  user_name TEXT,
  outcome TEXT NOT NULL,
  shares_amount NUMERIC(18, 4) NOT NULL DEFAULT 0.0000,
  avg_entry_price NUMERIC(18, 4) NOT NULL DEFAULT 0.0000,
  total_cost_kz NUMERIC(18, 4) NOT NULL DEFAULT 0.0000,
  is_lp BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (market_id, user_id, outcome, is_lp),
  CHECK (shares_amount >= 0)
);

CREATE TABLE IF NOT EXISTS public.platform_revenue (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  market_id TEXT REFERENCES public.markets(id) ON DELETE SET NULL,
  user_id TEXT,
  trade_id TEXT,
  source_type TEXT NOT NULL CHECK (source_type IN ('TRADING_FEE_BUY', 'TRADING_FEE_SELL', 'PAYOUT_WITHDRAWAL_FEE', 'MARKET_FEE')),
  gross_amount_kz NUMERIC(18, 4) NOT NULL DEFAULT 0.0000,
  fee_amount_kz NUMERIC(18, 4) NOT NULL DEFAULT 0.0000,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 6. Comentários
CREATE TABLE IF NOT EXISTS public.comments (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  market_id TEXT REFERENCES public.markets(id) ON DELETE CASCADE,
  user_id TEXT,
  user_name TEXT,
  user_avatar TEXT,
  parent_id TEXT,
  outcome_tag TEXT,
  text TEXT NOT NULL,
  likes INTEGER DEFAULT 0,
  timestamp TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.comments ADD COLUMN IF NOT EXISTS user_avatar TEXT;
ALTER TABLE public.comments ADD COLUMN IF NOT EXISTS parent_id TEXT;
ALTER TABLE public.comments ADD COLUMN IF NOT EXISTS outcome_tag TEXT;

-- 6b. Curtidas de Comentários
CREATE TABLE IF NOT EXISTS public.comment_likes (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  comment_id TEXT REFERENCES public.comments(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (comment_id, user_id)
);

-- 6c. Marcadores / Favoritos de Mercados
CREATE TABLE IF NOT EXISTS public.market_bookmarks (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  market_id TEXT REFERENCES public.markets(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (market_id, user_id)
);

-- 6d. Propostas de Resolução de Mercado
CREATE TABLE IF NOT EXISTS public.market_resolution_proposals (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  market_id TEXT REFERENCES public.markets(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  user_name TEXT,
  proposed_outcome TEXT NOT NULL,
  evidence_url TEXT,
  rationale TEXT NOT NULL,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected')),
  reviewed_by TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 6e. Perguntas Frequentes (FAQ) por Mercado
CREATE TABLE IF NOT EXISTS public.market_faqs (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  market_id TEXT REFERENCES public.markets(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 7. Histórico de Preços
CREATE TABLE IF NOT EXISTS public.price_history (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  market_id TEXT REFERENCES public.markets(id) ON DELETE CASCADE,
  yes_price NUMERIC(10, 4) NOT NULL,
  no_price NUMERIC(10, 4) NOT NULL,
  timestamp TIMESTAMPTZ DEFAULT NOW()
);

-- 7b. Histórico de Preços Multi-Opção
CREATE TABLE IF NOT EXISTS public.outcome_price_history (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  market_id TEXT REFERENCES public.markets(id) ON DELETE CASCADE,
  outcome_id TEXT NOT NULL,
  outcome_name TEXT NOT NULL,
  price NUMERIC(10, 4) NOT NULL,
  timestamp TIMESTAMPTZ DEFAULT NOW()
);

-- 8. Pedidos Financeiros (Depósitos e Saques)
CREATE TABLE IF NOT EXISTS public.finance_requests (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id TEXT REFERENCES public.users(id) ON DELETE CASCADE,
  user_name TEXT,
  user_email TEXT,
  type TEXT NOT NULL CHECK (type IN ('deposit', 'withdrawal')),
  amount NUMERIC(15, 2) NOT NULL,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  proof_url TEXT,
  method TEXT,
  details TEXT,
  iban_or_phone TEXT,
  processed_at TIMESTAMPTZ,
  processed_by TEXT,
  timestamp TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.finance_requests ADD COLUMN IF NOT EXISTS user_name TEXT;
ALTER TABLE public.finance_requests ADD COLUMN IF NOT EXISTS details TEXT;
ALTER TABLE public.finance_requests ADD COLUMN IF NOT EXISTS timestamp TIMESTAMPTZ DEFAULT NOW();

-- 9. Livro Razão (Ledger)
CREATE TABLE IF NOT EXISTS public.ledger (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id TEXT NOT NULL,
  market_id TEXT,
  type TEXT NOT NULL,
  amount NUMERIC(18, 4) NOT NULL,
  "balanceBefore" NUMERIC(18, 4) NOT NULL DEFAULT 0.0000,
  "balanceAfter" NUMERIC(18, 4) NOT NULL DEFAULT 0.0000,
  reference TEXT,
  "createdAt" TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.ledger ADD COLUMN IF NOT EXISTS market_id TEXT;
ALTER TABLE public.ledger ALTER COLUMN amount TYPE NUMERIC(18, 4);
ALTER TABLE public.ledger ALTER COLUMN "balanceBefore" TYPE NUMERIC(18, 4);
ALTER TABLE public.ledger ALTER COLUMN "balanceAfter" TYPE NUMERIC(18, 4);

-- 10. Logs de Auditoria
CREATE TABLE IF NOT EXISTS public.audit_logs (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  admin_id TEXT,
  action TEXT NOT NULL,
  details TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  timestamp TIMESTAMPTZ DEFAULT NOW()
);

-- 11. Notícias / Posts
CREATE TABLE IF NOT EXISTS public.posts (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  title TEXT NOT NULL,
  content TEXT,
  summary TEXT,
  category TEXT DEFAULT 'Geral',
  image_url TEXT,
  status TEXT DEFAULT 'published' CHECK (status IN ('published', 'draft', 'archived', 'blocked')),
  author_id TEXT,
  author_name TEXT,
  author_avatar TEXT,
  likes INTEGER DEFAULT 0,
  comments INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.posts ADD COLUMN IF NOT EXISTS category TEXT DEFAULT 'Geral';
ALTER TABLE public.posts ADD COLUMN IF NOT EXISTS author_name TEXT;
ALTER TABLE public.posts ADD COLUMN IF NOT EXISTS author_avatar TEXT;
ALTER TABLE public.posts ADD COLUMN IF NOT EXISTS likes INTEGER DEFAULT 0;
ALTER TABLE public.posts ADD COLUMN IF NOT EXISTS comments INTEGER DEFAULT 0;

-- 12. Definições da Plataforma
CREATE TABLE IF NOT EXISTS public.settings (
  id TEXT PRIMARY KEY,
  "tradingFee" NUMERIC(18, 4) DEFAULT 0.0100,
  "minDeposit" NUMERIC(18, 4) DEFAULT 500.0000,
  "minWithdrawal" NUMERIC(18, 4) DEFAULT 1000.0000,
  "maintenanceMode" BOOLEAN DEFAULT FALSE,
  "platformName" TEXT DEFAULT 'MarketPay',
  "siteProfit" NUMERIC(18, 4) DEFAULT 0.0000,
  "totalFees" NUMERIC(18, 4) DEFAULT 0.0000,
  updated_by TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO public.settings (id, "tradingFee", "minDeposit", "minWithdrawal", "maintenanceMode", "platformName")
VALUES ('platform', 0.01, 500, 1000, FALSE, 'MarketPay')
ON CONFLICT (id) DO NOTHING;

-- 13. Espelhos do Motor AMM
CREATE TABLE IF NOT EXISTS public.amm_settings (
  id TEXT PRIMARY KEY,
  platform_mode TEXT DEFAULT 'SANDBOX',
  amm_enabled BOOLEAN DEFAULT FALSE,
  emergency_halted BOOLEAN DEFAULT FALSE,
  autonomy_mode TEXT,
  warning_loss_bps INTEGER,
  protection_loss_bps INTEGER,
  halt_loss_bps INTEGER,
  max_allocation_budget_cents BIGINT,
  updated_by TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.amm_market_allocations (
  id TEXT PRIMARY KEY,
  market_id TEXT,
  market_question TEXT,
  allocated_capital_cents BIGINT DEFAULT 0,
  loss_limit_cents BIGINT DEFAULT 0,
  status TEXT,
  risk_state TEXT,
  requested_by TEXT,
  approved_by TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Índices para performance
CREATE INDEX IF NOT EXISTS idx_markets_status ON public.markets(status, resolved);
CREATE INDEX IF NOT EXISTS idx_trades_market ON public.trades(market_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_trades_user ON public.trades(user_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_positions_user ON public.positions(user_id);
CREATE INDEX IF NOT EXISTS idx_positions_market ON public.positions(market_id);
CREATE INDEX IF NOT EXISTS idx_comments_market ON public.comments(market_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_finance_user ON public.finance_requests(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ledger_user ON public.ledger(user_id, "createdAt" DESC);

-- Ativar RLS (Row Level Security)
ALTER TABLE public.categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.markets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trades ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.positions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.price_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.finance_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.amm_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.amm_market_allocations ENABLE ROW LEVEL SECURITY;

-- Políticas de leitura pública
DROP POLICY IF EXISTS "Public read categories" ON public.categories;
CREATE POLICY "Public read categories" ON public.categories FOR SELECT USING (true);
DROP POLICY IF EXISTS "Public read markets" ON public.markets;
CREATE POLICY "Public read markets" ON public.markets FOR SELECT USING (true);
DROP POLICY IF EXISTS "Public read trades" ON public.trades;
CREATE POLICY "Public read trades" ON public.trades FOR SELECT USING (true);
DROP POLICY IF EXISTS "Public read price_history" ON public.price_history;
CREATE POLICY "Public read price_history" ON public.price_history FOR SELECT USING (true);
DROP POLICY IF EXISTS "Public read comments" ON public.comments;
CREATE POLICY "Public read comments" ON public.comments FOR SELECT USING (true);
DROP POLICY IF EXISTS "Public read posts" ON public.posts;
CREATE POLICY "Public read posts" ON public.posts FOR SELECT USING (true);
DROP POLICY IF EXISTS "Public read settings" ON public.settings;
CREATE POLICY "Public read settings" ON public.settings FOR SELECT USING (true);
DROP POLICY IF EXISTS "Public read users leaderboard" ON public.users;
CREATE POLICY "Public read users leaderboard" ON public.users FOR SELECT USING (true);
DROP POLICY IF EXISTS "Public read positions" ON public.positions;
CREATE POLICY "Public read positions" ON public.positions FOR SELECT USING (true);

-- Políticas de utilizador autenticado
DROP POLICY IF EXISTS "Users insert own profile" ON public.users;
CREATE POLICY "Users insert own profile" ON public.users FOR INSERT WITH CHECK (auth.uid()::text = id);
DROP POLICY IF EXISTS "Users update own profile" ON public.users;
CREATE POLICY "Users update own profile" ON public.users FOR UPDATE USING (auth.uid()::text = id);
DROP POLICY IF EXISTS "Users read own ledger" ON public.ledger;
CREATE POLICY "Users read own ledger" ON public.ledger FOR SELECT USING (auth.uid()::text = user_id OR public.is_admin());
DROP POLICY IF EXISTS "Users read own finance" ON public.finance_requests;
CREATE POLICY "Users read own finance" ON public.finance_requests FOR SELECT USING (auth.uid()::text = user_id OR public.is_admin());
DROP POLICY IF EXISTS "Users insert own finance" ON public.finance_requests;
CREATE POLICY "Users insert own finance" ON public.finance_requests FOR INSERT WITH CHECK (auth.uid()::text = user_id);
DROP POLICY IF EXISTS "Users insert comments" ON public.comments;
CREATE POLICY "Users insert comments" ON public.comments FOR INSERT WITH CHECK (auth.uid()::text = user_id);
DROP POLICY IF EXISTS "Users delete own comments" ON public.comments;
CREATE POLICY "Users delete own comments" ON public.comments FOR DELETE USING (auth.uid()::text = user_id OR public.is_admin());
DROP POLICY IF EXISTS "Admins all comments" ON public.comments;
CREATE POLICY "Admins all comments" ON public.comments FOR ALL USING (public.is_admin());
DROP POLICY IF EXISTS "Authenticated create markets" ON public.markets;
CREATE POLICY "Authenticated create markets" ON public.markets FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);

-- Políticas de Administrador
DROP POLICY IF EXISTS "Admins all users" ON public.users;
CREATE POLICY "Admins all users" ON public.users FOR ALL USING (public.is_admin());
DROP POLICY IF EXISTS "Admins all categories" ON public.categories;
CREATE POLICY "Admins all categories" ON public.categories FOR ALL USING (public.is_admin());
DROP POLICY IF EXISTS "Admins all markets" ON public.markets;
CREATE POLICY "Admins all markets" ON public.markets FOR ALL USING (public.is_admin());
DROP POLICY IF EXISTS "Admins all trades" ON public.trades;
CREATE POLICY "Admins all trades" ON public.trades FOR ALL USING (public.is_admin());
DROP POLICY IF EXISTS "Admins all positions" ON public.positions;
CREATE POLICY "Admins all positions" ON public.positions FOR ALL USING (public.is_admin());
DROP POLICY IF EXISTS "Admins all finance" ON public.finance_requests;
CREATE POLICY "Admins all finance" ON public.finance_requests FOR ALL USING (public.is_admin());
DROP POLICY IF EXISTS "Admins all ledger" ON public.ledger;
CREATE POLICY "Admins all ledger" ON public.ledger FOR ALL USING (public.is_admin());
DROP POLICY IF EXISTS "Admins all audit_logs" ON public.audit_logs;
CREATE POLICY "Admins all audit_logs" ON public.audit_logs FOR ALL USING (public.is_admin());
DROP POLICY IF EXISTS "Admins all posts" ON public.posts;
CREATE POLICY "Admins all posts" ON public.posts FOR ALL USING (public.is_admin());
DROP POLICY IF EXISTS "Admins all settings" ON public.settings;
CREATE POLICY "Admins all settings" ON public.settings FOR ALL USING (public.is_admin());
DROP POLICY IF EXISTS "Admins all amm_settings" ON public.amm_settings;
CREATE POLICY "Admins all amm_settings" ON public.amm_settings FOR ALL USING (public.is_admin());
DROP POLICY IF EXISTS "Admins all amm_market_allocations" ON public.amm_market_allocations;
CREATE POLICY "Admins all amm_market_allocations" ON public.amm_market_allocations FOR ALL USING (public.is_admin());

CREATE INDEX IF NOT EXISTS idx_outcome_history_market ON public.outcome_price_history(market_id, timestamp ASC);
CREATE INDEX IF NOT EXISTS idx_proposals_market ON public.market_resolution_proposals(market_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_faqs_market ON public.market_faqs(market_id, sort_order ASC);
CREATE INDEX IF NOT EXISTS idx_market_positions_market_shares ON public.market_positions(market_id, shares_amount DESC);
CREATE INDEX IF NOT EXISTS idx_market_positions_user ON public.market_positions(user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_platform_revenue_created ON public.platform_revenue(created_at DESC);

ALTER TABLE public.comment_likes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.market_bookmarks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.market_resolution_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.market_faqs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.outcome_price_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.market_positions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_revenue ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Public read market_positions" ON public.market_positions;
CREATE POLICY "Public read market_positions" ON public.market_positions FOR SELECT USING (true);
DROP POLICY IF EXISTS "Admins all market_positions" ON public.market_positions;
CREATE POLICY "Admins all market_positions" ON public.market_positions FOR ALL USING (public.is_admin());

DROP POLICY IF EXISTS "Admins read platform_revenue" ON public.platform_revenue;
CREATE POLICY "Admins read platform_revenue" ON public.platform_revenue FOR SELECT USING (public.is_admin());
DROP POLICY IF EXISTS "Admins all platform_revenue" ON public.platform_revenue;
CREATE POLICY "Admins all platform_revenue" ON public.platform_revenue FOR ALL USING (public.is_admin());

DROP POLICY IF EXISTS "Public read comment_likes" ON public.comment_likes;
CREATE POLICY "Public read comment_likes" ON public.comment_likes FOR SELECT USING (true);
DROP POLICY IF EXISTS "Users manage own comment_likes" ON public.comment_likes;
CREATE POLICY "Users manage own comment_likes" ON public.comment_likes FOR ALL USING (auth.uid()::text = user_id);

DROP POLICY IF EXISTS "Users read own bookmarks" ON public.market_bookmarks;
CREATE POLICY "Users read own bookmarks" ON public.market_bookmarks FOR SELECT USING (auth.uid()::text = user_id);
DROP POLICY IF EXISTS "Users manage own bookmarks" ON public.market_bookmarks;
CREATE POLICY "Users manage own bookmarks" ON public.market_bookmarks FOR ALL USING (auth.uid()::text = user_id);

DROP POLICY IF EXISTS "Public read proposals" ON public.market_resolution_proposals;
CREATE POLICY "Public read proposals" ON public.market_resolution_proposals FOR SELECT USING (true);
DROP POLICY IF EXISTS "Authenticated insert proposals" ON public.market_resolution_proposals;
CREATE POLICY "Authenticated insert proposals" ON public.market_resolution_proposals FOR INSERT WITH CHECK (auth.uid()::text = user_id);
DROP POLICY IF EXISTS "Admins all proposals" ON public.market_resolution_proposals;
CREATE POLICY "Admins all proposals" ON public.market_resolution_proposals FOR ALL USING (public.is_admin());

DROP POLICY IF EXISTS "Public read faqs" ON public.market_faqs;
CREATE POLICY "Public read faqs" ON public.market_faqs FOR SELECT USING (true);
DROP POLICY IF EXISTS "Admins all faqs" ON public.market_faqs;
CREATE POLICY "Admins all faqs" ON public.market_faqs FOR ALL USING (public.is_admin());

DROP POLICY IF EXISTS "Public read outcome_price_history" ON public.outcome_price_history;
CREATE POLICY "Public read outcome_price_history" ON public.outcome_price_history FOR SELECT USING (true);
DROP POLICY IF EXISTS "Admins all outcome_price_history" ON public.outcome_price_history;
CREATE POLICY "Admins all outcome_price_history" ON public.outcome_price_history FOR ALL USING (public.is_admin());

-- ============================================================================
-- MOTOR FINANCEIRO AMM CPMM (x * y = k) EM KWANZA (Kz)
-- Liquidação por share vencedora = 100,00 Kz | Preço = 1,00..99,00 Kz
-- Taxa operação = 1% | Taxa liquidação/saque = 1%
-- Bloqueio Pessimista FOR UPDATE + Slippage Shield + Idempotência
-- ============================================================================

CREATE OR REPLACE FUNCTION public.normalize_cpmm_outcome(p_outcome TEXT)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_clean TEXT := LOWER(TRIM(COALESCE(p_outcome, '')));
BEGIN
  IF v_clean IN ('yes', 'sim', 's') THEN
    RETURN 'Yes';
  ELSIF v_clean IN ('no', 'nao', 'não', 'n') THEN
    RETURN 'No';
  END IF;
  RAISE EXCEPTION 'INVALID_OUTCOME: O resultado deve ser SIM (Yes) ou NÃO (No). Recebido: %', p_outcome;
END;
$$;

-- RPC 1: Criação de Mercado com Liquidez Inicial Automática (2.000,00 Kz -> 20 pares SIM/NÃO a 50%)
CREATE OR REPLACE FUNCTION public.create_market_with_liquidity(
  p_question TEXT,
  p_description TEXT DEFAULT NULL,
  p_category TEXT DEFAULT 'Geral',
  p_image_url TEXT DEFAULT NULL,
  p_end_date TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '7 days'),
  p_tags TEXT[] DEFAULT '{}',
  p_is_multi BOOLEAN DEFAULT FALSE,
  p_outcomes JSONB DEFAULT NULL,
  p_additional_context TEXT DEFAULT NULL,
  p_resolver_name TEXT DEFAULT 'MarketPay Oracle'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid TEXT := auth.uid()::text;
  v_user public.users%ROWTYPE;
  v_market_id TEXT := gen_random_uuid()::text;
  v_cost_kz NUMERIC(18, 4) := 2000.0000;
  v_initial_pairs NUMERIC(18, 4) := 20.0000;
  v_new_balance NUMERIC(18, 4);
  v_clean_question TEXT := TRIM(COALESCE(p_question, ''));
  v_clean_desc TEXT;
BEGIN
  IF v_uid IS NULL OR v_uid = '' THEN
    RAISE EXCEPTION 'UNAUTHORIZED: Sessão expirada. Faça login para criar um mercado.';
  END IF;

  IF LENGTH(v_clean_question) < 5 THEN
    RAISE EXCEPTION 'INVALID_QUESTION: A pergunta do mercado deve ter pelo menos 5 caracteres.';
  END IF;

  -- Lock pessimista na carteira do criador
  SELECT * INTO v_user FROM public.users WHERE id = v_uid FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'USER_NOT_FOUND: Conta de utilizador não encontrada.';
  END IF;

  IF v_user.status = 'blocked' THEN
    RAISE EXCEPTION 'ACCOUNT_BLOCKED: A sua conta encontra-se bloqueada.';
  END IF;

  IF COALESCE(v_user.balance, 0) < v_cost_kz THEN
    RAISE EXCEPTION 'INSUFFICIENT_BALANCE: Saldo insuficiente. Precisa de 2.000,00 Kz para o cofre de liquidez inicial. Saldo atual: % Kz.', ROUND(COALESCE(v_user.balance, 0), 2);
  END IF;

  v_new_balance := ROUND(v_user.balance - v_cost_kz, 4);
  v_clean_desc := COALESCE(NULLIF(TRIM(COALESCE(p_description, '')), ''), 'Este mercado resolve com base no resultado oficial para: ' || v_clean_question);

  -- 1. Debitar 2.000,00 Kz do criador
  PERFORM set_config('app.cpmm_rpc_active', 'true', true);
  UPDATE public.users
  SET balance = v_new_balance,
      updated_at = NOW()
  WHERE id = v_uid;
  PERFORM set_config('app.cpmm_rpc_active', 'false', true);

  -- 2 & 3 & 5. Criar mercado com 2.000,00 Kz no Cofre e 20 pares iniciais (20 SIM + 20 NÃO) a 50% / 50%
  INSERT INTO public.markets (
    id, question, description, additional_context, additional_context_updated_at,
    resolver_name, resolver_address, category, image_url,
    yes_price, no_price, yes_price_kz, no_price_kz,
    pool_yes, pool_no, liquidity_vault_kz, k_constant, b,
    volume, outcomes, is_multi, resolved, status, tags,
    creator_id, creator_fee_earned, admin_fee_earned, end_date, created_at
  ) VALUES (
    v_market_id,
    v_clean_question,
    v_clean_desc,
    NULLIF(TRIM(COALESCE(p_additional_context, '')), ''),
    CASE WHEN NULLIF(TRIM(COALESCE(p_additional_context, '')), '') IS NOT NULL THEN NOW() ELSE NULL END,
    COALESCE(NULLIF(TRIM(COALESCE(p_resolver_name, '')), ''), 'MarketPay Oracle'),
    'mp_oracle_v1',
    COALESCE(NULLIF(TRIM(COALESCE(p_category, '')), ''), 'Geral'),
    NULLIF(TRIM(COALESCE(p_image_url, '')), ''),
    0.5000, 0.5000, 50.0000, 50.0000,
    v_initial_pairs, v_initial_pairs, v_cost_kz, (v_initial_pairs * v_initial_pairs), v_cost_kz,
    0.0000, p_outcomes, COALESCE(p_is_multi, FALSE), FALSE, 'active',
    COALESCE(p_tags, ARRAY[COALESCE(NULLIF(TRIM(COALESCE(p_category, '')), ''), 'Geral'), 'Comunidade']),
    v_uid, 0.0000, 0.0000, COALESCE(p_end_date, NOW() + INTERVAL '7 days'), NOW()
  );

  -- 4. Registar o criador como Provedor de Liquidez (LP) detentor das 20 shares SIM + 20 shares NÃO iniciais
  INSERT INTO public.market_positions (
    id, market_id, user_id, user_name, outcome, shares_amount, avg_entry_price, total_cost_kz, is_lp, updated_at
  ) VALUES
    (gen_random_uuid()::text, v_market_id, v_uid, v_user.name, 'Yes', v_initial_pairs, 50.0000, 1000.0000, TRUE, NOW()),
    (gen_random_uuid()::text, v_market_id, v_uid, v_user.name, 'No', v_initial_pairs, 50.0000, 1000.0000, TRUE, NOW());

  -- Registar ponto inicial de preço e ledger
  INSERT INTO public.price_history (id, market_id, yes_price, no_price, timestamp)
  VALUES (gen_random_uuid()::text, v_market_id, 0.5000, 0.5000, NOW());

  INSERT INTO public.ledger (id, user_id, market_id, type, amount, "balanceBefore", "balanceAfter", reference, "createdAt")
  VALUES (gen_random_uuid()::text, v_uid, v_market_id, 'CRIACAO_MERCADO_LIQUIDEZ', -v_cost_kz, v_user.balance, v_new_balance, v_market_id, NOW());

  INSERT INTO public.audit_logs (id, admin_id, action, details, created_at, timestamp)
  VALUES (
    gen_random_uuid()::text,
    v_uid,
    'MARKET_CREATION_LP',
    'Criador ' || v_uid || ' abriu mercado ' || v_market_id || ' com 2.000,00 Kz no cofre (20 pares SIM/NÃO a 50%).',
    NOW(),
    NOW()
  );

  RETURN jsonb_build_object(
    'success', TRUE,
    'market_id', v_market_id,
    'liquidity_vault_kz', v_cost_kz,
    'pool_yes', v_initial_pairs,
    'pool_no', v_initial_pairs,
    'lp_pairs', v_initial_pairs,
    'yes_price_kz', 50.0000,
    'no_price_kz', 50.0000,
    'new_balance_kz', v_new_balance,
    'new_balance', v_new_balance
  );
END;
$$;

-- RPC 2: Compra Atómica de Shares via AMM CPMM (x * y = k) com Lock FOR UPDATE + Slippage Shield + Idempotência
CREATE OR REPLACE FUNCTION public.buy_shares(
  p_market_id TEXT,
  p_outcome TEXT,
  p_gross_amount_kz NUMERIC,
  p_expected_price NUMERIC,
  p_max_slippage_pct NUMERIC DEFAULT 1.0,
  p_idempotency_key TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid TEXT := auth.uid()::text;
  v_norm_outcome TEXT;
  v_existing_trade public.trades%ROWTYPE;
  v_market public.markets%ROWTYPE;
  v_user public.users%ROWTYPE;
  v_gross NUMERIC(18, 4);
  v_fee NUMERIC(18, 4);
  v_net NUMERIC(18, 4);
  v_pairs NUMERIC(18, 4);
  v_pool_yes NUMERIC(18, 4);
  v_pool_no NUMERIC(18, 4);
  v_total_pool NUMERIC(18, 4);
  v_spot_yes_before NUMERIC(18, 4);
  v_spot_no_before NUMERIC(18, 4);
  v_spot_before NUMERIC(18, 4);
  v_new_pool_yes NUMERIC(18, 4);
  v_new_pool_no NUMERIC(18, 4);
  v_shares_received NUMERIC(18, 4);
  v_avg_exec_price NUMERIC(18, 4);
  v_max_allowed NUMERIC(18, 4);
  v_new_total NUMERIC(18, 4);
  v_yes_price_kz NUMERIC(18, 4);
  v_no_price_kz NUMERIC(18, 4);
  v_yes_prob NUMERIC(18, 4);
  v_no_prob NUMERIC(18, 4);
  v_spot_after NUMERIC(18, 4);
  v_new_balance NUMERIC(18, 4);
  v_new_vault NUMERIC(18, 4);
  v_trade_id TEXT := gen_random_uuid()::text;
  v_clean_idem TEXT := NULLIF(TRIM(COALESCE(p_idempotency_key, '')), '');
  v_pos_id TEXT;
BEGIN
  IF v_uid IS NULL OR v_uid = '' THEN
    RAISE EXCEPTION 'UNAUTHORIZED: Inicie sessão para negociar.';
  END IF;

  v_norm_outcome := public.normalize_cpmm_outcome(p_outcome);
  v_gross := ROUND(COALESCE(p_gross_amount_kz, 0), 4);
  IF v_gross < 1.0000 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT: O valor mínimo de compra é 1,00 Kz.';
  END IF;

  -- Idempotência: se a chave já foi executada, devolve imediatamente sem duplicar débito
  IF v_clean_idem IS NOT NULL THEN
    SELECT * INTO v_existing_trade FROM public.trades WHERE idempotency_key = v_clean_idem LIMIT 1;
    IF FOUND THEN
      SELECT balance INTO v_new_balance FROM public.users WHERE id = v_uid;
      RETURN jsonb_build_object(
        'success', TRUE,
        'idempotent_replay', TRUE,
        'trade_id', v_existing_trade.id,
        'market_id', v_existing_trade.market_id,
        'outcome', v_existing_trade.outcome,
        'gross_amount_kz', v_existing_trade.amount,
        'net_amount_kz', v_existing_trade.net_amount_kz,
        'fee_kz', v_existing_trade.fee,
        'shares_received', v_existing_trade.shares,
        'avg_exec_price_kz', v_existing_trade.price,
        'spot_price_before_kz', v_existing_trade.price_before,
        'spot_price_after_kz', v_existing_trade.price_after,
        'new_balance_kz', COALESCE(v_new_balance, 0),
        'new_balance', COALESCE(v_new_balance, 0)
      );
    END IF;
  END IF;

  -- Lock pessimista ordenado (markets -> users) para enfileirar concorrência sem deadlocks
  SELECT * INTO v_market FROM public.markets WHERE id = p_market_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MARKET_NOT_FOUND: Mercado não encontrado.';
  END IF;

  SELECT * INTO v_user FROM public.users WHERE id = v_uid FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'USER_NOT_FOUND: Utilizador não encontrado.';
  END IF;

  IF v_user.status = 'blocked' THEN
    RAISE EXCEPTION 'ACCOUNT_BLOCKED: A sua conta encontra-se bloqueada.';
  END IF;

  IF v_market.resolved OR v_market.status <> 'active' THEN
    RAISE EXCEPTION 'MARKET_CLOSED: Este mercado já não se encontra ativo para negociação.';
  END IF;

  IF v_market.end_date <= NOW() THEN
    RAISE EXCEPTION 'MARKET_EXPIRED: O prazo deste mercado já encerrou.';
  END IF;

  IF COALESCE(v_user.balance, 0) < v_gross THEN
    RAISE EXCEPTION 'INSUFFICIENT_BALANCE: Saldo insuficiente (% Kz disponíveis).', ROUND(COALESCE(v_user.balance, 0), 2);
  END IF;

  -- Pools atuais (mínimo seguro de fallback para mercados antigos sem pool migrado)
  v_pool_yes := GREATEST(COALESCE(v_market.pool_yes, 20.0000), 0.0001);
  v_pool_no := GREATEST(COALESCE(v_market.pool_no, 20.0000), 0.0001);
  v_total_pool := v_pool_yes + v_pool_no;

  v_spot_yes_before := GREATEST(1.0000, LEAST(99.0000, ROUND((v_pool_no / v_total_pool) * 100.0000, 4)));
  v_spot_no_before := ROUND(100.0000 - v_spot_yes_before, 4);
  v_spot_before := CASE WHEN v_norm_outcome = 'Yes' THEN v_spot_yes_before ELSE v_spot_no_before END;

  -- Taxa de 1% -> platform_revenue | 99% líquido -> AMM CPMM
  v_fee := ROUND(v_gross * 0.0100, 4);
  v_net := ROUND(v_gross - v_fee, 4);
  v_pairs := ROUND(v_net / 100.0000, 4);

  IF v_norm_outcome = 'Yes' THEN
    v_new_pool_no := ROUND(v_pool_no + v_pairs, 4);
    v_new_pool_yes := ROUND((v_pool_yes * v_pool_no) / v_new_pool_no, 4);
    v_shares_received := ROUND((v_pool_yes + v_pairs) - v_new_pool_yes, 4);
  ELSE
    v_new_pool_yes := ROUND(v_pool_yes + v_pairs, 4);
    v_new_pool_no := ROUND((v_pool_yes * v_pool_no) / v_new_pool_yes, 4);
    v_shares_received := ROUND((v_pool_no + v_pairs) - v_new_pool_no, 4);
  END IF;

  IF v_shares_received <= 0 THEN
    RAISE EXCEPTION 'ZERO_SHARES: Montante líquido insuficiente para emitir shares.';
  END IF;

  v_avg_exec_price := ROUND(v_net / v_shares_received, 4);

  -- Proteção contra Slippage / Mudança de Preço
  IF COALESCE(p_expected_price, 0) > 0 THEN
    v_max_allowed := ROUND(p_expected_price * (1.0000 + GREATEST(0.0000, COALESCE(p_max_slippage_pct, 1.0000)) / 100.0000), 4);
    IF v_spot_before > v_max_allowed THEN
      RAISE EXCEPTION 'PRICE_CHANGED: O preço mudou de % para %. Confirme a nova cotação.', ROUND(p_expected_price, 2), ROUND(v_spot_before, 2);
    END IF;
    IF v_avg_exec_price > v_max_allowed THEN
      RAISE EXCEPTION 'PRICE_CHANGED: O preço mudou de % para %. Confirme a nova cotação.', ROUND(p_expected_price, 2), ROUND(v_avg_exec_price, 2);
    END IF;
  END IF;

  v_new_total := v_new_pool_yes + v_new_pool_no;
  v_yes_price_kz := GREATEST(1.0000, LEAST(99.0000, ROUND((v_new_pool_no / v_new_total) * 100.0000, 4)));
  v_no_price_kz := ROUND(100.0000 - v_yes_price_kz, 4);
  v_yes_prob := ROUND(v_yes_price_kz / 100.0000, 4);
  v_no_prob := ROUND(v_no_price_kz / 100.0000, 4);
  v_spot_after := CASE WHEN v_norm_outcome = 'Yes' THEN v_yes_price_kz ELSE v_no_price_kz END;

  v_new_balance := ROUND(v_user.balance - v_gross, 4);
  v_new_vault := ROUND(COALESCE(v_market.liquidity_vault_kz, (v_total_pool / 2.0000) * 100.0000) + v_net, 4);

  -- Debitar carteira do comprador
  PERFORM set_config('app.cpmm_rpc_active', 'true', true);
  UPDATE public.users
  SET balance = v_new_balance,
      updated_at = NOW()
  WHERE id = v_uid;
  PERFORM set_config('app.cpmm_rpc_active', 'false', true);

  -- Atualizar mercado (pools, cofre e preços)
  UPDATE public.markets
  SET pool_yes = v_new_pool_yes,
      pool_no = v_new_pool_no,
      liquidity_vault_kz = v_new_vault,
      k_constant = ROUND(v_new_pool_yes * v_new_pool_no, 4),
      yes_price = v_yes_prob,
      no_price = v_no_prob,
      yes_price_kz = v_yes_price_kz,
      no_price_kz = v_no_price_kz,
      volume = ROUND(COALESCE(volume, 0) + v_gross, 4),
      admin_fee_earned = ROUND(COALESCE(admin_fee_earned, 0) + v_fee, 4)
  WHERE id = p_market_id;

  -- Sincronizar posição LP do criador com as reservas atuais do pool
  IF v_market.creator_id IS NOT NULL THEN
    UPDATE public.market_positions
    SET shares_amount = CASE WHEN outcome = 'Yes' THEN v_new_pool_yes ELSE v_new_pool_no END,
        updated_at = NOW()
    WHERE market_id = p_market_id AND user_id = v_market.creator_id AND is_lp = TRUE;
  END IF;

  -- Upsert posição do trader em market_positions
  INSERT INTO public.market_positions (
    id, market_id, user_id, user_name, outcome, shares_amount, avg_entry_price, total_cost_kz, is_lp, updated_at
  ) VALUES (
    gen_random_uuid()::text, p_market_id, v_uid, v_user.name, v_norm_outcome,
    v_shares_received, v_avg_exec_price, v_net, FALSE, NOW()
  )
  ON CONFLICT (market_id, user_id, outcome, is_lp) DO UPDATE SET
    user_name = COALESCE(EXCLUDED.user_name, public.market_positions.user_name),
    shares_amount = ROUND(public.market_positions.shares_amount + EXCLUDED.shares_amount, 4),
    total_cost_kz = ROUND(public.market_positions.total_cost_kz + EXCLUDED.total_cost_kz, 4),
    avg_entry_price = ROUND(
      (public.market_positions.total_cost_kz + EXCLUDED.total_cost_kz)
      / NULLIF(public.market_positions.shares_amount + EXCLUDED.shares_amount, 0),
      4
    ),
    updated_at = NOW();

  -- Espelho de compatibilidade em public.positions
  v_pos_id := v_uid || '_' || p_market_id || '_' || v_norm_outcome;
  INSERT INTO public.positions (
    id, user_id, "userId", market_id, "marketId", outcome, shares, available_shares, reserved_shares, avg_price, updated_at
  )
  SELECT
    v_pos_id, v_uid, v_uid, p_market_id, p_market_id, v_norm_outcome,
    mp.shares_amount, mp.shares_amount, 0, mp.avg_entry_price, NOW()
  FROM public.market_positions mp
  WHERE mp.market_id = p_market_id AND mp.user_id = v_uid AND mp.outcome = v_norm_outcome AND mp.is_lp = FALSE
  ON CONFLICT (id) DO UPDATE SET
    shares = EXCLUDED.shares,
    available_shares = EXCLUDED.available_shares,
    avg_price = EXCLUDED.avg_price,
    updated_at = NOW();

  -- Registar Trade com chave de idempotência
  INSERT INTO public.trades (
    id, market_id, user_id, side, outcome, amount, net_amount_kz, shares,
    price, price_before, price_after, expected_price, slippage_pct, fee, idempotency_key, engine, timestamp
  ) VALUES (
    v_trade_id, p_market_id, v_uid, 'Buy', v_norm_outcome, v_gross, v_net, v_shares_received,
    v_avg_exec_price, v_spot_before, v_spot_after, p_expected_price, p_max_slippage_pct, v_fee, v_clean_idem, 'CPMM_AMM', NOW()
  );

  -- Registar receita da plataforma (1%)
  INSERT INTO public.platform_revenue (id, market_id, user_id, trade_id, source_type, gross_amount_kz, fee_amount_kz, created_at)
  VALUES (gen_random_uuid()::text, p_market_id, v_uid, v_trade_id, 'TRADING_FEE_BUY', v_gross, v_fee, NOW());

  UPDATE public.settings
  SET "totalFees" = ROUND(COALESCE("totalFees", 0) + v_fee, 4),
      "siteProfit" = ROUND(COALESCE("siteProfit", 0) + v_fee, 4),
      updated_at = NOW()
  WHERE id = 'platform';

  INSERT INTO public.price_history (id, market_id, yes_price, no_price, timestamp)
  VALUES (gen_random_uuid()::text, p_market_id, v_yes_prob, v_no_prob, NOW());

  INSERT INTO public.ledger (id, user_id, market_id, type, amount, "balanceBefore", "balanceAfter", reference, "createdAt")
  VALUES (gen_random_uuid()::text, v_uid, p_market_id, 'COMPRA_QUOTAS', -v_gross, v_user.balance, v_new_balance, COALESCE(v_clean_idem, p_market_id || ':' || v_trade_id), NOW());

  RETURN jsonb_build_object(
    'success', TRUE,
    'idempotent_replay', FALSE,
    'trade_id', v_trade_id,
    'market_id', p_market_id,
    'outcome', v_norm_outcome,
    'gross_amount_kz', v_gross,
    'net_amount_kz', v_net,
    'fee_kz', v_fee,
    'shares_received', v_shares_received,
    'avg_exec_price_kz', v_avg_exec_price,
    'spot_price_before_kz', v_spot_before,
    'spot_price_after_kz', v_spot_after,
    'yes_price_kz', v_yes_price_kz,
    'no_price_kz', v_no_price_kz,
    'pool_yes', v_new_pool_yes,
    'pool_no', v_new_pool_no,
    'liquidity_vault_kz', v_new_vault,
    'new_balance_kz', v_new_balance,
    'new_balance', v_new_balance
  );
END;
$$;

-- RPC 3: Venda Atómica de Shares de volta ao AMM CPMM (queima inversa de pares completos)
CREATE OR REPLACE FUNCTION public.sell_shares(
  p_market_id TEXT,
  p_outcome TEXT,
  p_shares_to_sell NUMERIC,
  p_expected_price NUMERIC,
  p_max_slippage_pct NUMERIC DEFAULT 1.0,
  p_idempotency_key TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid TEXT := auth.uid()::text;
  v_norm_outcome TEXT;
  v_existing_trade public.trades%ROWTYPE;
  v_market public.markets%ROWTYPE;
  v_user public.users%ROWTYPE;
  v_pos public.market_positions%ROWTYPE;
  v_shares NUMERIC(18, 4);
  v_pool_yes NUMERIC(18, 4);
  v_pool_no NUMERIC(18, 4);
  v_total_pool NUMERIC(18, 4);
  v_spot_yes_before NUMERIC(18, 4);
  v_spot_no_before NUMERIC(18, 4);
  v_spot_before NUMERIC(18, 4);
  v_b NUMERIC(18, 4);
  v_disc NUMERIC(36, 8);
  v_pairs_out NUMERIC(18, 4);
  v_gross_kz NUMERIC(18, 4);
  v_fee_kz NUMERIC(18, 4);
  v_net_kz NUMERIC(18, 4);
  v_new_pool_yes NUMERIC(18, 4);
  v_new_pool_no NUMERIC(18, 4);
  v_avg_exec_price NUMERIC(18, 4);
  v_min_allowed NUMERIC(18, 4);
  v_new_total NUMERIC(18, 4);
  v_yes_price_kz NUMERIC(18, 4);
  v_no_price_kz NUMERIC(18, 4);
  v_yes_prob NUMERIC(18, 4);
  v_no_prob NUMERIC(18, 4);
  v_spot_after NUMERIC(18, 4);
  v_new_balance NUMERIC(18, 4);
  v_new_vault NUMERIC(18, 4);
  v_remaining_shares NUMERIC(18, 4);
  v_remaining_cost NUMERIC(18, 4);
  v_trade_id TEXT := gen_random_uuid()::text;
  v_clean_idem TEXT := NULLIF(TRIM(COALESCE(p_idempotency_key, '')), '');
  v_pos_id TEXT;
BEGIN
  IF v_uid IS NULL OR v_uid = '' THEN
    RAISE EXCEPTION 'UNAUTHORIZED: Inicie sessão para vender shares.';
  END IF;

  v_norm_outcome := public.normalize_cpmm_outcome(p_outcome);
  v_shares := ROUND(COALESCE(p_shares_to_sell, 0), 4);
  IF v_shares <= 0 THEN
    RAISE EXCEPTION 'INVALID_SHARES: A quantidade de shares para venda deve ser superior a zero.';
  END IF;

  IF v_clean_idem IS NOT NULL THEN
    SELECT * INTO v_existing_trade FROM public.trades WHERE idempotency_key = v_clean_idem LIMIT 1;
    IF FOUND THEN
      SELECT balance INTO v_new_balance FROM public.users WHERE id = v_uid;
      RETURN jsonb_build_object(
        'success', TRUE,
        'idempotent_replay', TRUE,
        'trade_id', v_existing_trade.id,
        'market_id', v_existing_trade.market_id,
        'outcome', v_existing_trade.outcome,
        'shares_sold', v_existing_trade.shares,
        'gross_return_kz', v_existing_trade.amount,
        'net_return_kz', v_existing_trade.net_amount_kz,
        'fee_kz', v_existing_trade.fee,
        'avg_exec_price_kz', v_existing_trade.price,
        'new_balance_kz', COALESCE(v_new_balance, 0),
        'new_balance', COALESCE(v_new_balance, 0)
      );
    END IF;
  END IF;

  SELECT * INTO v_market FROM public.markets WHERE id = p_market_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MARKET_NOT_FOUND: Mercado não encontrado.';
  END IF;

  SELECT * INTO v_user FROM public.users WHERE id = v_uid FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'USER_NOT_FOUND: Utilizador não encontrado.';
  END IF;

  IF v_user.status = 'blocked' THEN
    RAISE EXCEPTION 'ACCOUNT_BLOCKED: A sua conta encontra-se bloqueada.';
  END IF;

  IF v_market.resolved OR v_market.status <> 'active' THEN
    RAISE EXCEPTION 'MARKET_CLOSED: Este mercado já não está ativo para negociação.';
  END IF;

  SELECT * INTO v_pos
  FROM public.market_positions
  WHERE market_id = p_market_id AND user_id = v_uid AND outcome = v_norm_outcome AND is_lp = FALSE
  FOR UPDATE;

  IF NOT FOUND OR v_pos.shares_amount < v_shares THEN
    RAISE EXCEPTION 'INSUFFICIENT_SHARES: Possui apenas % shares disponíveis para vender.', ROUND(COALESCE(v_pos.shares_amount, 0), 4);
  END IF;

  v_pool_yes := GREATEST(COALESCE(v_market.pool_yes, 20.0000), 0.0001);
  v_pool_no := GREATEST(COALESCE(v_market.pool_no, 20.0000), 0.0001);
  v_total_pool := v_pool_yes + v_pool_no;
  v_spot_yes_before := GREATEST(1.0000, LEAST(99.0000, ROUND((v_pool_no / v_total_pool) * 100.0000, 4)));
  v_spot_no_before := ROUND(100.0000 - v_spot_yes_before, 4);
  v_spot_before := CASE WHEN v_norm_outcome = 'Yes' THEN v_spot_yes_before ELSE v_spot_no_before END;

  -- Inversa exata CPMM: P^2 - (X + Y + S)*P + S*Y_opp = 0
  v_b := v_pool_yes + v_pool_no + v_shares;
  IF v_norm_outcome = 'Yes' THEN
    v_disc := GREATEST(0, (v_b * v_b) - (4.0000 * v_shares * v_pool_no));
    v_pairs_out := ROUND((v_b - SQRT(v_disc)) / 2.0000, 4);
    v_new_pool_yes := ROUND(v_pool_yes + v_shares - v_pairs_out, 4);
    v_new_pool_no := GREATEST(0.0001, ROUND(v_pool_no - v_pairs_out, 4));
  ELSE
    v_disc := GREATEST(0, (v_b * v_b) - (4.0000 * v_shares * v_pool_yes));
    v_pairs_out := ROUND((v_b - SQRT(v_disc)) / 2.0000, 4);
    v_new_pool_no := ROUND(v_pool_no + v_shares - v_pairs_out, 4);
    v_new_pool_yes := GREATEST(0.0001, ROUND(v_pool_yes - v_pairs_out, 4));
  END IF;

  v_gross_kz := ROUND(v_pairs_out * 100.0000, 4);
  IF v_gross_kz <= 0 OR v_gross_kz > COALESCE(v_market.liquidity_vault_kz, (v_total_pool / 2.0000) * 100.0000) THEN
    RAISE EXCEPTION 'ZERO_RETURN: Liquidez insuficiente no cofre para fechar esta venda.';
  END IF;

  v_fee_kz := ROUND(v_gross_kz * 0.0100, 4);
  v_net_kz := ROUND(v_gross_kz - v_fee_kz, 4);
  v_avg_exec_price := ROUND(v_gross_kz / v_shares, 4);

  IF COALESCE(p_expected_price, 0) > 0 THEN
    v_min_allowed := ROUND(p_expected_price * GREATEST(0.0100, 1.0000 - GREATEST(0.0000, COALESCE(p_max_slippage_pct, 1.0000)) / 100.0000), 4);
    IF v_spot_before < v_min_allowed THEN
      RAISE EXCEPTION 'PRICE_CHANGED: O preço mudou de % para %. Confirme a nova cotação.', ROUND(p_expected_price, 2), ROUND(v_spot_before, 2);
    END IF;
    IF v_avg_exec_price < v_min_allowed THEN
      RAISE EXCEPTION 'PRICE_CHANGED: O preço mudou de % para %. Confirme a nova cotação.', ROUND(p_expected_price, 2), ROUND(v_avg_exec_price, 2);
    END IF;
  END IF;

  v_new_total := v_new_pool_yes + v_new_pool_no;
  v_yes_price_kz := GREATEST(1.0000, LEAST(99.0000, ROUND((v_new_pool_no / v_new_total) * 100.0000, 4)));
  v_no_price_kz := ROUND(100.0000 - v_yes_price_kz, 4);
  v_yes_prob := ROUND(v_yes_price_kz / 100.0000, 4);
  v_no_prob := ROUND(v_no_price_kz / 100.0000, 4);
  v_spot_after := CASE WHEN v_norm_outcome = 'Yes' THEN v_yes_price_kz ELSE v_no_price_kz END;

  v_new_balance := ROUND(v_user.balance + v_net_kz, 4);
  v_new_vault := GREATEST(0.0000, ROUND(COALESCE(v_market.liquidity_vault_kz, (v_total_pool / 2.0000) * 100.0000) - v_gross_kz, 4));

  PERFORM set_config('app.cpmm_rpc_active', 'true', true);
  UPDATE public.users
  SET balance = v_new_balance,
      updated_at = NOW()
  WHERE id = v_uid;
  PERFORM set_config('app.cpmm_rpc_active', 'false', true);

  UPDATE public.markets
  SET pool_yes = v_new_pool_yes,
      pool_no = v_new_pool_no,
      liquidity_vault_kz = v_new_vault,
      k_constant = ROUND(v_new_pool_yes * v_new_pool_no, 4),
      yes_price = v_yes_prob,
      no_price = v_no_prob,
      yes_price_kz = v_yes_price_kz,
      no_price_kz = v_no_price_kz,
      volume = ROUND(COALESCE(volume, 0) + v_gross_kz, 4),
      admin_fee_earned = ROUND(COALESCE(admin_fee_earned, 0) + v_fee_kz, 4)
  WHERE id = p_market_id;

  IF v_market.creator_id IS NOT NULL THEN
    UPDATE public.market_positions
    SET shares_amount = CASE WHEN outcome = 'Yes' THEN v_new_pool_yes ELSE v_new_pool_no END,
        updated_at = NOW()
    WHERE market_id = p_market_id AND user_id = v_market.creator_id AND is_lp = TRUE;
  END IF;

  v_remaining_shares := ROUND(v_pos.shares_amount - v_shares, 4);
  v_pos_id := v_uid || '_' || p_market_id || '_' || v_norm_outcome;

  IF v_remaining_shares <= 0.0001 THEN
    DELETE FROM public.market_positions WHERE id = v_pos.id;
    DELETE FROM public.positions WHERE id = v_pos_id;
  ELSE
    v_remaining_cost := ROUND(v_pos.total_cost_kz * (v_remaining_shares / v_pos.shares_amount), 4);
    UPDATE public.market_positions
    SET shares_amount = v_remaining_shares,
        total_cost_kz = v_remaining_cost,
        updated_at = NOW()
    WHERE id = v_pos.id;

    UPDATE public.positions
    SET shares = v_remaining_shares,
        available_shares = v_remaining_shares,
        updated_at = NOW()
    WHERE id = v_pos_id;
  END IF;

  INSERT INTO public.trades (
    id, market_id, user_id, side, outcome, amount, net_amount_kz, shares,
    price, price_before, price_after, expected_price, slippage_pct, fee, idempotency_key, engine, timestamp
  ) VALUES (
    v_trade_id, p_market_id, v_uid, 'Sell', v_norm_outcome, v_gross_kz, v_net_kz, v_shares,
    v_avg_exec_price, v_spot_before, v_spot_after, p_expected_price, p_max_slippage_pct, v_fee_kz, v_clean_idem, 'CPMM_AMM', NOW()
  );

  INSERT INTO public.platform_revenue (id, market_id, user_id, trade_id, source_type, gross_amount_kz, fee_amount_kz, created_at)
  VALUES (gen_random_uuid()::text, p_market_id, v_uid, v_trade_id, 'TRADING_FEE_SELL', v_gross_kz, v_fee_kz, NOW());

  UPDATE public.settings
  SET "totalFees" = ROUND(COALESCE("totalFees", 0) + v_fee_kz, 4),
      "siteProfit" = ROUND(COALESCE("siteProfit", 0) + v_fee_kz, 4),
      updated_at = NOW()
  WHERE id = 'platform';

  INSERT INTO public.price_history (id, market_id, yes_price, no_price, timestamp)
  VALUES (gen_random_uuid()::text, p_market_id, v_yes_prob, v_no_prob, NOW());

  INSERT INTO public.ledger (id, user_id, market_id, type, amount, "balanceBefore", "balanceAfter", reference, "createdAt")
  VALUES (gen_random_uuid()::text, v_uid, p_market_id, 'VENDA_QUOTAS', v_net_kz, v_user.balance, v_new_balance, COALESCE(v_clean_idem, p_market_id || ':' || v_trade_id), NOW());

  RETURN jsonb_build_object(
    'success', TRUE,
    'idempotent_replay', FALSE,
    'trade_id', v_trade_id,
    'market_id', p_market_id,
    'outcome', v_norm_outcome,
    'shares_sold', v_shares,
    'gross_return_kz', v_gross_kz,
    'net_return_kz', v_net_kz,
    'fee_kz', v_fee_kz,
    'avg_exec_price_kz', v_avg_exec_price,
    'spot_price_before_kz', v_spot_before,
    'spot_price_after_kz', v_spot_after,
    'yes_price_kz', v_yes_price_kz,
    'no_price_kz', v_no_price_kz,
    'pool_yes', v_new_pool_yes,
    'pool_no', v_new_pool_no,
    'liquidity_vault_kz', v_new_vault,
    'new_balance_kz', v_new_balance,
    'new_balance', v_new_balance
  );
END;
$$;

-- RPC 4: Liquidação Final de Mercado (100,00 Kz bruto por share vencedora - 1% taxa de levantamento -> platform_revenue)
CREATE OR REPLACE FUNCTION public.resolve_market(
  p_market_id TEXT,
  p_winning_outcome TEXT,
  p_motive TEXT DEFAULT 'Resolução oficial do mercado'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_admin_uid TEXT := COALESCE(auth.uid()::text, 'SYSTEM_SERVICE');
  v_norm_winner TEXT;
  v_market public.markets%ROWTYPE;
  v_pos RECORD;
  v_user_bal NUMERIC(18, 4);
  v_new_bal NUMERIC(18, 4);
  v_gross_payout NUMERIC(18, 4);
  v_withdrawal_fee NUMERIC(18, 4);
  v_net_payout NUMERIC(18, 4);
  v_total_gross NUMERIC(18, 4) := 0.0000;
  v_total_fees NUMERIC(18, 4) := 0.0000;
  v_total_net NUMERIC(18, 4) := 0.0000;
  v_payouts_count INTEGER := 0;
BEGIN
  IF NOT (auth.role() = 'service_role' OR current_setting('role', true) = 'service_role' OR public.is_admin()) THEN
    RAISE EXCEPTION 'FORBIDDEN: Apenas administradores podem resolver mercados.';
  END IF;

  v_norm_winner := public.normalize_cpmm_outcome(p_winning_outcome);

  SELECT * INTO v_market FROM public.markets WHERE id = p_market_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MARKET_NOT_FOUND: Mercado não encontrado.';
  END IF;

  IF v_market.resolved THEN
    RAISE EXCEPTION 'ALREADY_RESOLVED: Este mercado já foi resolvido.';
  END IF;

  -- Liquidar todos os detentores vencedores (traders + criador LP das shares remanescentes do pool)
  FOR v_pos IN
    SELECT *
    FROM public.market_positions
    WHERE market_id = p_market_id
      AND outcome = v_norm_winner
      AND shares_amount > 0
    ORDER BY user_id ASC, is_lp ASC
  LOOP
    SELECT balance INTO v_user_bal FROM public.users WHERE id = v_pos.user_id FOR UPDATE;
    IF FOUND THEN
      v_gross_payout := ROUND(v_pos.shares_amount * 100.0000, 4);
      v_withdrawal_fee := ROUND(v_gross_payout * 0.0100, 4);
      v_net_payout := ROUND(v_gross_payout - v_withdrawal_fee, 4);
      v_new_bal := ROUND(COALESCE(v_user_bal, 0) + v_net_payout, 4);

      PERFORM set_config('app.cpmm_rpc_active', 'true', true);
      UPDATE public.users
      SET balance = v_new_bal,
          updated_at = NOW()
      WHERE id = v_pos.user_id;
      PERFORM set_config('app.cpmm_rpc_active', 'false', true);

      INSERT INTO public.platform_revenue (
        id, market_id, user_id, trade_id, source_type, gross_amount_kz, fee_amount_kz, created_at
      ) VALUES (
        gen_random_uuid()::text, p_market_id, v_pos.user_id, NULL, 'PAYOUT_WITHDRAWAL_FEE', v_gross_payout, v_withdrawal_fee, NOW()
      );

      INSERT INTO public.ledger (id, user_id, market_id, type, amount, "balanceBefore", "balanceAfter", reference, "createdAt")
      VALUES (
        gen_random_uuid()::text,
        v_pos.user_id,
        p_market_id,
        CASE WHEN v_pos.is_lp THEN 'LIQUIDACAO_LP' ELSE 'PREMIACAO_MERCADO' END,
        v_net_payout,
        COALESCE(v_user_bal, 0),
        v_new_bal,
        p_market_id,
        NOW()
      );

      v_total_gross := ROUND(v_total_gross + v_gross_payout, 4);
      v_total_fees := ROUND(v_total_fees + v_withdrawal_fee, 4);
      v_total_net := ROUND(v_total_net + v_net_payout, 4);
      v_payouts_count := v_payouts_count + 1;
    END IF;
  END LOOP;

  -- Fechar mercado e atualizar preços finais (100 Kz vencedor / 0 Kz perdedor)
  UPDATE public.markets
  SET resolved = TRUE,
      resolution_outcome = v_norm_winner,
      status = 'resolved',
      resolved_at = NOW(),
      resolution_motive = COALESCE(NULLIF(TRIM(COALESCE(p_motive, '')), ''), 'Resolução oficial'),
      resolved_by = v_admin_uid,
      yes_price = CASE WHEN v_norm_winner = 'Yes' THEN 1.0000 ELSE 0.0000 END,
      no_price = CASE WHEN v_norm_winner = 'No' THEN 1.0000 ELSE 0.0000 END,
      yes_price_kz = CASE WHEN v_norm_winner = 'Yes' THEN 100.0000 ELSE 0.0000 END,
      no_price_kz = CASE WHEN v_norm_winner = 'No' THEN 100.0000 ELSE 0.0000 END,
      liquidity_vault_kz = 0.0000,
      admin_fee_earned = ROUND(COALESCE(admin_fee_earned, 0) + v_total_fees, 4)
  WHERE id = p_market_id;

  -- Limpar posições abertas após liquidação
  DELETE FROM public.market_positions WHERE market_id = p_market_id;
  DELETE FROM public.positions WHERE market_id = p_market_id OR "marketId" = p_market_id;

  UPDATE public.settings
  SET "totalFees" = ROUND(COALESCE("totalFees", 0) + v_total_fees, 4),
      "siteProfit" = ROUND(COALESCE("siteProfit", 0) + v_total_fees, 4),
      updated_at = NOW()
  WHERE id = 'platform';

  INSERT INTO public.audit_logs (id, admin_id, action, details, created_at, timestamp)
  VALUES (
    gen_random_uuid()::text,
    v_admin_uid,
    'MARKET_RESOLUTION_CPMM',
    'Mercado ' || p_market_id || ' resolvido como ' || v_norm_winner || '. Pagamentos: ' || v_payouts_count || ', Bruto: ' || ROUND(v_total_gross, 2) || ' Kz, Líquido: ' || ROUND(v_total_net, 2) || ' Kz, Taxa 1%: ' || ROUND(v_total_fees, 2) || ' Kz.',
    NOW(),
    NOW()
  );

  RETURN jsonb_build_object(
    'resolved', TRUE,
    'market_id', p_market_id,
    'winning_outcome', v_norm_winner,
    'payouts_count', v_payouts_count,
    'total_gross_kz', v_total_gross,
    'total_fees_kz', v_total_fees,
    'total_net_kz', v_total_net
  );
END;
$$;

-- Tempo Real (Realtime)
DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'markets', 'trades', 'users', 'finance_requests',
    'comments', 'price_history', 'outcome_price_history', 'categories',
    'positions', 'market_positions', 'platform_revenue', 'posts'
  ]
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = tbl
    ) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', tbl);
    END IF;
  END LOOP;
END $$;

-- Promover Master Admins designados caso as contas já existam
UPDATE public.users
SET is_admin = TRUE,
    role = 'MASTER_ADMIN',
    updated_at = NOW()
WHERE LOWER(COALESCE(email, '')) IN (
  'evaristopaulocassoma00@gmail.com',
  'evaristopaulocassoma20@gmail.com'
);

-- ============================================================================
-- STORAGE BUCKET PARA IMAGENS DE MERCADOS (market-images)
-- ============================================================================
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'market-images',
  'market-images',
  TRUE,
  5242880,
  ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/gif']
)
ON CONFLICT (id) DO UPDATE
SET public = TRUE,
    file_size_limit = 5242880,
    allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

DROP POLICY IF EXISTS "Leitura pública das imagens de mercados" ON storage.objects;
CREATE POLICY "Leitura pública das imagens de mercados"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'market-images');

DROP POLICY IF EXISTS "Upload autenticado de imagens de mercados" ON storage.objects;
CREATE POLICY "Upload autenticado de imagens de mercados"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (bucket_id = 'market-images');

