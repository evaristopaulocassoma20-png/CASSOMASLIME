import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, Check, Copy, ExternalLink, Eye, EyeOff, Lock, Mail, RefreshCw, ShieldCheck, User as UserIcon } from 'lucide-react';
import { User } from '../types';
import {
  supabase,
  signInWithGoogle,
  isSupabaseConfigured,
  translateSupabaseAuthError,
  validatePasswordStrength,
  processOAuthCallbackParams,
  getOAuthCallbackUrl,
  getSupabaseAuthStatus,
  SupabaseAuthDiagnostics,
} from '../supabase';
import { supabaseService } from '../lib/supabase-service';

type AuthMode = 'login' | 'signup' | 'recovery';

export const LoginPage = ({ onLogin }: { onLogin: (user: User) => void }) => {
  const navigate = useNavigate();
  const [mode, setMode] = useState<AuthMode>('login');
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [error, setError] = useState('');
  const [infoMessage, setInfoMessage] = useState('');
  const [needsEmailConfirm, setNeedsEmailConfirm] = useState(false);
  const [manualOAuthUrl, setManualOAuthUrl] = useState<string | null>(null);
  const [cooldownSec, setCooldownSec] = useState(0);
  const [authDiag, setAuthDiag] = useState<SupabaseAuthDiagnostics | null>(null);
  const [showGoogleSetupGuide, setShowGoogleSetupGuide] = useState(false);
  const [checkingGoogle, setCheckingGoogle] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const strength = validatePasswordStrength(password);

  const refreshAuthDiagnostics = async () => {
    setCheckingGoogle(true);
    try {
      const diag = await getSupabaseAuthStatus();
      setAuthDiag(diag);
      if (diag.googleEnabled === true) {
        setShowGoogleSetupGuide(false);
      }
      return diag;
    } finally {
      setCheckingGoogle(false);
    }
  };

  useEffect(() => {
    refreshAuthDiagnostics();
  }, []);

  useEffect(() => {
    if (cooldownSec <= 0) return;
    const id = setInterval(() => {
      setCooldownSec((s) => (s > 0 ? s - 1 : 0));
    }, 1000);
    return () => clearInterval(id);
  }, [cooldownSec]);

  // Escuta conclusão de OAuth via aba/popup manual caso o popup automático tenha sido bloqueado
  useEffect(() => {
    if (!manualOAuthUrl || typeof BroadcastChannel === 'undefined') return;
    const ch = new BroadcastChannel('marketpay_oauth');
    ch.onmessage = async (event) => {
      if (event.data?.type !== 'SUPABASE_OAUTH_CALLBACK') return;
      try {
        setGoogleLoading(true);
        const session = await processOAuthCallbackParams(event.data.search || '', event.data.hash || '');
        if (session?.user) {
          const profile = await supabaseService.createUserProfile(session.user.id, {
            name: (session.user.user_metadata?.full_name as string) || session.user.email?.split('@')[0] || 'Utilizador',
            email: session.user.email || '',
          });
          setManualOAuthUrl(null);
          onLogin(profile);
          navigate('/');
        }
      } catch (err: any) {
        setError(translateSupabaseAuthError(err));
      } finally {
        setGoogleLoading(false);
      }
    };
    return () => ch.close();
  }, [manualOAuthUrl, navigate, onLogin]);

  const completeProfileAndEnter = async (sbUser: any) => {
    let profile = await supabaseService.getUserProfile(sbUser.id);
    if (!profile) {
      profile = await supabaseService.createUserProfile(sbUser.id, {
        name:
          (sbUser.user_metadata?.full_name as string) ||
          (sbUser.user_metadata?.name as string) ||
          fullName.trim() ||
          sbUser.email?.split('@')[0] ||
          'Utilizador',
        email: sbUser.email || email,
      });
    }
    onLogin(profile);
    navigate('/');
  };

  const handleAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setInfoMessage('');
    setNeedsEmailConfirm(false);

    if (!isSupabaseConfigured) {
      setError('Supabase não configurado. Defina VITE_SUPABASE_URL (https://seu-projeto.supabase.co) e VITE_SUPABASE_ANON_KEY nos Secrets.');
      return;
    }

    const cleanEmail = email.trim().toLowerCase();
    if (!cleanEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      setError('Insira um endereço de email válido.');
      return;
    }

    if (mode === 'recovery') {
      if (cooldownSec > 0) {
        setError(`Aguarde ${cooldownSec}s antes de solicitar outro email de recuperação.`);
        return;
      }
      setLoading(true);
      try {
        const { error: resetErr } = await supabase.auth.resetPasswordForEmail(cleanEmail, {
          redirectTo: `${window.location.origin}/reset-password`,
        });
        if (resetErr) throw resetErr;
        setCooldownSec(60);
        setInfoMessage(
          'Se este email estiver registado, receberá um link seguro de recuperação válido apenas uma vez. Verifique também a pasta Spam.'
        );
      } catch (err: any) {
        setError(translateSupabaseAuthError(err));
      } finally {
        setLoading(false);
      }
      return;
    }

    if (mode === 'signup') {
      if (fullName.trim().length < 2) {
        setError('Insira o seu nome completo (mínimo 2 caracteres).');
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
    }

    setLoading(true);
    try {
      if (mode === 'signup') {
        const { data, error: signUpErr } = await supabase.auth.signUp({
          email: cleanEmail,
          password,
          options: {
            data: {
              full_name: fullName.trim(),
            },
            emailRedirectTo: `${window.location.origin}/login`,
          },
        });
        if (signUpErr) throw signUpErr;

        // Supabase retorna identities vazio quando o email já existe e confirmação está ativa
        if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
          setError('Este email já possui uma conta registada. Tente iniciar sessão ou recuperar a palavra-passe.');
          return;
        }

        const sbUser = data.user;
        if (sbUser && data.session) {
          await completeProfileAndEnter(sbUser);
        } else {
          setNeedsEmailConfirm(true);
          setCooldownSec(60);
          setInfoMessage(
            'Conta criada! Enviámos um link de confirmação para o seu email. Confirme o email para ativar o acesso.'
          );
        }
      } else {
        const { data, error: signInErr } = await supabase.auth.signInWithPassword({
          email: cleanEmail,
          password,
        });
        if (signInErr) throw signInErr;
        if (!data.user) throw new Error('Falha ao obter sessão do utilizador.');
        await completeProfileAndEnter(data.user);
      }
    } catch (err: any) {
      const translated = translateSupabaseAuthError(err);
      if (String(err?.message || '').toLowerCase().includes('email not confirmed')) {
        setNeedsEmailConfirm(true);
      }
      setError(translated);
    } finally {
      setLoading(false);
    }
  };

  const handleResendConfirmation = async () => {
    const cleanEmail = email.trim().toLowerCase();
    if (!cleanEmail || cooldownSec > 0) return;
    setLoading(true);
    setError('');
    try {
      const { error: resendErr } = await supabase.auth.resend({
        type: 'signup',
        email: cleanEmail,
        options: { emailRedirectTo: `${window.location.origin}/login` },
      });
      if (resendErr) throw resendErr;
      setCooldownSec(60);
      setInfoMessage('Novo email de confirmação enviado! Verifique a caixa de entrada e o Spam.');
    } catch (err: any) {
      setError(translateSupabaseAuthError(err));
    } finally {
      setLoading(false);
    }
  };

  const handleGoogleLoginAction = async () => {
    setGoogleLoading(true);
    setError('');
    setInfoMessage('');
    setManualOAuthUrl(null);
    try {
      const result = await signInWithGoogle();
      if (result?.popupBlocked && result.url) {
        setManualOAuthUrl(result.url);
        setInfoMessage('O navegador bloqueou a janela popup. Clique no botão abaixo para abrir a autenticação Google.');
        return;
      }
      if (result?.cancelled) {
        setError('Autenticação Google cancelada antes da conclusão.');
        return;
      }
      if (result?.session?.user) {
        await completeProfileAndEnter(result.session.user);
      }
    } catch (err: any) {
      console.error('Erro no login com Google:', err);
      if (err?.code === 'GOOGLE_PROVIDER_DISABLED') {
        await refreshAuthDiagnostics();
        setShowGoogleSetupGuide(true);
      }
      setError(translateSupabaseAuthError(err));
    } finally {
      setGoogleLoading(false);
    }
  };

  const copyValue = (key: string, value: string) => {
    if (!value) return;
    navigator.clipboard.writeText(value);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 1800);
  };

  const switchMode = (next: AuthMode) => {
    setMode(next);
    setError('');
    setInfoMessage('');
    setNeedsEmailConfirm(false);
    setManualOAuthUrl(null);
  };

  return (
    <div className="min-h-[75vh] flex items-center justify-center px-4 py-10">
      <div className="market-card w-full max-w-md p-6 sm:p-8 space-y-6">
        <div className="text-center space-y-1.5">
          <h1 className="text-2xl font-bold text-white tracking-tight">
            {mode === 'signup'
              ? 'Criar conta'
              : mode === 'recovery'
              ? 'Recuperar conta'
              : 'Entrar no MarketPay'}
          </h1>
          <p className="text-sm text-market-text-muted">
            {mode === 'signup'
              ? 'Registe-se com segurança para negociar em Kwanza'
              : mode === 'recovery'
              ? 'Receba um link de uso único no seu email para redefinir a senha'
              : 'Aceda à sua conta para negociar mercados reais'}
          </p>
        </div>

        <form onSubmit={handleAuth} className="space-y-4">
          {mode === 'signup' && (
            <div className="space-y-1.5">
              <label className="block text-xs font-semibold text-market-text-muted">Nome completo</label>
              <div className="relative">
                <UserIcon className="w-4 h-4 text-market-text-muted absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  className="market-input pl-9"
                  placeholder="Ex: Paulo Cassoma"
                  required
                />
              </div>
            </div>
          )}

          <div className="space-y-1.5">
            <label className="block text-xs font-semibold text-market-text-muted">Email</label>
            <div className="relative">
              <Mail className="w-4 h-4 text-market-text-muted absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="market-input pl-9"
                placeholder="seu@email.com"
                autoComplete="email"
                required
              />
            </div>
          </div>

          {mode !== 'recovery' && (
            <div className="space-y-1.5">
              <div className="flex justify-between items-center">
                <label className="block text-xs font-semibold text-market-text-muted">Palavra-passe</label>
                {mode === 'login' && (
                  <button
                    type="button"
                    onClick={() => switchMode('recovery')}
                    className="text-xs text-market-green hover:underline font-medium"
                  >
                    Esqueceu a senha?
                  </button>
                )}
              </div>
              <div className="relative">
                <Lock className="w-4 h-4 text-market-text-muted absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="market-input pl-9 pr-10"
                  placeholder="••••••••"
                  autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
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

              {mode === 'signup' && password.length > 0 && (
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
          )}

          {mode === 'signup' && (
            <div className="space-y-1.5">
              <label className="block text-xs font-semibold text-market-text-muted">Confirmar palavra-passe</label>
              <div className="relative">
                <Lock className="w-4 h-4 text-market-text-muted absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  className="market-input pl-9"
                  placeholder="••••••••"
                  autoComplete="new-password"
                  required
                />
              </div>
            </div>
          )}

          {error && (
            <div className="text-market-red text-xs font-medium bg-market-red/10 p-3 rounded-lg border border-market-red/20 space-y-2">
              <p>{error}</p>
              {needsEmailConfirm && (
                <button
                  type="button"
                  onClick={handleResendConfirmation}
                  disabled={loading || cooldownSec > 0}
                  className="inline-flex items-center gap-1.5 text-white underline hover:text-market-green disabled:opacity-50"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  {cooldownSec > 0
                    ? `Reenviar em ${cooldownSec}s`
                    : 'Reenviar email de confirmação'}
                </button>
              )}
            </div>
          )}

          {infoMessage && (
            <div className="text-market-green text-xs font-medium bg-market-green/10 p-3 rounded-lg border border-market-green/20 space-y-2">
              <p>{infoMessage}</p>
              {manualOAuthUrl && (
                <a
                  href={manualOAuthUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center justify-center w-full py-2 px-3 bg-white text-black font-semibold rounded-lg text-xs hover:bg-gray-100"
                >
                  Abrir Autenticação Google numa Nova Aba
                </a>
              )}
            </div>
          )}

          <button
            type="submit"
            disabled={loading || googleLoading}
            className="w-full market-button-primary py-3 text-sm disabled:opacity-50"
          >
            {loading
              ? 'A processar...'
              : mode === 'signup'
              ? 'Criar conta'
              : mode === 'recovery'
              ? cooldownSec > 0
                ? `Reenviar em ${cooldownSec}s`
                : 'Enviar link de recuperação'
              : 'Entrar'}
          </button>
        </form>

        {mode === 'recovery' ? (
          <div className="space-y-3 pt-1">
            <div className="flex items-start gap-2 text-[11px] text-market-text-muted bg-market-bg/60 border border-market-border rounded-lg p-3">
              <ShieldCheck className="w-4 h-4 text-market-green shrink-0 mt-0.5" />
              <span>
                Por segurança, o link expira rapidamente e ao alterar a senha todas as sessões anteriores são encerradas automaticamente.
              </span>
            </div>
            <div className="text-center">
              <button
                type="button"
                onClick={() => switchMode('login')}
                className="text-xs text-market-green hover:underline font-semibold"
              >
                Voltar para iniciar sessão
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="relative">
              <div className="absolute inset-0 flex items-center">
                <div className="w-full border-t border-market-border" />
              </div>
              <div className="relative flex justify-center text-xs">
                <span className="bg-market-card px-2 text-market-text-muted">ou</span>
              </div>
            </div>

            <button
              type="button"
              onClick={handleGoogleLoginAction}
              disabled={loading || googleLoading}
              className="w-full bg-white text-black hover:bg-gray-100 font-semibold py-2.5 px-4 rounded-xl flex items-center justify-center gap-2.5 text-sm transition-colors disabled:opacity-50"
            >
              <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24">
                <path fill="currentColor" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
                <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
                <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
                <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
              </svg>
              {googleLoading ? 'A autenticar com Google...' : 'Continuar com Google'}
            </button>

            {(authDiag?.googleEnabled === false || showGoogleSetupGuide) && (
              <div className="rounded-xl border border-amber-500/35 bg-amber-500/10 p-3.5 space-y-2.5 text-xs">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2 text-amber-300 font-semibold">
                    <AlertTriangle className="w-4 h-4 shrink-0" />
                    <span>Ative o provedor Google no seu Supabase</span>
                  </div>
                  <button
                    type="button"
                    onClick={async () => {
                      const d = await refreshAuthDiagnostics();
                      if (d.googleEnabled) {
                        setError('');
                        setInfoMessage('Login Google detetado como ativo! Pode clicar em "Continuar com Google".');
                      }
                    }}
                    disabled={checkingGoogle}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded bg-market-card border border-market-border text-[11px] text-white hover:border-market-green"
                  >
                    <RefreshCw className={`w-3 h-3 ${checkingGoogle ? 'animate-spin' : ''}`} />
                    Verificar
                  </button>
                </div>

                <p className="text-[11px] text-amber-100/80 leading-relaxed">
                  O erro <code className="text-white">Unsupported provider: provider is not enabled</code> ocorre porque o Google ainda está desligado em{' '}
                  <strong>Authentication → Providers → Google</strong> no Supabase.
                </p>

                {authDiag?.supabaseCallbackUrl && (
                  <div className="space-y-1">
                    <span className="text-[10px] uppercase font-bold text-amber-200/80 block">
                      1. Colar no Google Cloud Console (Authorized Redirect URI):
                    </span>
                    <div className="flex items-center gap-1.5 bg-black/40 border border-market-border rounded-lg px-2.5 py-1.5">
                      <code className="text-[11px] text-white truncate flex-1 select-all">{authDiag.supabaseCallbackUrl}</code>
                      <button
                        type="button"
                        onClick={() => copyValue('sb_cb', authDiag.supabaseCallbackUrl)}
                        className="text-market-green hover:text-white shrink-0"
                        title="Copiar"
                      >
                        {copiedKey === 'sb_cb' ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                      </button>
                    </div>
                  </div>
                )}

                <div className="space-y-1">
                  <span className="text-[10px] uppercase font-bold text-amber-200/80 block">
                    2. Colar no Supabase (URL Configuration → Redirect URLs):
                  </span>
                  <div className="flex items-center gap-1.5 bg-black/40 border border-market-border rounded-lg px-2.5 py-1.5">
                    <code className="text-[11px] text-white truncate flex-1 select-all">{getOAuthCallbackUrl()}</code>
                    <button
                      type="button"
                      onClick={() => copyValue('app_cb', getOAuthCallbackUrl())}
                      className="text-market-green hover:text-white shrink-0"
                      title="Copiar"
                    >
                      {copiedKey === 'app_cb' ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                    </button>
                  </div>
                </div>

                <div className="flex flex-wrap gap-2 pt-1">
                  <a
                    href={authDiag?.authProvidersUrl || 'https://supabase.com/dashboard'}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-amber-500 text-black font-bold text-[11px] hover:bg-amber-400"
                  >
                    <ExternalLink className="w-3 h-3" />
                    Ativar Google no Supabase
                  </a>
                  <a
                    href={authDiag?.authUrlConfigUrl || 'https://supabase.com/dashboard'}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-market-card border border-market-border text-white font-semibold text-[11px] hover:border-white/40"
                  >
                    <ExternalLink className="w-3 h-3" />
                    Redirect URLs
                  </a>
                </div>
              </div>
            )}

            <p className="text-[11px] text-center text-market-text-muted">
              Callback OAuth: <code className="text-white/80 select-all">{getOAuthCallbackUrl()}</code>
            </p>

            <div className="text-center">
              <button
                type="button"
                onClick={() => switchMode(mode === 'signup' ? 'login' : 'signup')}
                className="text-xs text-market-green hover:underline font-semibold"
              >
                {mode === 'signup' ? 'Já tem conta? Iniciar sessão' : 'Não tem conta? Criar conta'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
};
