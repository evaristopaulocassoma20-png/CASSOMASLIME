import { createClient } from '@supabase/supabase-js';

const getSafeEnv = (key: string): string => {
  try {
    const value = (import.meta as any).env?.[key];
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed !== '' && trimmed !== 'undefined' && trimmed !== 'null') {
        return trimmed;
      }
    }
  } catch {
    // ignore env access error
  }
  return '';
};

const rawUrl = getSafeEnv('VITE_SUPABASE_URL');
const rawKey = getSafeEnv('VITE_SUPABASE_ANON_KEY');

const isValidHttpUrl = (val: string): boolean => {
  if (!val) return false;
  if (val.startsWith('sb_publishable_') || val.startsWith('sb_secret_')) return false;
  try {
    const parsed = new URL(val);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
};

let resolvedUrl = rawUrl;
if (!resolvedUrl.startsWith('http') && /^[a-z0-9]{20}$/.test(resolvedUrl)) {
  resolvedUrl = `https://${resolvedUrl}.supabase.co`;
} else if (!resolvedUrl.startsWith('http') && resolvedUrl.includes('.supabase.co')) {
  resolvedUrl = `https://${resolvedUrl}`;
}

export const isSupabaseConfigured =
  isValidHttpUrl(resolvedUrl) &&
  Boolean(rawKey) &&
  !rawKey.startsWith('sb_secret_') &&
  !resolvedUrl.includes('wxcokshyiyeogvzsabuy.supabase.co');

export const supabaseUrl = isSupabaseConfigured ? resolvedUrl : 'https://placeholder.supabase.co';
export const supabaseAnonKey = isSupabaseConfigured ? rawKey : 'placeholder-anon-key';

if (!isSupabaseConfigured && typeof window !== 'undefined') {
  console.warn(
    '[MarketPay] Supabase ainda não configurado corretamente. Defina VITE_SUPABASE_URL (ex: https://seu-projeto.supabase.co) e VITE_SUPABASE_ANON_KEY (chave publishable/anon) nos Secrets.'
  );
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    persistSession: isSupabaseConfigured,
    autoRefreshToken: isSupabaseConfigured,
    detectSessionInUrl: isSupabaseConfigured,
    flowType: 'pkce',
  },
});

export function getOAuthCallbackUrl(): string {
  if (typeof window === 'undefined') return '/auth/callback';
  return `${window.location.origin}/auth/callback`;
}

export function translateSupabaseAuthError(err: any): string {
  const msg = String(err?.message || err?.error_description || err || '');
  const lower = msg.toLowerCase();

  if (!msg) return 'Ocorreu um erro na autenticação. Tente novamente.';
  if (lower.includes('invalid login credentials') || lower.includes('invalid_credentials')) {
    return 'Email ou palavra-passe incorretos.';
  }
  if (lower.includes('email not confirmed')) {
    return 'O seu email ainda não foi confirmado. Verifique a caixa de entrada ou reenvie o email de confirmação.';
  }
  if (lower.includes('user already registered') || lower.includes('already exists')) {
    return 'Este email já possui uma conta registada. Tente iniciar sessão ou recuperar a palavra-passe.';
  }
  if (lower.includes('provider is not enabled') || lower.includes('unsupported provider')) {
    return `O login com Google ainda não está ativado no painel do Supabase (Authentication → Providers → Google). Callback URL: ${getOAuthCallbackUrl()}`;
  }
  if (lower.includes('redirect_uri_mismatch') || lower.includes('invalid redirect') || lower.includes('redirect url')) {
    return `URL de redirecionamento não autorizada no Supabase/Google. Adicione "${getOAuthCallbackUrl()}" em Authentication → URL Configuration → Redirect URLs.`;
  }
  if (lower.includes('rate limit') || lower.includes('too many requests') || lower.includes('over_email_send_rate_limit')) {
    return 'Muitas tentativas em sequência. Aguarde cerca de 60 segundos antes de tentar novamente.';
  }
  if (lower.includes('otp_expired') || lower.includes('token has expired') || lower.includes('expired')) {
    return 'O link de recuperação expirou ou já foi utilizado. Solicite um novo link de recuperação.';
  }
  if (lower.includes('same password') || lower.includes('should be different from the old password')) {
    return 'A nova palavra-passe deve ser diferente da palavra-passe atual.';
  }
  if (lower.includes('weak password') || lower.includes('at least')) {
    return 'Palavra-passe demasiado fraca. Use pelo menos 8 caracteres com letras e números.';
  }
  return msg;
}

