import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { User, Market } from '../types';
import { User as UserIcon, Settings, LogOut, Wallet, History, Shield, CheckCircle, XCircle, Clock, ArrowDownToLine, ArrowUpFromLine, Loader2, Coins } from 'lucide-react';
import { logout, logoutAllDevices, supabase, translateSupabaseAuthError, validatePasswordStrength } from '../supabase';
import { supabaseService as firebaseService } from '../lib/supabase-service';
import { ammApi } from '../lib/amm-api';
import { format } from 'date-fns';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export const UserProfile = ({ 
  user, 
  onLogout, 
  markets = [] 
}: { 
  user: User | null; 
  onLogout: () => void; 
  markets?: Market[];
}) => {
  const [activeTab, setActiveTab] = useState('overview');
  const [depositAmount, setDepositAmount] = useState('');
  const [withdrawAmount, setWithdrawAmount] = useState('');
  const [loading, setLoading] = useState(false);
  const [iban, setIban] = useState('');
  const [method, setMethod] = useState('iban');
  const [proofFile, setProofFile] = useState<File | null>(null);
  const [investmentHistory, setInvestmentHistory] = useState<any[]>([]);
  const [fetchingHistory, setFetchingHistory] = useState(false);
  const [userFinanceRequests, setUserFinanceRequests] = useState<any[]>([]);
  const [fetchingFinance, setFetchingFinance] = useState(false);
  const [ledgerEntries, setLedgerEntries] = useState<any[]>([]);
  const [fetchingLedger, setFetchingLedger] = useState(false);
  const [clobReservedKz, setClobReservedKz] = useState<number>(0);
  const [clobPositions, setClobPositions] = useState<any[] | null>(null);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [profileName, setProfileName] = useState(user?.name || '');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [emailNotifications, setEmailNotifications] = useState(true);
  const [marketAlerts, setMarketAlerts] = useState(true);

  useEffect(() => {
    setProfileName(user?.name || '');
  }, [user?.name]);

  const effectivePositions = (clobPositions && clobPositions.length > 0)
    ? clobPositions.map((p: any) => ({
        market_id: p.market_id,
        outcome: p.outcome,
        shares: (p.available_shares || 0) + (p.reserved_shares || 0),
        avg_price: (p.avg_price_cents || 0) / 100,
      }))
    : (user?.positions || []);

  // Calculate open positions stats
  const openPositionsStats = effectivePositions.reduce((acc, pos) => {
    const cost = pos.shares * pos.avg_price;
    const m = markets.find(market => market.id === pos.market_id);
    let currentPrice = pos.avg_price;
    if (m) {
      if (m.is_multi && m.outcomes) {
        const out = m.outcomes.find(o => o.name === pos.outcome);
        currentPrice = out ? out.price : 0.5;
      } else {
        currentPrice = pos.outcome === 'Yes' ? (m.yes_price || 0.5) : (m.no_price || 0.5);
      }
    }
    const currentValue = pos.shares * currentPrice;
    const pnl = currentValue - cost;

    acc.totalInvested += cost;
    acc.currentValue += currentValue;
    acc.unrealizedPnL += pnl;
    return acc;
  }, { totalInvested: 0, currentValue: 0, unrealizedPnL: 0 });

  // Calculate realized profit from won payouts (premiations)
  const totalRealizedWinnings = ledgerEntries
    .filter(entry => entry.type === 'PREMIACAO_MERCADO')
    .reduce((acc, entry) => acc + (entry.amount || 0), 0);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const tabParam = params.get('tab');
    if (tabParam) {
      setActiveTab(tabParam);
    }
  }, []);

  const fetchLedgerEntries = async () => {
    if (!user) return;
    setFetchingLedger(true);
    try {
      const entries = await firebaseService.getUserLedger(user.id);
      setLedgerEntries(entries || []);
    } catch (e) {
      console.error('Error fetching ledger entries:', e);
    } finally {
      setFetchingLedger(false);
    }
  };

  // Load finance requests
  const loadFinanceRequests = async () => {
    if (!user) return;
    setFetchingFinance(true);
    try {
      const resp = await firebaseService.getUserFinanceRequests(user.id);
      setUserFinanceRequests(resp || []);
    } catch (e) {
      console.error('Error fetching finance requests:', e);
    } finally {
      setFetchingFinance(false);
    }
  };

  useEffect(() => {
    if (user && (activeTab === 'overview' || activeTab === 'deposit' || activeTab === 'withdraw')) {
      loadFinanceRequests();
      ammApi.getMyClobOrders()
        .then((res) => {
          setClobReservedKz((res.account?.reserved_cents || 0) / 100);
          setClobPositions(res.positions || []);
        })
        .catch(() => null);
    }
    if (user && (activeTab === 'overview' || activeTab === 'ledger')) {
      fetchLedgerEntries();
    }
  }, [user, activeTab]);

  useEffect(() => {
    if (!user || activeTab !== 'history') return;
    setFetchingHistory(true);
    const unsub = firebaseService.getTradeHistory(user.id, (tradesData) => {
      const enrichedTrades = (tradesData || []).map(trade => {
        const associatedMarket = markets.find(m => m.id === trade.market_id);
        return {
          ...trade,
          markets: associatedMarket ? {
            question: associatedMarket.question,
            resolved: associatedMarket.resolved,
            resolution_outcome: associatedMarket.resolution_outcome
          } : null
        };
      });
      setInvestmentHistory(enrichedTrades);
      setFetchingHistory(false);
    });
    return () => {
      if (typeof unsub === 'function') unsub();
    };
  }, [user?.id, activeTab, markets]);

  const fetchInvestmentHistory = () => {
    setActiveTab('history');
  };

  const handleSaveSettings = async () => {
    if (!user) return;
    setFeedback(null);
    const trimmedName = profileName.trim();
    if (!trimmedName) {
      setFeedback({ type: 'error', text: 'O nome de exibição não pode estar vazio.' });
      return;
    }
    if (newPassword || confirmPassword) {
      const check = validatePasswordStrength(newPassword);
      if (!check.valid) {
        setFeedback({ type: 'error', text: check.feedback });
        return;
      }
      if (newPassword !== confirmPassword) {
        setFeedback({ type: 'error', text: 'As palavras-passe não coincidem.' });
        return;
      }
    }
    setLoading(true);
    try {
      await firebaseService.updateUserProfile(user.id, { name: trimmedName });
      if (newPassword) {
        const { error: pwErr } = await supabase.auth.updateUser({ password: newPassword });
        if (pwErr) throw pwErr;
      }
      setNewPassword('');
      setConfirmPassword('');
      setFeedback({ type: 'success', text: 'Definições da conta atualizadas com sucesso.' });
    } catch (error: any) {
      setFeedback({ type: 'error', text: translateSupabaseAuthError(error) });
    } finally {
      setLoading(false);
    }
  };

  const handleGlobalSignOut = async () => {
    setLoading(true);
    try {
      await logoutAllDevices();
      onLogout();
    } catch (error: any) {
      setFeedback({ type: 'error', text: translateSupabaseAuthError(error) });
    } finally {
      setLoading(false);
    }
  };

  const handleLogout = async () => {
    try {
      await logout();
      onLogout();
    } catch (e) {
      console.error('Logout error:', e);
      onLogout();
    }
  };

  const handleVerificationRequest = async () => {
    if (!user) return;
    setLoading(true);
    setFeedback(null);
    try {
      await firebaseService.updateUserProfile(user.id, { 
        status: 'pending_verification',
        verification_status: 'pending'
      });
      setFeedback({ type: 'success', text: 'Pedido de verificação enviado com sucesso.' });
    } catch (error) {
      console.error('Verification error:', error);
      setFeedback({ type: 'error', text: 'Erro ao solicitar verificação.' });
    } finally {
      setLoading(false);
    }
  };

  const handleFinanceRequest = async (type: 'deposit' | 'withdrawal') => {
    if (!user) return;
    setFeedback(null);
    const amount = type === 'deposit' ? parseFloat(depositAmount) : parseFloat(withdrawAmount);
    
    if (isNaN(amount) || amount <= 0) {
      setFeedback({ type: 'error', text: 'Montante inválido. Insira um valor maior que zero.' });
      return;
    }

    if (type === 'withdrawal' && amount > user.balance) {
      setFeedback({ type: 'error', text: 'Saldo insuficiente para efetuar este levantamento.' });
      return;
    }

    setLoading(true);
    try {
      let proofUrl = null;
      if (type === 'deposit' && proofFile) {
        proofUrl = `comprovativo://${encodeURIComponent(proofFile.name)} (${Math.round(proofFile.size / 1024)} KB)`;
      }

      await firebaseService.addFinanceRequest({
        user_id: user.id,
        user_name: user.name,
        user_email: user.email,
        type,
        amount,
        method,
        iban_or_phone: method === 'iban' ? iban : 'KWIK',
        details: method === 'iban' ? iban : 'KWIK Request',
        status: 'pending',
        proof_url: proofUrl,
        timestamp: new Date().toISOString()
      });

      setFeedback({
        type: 'success',
        text: `Pedido de ${type === 'deposit' ? 'depósito' : 'levantamento'} de ${amount.toLocaleString()} KZ enviado.`
      });
      setDepositAmount('');
      setWithdrawAmount('');
      setIban('');
      setProofFile(null);
      loadFinanceRequests();
    } catch (error) {
      console.error('Finance request error:', error);
      setFeedback({ type: 'error', text: 'Erro ao processar pedido financeiro.' });
    } finally {
      setLoading(false);
    }
  };

  const renderFinanceHistory = () => (
    <div className="market-card p-6 mt-6">
      <h4 className="text-sm font-bold text-white uppercase tracking-widest mb-4 flex items-center gap-2">
        <Coins className="w-4 h-4 text-market-green" />
        Suas Solicitações Financeiras (Depósitos & Saques)
      </h4>
      {fetchingFinance ? (
        <div className="flex justify-center p-6"><Loader2 className="w-6 h-6 animate-spin text-market-green" /></div>
      ) : userFinanceRequests.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="border-b border-market-border/30 text-market-text-muted font-bold uppercase tracking-widest text-[9px]">
                <th className="pb-3 text-left">Tipo</th>
                <th className="pb-3 text-right">Montante</th>
                <th className="pb-3 text-center">Método</th>
                <th className="pb-3 text-center">Estado</th>
                <th className="pb-3 text-right text-market-text-muted">Data</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-market-border/15">
              {userFinanceRequests.map((req, index) => (
                <tr key={index} className="hover:bg-white/[0.01] transition-colors">
                  <td className="py-3 items-center">
                    <span className={cn(
                      "px-2 py-0.5 rounded text-[8px] font-black uppercase tracking-wider",
                      req.type === 'deposit' ? "bg-market-green/15 text-market-green border border-market-green/20" : "bg-market-red/15 text-market-red border border-market-red/20"
                    )}>
                      {req.type === 'deposit' ? 'Depósito' : 'Saque'}
                    </span>
                  </td>
                  <td className="py-3 text-right font-bold text-white">{(req.amount || 0).toLocaleString()} KZ</td>
                  <td className="py-3 text-center text-market-text-muted uppercase font-mono">{req.method}</td>
                  <td className="py-3 text-center">
                    <span className={cn(
                      "px-2 py-0.5 rounded text-[8px] font-bold uppercase tracking-wider",
                      req.status === 'approved' && "bg-market-green/15 text-market-green",
                      req.status === 'pending' && "bg-orange-500/15 text-orange-500",
                      req.status === 'rejected' && "bg-market-red/15 text-market-red"
                    )}>
                      {req.status === 'approved' ? 'Aprovado' : req.status === 'pending' ? 'Pendente' : 'Rejeitado'}
                    </span>
                  </td>
                  <td className="py-3 text-right text-market-text-muted">
                    {req.timestamp || req.created_at ? format(new Date(req.timestamp || req.created_at), 'dd/MM HH:mm') : '-'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="text-center py-4 text-market-text-muted italic">
          Nenhuma solicitação financeira efetuada até o momento.
        </div>
      )}
    </div>
  );

  if (!user) {
    return (
      <div className="flex flex-col items-center justify-center py-20">
        <h2 className="text-2xl font-bold text-white mb-4">Por favor, inicie sessão</h2>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-4 md:px-8 py-12">
      <div className="flex flex-col md:flex-row gap-8">
        {/* Sidebar */}
        <div className="w-full md:w-64 space-y-6">
          <div className="market-card p-6 text-center">
            <div className="w-24 h-24 mx-auto bg-market-card-lighter border-2 border-market-green rounded-full flex items-center justify-center mb-4 relative">
              <UserIcon className="w-12 h-12 text-market-text-muted" />
              {user.is_admin && (
                <div className="absolute -bottom-2 -right-2 bg-market-green text-market-bg p-1.5 rounded-full" title="Administrador">
                  <Shield className="w-4 h-4" />
                </div>
              )}
            </div>
            <h2 className="text-xl font-bold text-white flex items-center justify-center gap-2">
              {user.name}
              {user.status === 'active' ? (
                <span title="Perfil Verificado"><CheckCircle className="w-4 h-4 text-market-green" /></span>
              ) : user.status === 'pending_verification' ? (
                <span title="Verificação Pendente"><Clock className="w-4 h-4 text-orange-500" /></span>
              ) : (
                <span title="Perfil Não Verificado"><XCircle className="w-4 h-4 text-market-red" /></span>
              )}
            </h2>
            <p className="text-xs text-market-text-muted font-mono mt-1 break-all">{user.wallet_address}</p>
            {user.status !== 'active' && user.status !== 'pending_verification' && (
              <div className="mt-4">
                <button 
                  onClick={handleVerificationRequest}
                  disabled={loading}
                  className="text-[10px] font-bold uppercase tracking-widest text-market-green hover:text-white transition-colors border border-market-green hover:border-white rounded px-3 py-1 disabled:opacity-50"
                >
                  {loading ? 'A processar...' : 'Solicitar Verificação'}
                </button>
              </div>
            )}
          </div>

          <div className="market-card p-2">
            <div className="flex flex-col gap-1">
              {[
                { id: 'overview', label: 'Visão Geral', icon: Wallet },
                { id: 'deposit', label: 'Depositar', icon: ArrowDownToLine },
                { id: 'withdraw', label: 'Levantar', icon: ArrowUpFromLine },
                { id: 'ledger', label: 'Livro Razão', icon: Coins, onClick: fetchLedgerEntries },
                { id: 'history', label: 'Histórico', icon: History, onClick: fetchInvestmentHistory },
                { id: 'settings', label: 'Definições', icon: Settings },
              ].map(tab => (
                <button
                  key={tab.id}
                  onClick={() => {
                    setActiveTab(tab.id);
                    setFeedback(null);
                    if (tab.onClick) tab.onClick();
                  }}
                  className={`flex items-center gap-3 px-4 py-2.5 rounded-lg text-sm font-medium transition-colors whitespace-nowrap ${
                    activeTab === tab.id 
                      ? 'bg-market-green/15 text-market-green font-semibold' 
                      : 'text-market-text-muted hover:bg-market-card-lighter hover:text-white'
                  }`}
                >
                  <tab.icon className="w-4 h-4 shrink-0" />
                  {tab.label}
                </button>
              ))}
              <button
                onClick={handleLogout}
                className="flex items-center gap-3 px-4 py-2.5 rounded-lg text-sm font-medium text-market-red hover:bg-market-red/10 transition-colors mt-1 whitespace-nowrap"
              >
                <LogOut className="w-4 h-4 shrink-0" />
                Sair
              </button>
            </div>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 space-y-6 min-w-0">
          {feedback && (
            <div className={cn(
              "p-3.5 rounded-xl border text-sm font-medium",
              feedback.type === 'success'
                ? "bg-market-green/10 border-market-green/30 text-market-green"
                : "bg-market-red/10 border-market-red/30 text-market-red"
            )}>
              {feedback.text}
            </div>
          )}

          {activeTab === 'overview' && (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                <div className="market-card p-5 flex flex-col justify-between gap-4">
                  <div>
                    <p className="text-xs font-medium text-market-text-muted">Saldo Disponível</p>
                    <p className="text-2xl font-bold text-white tabular-nums mt-1">{user.balance.toLocaleString()} KZ</p>
                  </div>
                  <div className="flex gap-2">
                    <button onClick={() => setActiveTab('deposit')} className="market-button-primary py-1.5 px-3 text-xs flex-1">Depositar</button>
                    <button onClick={() => setActiveTab('withdraw')} className="market-button-outline py-1.5 px-3 text-xs flex-1">Levantar</button>
                  </div>
                </div>

                <div className="market-card p-5 flex flex-col justify-between gap-2">
                  <div>
                    <p className="text-xs font-medium text-market-text-muted">Em Posições & Ordens</p>
                    <p className="text-2xl font-bold text-white tabular-nums mt-1">{(openPositionsStats.totalInvested + clobReservedKz).toLocaleString()} KZ</p>
                  </div>
                  <p className="text-xs text-market-text-muted tabular-nums">
                    Valor atual: <span className="text-white font-semibold">{openPositionsStats.currentValue.toLocaleString()} KZ</span>
                  </p>
                </div>

                <div className="market-card p-5 flex flex-col justify-between gap-2">
                  <div>
                    <p className="text-xs font-medium text-market-text-muted">PnL Flutuante</p>
                    <p className={cn(
                      "text-2xl font-bold tabular-nums mt-1",
                      openPositionsStats.unrealizedPnL > 0 ? "text-market-green" : openPositionsStats.unrealizedPnL < 0 ? "text-market-red" : "text-white"
                    )}>
                      {openPositionsStats.unrealizedPnL > 0 ? '+' : ''}{openPositionsStats.unrealizedPnL.toLocaleString()} KZ
                    </p>
                  </div>
                  <p className="text-xs text-market-text-muted">Com base no preço atual</p>
                </div>

                <div className="market-card p-5 flex flex-col justify-between gap-2">
                  <div>
                    <p className="text-xs font-medium text-market-text-muted">Retornos Realizados</p>
                    <p className="text-2xl font-bold text-market-green tabular-nums mt-1">{totalRealizedWinnings.toLocaleString()} KZ</p>
                  </div>
                  <p className="text-xs text-market-text-muted">Mercados liquidados</p>
                </div>
              </div>

              <div className="market-card p-6">
                <h3 className="text-lg font-bold text-white mb-6">Posições Ativas</h3>
                {effectivePositions.length > 0 ? (
                  <div className="space-y-4">
                    {effectivePositions.map((pos, i) => {
                      const posMarket = markets.find(m => m.id === pos.market_id);
                      return (
                        <Link
                          key={`${pos.market_id}_${pos.outcome}_${i}`}
                          to={`/market/${pos.market_id}?outcome=${encodeURIComponent(pos.outcome)}&type=sell`}
                          className="flex items-center justify-between p-4 bg-market-card-lighter rounded-xl border border-market-border hover:border-market-green/40 transition-colors"
                        >
                          <div className="min-w-0 pr-4">
                            <p className="font-bold text-white text-sm truncate">{posMarket?.question || `Mercado #${pos.market_id}`}</p>
                            <p className="text-xs text-market-text-muted mt-1">
                              Aposta: <span className={cn("font-bold", pos.outcome === 'Yes' ? 'text-market-green' : pos.outcome === 'No' ? 'text-market-red' : 'text-blue-400')}>{pos.outcome === 'Yes' ? 'Sim' : pos.outcome === 'No' ? 'Não' : pos.outcome}</span>
                            </p>
                          </div>
                          <div className="text-right shrink-0">
                            <p className="font-bold text-white tabular-nums">{pos.shares.toLocaleString('pt-AO')} Quotas</p>
                            <p className="text-xs text-market-text-muted mt-1 tabular-nums">Média: {(pos.avg_price * 100).toFixed(0)} KZ</p>
                          </div>
                        </Link>
                      );
                    })}
                  </div>
                ) : (
                  <div className="text-center py-8 text-market-text-muted text-sm">
                    Não tem posições ativas no momento.
                  </div>
                )}
              </div>
              {renderFinanceHistory()}
            </>
          )}

          {activeTab === 'deposit' && (
            <>
              <div className="market-card p-6 space-y-6">
                <h3 className="text-lg font-bold text-white mb-6 flex items-center gap-2">
                  <ArrowDownToLine className="w-5 h-5 text-market-green" />
                  Depositar Fundos
                </h3>
                
                <div className="space-y-4 max-w-md">
                  <div>
                    <label className="block text-xs font-bold text-market-text-muted uppercase tracking-widest mb-2">Método de Depósito</label>
                    <select 
                      value={method}
                      onChange={(e) => setMethod(e.target.value)}
                      className="market-input w-full bg-market-card appearance-none"
                    >
                      <option value="iban">Transferência IBAN</option>
                      <option value="kwik">Multicaixa Express / KWIK</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-bold text-market-text-muted uppercase tracking-widest mb-2">Montante (KZ)</label>
                    <input 
                      type="number" 
                      value={depositAmount}
                      onChange={(e) => setDepositAmount(e.target.value)}
                      placeholder="0.00" 
                      className="market-input w-full" 
                    />
                  </div>
                  {method === 'iban' && (
                    <div>
                      <label className="block text-xs font-bold text-market-text-muted uppercase tracking-widest mb-2">IBAN de Origem</label>
                      <input 
                        type="text" 
                        value={iban}
                        onChange={(e) => setIban(e.target.value)}
                        placeholder="AO06..." 
                        className="market-input w-full" 
                      />
                    </div>
                  )}
                  <div>
                    <label className="block text-xs font-bold text-market-text-muted uppercase tracking-widest mb-2">Comprovativo de Pagamento</label>
                    <input 
                      type="file" 
                      onChange={(e) => setProofFile(e.target.files?.[0] || null)}
                      className="market-input w-full text-xs" 
                      accept="image/*,.pdf"
                    />
                    <p className="text-[10px] text-market-text-muted mt-1">Anexe uma foto ou PDF do comprovativo.</p>
                  </div>
                  <div className="pt-4">
                    <button 
                      onClick={() => handleFinanceRequest('deposit')}
                      disabled={loading}
                      className="market-button-primary w-full py-3 text-sm flex items-center justify-center gap-2"
                    >
                      {loading && <Loader2 className="w-4 h-4 animate-spin" />}
                      Solicitar Depósito
                    </button>
                  </div>
                  <p className="text-[10px] text-market-text-muted text-center mt-4">
                    Os depósitos estão sujeitos a verificação pelo administrador.
                  </p>
                </div>
              </div>
              {renderFinanceHistory()}
            </>
          )}

          {activeTab === 'withdraw' && (
            <>
              <div className="market-card p-6 space-y-6">
                <h3 className="text-lg font-bold text-white mb-6 flex items-center gap-2">
                  <ArrowUpFromLine className="w-5 h-5 text-market-red" />
                  Levantar Fundos
                </h3>
                
                <div className="space-y-4 max-w-md">
                  <div className="bg-market-card-lighter p-4 rounded-lg mb-4">
                    <div className="flex justify-between text-sm">
                      <span className="text-market-text-muted">Saldo Disponível:</span>
                      <span className="font-bold text-white">{user.balance.toLocaleString()} KZ</span>
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs font-bold text-market-text-muted uppercase tracking-widest mb-2">Método de Levantamento</label>
                    <select 
                      value={method}
                      onChange={(e) => setMethod(e.target.value)}
                      className="market-input w-full bg-market-card appearance-none"
                    >
                      <option value="iban">Transferência IBAN</option>
                      <option value="kwik">Multicaixa Express / KWIK</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-bold text-market-text-muted uppercase tracking-widest mb-2">Montante (KZ)</label>
                    <input 
                      type="number" 
                      value={withdrawAmount}
                      onChange={(e) => setWithdrawAmount(e.target.value)}
                      placeholder="0.00" 
                      className="market-input w-full" 
                    />
                    {withdrawAmount && parseFloat(withdrawAmount) > 0 && (
                      <div className="mt-2.5 p-3.5 bg-[#1C1D21] border border-market-border rounded-xl space-y-1.5 font-mono text-[11px] text-market-text-muted">
                        <div className="flex justify-between">
                          <span>Taxa de Saque (0.5%):</span>
                          <span className="text-market-red">{(parseFloat(withdrawAmount) * 0.005).toFixed(2)} KZ</span>
                        </div>
                        <div className="flex justify-between border-t border-market-border/30 pt-1.5 font-bold text-white">
                          <span>Recebe líquido:</span>
                          <span className="text-market-green">{(parseFloat(withdrawAmount) * 0.995).toFixed(2)} KZ</span>
                        </div>
                      </div>
                    )}
                  </div>
                  <div>
                    <label className="block text-xs font-bold text-market-text-muted uppercase tracking-widest mb-2">
                      {method === 'iban' ? 'IBAN de Destino' : 'Número de Telefone (KWIK)'}
                    </label>
                    <input 
                      type="text" 
                      value={iban}
                      onChange={(e) => setIban(e.target.value)}
                      placeholder={method === 'iban' ? "AO06..." : "9XX..."} 
                      className="market-input w-full" 
                    />
                  </div>
                  <div className="pt-4">
                    <button 
                      onClick={() => handleFinanceRequest('withdrawal')}
                      disabled={loading}
                      className="market-button-outline w-full py-3 text-sm text-market-red hover:bg-market-red/10 border-market-red/50 flex items-center justify-center gap-2"
                    >
                      {loading && <Loader2 className="w-4 h-4 animate-spin" />}
                      Solicitar Levantamento
                    </button>
                  </div>
                  <p className="text-[10px] text-market-text-muted text-center mt-4">
                    Os levantamentos podem demorar até 24h úteis para serem processados.
                  </p>
                </div>
              </div>
              {renderFinanceHistory()}
            </>
          )}

          {activeTab === 'history' && (
            <div className="market-card p-6 space-y-6">
              <h3 className="text-lg font-bold text-white mb-6 flex items-center gap-2">
                <History className="w-5 h-5 text-market-green" />
                Histórico de Investimentos
              </h3>
              
              {fetchingHistory ? (
                <div className="flex justify-center py-12">
                  <Loader2 className="w-8 h-8 animate-spin text-market-green" />
                </div>
              ) : investmentHistory.length > 0 ? (
                <div className="space-y-4">
                  {investmentHistory.map((trade) => {
                    const isResolved = trade.markets?.resolved;
                    const isWinner = isResolved && trade.markets?.resolution_outcome === trade.outcome;
                    const profit = isResolved ? (isWinner ? trade.shares - trade.amount : -trade.amount) : 0;

                    return (
                      <div key={trade.id} className="p-4 bg-market-card-lighter rounded-xl border border-market-border flex flex-col md:flex-row md:items-center justify-between gap-4">
                        <div className="flex-1">
                          <div className="flex items-center gap-2 mb-1">
                            <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded ${
                              trade.side === 'Buy' ? 'bg-market-green/10 text-market-green' : 'bg-market-red/10 text-market-red'
                            }`}>
                              {trade.side === 'Buy' ? 'Compra' : 'Venda'}
                            </span>
                            <span className="text-xs text-market-text-muted">{format(new Date(trade.created_at || trade.timestamp), 'dd/MM/yyyy HH:mm')}</span>
                          </div>
                          <p className="font-bold text-white text-sm">{trade.markets?.question || `Mercado #${trade.market_id}`}</p>
                          <p className="text-xs text-market-text-muted mt-1">
                            Aposta: <span className={cn("font-bold", trade.outcome === 'Yes' ? 'text-market-green' : trade.outcome === 'No' ? 'text-market-red' : 'text-blue-400')}>{trade.outcome}</span>
                          </p>
                        </div>
                        <div className="flex flex-row md:flex-col justify-between md:text-right gap-2">
                          <div>
                            <p className="font-bold text-white">{trade.amount.toLocaleString()} KZ</p>
                            <p className="text-[10px] text-market-text-muted uppercase tracking-widest">{trade.shares.toLocaleString()} Ações @ {trade.price} KZ</p>
                          </div>
                          {isResolved && (
                            <div className={cn(
                              "text-xs font-bold px-2 py-1 rounded h-fit",
                              profit > 0 ? "bg-market-green/10 text-market-green" : "bg-market-red/10 text-market-red"
                            )}>
                              {profit > 0 ? `+${profit.toLocaleString()} KZ` : `${profit.toLocaleString()} KZ`}
                            </div>
                          )}
                          {!isResolved && (
                            <div className="text-[10px] font-bold text-orange-500 bg-orange-500/10 px-2 py-1 rounded h-fit uppercase tracking-widest">
                              Ativo
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="text-center py-12 text-market-text-muted italic">
                  Ainda não realizou nenhum investimento.
                </div>
              )}
            </div>
          )}

          {activeTab === 'ledger' && (
            <div className="market-card p-6 space-y-6">
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-market-border pb-4">
                <div>
                  <h3 className="text-lg font-bold text-white flex items-center gap-2">
                    <Coins className="w-5 h-5 text-market-green" />
                    Livro Razão (Financial Ledger)
                  </h3>
                  <p className="text-xs text-market-text-muted mt-1">
                    Histórico completo e imutável de todas as movimentações financeiras da sua conta.
                  </p>
                </div>
                <div className="bg-market-card-lighter border border-market-border px-4 py-2 rounded-lg">
                  <span className="text-[10px] font-bold text-market-text-muted uppercase tracking-wider block">Saldo do Livro Razão</span>
                  <span className="text-lg font-black text-white">{user.balance.toLocaleString()} KZ</span>
                </div>
              </div>

              {fetchingLedger ? (
                <div className="flex justify-center py-12">
                  <Loader2 className="w-8 h-8 animate-spin text-market-green" />
                </div>
              ) : ledgerEntries.length > 0 ? (
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse text-xs">
                    <thead>
                      <tr className="border-b border-market-border/30 text-market-text-muted font-bold uppercase tracking-widest text-[9px]">
                        <th className="pb-3 text-left">Ref / ID Transação</th>
                        <th className="pb-3 text-center">Tipo de Movimentação</th>
                        <th className="pb-3 text-right">Montante</th>
                        <th className="pb-3 text-right">Saldo Anterior</th>
                        <th className="pb-3 text-right">Novo Saldo</th>
                        <th className="pb-3 text-right text-market-text-muted">Data & Hora</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-market-border/15 font-mono">
                      {ledgerEntries.map((entry, idx) => {
                        const isPositive = entry.amount > 0;
                        return (
                          <tr key={entry.id || idx} className="hover:bg-white/[0.01] transition-colors">
                            <td className="py-4 text-left text-market-text-muted text-[10px] break-all max-w-[120px]" title={entry.id}>
                              #{entry.id?.substring(0, 8)}...
                            </td>
                            <td className="py-4 text-center">
                              <span className={cn(
                                "px-2 py-0.5 rounded text-[8px] font-bold uppercase tracking-wider",
                                entry.type === 'DEPOSITO' && "bg-market-green/15 text-market-green border border-market-green/20",
                                entry.type === 'SAQUE' && "bg-market-red/15 text-market-red border border-market-red/20",
                                entry.type === 'COMPRA_QUOTAS' && "bg-blue-500/15 text-blue-400 border border-blue-500/20",
                                entry.type === 'VENDA_QUOTAS' && "bg-purple-500/15 text-purple-400 border border-purple-500/20",
                                entry.type === 'PREMIACAO_MERCADO' && "bg-amber-500/15 text-amber-500 border border-amber-500/20"
                              )}>
                                {entry.type === 'DEPOSITO' ? 'DEPÓSITO' :
                                 entry.type === 'SAQUE' ? 'SAQUE' :
                                 entry.type === 'COMPRA_QUOTAS' ? 'COMPRA QUOTAS' :
                                 entry.type === 'VENDA_QUOTAS' ? 'VENDA QUOTAS' :
                                 entry.type === 'PREMIACAO_MERCADO' ? 'PREMIAÇÃO VENCEDOR' : entry.type}
                              </span>
                            </td>
                            <td className={cn("py-4 text-right font-bold text-sm", isPositive ? "text-market-green" : "text-market-red")}>
                              {isPositive ? '+' : ''}{(entry.amount || 0).toLocaleString()} KZ
                            </td>
                            <td className="py-4 text-right text-market-text-muted">
                              {(entry.balanceBefore || 0).toLocaleString()} KZ
                            </td>
                            <td className="py-4 text-right text-white font-bold">
                              {(entry.balanceAfter || 0).toLocaleString()} KZ
                            </td>
                            <td className="py-4 text-right text-market-text-muted text-[10px]">
                              {entry.createdAt ? format(new Date(entry.createdAt), 'dd/MM/yyyy HH:mm:ss') : '-'}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="text-center py-12 text-market-text-muted italic">
                  Nenhum registro financeiro encontrado no Livro Razão imutável para esta conta.
                </div>
              )}
            </div>
          )}

          {activeTab === 'settings' && (
            <div className="market-card p-6 space-y-6">
              <h3 className="text-lg font-bold text-white mb-6">Definições de Conta</h3>
              
              <div className="space-y-6 max-w-md">
                <div className="space-y-4">
                  <h4 className="text-xs font-bold text-market-text-muted uppercase tracking-widest border-b border-market-border pb-2">Perfil</h4>
                  <div>
                    <label className="block text-xs font-bold text-market-text-muted uppercase tracking-widest mb-2">Nome de Exibição</label>
                    <input type="text" value={profileName} onChange={(e) => setProfileName(e.target.value)} className="market-input w-full" />
                  </div>
                  <div>
                    <label className="block text-xs font-bold text-market-text-muted uppercase tracking-widest mb-2">Email</label>
                    <input type="email" value={user.email} disabled className="market-input w-full opacity-60 cursor-not-allowed" />
                  </div>
                </div>

                <div className="space-y-4">
                  <h4 className="text-xs font-bold text-market-text-muted uppercase tracking-widest border-b border-market-border pb-2">Segurança & Recuperação</h4>
                  <div>
                    <label className="block text-xs font-bold text-market-text-muted uppercase tracking-widest mb-2">Nova Palavra-passe (mín. 8 caracteres, letras e números)</label>
                    <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder="••••••••" className="market-input w-full" />
                  </div>
                  <div>
                    <label className="block text-xs font-bold text-market-text-muted uppercase tracking-widest mb-2">Confirmar Palavra-passe</label>
                    <input type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} placeholder="••••••••" className="market-input w-full" />
                  </div>
                  <div className="pt-1">
                    <button
                      type="button"
                      onClick={handleGlobalSignOut}
                      disabled={loading}
                      className="text-xs font-semibold text-market-red hover:underline flex items-center gap-1.5"
                    >
                      <Shield className="w-3.5 h-3.5" />
                      Terminar sessão em todos os dispositivos
                    </button>
                  </div>
                </div>

                <div className="space-y-4">
                  <h4 className="text-xs font-bold text-market-text-muted uppercase tracking-widest border-b border-market-border pb-2">Notificações</h4>
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-white">Notificações por Email</span>
                    <input type="checkbox" checked={emailNotifications} onChange={(e) => setEmailNotifications(e.target.checked)} className="w-4 h-4 rounded border-market-border bg-market-card text-market-green focus:ring-market-green" />
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-white">Alertas de Mercado</span>
                    <input type="checkbox" checked={marketAlerts} onChange={(e) => setMarketAlerts(e.target.checked)} className="w-4 h-4 rounded border-market-border bg-market-card text-market-green focus:ring-market-green" />
                  </div>
                </div>

                <div className="pt-4">
                  <button
                    type="button"
                    onClick={handleSaveSettings}
                    disabled={loading}
                    className="market-button-primary w-full py-3 text-xs flex items-center justify-center gap-2 disabled:opacity-50"
                  >
                    {loading && <Loader2 className="w-4 h-4 animate-spin" />}
                    Guardar Alterações
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
