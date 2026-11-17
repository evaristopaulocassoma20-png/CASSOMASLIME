import type { Request, Response, NextFunction } from 'express';
import type { VerifiedActor, AdminRole } from './adminControls';
import {
  SUPABASE_ANON_KEY,
  SUPABASE_SERVICE_ROLE_KEY,
  SUPABASE_URL,
  getSupabaseRestHeaders,
  isServerSupabaseConfigured,
} from './supabaseConfig';

export const MASTER_ADMIN_EMAIL = 'evaristopaulocassoma00@gmail.com';
export const MASTER_ADMIN_EMAILS = new Set([
  'evaristopaulocassoma00@gmail.com',
  'evaristopaulocassoma20@gmail.com',
]);
export const DESIGNATED_ADMIN_EMAILS = new Set<string>();

export function isMasterAdminEmail(email?: string | null): boolean {
  return MASTER_ADMIN_EMAILS.has(String(email || '').trim().toLowerCase());
}

interface CachedTokenInfo {
  actor: VerifiedActor;
  remoteBalanceCents: number;
  expiresAt: number;
}

const tokenCache = new Map<string, CachedTokenInfo>();

export interface AuthenticatedRequest extends Request {
  actor?: VerifiedActor;
  idToken?: string;
  firestoreBalanceCents?: number;
}