export function validatePasswordStrength(password: string): {
  valid: boolean;
  score: number;
  label: string;
  feedback: string;
} {
  let score = 0;
  if (password.length >= 8) score++;
  if (/[A-Za-z]/.test(password)) score++;
  if (/[0-9]/.test(password)) score++;
  if (/[^A-Za-z0-9]/.test(password) || (/[a-z]/.test(password) && /[A-Z]/.test(password))) score++;

  if (password.length < 8) {
    return { valid: false, score, label: 'Curta', feedback: 'Mínimo de 8 caracteres obrigatórios.' };
  }
  if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
    return { valid: false, score, label: 'Fraca', feedback: 'Inclua pelo menos uma letra e um número.' };
  }
  if (score >= 4) {
    return { valid: true, score, label: 'Forte', feedback: 'Palavra-passe segura.' };
  }
  return { valid: true, score, label: 'Boa', feedback: 'Cumpre os requisitos mínimos de segurança.' };
}

export async function processOAuthCallbackParams(search: string, hash: string) {
  const searchParams = new URLSearchParams(search.startsWith('?') ? search : `?${search}`);
  const hashClean = hash.startsWith('#') ? hash.slice(1) : hash;
  const hashParams = new URLSearchParams(hashClean);

  const errMsg =
    searchParams.get('error_description') ||
    hashParams.get('error_description') ||
    searchParams.get('error') ||
    hashParams.get('error');

  if (errMsg) {
    throw new Error(translateSupabaseAuthError(errMsg));
  }

  const code = searchParams.get('code');
  if (code) {
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) throw new Error(translateSupabaseAuthError(error));
    return data.session;
  }

  const accessToken = hashParams.get('access_token');
  const refreshToken = hashParams.get('refresh_token');
  if (accessToken && refreshToken) {
    const { data, error } = await supabase.auth.setSession({
      access_token: accessToken,
      refresh_token: refreshToken,
    });
    if (error) throw new Error(translateSupabaseAuthError(error));
    return data.session;
  }

  const { data } = await supabase.auth.getSession();
  return data.session;
}

export interface SupabaseAuthDiagnostics {
  googleEnabled: boolean | null;
  emailEnabled: boolean;
  mailerAutoconfirm: boolean;
  supabaseCallbackUrl: string;
  authProvidersUrl: string;
  authUrlConfigUrl: string;
}

export async function getSupabaseAuthStatus(): Promise<SupabaseAuthDiagnostics> {
  try {
    const resp = await fetch('/api/supabase/status');
    if (resp.ok) {
      const json = await resp.json();
      return {
        googleEnabled:
          typeof json?.authSettings?.googleEnabled === 'boolean'
            ? json.authSettings.googleEnabled
            : null,
        emailEnabled: json?.authSettings?.emailEnabled !== false,
        mailerAutoconfirm: Boolean(json?.authSettings?.mailerAutoconfirm),
        supabaseCallbackUrl: json?.supabaseCallbackUrl || '',
        authProvidersUrl: json?.authProvidersUrl || 'https://supabase.com/dashboard',
        authUrlConfigUrl: json?.authUrlConfigUrl || 'https://supabase.com/dashboard',
      };
    }
  } catch {
    // fallback below
  }

  if (isSupabaseConfigured) {
    try {
      const resp = await fetch(`${supabaseUrl}/auth/v1/settings`, {
        headers: { apikey: supabaseAnonKey },
      });
      if (resp.ok) {
        const authJson = await resp.json();
        const ref = new URL(supabaseUrl).hostname.split('.')[0] || '';
        return {
          googleEnabled: Boolean(authJson?.external?.google),
          emailEnabled: authJson?.external?.email !== false,
          mailerAutoconfirm: Boolean(authJson?.mailer_autoconfirm),
          supabaseCallbackUrl: `${supabaseUrl}/auth/v1/callback`,
          authProvidersUrl: ref
            ? `https://supabase.com/dashboard/project/${ref}/auth/providers`
            : 'https://supabase.com/dashboard',
          authUrlConfigUrl: ref
            ? `https://supabase.com/dashboard/project/${ref}/auth/url-configuration`
            : 'https://supabase.com/dashboard',
        };
      }
    } catch {
      // ignore
    }
  }

  return {
    googleEnabled: null,
    emailEnabled: true,
    mailerAutoconfirm: false,
    supabaseCallbackUrl: isSupabaseConfigured ? `${supabaseUrl}/auth/v1/callback` : '',
    authProvidersUrl: 'https://supabase.com/dashboard',
    authUrlConfigUrl: 'https://supabase.com/dashboard',
  };
}

