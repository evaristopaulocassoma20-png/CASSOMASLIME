import 'dotenv/config';

function cleanEnv(val?: string): string {
  if (!val) return '';
  const trimmed = val.trim();
  if (!trimmed || trimmed === 'undefined' || trimmed === 'null') return '';
  return trimmed;
}

function isValidHttpUrl(val: string): boolean {
  if (!val || val.startsWith('sb_publishable_') || val.startsWith('sb_secret_')) return false;
  try {
    const parsed = new URL(val);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

const candidateUrl = cleanEnv(process.env.SUPABASE_URL) || cleanEnv(process.env.VITE_SUPABASE_URL);
const candidateAnonKey =
  cleanEnv(process.env.SUPABASE_ANON_KEY) || cleanEnv(process.env.VITE_SUPABASE_ANON_KEY);

export const SUPABASE_URL = isValidHttpUrl(candidateUrl) ? candidateUrl : '';
export const SUPABASE_ANON_KEY =
  candidateAnonKey && !candidateAnonKey.startsWith('sb_secret_') ? candidateAnonKey : '';

// Secret / service_role key is server-only (never expose via VITE_*)
export const SUPABASE_SERVICE_ROLE_KEY = cleanEnv(process.env.SUPABASE_SERVICE_ROLE_KEY);

export const isServerSupabaseConfigured = Boolean(SUPABASE_URL && (SUPABASE_ANON_KEY || SUPABASE_SERVICE_ROLE_KEY));

export function getSupabaseRestHeaders(userToken?: string, prefer?: string): Record<string, string> {
  const apiKey = SUPABASE_SERVICE_ROLE_KEY || SUPABASE_ANON_KEY;
  const authBearer = SUPABASE_SERVICE_ROLE_KEY || userToken || SUPABASE_ANON_KEY;
  const headers: Record<string, string> = {
    apikey: apiKey,
    Authorization: `Bearer ${authBearer}`,
    'Content-Type': 'application/json',
  };
  if (prefer) {
    headers.Prefer = prefer;
  }
  return headers;
}
