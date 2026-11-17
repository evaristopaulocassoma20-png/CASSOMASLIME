import React, { useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowDownToLine,
  ArrowUpFromLine,
  Ban,
  CheckCircle,
  Clock,
  Edit2,
  Eye,
  KeyRound,
  Loader2,
  Lock,
  MailCheck,
  RotateCcw,
  Search,
  Shield,
  ShieldCheck,
  Trash2,
  UserCheck,
  Users,
  Wallet,
  X,
} from 'lucide-react';
import { User } from '../../types';
import { ammApi } from '../../lib/amm-api';

function maskDetails(raw: string | undefined): string {
  if (!raw) return '—';
  const s = String(raw).trim();
  if (s.length <= 8) return s;
  return `${s.slice(0, 4)}••••${s.slice(-4)}`;
}

const MASTER_ADMIN_EMAILS = new Set([
  'evaristopaulocassoma00@gmail.com',
  'evaristopaulocassoma20@gmail.com',
]);

function isMasterEmail(email?: string | null): boolean {
  return MASTER_ADMIN_EMAILS.has(String(email || '').trim().toLowerCase());
}

export const UsersAndFinancePanel = ({
  mode,
  users,
  requests,
  trades,
  sqlAccounts,
  sqlPositions,
  actorRole,
  platformFeePct,
  addToast,
  onRefreshData,
}: {
  mode: 'users' | 'wallets' | 'deposits' | 'withdrawals' | 'kyc';
  users: User[];
  requests: any[];
  trades: any[];
  sqlAccounts: any[];
  sqlPositions: any[];
  actorRole: 'MASTER_ADMIN' | 'OPERATIONAL_ADMIN' | 'USER';
  platformFeePct: number;
  addToast: (msg: string, type?: 'success' | 'error' | 'info') => void;
  onRefreshData: () => void;
}) => {
  const isMaster = actorRole === 'MASTER_ADMIN';
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [page, setPage] = useState(1);
  const pageSize = 20;

  // Inspection Drawer State
  const [inspectUser, setInspectUser] = useState<User | null>(null);
  const [inspectDetails, setInspectDetails] = useState<any | null>(null);
  const [loadingDetails, setLoadingDetails] = useState(false);
  const [drawerTab, setDrawerTab] = useState<'overview' | 'finance' | 'audit'>('overview');

  // Edit User Modal State
  const [editingUser, setEditingUser] = useState<User | null>(null);
  const [editForm, setEditForm] = useState<{
    name: string;
    email: string;
    wallet_address: string;
    status: 'active' | 'blocked' | 'pending_verification';
    verification_status: 'none' | 'pending' | 'verified' | 'rejected';
    is_admin: boolean;
    justification: string;
  }>({
    name: '',
    email: '',
    wallet_address: '',
    status: 'active',
    verification_status: 'none',
    is_admin: false,
    justification: '',
  });

  // Delete User Modal State
  const [deletingUser, setDeletingUser] = useState<User | null>(null);
  const [deleteReason, setDeleteReason] = useState('');

  // Balance Edit Modal State (Master Admin)
  const [editingBalanceUser, setEditingBalanceUser] = useState<User | null>(null);
  const [newBalanceKz, setNewBalanceKz] = useState('');
  const [balanceReason, setBalanceReason] = useState('');

  const [busyId, setBusyId] = useState<string | null>(null);
  const [proofPreviewUrl, setProofPreviewUrl] = useState<string | null>(null);

  const sqlAccountMap = useMemo(() => {
    const m = new Map<string, any>();
    for (const a of sqlAccounts || []) m.set(a.user_id, a);
    return m;
  }, [sqlAccounts]);

  const userTradeStats = useMemo(() => {
    const stats = new Map<string, { volume: number; count: number; fees: number }>();
    for (const t of trades || []) {
      const uid = t.user_id;
      if (!uid) continue;
      const cur = stats.get(uid) || { volume: 0, count: 0, fees: 0 };
      cur.volume += Number(t.amount || 0);
      cur.count += 1;
      cur.fees += Number(t.fee || 0);
      stats.set(uid, cur);
    }
    return stats;
  }, [trades]);

  const userPositionsMap = useMemo(() => {
    const m = new Map<string, any[]>();
    for (const p of sqlPositions || []) {
      const list = m.get(p.user_id) || [];
      list.push(p);
      m.set(p.user_id, list);
    }
    return m;
  }, [sqlPositions]);

  const openUserDrawer = async (u: User) => {
    setInspectUser(u);
    setDrawerTab('overview');
    setInspectDetails(null);
    setLoadingDetails(true);
    try {
      const details = await ammApi.getAdminUserDetails(u.id);
      setInspectDetails(details);
      if (details?.profile) {
        setInspectUser((prev) => (prev && prev.id === u.id ? { ...prev, ...details.profile } : prev));
      }
    } catch (e: any) {
      addToast('Aviso ao carregar detalhes completos: ' + (e?.message || 'Erro'), 'info');
    } finally {
      setLoadingDetails(false);
    }
  };

  const openEditUserModal = (u: User) => {
    const kycState = (u.verification_status || (u.is_verified ? 'verified' : 'none')) as
      | 'none'
      | 'pending'
      | 'verified'
      | 'rejected';
    setEditingUser(u);
    setEditForm({
      name: u.name || '',
      email: u.email || '',
      wallet_address: u.wallet_address || '',
      status: (u.status || 'active') as 'active' | 'blocked' | 'pending_verification',
      verification_status: kycState,
      is_admin: Boolean(u.is_admin),
      justification: '',
    });
  };

  const handleSaveEditUser = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingUser) return;
    setBusyId(editingUser.id);
    try {
      const payload: any = {
        name: editForm.name.trim(),
        email: editForm.email.trim(),
        wallet_address: editForm.wallet_address.trim() || null,
        status: editForm.status,
        verification_status: editForm.verification_status,
        is_verified: editForm.verification_status === 'verified',
        justification: editForm.justification.trim() || 'Edição de dados pelo painel admin',
      };
      if (isMaster) {
        payload.is_admin = editForm.is_admin;
      }

      const res = await ammApi.updateAdminUser(editingUser.id, payload);
      addToast(
        res.cancelledOrders > 0
          ? `Utilizador atualizado (${res.cancelledOrders} ordem(ns) aberta(s) cancelada(s)).`
          : 'Dados do utilizador atualizados com sucesso.',
        'success'
      );
      if (inspectUser?.id === editingUser.id && res.user) {
        setInspectUser((prev) => (prev ? { ...prev, ...res.user } : prev));
        openUserDrawer({ ...editingUser, ...res.user });
      }
      setEditingUser(null);
      onRefreshData();
    } catch (e: any) {
      addToast('Erro ao editar utilizador: ' + (e?.message || 'Erro'), 'error');
    } finally {
      setBusyId(null);
    }
  };

  const handleToggleBlockUser = async (u: User) => {
    const nextStatus = u.status === 'blocked' ? 'active' : 'blocked';
    setBusyId(u.id);
    try {
      const res = await ammApi.updateAdminUserStatus(
        u.id,
        nextStatus,
        nextStatus === 'blocked' ? 'Suspensão via painel administrativo' : 'Reativação via painel administrativo'
      );
      addToast(
        nextStatus === 'blocked'
          ? `Utilizador ${u.name || u.email} bloqueado${res.cancelledOrders ? ` (${res.cancelledOrders} ordens canceladas)` : ''}.`
          : `Utilizador ${u.name || u.email} reativado com sucesso.`,
        nextStatus === 'blocked' ? 'info' : 'success'
      );
      if (inspectUser?.id === u.id) {
        setInspectUser((prev) => (prev ? { ...prev, status: nextStatus } : prev));
      }
      onRefreshData();
    } catch (e: any) {
      addToast('Erro ao atualizar estado do utilizador: ' + (e?.message || 'Erro'), 'error');
    } finally {
      setBusyId(null);
    }
  };

  const handleKycDecision = async (userId: string, decision: 'verified' | 'rejected' | 'pending') => {
    setBusyId(userId);
    try {
      const res = await ammApi.updateAdminUserKyc(
        userId,
        decision,
        decision === 'verified'
          ? 'Verificação KYC aprovada pela administração'
          : decision === 'rejected'
            ? 'Verificação KYC rejeitada pela administração'
            : 'Estado KYC reposto para pendente'
      );
      addToast(
        decision === 'verified'
          ? 'Identidade KYC verificada com sucesso.'
          : decision === 'rejected'
            ? 'Verificação KYC rejeitada.'
            : 'KYC marcado como pendente.',
        decision === 'verified' ? 'success' : 'info'
      );
      if (inspectUser?.id === userId && res.user) {
        setInspectUser((prev) => (prev ? { ...prev, ...res.user } : prev));
      }
      onRefreshData();
    } catch (e: any) {
      addToast('Erro ao atualizar KYC: ' + (e?.message || 'Erro'), 'error');
    } finally {
      setBusyId(null);
    }
  };

  const handleConfirmDeleteUser = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!deletingUser) return;
    setBusyId(deletingUser.id);
    try {
      const res = await ammApi.deleteAdminUser(
        deletingUser.id,
        deleteReason.trim() || 'Remoção de conta via painel administrativo'
      );
      addToast(
        `Utilizador ${deletingUser.name || deletingUser.email} apagado${res.cancelledOrders ? ` (${res.cancelledOrders} ordens canceladas)` : ''}.`,
        'success'
      );
      if (inspectUser?.id === deletingUser.id) {
        setInspectUser(null);
      }
      setDeletingUser(null);
      setDeleteReason('');
      onRefreshData();
    } catch (e: any) {
      addToast('Erro ao apagar utilizador: ' + (e?.message || 'Erro'), 'error');
    } finally {
      setBusyId(null);
    }
  };

  const handleManualBalanceSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingBalanceUser) return;
    if (!isMaster) {
      addToast('Apenas o Master Admin pode alterar saldos manualmente.', 'error');
      return;
    }
    const parsed = parseFloat(newBalanceKz);
    if (isNaN(parsed) || parsed < 0) {
      addToast('Introduza um montante numérico não negativo.', 'error');
      return;
    }
    if (balanceReason.trim().length < 5) {
      addToast('Justificação obrigatória (mínimo 5 caracteres).', 'error');
      return;
    }
    setBusyId(editingBalanceUser.id);
    try {
      await ammApi.adminUpdateUserBalance(editingBalanceUser.id, parsed, balanceReason.trim());
      addToast(`Saldo de ${editingBalanceUser.name} atualizado para ${parsed.toLocaleString('pt-PT')} Kz.`, 'success');
      if (inspectUser?.id === editingBalanceUser.id) {
        openUserDrawer({ ...editingBalanceUser, balance: parsed });
      }
      setEditingBalanceUser(null);
      setNewBalanceKz('');
      setBalanceReason('');
      onRefreshData();
    } catch (e: any) {
      addToast('Erro ao ajustar saldo: ' + e.message, 'error');
    } finally {
      setBusyId(null);
    }
  };

  const handleProcessFinance = async (reqId: string, status: 'approved' | 'rejected') => {
    setBusyId(reqId);
    try {
      await ammApi.processFinanceRequest(reqId, status);
      addToast(
        status === 'approved'
          ? 'Operação financeira aprovada e reconciliada no SQLite + Supabase.'
          : 'Pedido financeiro rejeitado e registado na auditoria.',
        status === 'approved' ? 'success' : 'info'
      );
      onRefreshData();
    } catch (e: any) {
      addToast('Erro ao processar solicitação: ' + e.message, 'error');
    } finally {
      setBusyId(null);
    }
  };

  const filteredUsers = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (users || []).filter((u) => {
      if (mode === 'kyc') {
        const kycState = u.verification_status || (u.is_verified ? 'verified' : 'none');
        if (statusFilter === 'pending' && kycState !== 'pending' && u.status !== 'pending_verification') return false;
        if (statusFilter === 'verified' && !u.is_verified && kycState !== 'verified') return false;
        if (statusFilter === 'rejected' && kycState !== 'rejected') return false;
        if (statusFilter === 'none' && kycState !== 'none') return false;
      } else {
        if (statusFilter === 'active' && u.status === 'blocked') return false;
        if (statusFilter === 'blocked' && u.status !== 'blocked') return false;
        if (statusFilter === 'verified' && !u.is_verified && u.verification_status !== 'verified') return false;
        if (statusFilter === 'pending_kyc' && u.verification_status !== 'pending' && u.status !== 'pending_verification') return false;
        if (statusFilter === 'admins' && !u.is_admin) return false;
      }
      if (!q) return true;
      return (
        String(u.name || '').toLowerCase().includes(q) ||
        String(u.email || '').toLowerCase().includes(q) ||
        String(u.id || '').toLowerCase().includes(q) ||
        String(u.wallet_address || '').toLowerCase().includes(q)
      );
    });
  }, [users, search, statusFilter, mode]);

  const filteredFinanceRequests = useMemo(() => {
    const targetType = mode === 'deposits' ? 'deposit' : 'withdrawal';
    const q = search.trim().toLowerCase();
    return (requests || []).filter((r) => {
      if (r.type !== targetType) return false;
      if (statusFilter !== 'all' && (r.status || 'pending') !== statusFilter) return false;
      if (!q) return true;
      return (
        String(r.id || '').toLowerCase().includes(q) ||
        String(r.user_id || '').toLowerCase().includes(q) ||
        String(r.user_name || r.userName || '').toLowerCase().includes(q) ||
        String(r.details || '').toLowerCase().includes(q)
      );
    });
  }, [requests, mode, statusFilter, search]);

  const paginatedUsers = filteredUsers.slice((page - 1) * pageSize, page * pageSize);
  const paginatedRequests = filteredFinanceRequests.slice((page - 1) * pageSize, page * pageSize);

  const renderKycBadge = (u: User) => {
    const kyc = u.verification_status || (u.is_verified ? 'verified' : 'none');
    return (
      <span
        className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
          kyc === 'verified'
            ? 'bg-market-green/15 text-market-green'
            : kyc === 'pending'
              ? 'bg-amber-500/15 text-amber-400'
              : kyc === 'rejected'
                ? 'bg-market-red/15 text-market-red'
                : 'bg-market-bg text-market-text-muted border border-market-border'
        }`}
      >
        {kyc === 'verified'
          ? 'Verificado'
          : kyc === 'pending'
            ? 'Pendente'
            : kyc === 'rejected'
              ? 'Rejeitado'
              : 'Não submetido'}
      </span>
    );
  };

  return (
    <div className="space-y-6">
      {/* Header & Filters */}
      <div className="market-card p-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          {mode === 'users' && <Users className="w-4 h-4 text-market-green" />}
          {mode === 'wallets' && <Wallet className="w-4 h-4 text-blue-400" />}
          {mode === 'deposits' && <ArrowDownToLine className="w-4 h-4 text-market-green" />}
          {mode === 'withdrawals' && <ArrowUpFromLine className="w-4 h-4 text-market-red" />}
          {mode === 'kyc' && <ShieldCheck className="w-4 h-4 text-cyan-400" />}
          <div>
            <h2 className="text-sm font-bold text-white">
              {mode === 'users'
                ? 'Gestão Completa de Utilizadores'
                : mode === 'wallets'
                  ? 'Carteiras e Colateral (Supabase + CLOB)'
                  : mode === 'deposits'
                    ? 'Depósitos de Utilizadores'
                    : mode === 'withdrawals'
                      ? 'Levantamentos de Utilizadores'
                      : 'Verificação de Identidade (KYC)'}
            </h2>
            <p className="text-[11px] text-market-text-muted">
              {mode === 'deposits' || mode === 'withdrawals'
                ? 'Aprovações atualizam atomicamente o saldo SQLite, Supabase e Livro Razão.'
                : mode === 'users'
                  ? 'Inspecione detalhes completos, edite dados, valide KYC, suspenda ou remova utilizadores.'
                  : 'Controlo operacional sincronizado com Supabase e motor CLOB SQLite.'}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-market-text-muted absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              placeholder="Pesquisar nome, email, ID..."
              className="bg-market-bg border border-market-border rounded-lg pl-8 pr-3 py-1.5 text-xs text-white w-56"
            />
          </div>

          {mode === 'deposits' || mode === 'withdrawals' ? (
            <select
              value={statusFilter}
              onChange={(e) => {
                setStatusFilter(e.target.value);
                setPage(1);
              }}
              className="bg-market-bg border border-market-border rounded-lg px-3 py-1.5 text-xs text-white"
            >
              <option value="all">Todos Estados</option>
              <option value="pending">Pendentes</option>
              <option value="approved">Aprovados</option>
              <option value="rejected">Rejeitados</option>
            </select>
          ) : mode === 'kyc' ? (
            <select
              value={statusFilter}
              onChange={(e) => {
                setStatusFilter(e.target.value);
                setPage(1);
              }}
              className="bg-market-bg border border-market-border rounded-lg px-3 py-1.5 text-xs text-white"
            >
              <option value="all">Todos</option>
              <option value="pending">KYC Pendentes</option>
              <option value="verified">KYC Verificados</option>
              <option value="rejected">KYC Rejeitados</option>
              <option value="none">Não Submetido</option>
            </select>
          ) : (
            <select
              value={statusFilter}
              onChange={(e) => {
                setStatusFilter(e.target.value);
                setPage(1);
              }}
              className="bg-market-bg border border-market-border rounded-lg px-3 py-1.5 text-xs text-white"
            >
              <option value="all">Todos</option>
              <option value="active">Ativos</option>
              <option value="blocked">Bloqueados</option>
              <option value="verified">KYC Verificado</option>
              <option value="pending_kyc">KYC Pendente</option>
              <option value="admins">Administradores</option>
            </select>
          )}
        </div>
      </div>

      {/* USERS TABLE */}
      {mode === 'users' && (
        <div className="market-card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-xs text-left">
              <thead className="bg-market-bg text-market-text-muted uppercase text-[10px]">
                <tr>
                  <th className="px-4 py-3">Utilizador / ID</th>
                  <th className="px-4 py-3">Registo</th>
                  <th className="px-4 py-3">Estado / KYC</th>
                  <th className="px-4 py-3 text-right">Saldo Disponível</th>
                  <th className="px-4 py-3 text-right">Reservado</th>
                  <th className="px-4 py-3 text-right">Volume / Ops</th>
                  <th className="px-4 py-3 text-right">Controlo</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-market-border">
                {paginatedUsers.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="py-10 text-center text-market-text-muted">
                      Nenhum utilizador encontrado.
                    </td>
                  </tr>
                ) : (
                  paginatedUsers.map((u) => {
                    const sql = sqlAccountMap.get(u.id);
                    const availKz = sql ? sql.available_cents / 100 : Number(u.balance || 0);
                    const reservedKz = sql ? sql.reserved_cents / 100 : 0;
                    const tStats = userTradeStats.get(u.id) || { volume: 0, count: 0, fees: 0 };
                    const isBlocked = u.status === 'blocked';
                    const isMasterTarget = isMasterEmail(u.email);
                    return (
                      <tr key={u.id} className="hover:bg-market-card-lighter/40">
                        <td className="px-4 py-3">
                          <button
                            type="button"
                            onClick={() => openUserDrawer(u)}
                            className="text-left group"
                          >
                            <div className="font-semibold text-white group-hover:text-market-green flex items-center gap-2 transition-colors">
                              <span>{u.name || 'Sem nome'}</span>
                              {u.is_admin && (
                                <span
                                  className={`px-1.5 py-0.5 rounded text-[9px] font-bold uppercase ${
                                    isMasterTarget ? 'bg-amber-500/20 text-amber-300' : 'bg-blue-500/15 text-blue-300'
                                  }`}
                                >
                                  {isMasterTarget ? 'Master' : 'Admin'}
                                </span>
                              )}
                            </div>
                            <div className="text-[11px] text-market-text-muted font-mono">{u.email || '—'}</div>
                            <div className="text-[10px] text-market-text-muted/70 font-mono">
                              ID: {u.id.slice(0, 12)}
                              {u.wallet_address ? ` · ${u.wallet_address}` : ''}
                            </div>
                          </button>
                        </td>
                        <td className="px-4 py-3 font-mono text-[11px] text-market-text-muted">
                          {u.created_at ? new Date(u.created_at).toLocaleDateString('pt-PT') : '—'}
                        </td>
                        <td className="px-4 py-3 space-y-1">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span
                              className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
                                isBlocked
                                  ? 'bg-market-red/15 text-market-red'
                                  : u.status === 'pending_verification'
                                    ? 'bg-amber-500/15 text-amber-400'
                                    : 'bg-market-green/15 text-market-green'
                              }`}
                            >
                              {isBlocked ? 'Bloqueado' : u.status === 'pending_verification' ? 'Em Verificação' : 'Ativo'}
                            </span>
                            {renderKycBadge(u)}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-right font-mono tabular-nums font-bold text-white">
                          {availKz.toLocaleString('pt-PT', { minimumFractionDigits: 2 })} Kz
                        </td>
                        <td className="px-4 py-3 text-right font-mono tabular-nums text-amber-400">
                          {reservedKz.toLocaleString('pt-PT', { minimumFractionDigits: 2 })} Kz
                        </td>
                        <td className="px-4 py-3 text-right font-mono tabular-nums">
                          <span className="text-market-green block">
                            {tStats.volume.toLocaleString('pt-PT', { minimumFractionDigits: 2 })} Kz
                          </span>
                          <span className="text-[10px] text-market-text-muted">{tStats.count} ops</span>
                        </td>
                        <td className="px-4 py-3 text-right">
                          <div className="inline-flex items-center gap-1">
                            <button
                              type="button"
                              onClick={() => openUserDrawer(u)}
                              className="p-1.5 rounded bg-market-bg border border-market-border text-market-text-muted hover:text-white"
                              title="Ver detalhes, verificação e atividade"
                            >
                              <Eye className="w-3.5 h-3.5" />
                            </button>
                            <button
                              type="button"
                              disabled={busyId === u.id}
                              onClick={() => openEditUserModal(u)}
                              className="p-1.5 rounded bg-market-bg border border-market-border text-blue-300 hover:bg-blue-500/15"
                              title="Editar dados do utilizador"
                            >
                              <Edit2 className="w-3.5 h-3.5" />
                            </button>
                            {u.verification_status !== 'verified' && !u.is_verified && (
                              <button
                                type="button"
                                disabled={busyId === u.id}
                                onClick={() => handleKycDecision(u.id, 'verified')}
                                className="p-1.5 rounded border border-cyan-500/30 text-cyan-300 hover:bg-cyan-500/15"
                                title="Aprovar Verificação KYC"
                              >
                                <ShieldCheck className="w-3.5 h-3.5" />
                              </button>
                            )}
                            {!isMasterTarget && (
                              <button
                                type="button"
                                disabled={busyId === u.id}
                                onClick={() => handleToggleBlockUser(u)}
                                className={`p-1.5 rounded border ${
                                  isBlocked
                                    ? 'border-market-green/30 text-market-green hover:bg-market-green/10'
                                    : 'border-amber-500/30 text-amber-400 hover:bg-amber-500/10'
                                }`}
                                title={isBlocked ? 'Desbloquear / Reativar conta' : 'Bloquear / Suspender conta'}
                              >
                                {busyId === u.id ? (
                                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                ) : isBlocked ? (
                                  <CheckCircle className="w-3.5 h-3.5" />
                                ) : (
                                  <Ban className="w-3.5 h-3.5" />
                                )}
                              </button>
                            )}
                            {!isMasterTarget && (!u.is_admin || isMaster) && (
                              <button
                                type="button"
                                disabled={busyId === u.id}
                                onClick={() => {
                                  setDeletingUser(u);
                                  setDeleteReason('');
                                }}
                                className="p-1.5 rounded border border-market-red/30 text-market-red hover:bg-market-red/15"
                                title="Apagar utilizador"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* WALLETS VIEW */}
      {mode === 'wallets' && (
        <div className="market-card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-xs text-left">
              <thead className="bg-market-bg text-market-text-muted uppercase text-[10px]">
                <tr>
                  <th className="px-4 py-3">Titular</th>
                  <th className="px-4 py-3 text-right">Supabase (Kz)</th>
                  <th className="px-4 py-3 text-right">CLOB Disponível (Kz)</th>
                  <th className="px-4 py-3 text-right">CLOB Reservado (Kz)</th>
                  <th className="px-4 py-3 text-right">Posições Ativas</th>
                  <th className="px-4 py-3 text-right">Ações</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-market-border">
                {paginatedUsers.map((u) => {
                  const sql = sqlAccountMap.get(u.id);
                  const posList = userPositionsMap.get(u.id) || [];
                  return (
                    <tr key={u.id} className="hover:bg-market-card-lighter/40">
                      <td className="px-4 py-3">
                        <span className="font-semibold text-white block">{u.name || 'Sem nome'}</span>
                        <span className="text-[11px] font-mono text-market-text-muted">{u.email}</span>
                      </td>
                      <td className="px-4 py-3 text-right font-mono tabular-nums text-white">
                        {Number(u.balance || 0).toLocaleString('pt-PT', { minimumFractionDigits: 2 })} Kz
                      </td>
                      <td className="px-4 py-3 text-right font-mono tabular-nums text-market-green">
                        {((sql ? sql.available_cents : Number(u.balance || 0) * 100) / 100).toLocaleString('pt-PT', {
                          minimumFractionDigits: 2,
                        })}{' '}
                        Kz
                      </td>
                      <td className="px-4 py-3 text-right font-mono tabular-nums text-amber-400">
                        {((sql?.reserved_cents || 0) / 100).toLocaleString('pt-PT', { minimumFractionDigits: 2 })} Kz
                      </td>
                      <td className="px-4 py-3 text-right font-mono tabular-nums text-white">{posList.length}</td>
                      <td className="px-4 py-3 text-right">
                        <div className="inline-flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => openUserDrawer(u)}
                            className="p-1.5 rounded bg-market-bg border border-market-border text-market-text-muted hover:text-white"
                            title="Ver carteira e detalhes"
                          >
                            <Eye className="w-3.5 h-3.5" />
                          </button>
                          {isMaster ? (
                            <button
                              type="button"
                              onClick={() => {
                                setEditingBalanceUser(u);
                                setNewBalanceKz(String(u.balance || 0));
                              }}
                              className="px-2.5 py-1 rounded bg-amber-500/15 text-amber-300 border border-amber-500/30 text-[10px] font-bold hover:bg-amber-500/25"
                            >
                              Ajustar Saldo
                            </button>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-[10px] text-market-text-muted">
                              <Lock className="w-3 h-3" /> Master
                            </span>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* DEPOSITS & WITHDRAWALS SEPARATED TABLES */}
      {(mode === 'deposits' || mode === 'withdrawals') && (
        <div className="market-card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-xs text-left">
              <thead className="bg-market-bg text-market-text-muted uppercase text-[10px]">
                <tr>
                  <th className="px-4 py-3">ID Pedido</th>
                  <th className="px-4 py-3">Utilizador</th>
                  <th className="px-4 py-3 text-right">Valor Bruto</th>
                  <th className="px-4 py-3 text-right">Taxa</th>
                  <th className="px-4 py-3 text-right">Líquido</th>
                  <th className="px-4 py-3">Método / Referência</th>
                  <th className="px-4 py-3 text-center">Comprovativo</th>
                  <th className="px-4 py-3 text-center">Estado / Admin</th>
                  <th className="px-4 py-3 text-right">Ações</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-market-border">
                {paginatedRequests.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="py-10 text-center text-market-text-muted">
                      Sem solicitações de {mode === 'deposits' ? 'depósito' : 'levantamento'} encontradas.
                    </td>
                  </tr>
                ) : (
                  paginatedRequests.map((req) => {
                    const amt = Number(req.amount || 0);
                    const fee = mode === 'withdrawals' ? Number((amt * (platformFeePct / 100) * 0).toFixed(2)) : 0;
                    const net = Number((amt - fee).toFixed(2));
                    const st = req.status || 'pending';
                    return (
                      <tr key={req.id} className="hover:bg-market-card-lighter/40">
                        <td className="px-4 py-3 font-mono text-[11px] text-market-text-muted">
                          <div>{String(req.id).slice(0, 10)}</div>
                          <div className="text-[10px]">{req.created_at ? new Date(req.created_at).toLocaleString('pt-PT') : '—'}</div>
                        </td>
                        <td className="px-4 py-3">
                          <div className="font-semibold text-white">{req.user_name || req.userName || 'Utilizador'}</div>
                          <div className="text-[10px] font-mono text-market-text-muted">{req.user_id?.slice(0, 14)}</div>
                        </td>
                        <td className="px-4 py-3 text-right font-mono tabular-nums font-bold text-white">
                          {amt.toLocaleString('pt-PT', { minimumFractionDigits: 2 })} Kz
                        </td>
                        <td className="px-4 py-3 text-right font-mono tabular-nums text-market-text-muted">
                          {fee.toLocaleString('pt-PT', { minimumFractionDigits: 2 })} Kz
                        </td>
                        <td className="px-4 py-3 text-right font-mono tabular-nums text-market-green font-semibold">
                          {net.toLocaleString('pt-PT', { minimumFractionDigits: 2 })} Kz
                        </td>
                        <td className="px-4 py-3 font-mono text-[11px]">
                          <span className="text-white uppercase block">{req.method || 'iban'}</span>
                          <span className="text-market-text-muted">{maskDetails(req.details)}</span>
                        </td>
                        <td className="px-4 py-3 text-center">
                          {req.proof_url && !String(req.proof_url).includes('unsplash.com') ? (
                            <button
                              type="button"
                              onClick={() => setProofPreviewUrl(req.proof_url)}
                              className="px-2 py-1 rounded bg-blue-500/15 text-blue-300 text-[10px] font-semibold hover:bg-blue-500/25"
                            >
                              Ver Recibo
                            </button>
                          ) : (
                            <span className="text-[11px] text-market-text-muted">Sem anexo</span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-center">
                          <span
                            className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
                              st === 'approved'
                                ? 'bg-market-green/15 text-market-green'
                                : st === 'rejected'
                                  ? 'bg-market-red/15 text-market-red'
                                  : 'bg-amber-500/15 text-amber-400'
                            }`}
                          >
                            {st === 'approved' ? 'Aprovado' : st === 'rejected' ? 'Rejeitado' : 'Pendente'}
                          </span>
                          {req.processed_by && (
                            <div className="text-[10px] font-mono text-market-text-muted mt-0.5">
                              Admin: {String(req.processed_by).slice(0, 10)}
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right">
                          {st === 'pending' ? (
                            <div className="inline-flex items-center gap-1.5">
                              <button
                                type="button"
                                disabled={busyId === req.id}
                                onClick={() => handleProcessFinance(req.id, 'approved')}
                                className="px-2.5 py-1 rounded bg-market-green/15 text-market-green hover:bg-market-green hover:text-black text-[11px] font-bold transition-colors"
                              >
                                {busyId === req.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Aprovar'}
                              </button>
                              <button
                                type="button"
                                disabled={busyId === req.id}
                                onClick={() => handleProcessFinance(req.id, 'rejected')}
                                className="px-2.5 py-1 rounded bg-market-red/15 text-market-red hover:bg-market-red hover:text-white text-[11px] font-bold transition-colors"
                              >
                                Rejeitar
                              </button>
                            </div>
                          ) : (
                            <span className="text-[11px] text-market-text-muted">Liquidado</span>
                          )}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* KYC TABLE */}
      {mode === 'kyc' && (
        <div className="market-card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-xs text-left">
              <thead className="bg-market-bg text-market-text-muted uppercase text-[10px]">
                <tr>
                  <th className="px-4 py-3">Utilizador / ID</th>
                  <th className="px-4 py-3">Email / Carteira</th>
                  <th className="px-4 py-3 text-center">Estado Conta</th>
                  <th className="px-4 py-3 text-center">Estado KYC</th>
                  <th className="px-4 py-3 text-right">Registo</th>
                  <th className="px-4 py-3 text-right">Decisão & Controlo</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-market-border">
                {paginatedUsers.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-10 text-center text-market-text-muted">
                      Sem registos para o filtro KYC selecionado.
                    </td>
                  </tr>
                ) : (
                  paginatedUsers.map((u) => {
                    const isBlocked = u.status === 'blocked';
                    const isMasterTarget = isMasterEmail(u.email);
                    return (
                      <tr key={u.id} className="hover:bg-market-card-lighter/40">
                        <td className="px-4 py-3">
                          <div className="font-semibold text-white">{u.name || 'Sem nome'}</div>
                          <div className="text-[10px] font-mono text-market-text-muted">{u.id.slice(0, 14)}</div>
                        </td>
                        <td className="px-4 py-3">
                          <div className="font-mono text-market-text-muted">{u.email || '—'}</div>
                          {u.wallet_address && (
                            <div className="text-[10px] font-mono text-cyan-400 mt-0.5">{u.wallet_address}</div>
                          )}
                        </td>
                        <td className="px-4 py-3 text-center">
                          <span
                            className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
                              isBlocked
                                ? 'bg-market-red/15 text-market-red'
                                : u.status === 'pending_verification'
                                  ? 'bg-amber-500/15 text-amber-400'
                                  : 'bg-market-green/15 text-market-green'
                            }`}
                          >
                            {isBlocked ? 'Bloqueado' : u.status === 'pending_verification' ? 'Aguardando KYC' : 'Ativo'}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-center">{renderKycBadge(u)}</td>
                        <td className="px-4 py-3 text-right font-mono text-[11px] text-market-text-muted">
                          {u.created_at ? new Date(u.created_at).toLocaleDateString('pt-PT') : '—'}
                        </td>
                        <td className="px-4 py-3 text-right">
                          <div className="inline-flex items-center gap-1.5 flex-wrap justify-end">
                            <button
                              type="button"
                              onClick={() => openUserDrawer(u)}
                              className="p-1.5 rounded bg-market-bg border border-market-border text-market-text-muted hover:text-white"
                              title="Ver detalhes completos da verificação"
                            >
                              <Eye className="w-3.5 h-3.5" />
                            </button>
                            <button
                              type="button"
                              disabled={busyId === u.id}
                              onClick={() => handleKycDecision(u.id, 'verified')}
                              className="px-2.5 py-1 rounded bg-market-green/15 text-market-green hover:bg-market-green hover:text-black text-[11px] font-bold"
                            >
                              Aprovar KYC
                            </button>
                            <button
                              type="button"
                              disabled={busyId === u.id}
                              onClick={() => handleKycDecision(u.id, 'rejected')}
                              className="px-2.5 py-1 rounded bg-market-red/15 text-market-red hover:bg-market-red hover:text-white text-[11px] font-bold"
                            >
                              Rejeitar
                            </button>
                            <button
                              type="button"
                              disabled={busyId === u.id}
                              onClick={() => handleKycDecision(u.id, 'pending')}
                              className="p-1.5 rounded bg-market-bg border border-market-border text-amber-400 hover:bg-amber-500/10"
                              title="Marcar como Pendente"
                            >
                              <RotateCcw className="w-3.5 h-3.5" />
                            </button>
                            {!isMasterTarget && (
                              <button
                                type="button"
                                disabled={busyId === u.id}
                                onClick={() => handleToggleBlockUser(u)}
                                className={`p-1.5 rounded border ${
                                  isBlocked
                                    ? 'border-market-green/30 text-market-green hover:bg-market-green/10'
                                    : 'border-amber-500/30 text-amber-400 hover:bg-amber-500/10'
                                }`}
                                title={isBlocked ? 'Desbloquear conta' : 'Bloquear conta'}
                              >
                                {isBlocked ? <CheckCircle className="w-3.5 h-3.5" /> : <Ban className="w-3.5 h-3.5" />}
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Pagination Footer */}
      <div className="flex items-center justify-between text-xs font-mono text-market-text-muted">
        <span>
          Página {page} ·{' '}
          {mode === 'deposits' || mode === 'withdrawals'
            ? `${filteredFinanceRequests.length} pedidos`
            : `${filteredUsers.length} utilizadores`}
        </span>
        <div className="flex gap-2">
          <button
            type="button"
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            className="px-3 py-1 rounded border border-market-border disabled:opacity-40"
          >
            Anterior
          </button>
          <button
            type="button"
            disabled={
              mode === 'deposits' || mode === 'withdrawals'
                ? page * pageSize >= filteredFinanceRequests.length
                : page * pageSize >= filteredUsers.length
            }
            onClick={() => setPage((p) => p + 1)}
            className="px-3 py-1 rounded border border-market-border disabled:opacity-40"
          >
            Seguinte
          </button>
        </div>
      </div>

      {/* USER INSPECTION MODAL / DRAWER */}
      {inspectUser && (
        <div className="fixed inset-0 z-[120] bg-black/75 flex items-center justify-end">
          <div className="w-full max-w-2xl h-full bg-[#0d1117] border-l border-market-border p-6 overflow-y-auto space-y-5">
            {/* Drawer Header */}
            <div className="flex items-start justify-between border-b border-market-border pb-4 gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <UserCheck className="w-4 h-4 text-market-green shrink-0" />
                  <h3 className="text-base font-bold text-white truncate">{inspectUser.name || 'Utilizador'}</h3>
                  <span
                    className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
                      inspectUser.status === 'blocked'
                        ? 'bg-market-red/15 text-market-red'
                        : inspectUser.status === 'pending_verification'
                          ? 'bg-amber-500/15 text-amber-400'
                          : 'bg-market-green/15 text-market-green'
                    }`}
                  >
                    {inspectUser.status === 'blocked'
                      ? 'Bloqueado'
                      : inspectUser.status === 'pending_verification'
                        ? 'Em Verificação'
                        : 'Ativo'}
                  </span>
                  {renderKycBadge(inspectUser)}
                  {inspectUser.is_admin && (
                    <span
                      className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
                        isMasterEmail(inspectUser.email)
                          ? 'bg-amber-500/20 text-amber-300'
                          : 'bg-blue-500/15 text-blue-300'
                      }`}
                    >
                      {isMasterEmail(inspectUser.email) ? 'MASTER ADMIN' : 'ADMIN'}
                    </span>
                  )}
                </div>
                <p className="text-xs font-mono text-market-text-muted mt-1">{inspectUser.email || 'Sem email'}</p>
                <p className="text-[11px] font-mono text-market-text-muted/80">UID: {inspectUser.id}</p>
              </div>
              <button
                type="button"
                onClick={() => setInspectUser(null)}
                className="p-1.5 rounded-lg hover:bg-market-card text-market-text-muted hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Wallet & Stats Summary */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {(() => {
                const sql = inspectDetails?.clobAccount || sqlAccountMap.get(inspectUser.id);
                const avail = sql ? sql.available_cents / 100 : Number(inspectUser.balance || 0);
                const resv = sql ? sql.reserved_cents / 100 : 0;
                const execsCount = inspectDetails?.clobStats?.executionsCount ?? (userTradeStats.get(inspectUser.id)?.count || 0);
                const execVol = inspectDetails?.clobStats?.executedVolumeKz ?? (userTradeStats.get(inspectUser.id)?.volume || 0);
                return (
                  <>
                    <div className="market-card p-3">
                      <span className="text-[10px] uppercase text-market-text-muted block">CLOB Disponível</span>
                      <span className="text-sm font-mono font-bold text-market-green">{avail.toLocaleString('pt-PT')} Kz</span>
                    </div>
                    <div className="market-card p-3">
                      <span className="text-[10px] uppercase text-market-text-muted block">CLOB Reservado</span>
                      <span className="text-sm font-mono font-bold text-amber-400">{resv.toLocaleString('pt-PT')} Kz</span>
                    </div>
                    <div className="market-card p-3">
                      <span className="text-[10px] uppercase text-market-text-muted block">Supabase</span>
                      <span className="text-sm font-mono font-bold text-white">
                        {Number(inspectUser.balance || 0).toLocaleString('pt-PT')} Kz
                      </span>
                    </div>
                    <div className="market-card p-3">
                      <span className="text-[10px] uppercase text-market-text-muted block">Negócios</span>
                      <span className="text-sm font-mono font-bold text-cyan-400">
                        {execsCount} ({execVol.toLocaleString('pt-PT')} Kz)
                      </span>
                    </div>
                  </>
                );
              })()}
            </div>

            {/* Identity & Verification Details Card */}
            <div className="market-card p-4 space-y-3">
              <div className="flex items-center justify-between">
                <h4 className="text-xs font-bold uppercase tracking-wider text-white flex items-center gap-1.5">
                  <Shield className="w-3.5 h-3.5 text-cyan-400" />
                  Detalhes da Conta & Verificação
                </h4>
                {loadingDetails && (
                  <span className="inline-flex items-center gap-1 text-[11px] text-market-text-muted">
                    <Loader2 className="w-3 h-3 animate-spin" /> A carregar Auth...
                  </span>
                )}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                <div className="bg-market-bg border border-market-border rounded-lg p-2.5">
                  <span className="text-[10px] uppercase text-market-text-muted block">Email Confirmado (Auth)</span>
                  <span className="font-mono text-white flex items-center gap-1.5 mt-0.5">
                    <MailCheck className={`w-3.5 h-3.5 ${inspectDetails?.authMeta?.emailConfirmedAt || inspectUser.is_verified ? 'text-market-green' : 'text-amber-400'}`} />
                    {inspectDetails?.authMeta?.emailConfirmedAt
                      ? `Confirmado em ${new Date(inspectDetails.authMeta.emailConfirmedAt).toLocaleDateString('pt-PT')}`
                      : inspectUser.is_verified
                        ? 'Verificado'
                        : 'Não confirmado'}
                  </span>
                </div>
                <div className="bg-market-bg border border-market-border rounded-lg p-2.5">
                  <span className="text-[10px] uppercase text-market-text-muted block">Método de Login & Último Acesso</span>
                  <span className="font-mono text-white flex items-center gap-1.5 mt-0.5">
                    <Clock className="w-3.5 h-3.5 text-blue-400" />
                    {inspectDetails?.authMeta?.providers?.length
                      ? inspectDetails.authMeta.providers.join(', ').toUpperCase()
                      : 'EMAIL'}{' '}
                    ·{' '}
                    {inspectDetails?.authMeta?.lastSignInAt
                      ? new Date(inspectDetails.authMeta.lastSignInAt).toLocaleString('pt-PT')
                      : 'Sem registo recente'}
                  </span>
                </div>
                <div className="bg-market-bg border border-market-border rounded-lg p-2.5">
                  <span className="text-[10px] uppercase text-market-text-muted block">Carteira / IBAN / Contacto</span>
                  <span className="font-mono text-white mt-0.5 block break-all">
                    {inspectUser.wallet_address || 'Não definido'}
                  </span>
                </div>
                <div className="bg-market-bg border border-market-border rounded-lg p-2.5">
                  <span className="text-[10px] uppercase text-market-text-muted block">Registo / Atualização</span>
                  <span className="font-mono text-white mt-0.5 block">
                    {inspectUser.created_at ? new Date(inspectUser.created_at).toLocaleDateString('pt-PT') : '—'}
                    {inspectUser.updated_at ? ` · Atualizado ${new Date(inspectUser.updated_at).toLocaleDateString('pt-PT')}` : ''}
                  </span>
                </div>
              </div>
            </div>

            {/* Sub-tabs inside Drawer */}
            <div className="flex items-center gap-1.5 border-b border-market-border pb-2">
              {[
                { id: 'overview', label: 'Posições & Ordens CLOB' },
                { id: 'finance', label: 'Depósitos, Saques & Ledger' },
                { id: 'audit', label: 'Auditoria de Segurança' },
              ].map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setDrawerTab(t.id as any)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                    drawerTab === t.id
                      ? 'bg-market-green/15 text-market-green'
                      : 'text-market-text-muted hover:text-white'
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>

            {drawerTab === 'overview' && (
              <div className="space-y-4">
                <div className="space-y-2">
                  <h4 className="text-xs font-bold uppercase tracking-wider text-market-text-muted">Posições Ativas CLOB</h4>
                  <div className="market-card divide-y divide-market-border">
                    {((inspectDetails?.clobPositions || userPositionsMap.get(inspectUser.id) || []) as any[]).length === 0 ? (
                      <p className="p-4 text-xs text-market-text-muted">Sem posições CLOB abertas.</p>
                    ) : (
                      ((inspectDetails?.clobPositions || userPositionsMap.get(inspectUser.id) || []) as any[]).map((p: any, i: number) => (
                        <div key={i} className="p-3 flex items-center justify-between text-xs font-mono">
                          <div className="min-w-0 pr-3">
                            <span className="text-white font-semibold block truncate">{p.market_question || p.market_id}</span>
                            <span className={p.outcome === 'Yes' ? 'text-market-green' : 'text-market-red'}>{p.outcome}</span>
                          </div>
                          <div className="text-right shrink-0">
                            <span className="text-white block">{p.available_shares + p.reserved_shares} quotas</span>
                            <span className="text-market-text-muted text-[10px]">Média: {p.avg_price_cents}¢</span>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>

                <div className="space-y-2">
                  <h4 className="text-xs font-bold uppercase tracking-wider text-market-text-muted">
                    Ordens CLOB Recentes ({(inspectDetails?.clobOrders || []).length})
                  </h4>
                  <div className="market-card max-h-56 overflow-y-auto divide-y divide-market-border">
                    {loadingDetails ? (
                      <div className="p-5 text-center text-xs text-market-text-muted">A carregar ordens...</div>
                    ) : (inspectDetails?.clobOrders || []).length === 0 ? (
                      <p className="p-4 text-xs text-market-text-muted">Sem ordens registadas no livro CLOB.</p>
                    ) : (
                      (inspectDetails?.clobOrders || []).map((o: any) => (
                        <div key={o.id} className="p-3 flex items-center justify-between text-xs font-mono gap-2">
                          <div className="min-w-0">
                            <span className="text-white font-semibold block truncate">{o.market_question || o.market_id}</span>
                            <span className="text-[10px] text-market-text-muted">
                              {o.side} {o.outcome} @ {o.price_cents}¢ · {o.filled_quantity}/{o.quantity} quotas
                            </span>
                          </div>
                          <span
                            className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase shrink-0 ${
                              o.status === 'FILLED'
                                ? 'bg-market-green/15 text-market-green'
                                : o.status === 'OPEN' || o.status === 'PARTIAL'
                                  ? 'bg-blue-500/15 text-blue-300'
                                  : 'bg-market-bg text-market-text-muted'
                            }`}
                          >
                            {o.status}
                          </span>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>
            )}

            {drawerTab === 'finance' && (
              <div className="space-y-4">
                <div className="space-y-2">
                  <h4 className="text-xs font-bold uppercase tracking-wider text-market-text-muted">
                    Solicitações Financeiras ({(inspectDetails?.financeRequests || []).length})
                  </h4>
                  <div className="market-card max-h-48 overflow-y-auto divide-y divide-market-border">
                    {loadingDetails ? (
                      <div className="p-5 text-center text-xs text-market-text-muted">A carregar pedidos...</div>
                    ) : (inspectDetails?.financeRequests || []).length === 0 ? (
                      <p className="p-4 text-xs text-market-text-muted">Sem depósitos ou levantamentos registados.</p>
                    ) : (
                      (inspectDetails?.financeRequests || []).map((r: any) => (
                        <div key={r.id} className="p-3 flex items-center justify-between text-xs">
                          <div>
                            <span className="font-bold text-white uppercase">{r.type === 'deposit' ? 'Depósito' : 'Levantamento'} · {r.method || 'iban'}</span>
                            <span className="block text-[10px] font-mono text-market-text-muted">
                              {r.created_at ? new Date(r.created_at).toLocaleString('pt-PT') : '—'}
                            </span>
                          </div>
                          <div className="text-right font-mono">
                            <span className="font-bold text-white block">{Number(r.amount || 0).toLocaleString('pt-PT')} Kz</span>
                            <span
                              className={`text-[10px] uppercase font-bold ${
                                r.status === 'approved' ? 'text-market-green' : r.status === 'rejected' ? 'text-market-red' : 'text-amber-400'
                              }`}
                            >
                              {r.status}
                            </span>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>

                <div className="space-y-2">
                  <h4 className="text-xs font-bold uppercase tracking-wider text-market-text-muted">
                    Livro Razão (Ledger) ({(inspectDetails?.ledger || []).length})
                  </h4>
                  <div className="market-card max-h-56 overflow-y-auto divide-y divide-market-border">
                    {loadingDetails ? (
                      <div className="p-5 text-center text-xs text-market-text-muted">A carregar movimentos...</div>
                    ) : (inspectDetails?.ledger || []).length === 0 ? (
                      <p className="p-4 text-xs text-market-text-muted">Sem lançamentos no ledger do utilizador.</p>
                    ) : (
                      (inspectDetails?.ledger || []).map((l: any) => (
                        <div key={l.id} className="p-3 flex items-center justify-between text-xs">
                          <div>
                            <span className="font-bold text-white block">{l.type}</span>
                            <span className="text-[10px] font-mono text-market-text-muted">
                              {l.createdAt ? new Date(l.createdAt).toLocaleString('pt-PT') : '—'} · Ref: {String(l.reference || '').slice(0, 12)}
                            </span>
                          </div>
                          <div className="text-right font-mono">
                            <span className={Number(l.amount || 0) >= 0 ? 'text-market-green font-bold' : 'text-market-red font-bold'}>
                              {Number(l.amount || 0) >= 0 ? '+' : ''}
                              {Number(l.amount || 0).toLocaleString('pt-PT')} Kz
                            </span>
                            <span className="block text-[10px] text-market-text-muted">
                              Após: {Number(l.balanceAfter || 0).toLocaleString('pt-PT')} Kz
                            </span>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>
            )}

            {drawerTab === 'audit' && (
              <div className="space-y-2">
                <h4 className="text-xs font-bold uppercase tracking-wider text-market-text-muted">
                  Trilha de Auditoria e Segurança
                </h4>
                <div className="market-card max-h-72 overflow-y-auto divide-y divide-market-border">
                  {loadingDetails ? (
                    <div className="p-5 text-center text-xs text-market-text-muted">A carregar auditoria...</div>
                  ) : (inspectDetails?.securityAudits || []).length === 0 ? (
                    <p className="p-4 text-xs text-market-text-muted">Sem eventos de auditoria registados para esta conta.</p>
                  ) : (
                    (inspectDetails?.securityAudits || []).map((a: any) => (
                      <div key={a.id} className="p-3 space-y-1 text-xs">
                        <div className="flex items-center justify-between font-mono text-[10px]">
                          <span className="text-market-green font-bold">{a.action}</span>
                          <span className="text-market-text-muted">{new Date(a.created_at).toLocaleString('pt-PT')}</span>
                        </div>
                        <p className="text-white">{a.justification}</p>
                        <p className="text-[10px] font-mono text-market-text-muted">Por: {a.actor_email || a.actor_id}</p>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}

            {/* Drawer Actions Footer */}
            <div className="pt-3 border-t border-market-border flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => openEditUserModal(inspectUser)}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-blue-500/15 text-blue-300 border border-blue-500/30 text-xs font-bold hover:bg-blue-500/25"
              >
                <Edit2 className="w-3.5 h-3.5" />
                Editar Dados
              </button>
              <button
                type="button"
                disabled={busyId === inspectUser.id}
                onClick={() => handleKycDecision(inspectUser.id, 'verified')}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-market-green/15 text-market-green border border-market-green/30 text-xs font-bold hover:bg-market-green/25"
              >
                <ShieldCheck className="w-3.5 h-3.5" />
                Aprovar KYC
              </button>
              <button
                type="button"
                disabled={busyId === inspectUser.id}
                onClick={() => handleKycDecision(inspectUser.id, 'rejected')}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-market-bg text-market-text-muted border border-market-border text-xs font-bold hover:text-white"
              >
                Rejeitar KYC
              </button>
              {!isMasterEmail(inspectUser.email) && (
                <button
                  type="button"
                  disabled={busyId === inspectUser.id}
                  onClick={() => handleToggleBlockUser(inspectUser)}
                  className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border text-xs font-bold ${
                    inspectUser.status === 'blocked'
                      ? 'bg-market-green/15 text-market-green border-market-green/30'
                      : 'bg-amber-500/15 text-amber-300 border-amber-500/30'
                  }`}
                >
                  <Ban className="w-3.5 h-3.5" />
                  {inspectUser.status === 'blocked' ? 'Desbloquear Conta' : 'Bloquear Conta'}
                </button>
              )}
              {isMaster && (
                <button
                  type="button"
                  onClick={() => {
                    setEditingBalanceUser(inspectUser);
                    setNewBalanceKz(String(inspectUser.balance || 0));
                  }}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-amber-500/15 text-amber-300 border border-amber-500/30 text-xs font-bold"
                >
                  <KeyRound className="w-3.5 h-3.5" />
                  Ajustar Saldo
                </button>
              )}
              {!isMasterEmail(inspectUser.email) && (!inspectUser.is_admin || isMaster) && (
                <button
                  type="button"
                  onClick={() => {
                    setDeletingUser(inspectUser);
                    setDeleteReason('');
                  }}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-market-red/15 text-market-red border border-market-red/30 text-xs font-bold hover:bg-market-red/25 ml-auto"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  Apagar Conta
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* EDIT USER MODAL */}
      {editingUser && (
        <div className="fixed inset-0 z-[130] bg-black/80 flex items-center justify-center p-4">
          <form onSubmit={handleSaveEditUser} className="w-full max-w-lg market-card p-6 space-y-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between border-b border-market-border pb-3">
              <h3 className="text-sm font-bold text-white flex items-center gap-2">
                <Edit2 className="w-4 h-4 text-blue-400" />
                Editar Utilizador
              </h3>
              <button type="button" onClick={() => setEditingUser(null)} className="text-market-text-muted hover:text-white">
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-[11px] font-bold uppercase text-market-text-muted mb-1">Nome Completo</label>
                <input
                  type="text"
                  required
                  minLength={2}
                  value={editForm.name}
                  onChange={(e) => setEditForm((f) => ({ ...f, name: e.target.value }))}
                  className="market-input text-xs"
                />
              </div>
              <div>
                <label className="block text-[11px] font-bold uppercase text-market-text-muted mb-1">Email</label>
                <input
                  type="email"
                  required
                  value={editForm.email}
                  onChange={(e) => setEditForm((f) => ({ ...f, email: e.target.value }))}
                  className="market-input text-xs font-mono"
                />
              </div>
            </div>

            <div>
              <label className="block text-[11px] font-bold uppercase text-market-text-muted mb-1">
                Carteira / IBAN / Telefone
              </label>
              <input
                type="text"
                value={editForm.wallet_address}
                onChange={(e) => setEditForm((f) => ({ ...f, wallet_address: e.target.value }))}
                placeholder="Ex: AO06 0040... ou +244..."
                className="market-input text-xs font-mono"
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-[11px] font-bold uppercase text-market-text-muted mb-1">Estado da Conta</label>
                <select
                  value={editForm.status}
                  onChange={(e) => setEditForm((f) => ({ ...f, status: e.target.value as any }))}
                  className="market-input text-xs"
                >
                  <option value="active">Ativo</option>
                  <option value="blocked">Bloqueado (Suspenso)</option>
                  <option value="pending_verification">Aguardando Verificação</option>
                </select>
              </div>
              <div>
                <label className="block text-[11px] font-bold uppercase text-market-text-muted mb-1">Verificação KYC</label>
                <select
                  value={editForm.verification_status}
                  onChange={(e) => setEditForm((f) => ({ ...f, verification_status: e.target.value as any }))}
                  className="market-input text-xs"
                >
                  <option value="none">Não Submetido</option>
                  <option value="pending">Pendente</option>
                  <option value="verified">Verificado</option>
                  <option value="rejected">Rejeitado</option>
                </select>
              </div>
            </div>

            {isMaster && !isMasterEmail(editingUser.email) && (
              <label className="flex items-center gap-2.5 p-3 rounded-lg bg-market-bg border border-market-border cursor-pointer">
                <input
                  type="checkbox"
                  checked={editForm.is_admin}
                  onChange={(e) => setEditForm((f) => ({ ...f, is_admin: e.target.checked }))}
                  className="rounded border-market-border"
                />
                <span className="text-xs text-white font-semibold">
                  Conceder privilégios de Admin Operacional
                </span>
              </label>
            )}

            <div>
              <label className="block text-[11px] font-bold uppercase text-market-text-muted mb-1">
                Nota de Auditoria (Opcional)
              </label>
              <input
                type="text"
                value={editForm.justification}
                onChange={(e) => setEditForm((f) => ({ ...f, justification: e.target.value }))}
                placeholder="Motivo da alteração..."
                className="market-input text-xs"
              />
            </div>

            <div className="flex gap-2 pt-2">
              <button type="button" onClick={() => setEditingUser(null)} className="market-button-outline flex-1 text-xs">
                Cancelar
              </button>
              <button type="submit" disabled={busyId === editingUser.id} className="market-button-primary flex-1 text-xs">
                {busyId === editingUser.id ? 'A guardar...' : 'Guardar Alterações'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* DELETE USER CONFIRMATION MODAL */}
      {deletingUser && (
        <div className="fixed inset-0 z-[135] bg-black/80 flex items-center justify-center p-4">
          <form onSubmit={handleConfirmDeleteUser} className="w-full max-w-md market-card border-market-red/40 p-6 space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2.5 text-market-red">
                <AlertTriangle className="w-5 h-5 shrink-0" />
                <h3 className="text-sm font-bold">Apagar Conta de Utilizador</h3>
              </div>
              <button type="button" onClick={() => setDeletingUser(null)} className="text-market-text-muted hover:text-white">
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-3 rounded-lg bg-market-red/10 border border-market-red/30 text-xs text-white space-y-1">
              <p>
                Tem a certeza que pretende apagar permanentemente <strong>{deletingUser.name || 'Utilizador'}</strong>?
              </p>
              <p className="font-mono text-[11px] text-market-text-muted">{deletingUser.email}</p>
              <p className="text-[11px] text-market-text-muted pt-1">
                Esta ação cancela ordens CLOB abertas, remove posições/histórico no Supabase e apaga a conta de autenticação.
              </p>
            </div>

            <div>
              <label className="block text-[11px] font-bold uppercase text-market-text-muted mb-1">
                Motivo da Remoção (Auditoria)
              </label>
              <input
                type="text"
                value={deleteReason}
                onChange={(e) => setDeleteReason(e.target.value)}
                placeholder="Ex: Conta duplicada ou pedido de encerramento"
                className="market-input text-xs"
              />
            </div>

            <div className="flex gap-2">
              <button type="button" onClick={() => setDeletingUser(null)} className="market-button-outline flex-1 text-xs">
                Cancelar
              </button>
              <button
                type="submit"
                disabled={busyId === deletingUser.id}
                className="flex-1 px-4 py-2 rounded-lg bg-market-red hover:bg-red-600 text-white text-xs font-bold disabled:opacity-50"
              >
                {busyId === deletingUser.id ? 'A apagar...' : 'Apagar Definitivamente'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* MASTER ADMIN MANUAL BALANCE MODAL */}
      {editingBalanceUser && isMaster && (
        <div className="fixed inset-0 z-[130] bg-black/80 flex items-center justify-center p-4">
          <form onSubmit={handleManualBalanceSubmit} className="w-full max-w-md market-card p-6 space-y-4">
            <div className="flex items-center justify-between border-b border-market-border pb-3">
              <h3 className="text-sm font-bold text-white flex items-center gap-2">
                <KeyRound className="w-4 h-4 text-amber-400" />
                Ajuste Manual Auditado (Master Admin)
              </h3>
              <button type="button" onClick={() => setEditingBalanceUser(null)} className="text-market-text-muted hover:text-white">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="text-xs text-market-text-muted">
              Conta: <strong className="text-white">{editingBalanceUser.name}</strong> ({editingBalanceUser.email})
            </div>
            <div>
              <label className="block text-[11px] font-bold uppercase text-market-text-muted mb-1">Novo Saldo (Kz)</label>
              <input
                type="number"
                step="0.01"
                min="0"
                required
                value={newBalanceKz}
                onChange={(e) => setNewBalanceKz(e.target.value)}
                className="market-input font-mono text-sm"
              />
            </div>
            <div>
              <label className="block text-[11px] font-bold uppercase text-market-text-muted mb-1">
                Justificação Obrigatória (Auditoria)
              </label>
              <textarea
                required
                minLength={5}
                rows={3}
                value={balanceReason}
                onChange={(e) => setBalanceReason(e.target.value)}
                placeholder="Descreva o motivo contabilístico deste ajuste..."
                className="market-input text-xs"
              />
            </div>
            <div className="flex gap-2">
              <button type="button" onClick={() => setEditingBalanceUser(null)} className="market-button-outline flex-1 text-xs">
                Cancelar
              </button>
              <button type="submit" disabled={busyId === editingBalanceUser.id} className="market-button-primary flex-1 text-xs">
                {busyId === editingBalanceUser.id ? 'A aplicar...' : 'Confirmar Ajuste'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* RECEIPT PROOF PREVIEW MODAL */}
      {proofPreviewUrl && (
        <div className="fixed inset-0 z-[130] bg-black/80 flex items-center justify-center p-4">
          <div className="max-w-lg w-full market-card p-4 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-white">Comprovativo Submetido pelo Utilizador</span>
              <button type="button" onClick={() => setProofPreviewUrl(null)} className="text-market-text-muted hover:text-white">
                <X className="w-4 h-4" />
              </button>
            </div>
            <img src={proofPreviewUrl} alt="Comprovativo financeiro" className="w-full max-h-[65vh] object-contain rounded-lg bg-black" />
          </div>
        </div>
      )}
    </div>
  );
};