export const signInWithGoogle = async (): Promise<{
  popupBlocked?: boolean;
  url?: string;
  session?: any;
  cancelled?: boolean;
}> => {
  if (!isSupabaseConfigured) {
    throw new Error('Supabase não configurado. Defina VITE_SUPABASE_URL e VITE_SUPABASE_ANON_KEY nos Secrets.');
  }

  const authStatus = await getSupabaseAuthStatus();
  if (authStatus.googleEnabled === false) {
    const err = new Error(
      'O provedor Google ainda não foi ativado no painel do Supabase (Authentication → Providers → Google).'
    ) as Error & { code?: string };
    err.code = 'GOOGLE_PROVIDER_DISABLED';
    throw err;
  }

  const redirectTo = getOAuthCallbackUrl();
  const inIframe = (() => {
    try {
      return window.self !== window.top;
    } catch {
      return true;
    }
  })();

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo,
      skipBrowserRedirect: true,
      queryParams: {
        access_type: 'offline',
        prompt: 'select_account',
      },
    },
  });

  if (error) {
    throw new Error(translateSupabaseAuthError(error));
  }

  if (!data?.url) {
    throw new Error('Não foi possível gerar o URL de autenticação Google.');
  }

  if (!inIframe) {
    window.location.assign(data.url);
    return { url: data.url };
  }

  // No ambiente iframe (AI Studio preview), Google bloqueia carregamento em frame.
  // Abrimos o fluxo num popup e recebemos o callback via /auth/callback -> postMessage / BroadcastChannel.
  const width = 520;
  const height = 660;
  const left = Math.max(0, Math.round(window.screenX + (window.outerWidth - width) / 2));
  const top = Math.max(0, Math.round(window.screenY + (window.outerHeight - height) / 2));

  const popup = window.open(
    data.url,
    'marketpay_google_oauth',
    `width=${width},height=${height},left=${left},top=${top},menubar=no,toolbar=no,status=no`
  );

  return await new Promise((resolve, reject) => {
    let settled = false;
    let channel: BroadcastChannel | null = null;
    let closePoll: ReturnType<typeof setInterval> | null = null;
    let closeGraceTimer: ReturnType<typeof setTimeout> | null = null;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      window.removeEventListener('message', onMessage);
      if (channel) {
        try {
          channel.close();
        } catch {
          // ignore
        }
      }
      if (closePoll) clearInterval(closePoll);
      if (closeGraceTimer) clearTimeout(closeGraceTimer);
      if (timeoutId) clearTimeout(timeoutId);
    };

    const handleCallbackPayload = async (payload: { type?: string; search?: string; hash?: string }) => {
      if (settled || payload?.type !== 'SUPABASE_OAUTH_CALLBACK') return;
      settled = true;
      cleanup();
      try {
        const session = await processOAuthCallbackParams(payload.search || '', payload.hash || '');
        resolve({ session });
      } catch (err: any) {
        reject(new Error(translateSupabaseAuthError(err)));
      }
    };

    const onMessage = (event: MessageEvent) => {
      if (!event.data || event.data.type !== 'SUPABASE_OAUTH_CALLBACK') return;
      handleCallbackPayload(event.data);
    };

    window.addEventListener('message', onMessage);

    if (typeof BroadcastChannel !== 'undefined') {
      try {
        channel = new BroadcastChannel('marketpay_oauth');
        channel.onmessage = (event) => handleCallbackPayload(event.data);
      } catch {
        channel = null;
      }
    }

    if (!popup) {
      settled = true;
      cleanup();
      resolve({ popupBlocked: true, url: data.url });
      return;
    }

    closePoll = setInterval(() => {
      if (settled || !popup.closed || closeGraceTimer) return;
      closeGraceTimer = setTimeout(async () => {
        if (settled) return;
        settled = true;
        cleanup();
        try {
          const { data: sessData } = await supabase.auth.getSession();
          if (sessData.session) {
            resolve({ session: sessData.session });
          } else {
            resolve({ cancelled: true });
          }
        } catch {
          resolve({ cancelled: true });
        }
      }, 450);
    }, 500);

    timeoutId = setTimeout(() => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(new Error('Tempo limite excedido na autenticação Google. Tente novamente.'));
      }
    }, 180_000);
  });
};

export const logout = async () => {
  if (!isSupabaseConfigured) return;
  const { error } = await supabase.auth.signOut();
  if (error) {
    throw error;
  }
};

export const logoutAllDevices = async () => {
  if (!isSupabaseConfigured) return;
  const { error } = await supabase.auth.signOut({ scope: 'global' });
  if (error) {
    throw new Error(translateSupabaseAuthError(error));
  }
};

export const getSupabaseAccessToken = async (): Promise<string | null> => {
  if (!isSupabaseConfigured) return null;
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
};