async function lookupSupabaseUser(accessToken: string): Promise<{
  uid: string;
  email: string;
  emailVerified: boolean;
}> {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error('Supabase não configurado no servidor (SUPABASE_URL / SUPABASE_ANON_KEY).');
  }
  const url = `${SUPABASE_URL}/auth/v1/user`;
  const resp = await fetch(url, {
    method: 'GET',
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${accessToken}`,
    },
  });
  if (!resp.ok) {
    throw new Error('Token Supabase inválido ou expirado.');
  }
  const user = (await resp.json()) as any;
  if (!user || !user.id) {
    throw new Error('Utilizador Supabase não encontrado.');
  }
  return {
    uid: String(user.id),
    email: String(user.email || ''),
    emailVerified: Boolean(user.email_confirmed_at || user.confirmed_at),
  };
}

async function fetchSupabaseUserProfile(accessToken: string, uid: string): Promise<{
  isAdmin: boolean;
  roleField: string | null;
  balanceCents: number;
}> {
  const url = `${SUPABASE_URL}/rest/v1/users?id=eq.${encodeURIComponent(uid)}&select=id,is_admin,role,balance&limit=1`;
  const resp = await fetch(url, {
    headers: getSupabaseRestHeaders(accessToken),
  });
  if (!resp.ok) {
    return { isAdmin: false, roleField: null, balanceCents: 0 };
  }
  const rows = (await resp.json()) as any[];
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row) {
    return { isAdmin: false, roleField: null, balanceCents: 0 };
  }
  const isAdmin = Boolean(row.is_admin);
  const roleField = row.role ? String(row.role) : null;
  const balanceRaw = Number(row.balance || 0);
  return {
    isAdmin,
    roleField,
    balanceCents: Math.max(0, Math.round(balanceRaw * 100)),
  };
}

export async function verifySupabaseRequest(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Autenticação obrigatória (Bearer token em falta).' });
      return;
    }

    const accessToken = authHeader.slice(7).trim();
    if (!accessToken) {
      res.status(401).json({ error: 'Token de autenticação vazio.' });
      return;
    }

    const now = Date.now();
    const cached = tokenCache.get(accessToken);
    if (cached && cached.expiresAt > now) {
      req.actor = { ...cached.actor, ip: req.ip };
      req.idToken = accessToken;
      req.firestoreBalanceCents = cached.remoteBalanceCents;
      next();
      return;
    }

    const sbUser = await lookupSupabaseUser(accessToken);
    const profile = await fetchSupabaseUserProfile(accessToken, sbUser.uid);

    let role: AdminRole = 'USER';
    const lowerEmail = sbUser.email.toLowerCase();
    if (isMasterAdminEmail(lowerEmail) && sbUser.emailVerified) {
      role = 'MASTER_ADMIN';
    } else if (
      profile.isAdmin ||
      profile.roleField === 'admin' ||
      profile.roleField === 'operational_admin' ||
      profile.roleField === 'OPERATIONAL_ADMIN' ||
      profile.roleField === 'MASTER_ADMIN' ||
      (DESIGNATED_ADMIN_EMAILS.has(lowerEmail) && sbUser.emailVerified)
    ) {
      role = profile.roleField === 'MASTER_ADMIN' ? 'MASTER_ADMIN' : 'OPERATIONAL_ADMIN';
    }

    const actor: VerifiedActor = {
      uid: sbUser.uid,
      email: sbUser.email,
      role,
      ip: req.ip,
    };

    tokenCache.set(accessToken, {
      actor,
      remoteBalanceCents: profile.balanceCents,
      expiresAt: now + 15_000,
    });

    req.actor = actor;
    req.idToken = accessToken;
    req.firestoreBalanceCents = profile.balanceCents;
    next();
  } catch (err: any) {
    res.status(401).json({ error: err?.message || 'Falha na verificação de sessão.' });
  }
}

export async function optionalSupabaseRequest(
  req: AuthenticatedRequest,
  _res: Response,
  next: NextFunction
) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      next();
      return;
    }
    const accessToken = authHeader.slice(7).trim();
    if (!accessToken) {
      next();
      return;
    }
    const now = Date.now();
    const cached = tokenCache.get(accessToken);
    if (cached && cached.expiresAt > now) {
      req.actor = { ...cached.actor, ip: req.ip };
      req.idToken = accessToken;
      req.firestoreBalanceCents = cached.remoteBalanceCents;
      next();
      return;
    }
    const sbUser = await lookupSupabaseUser(accessToken);
    req.actor = { uid: sbUser.uid, email: sbUser.email, role: 'USER', ip: req.ip };
    req.idToken = accessToken;
  } catch {
    // Optional auth ignores invalid tokens cleanly
  }
  next();
}

export const verifyFirebaseRequest = verifySupabaseRequest;
export const optionalFirebaseRequest = optionalSupabaseRequest;

export function requireAdminMiddleware(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) {
  if (!req.actor || (req.actor.role !== 'MASTER_ADMIN' && req.actor.role !== 'OPERATIONAL_ADMIN')) {
    res.status(403).json({ error: 'Acesso restrito a administradores autorizados.' });
    return;
  }
  next();
}

export function requireMasterAdminMiddleware(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) {
  if (!req.actor || req.actor.role !== 'MASTER_ADMIN') {
    res.status(403).json({ error: 'Ação exclusiva do Master Admin.' });
    return;
  }
  next();
}

// Sliding window rate limiter per user/IP
const rateBuckets = new Map<string, number[]>();

export function rateLimit(maxRequests: number, windowMs: number) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    const key = `${req.actor?.uid || req.ip}:${req.baseUrl}${req.path}`;
    const now = Date.now();
    const list = (rateBuckets.get(key) || []).filter(ts => ts > now - windowMs);
    if (list.length >= maxRequests) {
      res.status(429).json({
        error: 'Limite de taxa excedido (Rate Limiting). Aguarde alguns segundos antes de tentar novamente.',
      });
      return;
    }
    list.push(now);
    rateBuckets.set(key, list);
    next();
  };
}

export async function syncDesignatedAdminsInSupabase(): Promise<{
  checked: number;
  promoted: string[];
}> {
  if (!isServerSupabaseConfigured || !SUPABASE_SERVICE_ROLE_KEY) {
    return { checked: 0, promoted: [] };
  }

  const targets: Array<{ email: string; role: 'MASTER_ADMIN' | 'OPERATIONAL_ADMIN' }> = [
    ...Array.from(MASTER_ADMIN_EMAILS).map((email) => ({
      email,
      role: 'MASTER_ADMIN' as const,
    })),
    ...Array.from(DESIGNATED_ADMIN_EMAILS).map((email) => ({
      email,
      role: 'OPERATIONAL_ADMIN' as const,
    })),
  ];

  const promoted: string[] = [];
  let authUsersCache: any[] | null = null;

  for (const target of targets) {
    try {
      const lookupResp = await fetch(
        `${SUPABASE_URL}/rest/v1/users?email=ilike.${encodeURIComponent(target.email)}&select=id,email,is_admin,role`,
        { headers: getSupabaseRestHeaders() }
      );
      if (!lookupResp.ok) continue;
      const rows = (await lookupResp.json()) as any[];

      if (Array.isArray(rows) && rows.length > 0) {
        for (const row of rows) {
          if (!row.is_admin || row.role === 'USER' || (target.role === 'MASTER_ADMIN' && row.role !== 'MASTER_ADMIN')) {
            const patchResp = await fetch(
              `${SUPABASE_URL}/rest/v1/users?id=eq.${encodeURIComponent(row.id)}`,
              {
                method: 'PATCH',
                headers: getSupabaseRestHeaders(undefined, 'return=minimal'),
                body: JSON.stringify({
                  is_admin: true,
                  role: target.role,
                  updated_at: new Date().toISOString(),
                }),
              }
            );
            if (patchResp.ok) {
              promoted.push(target.email);
            }
          }
        }
        continue;
      }

      // If user exists in Supabase Auth (auth.users) without public.users row, create profile as admin
      if (authUsersCache === null) {
        const authListResp = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?page=1&per_page=200`, {
          headers: {
            apikey: SUPABASE_SERVICE_ROLE_KEY,
            Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          },
        });
        if (authListResp.ok) {
          const authJson = (await authListResp.json()) as any;
          authUsersCache = Array.isArray(authJson?.users) ? authJson.users : [];
        } else {
          authUsersCache = [];
        }
      }

      const authMatch = (authUsersCache || []).find(
        (u: any) => String(u?.email || '').toLowerCase() === target.email.toLowerCase()
      );
      if (authMatch?.id) {
        const name =
          String(
            authMatch?.user_metadata?.full_name ||
              authMatch?.user_metadata?.name ||
              target.email.split('@')[0] ||
              'Admin'
          ).trim() || 'Admin';
        const insertResp = await fetch(`${SUPABASE_URL}/rest/v1/users`, {
          method: 'POST',
          headers: getSupabaseRestHeaders(undefined, 'resolution=merge-duplicates,return=minimal'),
          body: JSON.stringify({
            id: String(authMatch.id),
            name,
            email: authMatch.email || target.email,
            balance: 1000,
            is_admin: true,
            role: target.role,
            status: 'active',
            verification_status: 'none',
            is_verified: Boolean(authMatch.email_confirmed_at || authMatch.confirmed_at),
            avatar_url: authMatch?.user_metadata?.avatar_url || authMatch?.user_metadata?.picture || null,
            created_at: new Date().toISOString(),
          }),
        });
        if (insertResp.ok) {
          promoted.push(target.email);
        }
      }
    } catch {
      // Non-blocking startup sync
    }
  }

  return { checked: targets.length, promoted };
}
