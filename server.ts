import express from "express";
import cors from "cors";
import { createServer } from "http";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import { createAmmDatabase } from "./server/db";
import { createAmmRouter } from "./server/routes/ammRoutes";
import { createAdminAnalyticsRouter } from "./server/routes/adminAnalyticsRoutes";
import { createMarketInteractionRouter } from "./server/routes/marketInteractionRoutes";
import { apiMetricsMiddleware } from "./server/healthMonitor";
import { runAmmStrategyForMarket } from "./server/ammStrategy";
import { SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, getSupabaseRestHeaders, isServerSupabaseConfigured } from "./server/supabaseConfig";
import { syncDesignatedAdminsInSupabase } from "./server/auth";

// Disable Vite HMR standalone WS server (port 24678) in AI Studio iframe/dev proxy environments
if (!process.env.DISABLE_HMR) {
  process.env.DISABLE_HMR = "true";
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  
  // Habilitar CORS para evitar "Failed to fetch" em ambientes de proxy/iframe
  app.use(cors());
  app.use(express.json());
  app.use(apiMetricsMiddleware);

  // Initialize authoritative AMM + CLOB + Double-Entry Accounting database
  const ammDb = createAmmDatabase();
  app.use("/api", createAmmRouter(ammDb));
  app.use("/api", createAdminAnalyticsRouter(ammDb));
  app.use("/api", createMarketInteractionRouter(ammDb));

  syncDesignatedAdminsInSupabase()
    .then((res) => {
      if (res.promoted.length > 0) {
        console.log("Designated admins synced in Supabase:", res.promoted.join(", "));
      }
    })
    .catch((err) => {
      console.warn("Designated admin sync skipped:", err?.message || err);
    });

  // Controlled autonomous AMM strategy loop (only executes when Master Admin enables AMM in SANDBOX)
  setInterval(() => {
    try {
      const settings = ammDb.prepare(`SELECT amm_enabled, emergency_halted FROM amm_settings WHERE id = 1`).get() as any;
      if (settings?.amm_enabled === 1 && settings?.emergency_halted === 0) {
        const approved = ammDb
          .prepare(`SELECT market_id FROM amm_market_allocations WHERE status = 'APPROVED' AND market_resolved = 0`)
          .all() as Array<{ market_id: string }>;
        for (const m of approved) {
          runAmmStrategyForMarket(ammDb, m.market_id);
        }
      }
    } catch (err) {
      console.error("AMM autonomous strategy cycle error:", err);
    }
  }, 15_000);

  const server = createServer(app);
  const PORT = 3000;

  // Lightweight OAuth callback bridge (works inside AI Studio iframe popups without loading the full SPA)
  app.get(["/auth/callback", "/auth/callback/"], (_req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(`<!doctype html>
<html lang="pt">
<head>
  <meta charset="utf-8" />
  <title>Autenticando MarketPay...</title>
  <style>
    body { background: #0f1115; color: #e2e8f0; font-family: system-ui, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    .card { text-align: center; padding: 24px 32px; background: #181a20; border: 1px solid #2b2f3a; border-radius: 12px; max-width: 380px; }
    .muted { color: #94a3b8; font-size: 13px; margin-top: 8px; }
  </style>
</head>
<body>
  <div class="card">
    <strong>A concluir autenticação Google...</strong>
    <p class="muted" id="msg">Pode fechar esta janela se não fechar automaticamente.</p>
  </div>
  <script>
    (function () {
      var payload = {
        type: 'SUPABASE_OAUTH_CALLBACK',
        search: window.location.search || '',
        hash: window.location.hash || ''
      };
      try {
        if (typeof BroadcastChannel !== 'undefined') {
          var ch = new BroadcastChannel('marketpay_oauth');
          ch.postMessage(payload);
          ch.close();
        }
      } catch (e) {}
      if (window.opener && !window.opener.closed) {
        try {
          window.opener.postMessage(payload, '*');
        } catch (e) {}
        setTimeout(function () { window.close(); }, 350);
      } else {
        window.location.replace('/' + (window.location.search || '') + (window.location.hash || ''));
      }
    })();
  </script>
</body>
</html>`);
  });

  // Safe non-secret Supabase connectivity & table existence diagnostics
  app.get("/api/supabase/status", async (_req, res) => {
    const requiredTables = [
      "categories",
      "users",
      "markets",
      "trades",
      "positions",
      "comments",
      "price_history",
      "finance_requests",
      "ledger",
      "audit_logs",
      "posts",
      "settings",
      "amm_settings",
      "amm_market_allocations",
    ];
    if (!isServerSupabaseConfigured) {
      res.json({
        configured: false,
        hasUrl: Boolean(SUPABASE_URL),
        hasAnonKey: Boolean(SUPABASE_ANON_KEY),
        hasServiceRoleKey: Boolean(SUPABASE_SERVICE_ROLE_KEY),
        tables: Object.fromEntries(requiredTables.map((t) => [t, { ok: false, status: 0, error: "Not configured" }])),
      });
      return;
    }

    const tables: Record<string, { ok: boolean; status: number; error?: string }> = {};
    await Promise.all(
      requiredTables.map(async (table) => {
        try {
          const resp = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=*&limit=1`, {
            headers: getSupabaseRestHeaders(),
          });
          if (resp.ok) {
            tables[table] = { ok: true, status: resp.status };
          } else {
            const text = await resp.text();
            tables[table] = { ok: false, status: resp.status, error: text.slice(0, 180) };
          }
        } catch (err: any) {
          tables[table] = { ok: false, status: 0, error: err?.message || "Network error" };
        }
      })
    );

    let authSettings: {
      googleEnabled: boolean;
      emailEnabled: boolean;
      mailerAutoconfirm: boolean;
      disableSignup: boolean;
    } | null = null;

    try {
      const authResp = await fetch(`${SUPABASE_URL}/auth/v1/settings`, {
        headers: { apikey: SUPABASE_ANON_KEY },
      });
      if (authResp.ok) {
        const authJson = (await authResp.json()) as any;
        authSettings = {
          googleEnabled: Boolean(authJson?.external?.google),
          emailEnabled: authJson?.external?.email !== false,
          mailerAutoconfirm: Boolean(authJson?.mailer_autoconfirm),
          disableSignup: Boolean(authJson?.disable_signup),
        };
      }
    } catch {
      authSettings = null;
    }

    let projectRef = "";
    try {
      projectRef = new URL(SUPABASE_URL).hostname.split(".")[0] || "";
    } catch {
      projectRef = "";
    }
    const authProvidersUrl = projectRef
      ? `https://supabase.com/dashboard/project/${projectRef}/auth/providers`
      : "https://supabase.com/dashboard";
    const authUrlConfigUrl = projectRef
      ? `https://supabase.com/dashboard/project/${projectRef}/auth/url-configuration`
      : "https://supabase.com/dashboard";
    const supabaseCallbackUrl = SUPABASE_URL ? `${SUPABASE_URL.replace(/\/+$/, "")}/auth/v1/callback` : "";

    let extraTables: Record<string, { ok: boolean; status: number }> = {};
    let cpmmRpcReady = false;
    await Promise.all([
      ...["market_positions", "platform_revenue"].map(async (table) => {
        try {
          const resp = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=*&limit=1`, {
            headers: getSupabaseRestHeaders(),
          });
          extraTables[table] = { ok: resp.ok, status: resp.status };
        } catch {
          extraTables[table] = { ok: false, status: 0 };
        }
      }),
      (async () => {
        try {
          const rpcCheck = await fetch(`${SUPABASE_URL}/rest/v1/rpc/buy_shares`, {
            method: 'POST',
            headers: getSupabaseRestHeaders(),
            body: JSON.stringify({
              p_market_id: '__probe__',
              p_outcome: 'Yes',
              p_gross_amount_kz: 0,
              p_expected_price: 50,
            }),
          });
          const bodyText = await rpcCheck.text();
          // If the function exists, it returns 400 (INVALID_AMOUNT / UNAUTHORIZED) instead of PGRST202 / 404
          cpmmRpcReady = rpcCheck.status !== 404 && !bodyText.includes('PGRST202');
        } catch {
          cpmmRpcReady = false;
        }
      })(),
    ]);

    res.json({
      configured: true,
      hasUrl: Boolean(SUPABASE_URL),
      hasAnonKey: Boolean(SUPABASE_ANON_KEY),
      hasServiceRoleKey: Boolean(SUPABASE_SERVICE_ROLE_KEY),
      hasDatabaseUrl: Boolean(process.env.DATABASE_URL || process.env.SUPABASE_DB_URL || process.env.POSTGRES_URL),
      hasAccessToken: Boolean(process.env.SUPABASE_ACCESS_TOKEN),
      authSettings,
      supabaseCallbackUrl,
      authProvidersUrl,
      authUrlConfigUrl,
      tables,
      extraTables,
      cpmmRpcReady,
    });
  });

  app.get("/api/supabase/schema-sql", async (_req, res) => {
    try {
      const fs = await import("fs/promises");
      const sqlPath = path.resolve(__dirname, "supabase_schema.sql");
      const sql = await fs.readFile(sqlPath, "utf-8");
      let projectRef = "";
      try {
        const host = new URL(SUPABASE_URL).hostname;
        projectRef = host.split(".")[0] || "";
      } catch {
        projectRef = "";
      }
      const sqlEditorUrl = projectRef ? `https://supabase.com/dashboard/project/${projectRef}/sql/new` : "https://supabase.com/dashboard";
      const authProvidersUrl = projectRef ? `https://supabase.com/dashboard/project/${projectRef}/auth/providers` : "https://supabase.com/dashboard";
      const authUrlConfigUrl = projectRef ? `https://supabase.com/dashboard/project/${projectRef}/auth/url-configuration` : "https://supabase.com/dashboard";
      res.json({ sql, projectRef, sqlEditorUrl, authProvidersUrl, authUrlConfigUrl });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || "Erro ao ler supabase_schema.sql" });
    }
  });

  // API Routes
  app.get("/api/health", (req, res) => {
    console.log('Health check requested');
    res.json({ status: "ok", platform_mode: "SANDBOX", timestamp: new Date().toISOString() });
  });

  app.get("/api/market-rates", async (req, res) => {
    console.log('Fetching market rates...');
    try {
      const symbols = ['USDAOA=X', 'EURAOA=X', 'BTC-USD', 'ETH-USD'];
      
      const fetchWithTimeout = async (symbol: string) => {
        try {
          // Yahoo Finance API
          const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}`;
          const response = await fetch(url, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            }
          });
          
          if (!response.ok) {
            console.error(`Yahoo API error for ${symbol}: ${response.status}`);
            return null;
          }
          return await response.json();
        } catch (e) {
          console.error(`Network error for ${symbol}:`, e);
          return null;
        }
      };

      const responses = await Promise.all(symbols.map(s => fetchWithTimeout(s)));

      const data: any = {};
      responses.forEach((resp: any, index) => {
        const symbol = symbols[index];
        if (resp && resp.chart?.result?.[0]?.meta?.regularMarketPrice) {
          data[symbol] = resp.chart.result[0].meta.regularMarketPrice;
        } else {
          // Fallbacks realistas caso a API falhe
          const fallbacks: any = { 'USDAOA=X': 954.5, 'EURAOA=X': 1032.12, 'BTC-USD': 65000, 'ETH-USD': 3500 };
          data[symbol] = fallbacks[symbol];
          console.warn(`Using fallback for ${symbol}`);
        }
      });

      const usdToAoa = data['USDAOA=X'] || 954.5;
      
      const rates = {
        'USD-AOA': usdToAoa,
        'EUR-AOA': data['EURAOA=X'] || (usdToAoa * 1.08),
        'BTC-AOA': (data['BTC-USD'] || 65000) * usdToAoa,
        'ETH-AOA': (data['ETH-USD'] || 3500) * usdToAoa
      };

      console.log('Rates fetched successfully');
      res.json(rates);
    } catch (error) {
      console.error('Critical error in /api/market-rates:', error);
      res.status(500).json({ error: 'Internal server error', message: String(error) });
    }
  });

  // Ensure any unmatched /api/* route returns JSON 404 rather than SPA HTML
  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "Endpoint da API não encontrado." });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: process.env.DISABLE_HMR === "true" ? false : { server },
      },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static("dist"));
    app.get("*", (req, res) => {
      res.sendFile(path.resolve(__dirname, "dist", "index.html"));
    });
  }

  server.on("error", (err: any) => {
    console.error("HTTP server error:", err);
  });

  server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });

  const shutdown = () => {
    try {
      server.close();
      ammDb.close();
    } catch {
      // ignore cleanup errors
    }
    process.exit(0);
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

startServer().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
