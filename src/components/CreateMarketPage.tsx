import React, { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Check, Loader2, Plus, Trash2, Scale, Layers, Upload } from 'lucide-react';
import { supabaseService as firebaseService } from '../lib/supabase-service';
import { uploadMarketImage, validateMarketImageFile } from '../lib/storage-upload';
import { sanitizeHttpUrl, sanitizePlainText } from '../lib/sanitize';
import { CreateMarketModal } from './market/CreateMarketModal';
import { Market, Category, User } from '../types';

interface CreateMarketPageProps {
  user: User | null;
  categories: Category[];
  markets: Market[];
  addToast: (msg: string, type?: 'success' | 'error' | 'info') => void;
  onRefreshData: () => void;
  onBalanceUpdate?: (newBalanceKz: number) => void;
  setActiveTab: (tab: string) => void;
}

interface DraftOutcome {
  id: string;
  name: string;
  pct: string;
  image_url: string;
}

const PRESET_THEMES = [
  { name: 'Finanças & Mercados', url: '' },
  { name: 'Angola & Economia', url: '' },
  { name: 'Desporto', url: '' },
  { name: 'Tecnologia & Crypto', url: '' },
];

export const CreateMarketPage: React.FC<CreateMarketPageProps> = ({
  user,
  categories,
  markets,
  addToast,
  onRefreshData,
  onBalanceUpdate,
}) => {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [marketType, setMarketType] = useState<'binary' | 'multi'>('binary');
  const [question, setQuestion] = useState('');
  const [description, setDescription] = useState('');
  const [additionalContext, setAdditionalContext] = useState('');
  const [resolverName, setResolverName] = useState('MarketPay Oracle');
  const [category, setCategory] = useState(categories[0]?.name || 'Finanças');
  const [customImage, setCustomImage] = useState('');
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [showQuickModal, setShowQuickModal] = useState(false);
  const [endDate, setEndDate] = useState(
    new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 16)
  );
  const [outcomes, setOutcomes] = useState<DraftOutcome[]>([
    { id: '1', name: '', pct: '50', image_url: '' },
    { id: '2', name: '', pct: '50', image_url: '' },
  ]);

  useEffect(() => {
    return () => {
      if (imagePreview) URL.revokeObjectURL(imagePreview);
    };
  }, [imagePreview]);

  useEffect(() => {
    if (categories && categories.length > 0) {
      if (!category || !categories.some((c) => c.name === category)) {
        setCategory(categories[0].name);
      }
    }
  }, [categories, category]);

  const userMarkets = markets.filter((m) => m.creator_id === user?.id);

  const distributeEqually = () => {
    const n = outcomes.length;
    if (n <= 0) return;
    const base = Math.floor(100 / n);
    const remainder = 100 - base * n;
    setOutcomes((prev) =>
      prev.map((o, idx) => ({
        ...o,
        pct: String(idx === 0 ? base + remainder : base),
      }))
    );
  };

  const handleAddOutcome = () => {
    if (outcomes.length >= 12) {
      addToast('Máximo de 12 opções permitidas por mercado.', 'error');
      return;
    }
    const nextId = String(outcomes.length + 1);
    setOutcomes((prev) => [...prev, { id: nextId, name: '', pct: '10', image_url: '' }]);
  };

  const handleRemoveOutcome = (idx: number) => {
    if (outcomes.length <= 2) {
      addToast('Um mercado multi-opção precisa de pelo menos 2 opções.', 'error');
      return;
    }
    setOutcomes((prev) => prev.filter((_, i) => i !== idx));
  };

  const handleImageFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const validationErr = validateMarketImageFile(file);
    if (validationErr) {
      addToast(validationErr, 'error');
      e.target.value = '';
      return;
    }
    if (imagePreview) URL.revokeObjectURL(imagePreview);
    setImageFile(file);
    setImagePreview(URL.createObjectURL(file));
  };

  const handleClearImageFile = () => {
    if (imagePreview) URL.revokeObjectURL(imagePreview);
    setImageFile(null);
    setImagePreview(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) {
      addToast('Faça login para criar um mercado.', 'error');
      return;
    }

    if (user.balance < 2000) {
      addToast(
        `Saldo insuficiente. São necessários 2.000,00 KZ para o cofre de liquidez inicial (20 pares Sim/Não). Saldo atual: ${user.balance.toFixed(2)} KZ.`,
        'error'
      );
      return;
    }

    const cleanQuestion = sanitizePlainText(question, 140);
    if (cleanQuestion.length < 5) {
      addToast('Insira uma pergunta válida com pelo menos 5 caracteres.', 'error');
      return;
    }

    const trimmedCustomImage = customImage.trim();
    const safeCustomImage = trimmedCustomImage ? sanitizeHttpUrl(trimmedCustomImage) : '';
    if (trimmedCustomImage && !safeCustomImage) {
      addToast('O URL da imagem de capa deve começar por http:// ou https://.', 'error');
      return;
    }

    let formattedOutcomes: any[] | undefined;
    if (marketType === 'multi') {
      const cleaned = outcomes
        .map((o, idx) => {
          const cleanOptImg = o.image_url.trim() ? sanitizeHttpUrl(o.image_url) : null;
          return {
            id: String(idx + 1),
            name: sanitizePlainText(o.name, 80),
            rawPct: Math.max(1, Number(o.pct) || 1),
            image_url: cleanOptImg || undefined,
          };
        })
        .filter((o) => o.name.length > 0);

      if (cleaned.length < 2) {
        addToast('Preencha pelo menos 2 opções válidas para o mercado multi-opção.', 'error');
        return;
      }

      const uniqueNames = new Set(cleaned.map((o) => o.name.toLowerCase()));
      if (uniqueNames.size !== cleaned.length) {
        addToast('Os nomes das opções não podem ser repetidos.', 'error');
        return;
      }

      const sumPct = cleaned.reduce((acc, o) => acc + o.rawPct, 0) || 100;
      const totalInitialPool = 1000;
      formattedOutcomes = cleaned.map((o) => {
        const normalizedProb = Math.max(0.01, Math.min(0.99, Number((o.rawPct / sumPct).toFixed(4))));
        return {
          id: o.id,
          name: o.name,
          price: normalizedProb,
          pool: Math.round(totalInitialPool * normalizedProb),
          image_url: o.image_url,
          change_24h: 0,
        };
      });
    }

    setLoading(true);
    try {
      let resolvedImageUrl = safeCustomImage || '';
      if (imageFile) {
        resolvedImageUrl = await uploadMarketImage(imageFile);
      }

      const marketPayload = {
        question: cleanQuestion,
        category: sanitizePlainText(category, 40) || 'Finanças',
        description:
          sanitizePlainText(description, 2000) ||
          `Este mercado resolve com base no resultado oficial para: ${cleanQuestion}.`,
        additional_context: sanitizePlainText(additionalContext, 2000) || undefined,
        resolver_name: sanitizePlainText(resolverName, 80) || 'MarketPay Oracle',
        image_url: resolvedImageUrl,
        tags: [sanitizePlainText(category, 40) || 'Finanças', marketType === 'multi' ? 'Multi-Opção' : 'Comunidade'],
        end_date: new Date(endDate).toISOString(),
        is_multi: marketType === 'multi',
        outcomes: formattedOutcomes,
        b: 2000,
        status: 'active',
      };

      const createdId = await firebaseService.createUserMarket(user.id, marketPayload);
      onBalanceUpdate?.(Math.max(0, Number((user.balance - 2000).toFixed(4))));
      addToast('Mercado criado! 2.000,00 KZ alocados ao Cofre de Liquidez (20 pares LP).', 'success');
      setQuestion('');
      setDescription('');
      setAdditionalContext('');
      setCustomImage('');
      handleClearImageFile();
      setOutcomes([
        { id: '1', name: '', pct: '50', image_url: '' },
        { id: '2', name: '', pct: '50', image_url: '' },
      ]);
      await Promise.resolve(onRefreshData());
      if (createdId) {
        navigate(`/market/${createdId}`);
      }
    } catch (error: any) {
      addToast(error.message || 'Erro ao criar o mercado.', 'error');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="max-w-5xl mx-auto px-4 md:px-6 py-8 space-y-6 text-white">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 border-b border-market-border pb-5">
        <div>
          <h1 className="text-2xl font-bold text-white tracking-tight">Criar mercado</h1>
          <p className="text-sm text-market-text-muted mt-1">
            Lance um mercado binário (Sim / Não) ou multi-opção. Depósito inicial: 2.000,00 KZ no Cofre de Liquidez AMM (20 pares Sim/Não a 50%).
          </p>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <div className="text-sm font-mono tabular-nums text-market-text-muted">
            Saldo: <span className="text-white font-semibold">{user ? `${user.balance.toLocaleString('pt-AO')} KZ` : '—'}</span>
          </div>
          <button
            type="button"
            onClick={() => setShowQuickModal(true)}
            className="px-3 py-1.5 rounded-lg bg-[#1b222c] border border-[#28313e] hover:border-[#3dd68c] text-xs font-semibold text-white transition-colors"
          >
            Modal Rápido
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        <form onSubmit={handleSubmit} className="lg:col-span-7 market-card p-6 space-y-5">
          {/* Market Type Selector */}
          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-market-text-muted block">Formato do mercado</label>
            <div className="grid grid-cols-2 gap-2.5">
              <button
                type="button"
                onClick={() => setMarketType('binary')}
                className={`flex items-center justify-center gap-2 py-2.5 px-3 rounded-lg border text-xs font-semibold transition-colors ${
                  marketType === 'binary'
                    ? 'bg-[#28313e] border-[#3d7eff] text-white'
                    : 'bg-market-bg border-market-border text-market-text-muted hover:text-white'
                }`}
              >
                <Scale className="w-3.5 h-3.5" />
                Binário (Sim / Não)
              </button>
              <button
                type="button"
                onClick={() => setMarketType('multi')}
                className={`flex items-center justify-center gap-2 py-2.5 px-3 rounded-lg border text-xs font-semibold transition-colors ${
                  marketType === 'multi'
                    ? 'bg-[#28313e] border-[#3d7eff] text-white'
                    : 'bg-market-bg border-market-border text-market-text-muted hover:text-white'
                }`}
              >
                <Layers className="w-3.5 h-3.5" />
                Multi-Opção (Vários)
              </button>
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-market-text-muted block">Pergunta do mercado</label>
            <input
              type="text"
              placeholder={
                marketType === 'multi'
                  ? 'Ex: Quem vencerá o campeonato nacional desta época?'
                  : 'Ex: O USD/KZ fecha acima de 950 KZ este mês?'
              }
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              maxLength={140}
              required
              className="market-input"
            />
          </div>

          {marketType === 'multi' && (
            <div className="space-y-3 p-4 rounded-xl bg-market-bg/60 border border-market-border">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <span className="text-xs font-semibold text-white block">
                    Opções / Resultados ({outcomes.length})
                  </span>
                  <span className="text-[11px] text-market-text-muted">
                    As probabilidades são normalizadas automaticamente para somar 100%.
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={distributeEqually}
                    className="px-2.5 py-1 rounded-md bg-[#222c38] hover:bg-[#2c3846] text-[11px] font-semibold text-[#6bb4ff] transition-colors"
                  >
                    Distribuir igualmente
                  </button>
                  <button
                    type="button"
                    onClick={handleAddOutcome}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-[#1452f0] hover:bg-[#1e5ef8] text-[11px] font-semibold text-white transition-colors"
                  >
                    <Plus className="w-3 h-3" /> Adicionar
                  </button>
                </div>
              </div>

              <div className="space-y-2.5">
                {outcomes.map((o, idx) => (
                  <div key={o.id} className="grid grid-cols-12 gap-2 items-center">
                    <div className="col-span-5">
                      <input
                        type="text"
                        placeholder={`Opção ${idx + 1}`}
                        value={o.name}
                        onChange={(e) => {
                          const val = e.target.value;
                          setOutcomes((prev) =>
                            prev.map((item, i) => (i === idx ? { ...item, name: val } : item))
                          );
                        }}
                        className="market-input py-2 text-xs"
                        required
                      />
                    </div>
                    <div className="col-span-2 relative">
                      <input
                        type="number"
                        min={1}
                        max={99}
                        value={o.pct}
                        onChange={(e) => {
                          const val = e.target.value;
                          setOutcomes((prev) =>
                            prev.map((item, i) => (i === idx ? { ...item, pct: val } : item))
                          );
                        }}
                        className="market-input py-2 text-xs pr-5 text-right tabular-nums"
                        title="Peso percentual inicial"
                      />
                      <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[11px] text-market-text-muted">%</span>
                    </div>
                    <div className="col-span-4">
                      <input
                        type="url"
                        placeholder="URL imagem (opcional)"
                        value={o.image_url}
                        onChange={(e) => {
                          const val = e.target.value;
                          setOutcomes((prev) =>
                            prev.map((item, i) => (i === idx ? { ...item, image_url: val } : item))
                          );
                        }}
                        className="market-input py-2 text-xs"
                      />
                    </div>
                    <div className="col-span-1 flex justify-end">
                      <button
                        type="button"
                        onClick={() => handleRemoveOutcome(idx)}
                        disabled={outcomes.length <= 2}
                        className="p-2 rounded-lg text-market-text-muted hover:text-red-400 hover:bg-red-500/10 disabled:opacity-30 transition-colors"
                        title="Remover opção"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-market-text-muted block">Categoria</label>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="market-input appearance-none"
              >
                {categories && categories.length > 0
                  ? categories.map((cat) => (
                      <option key={cat.id} value={cat.name} className="bg-market-bg text-white">
                        {cat.name}
                      </option>
                    ))
                  : PRESET_THEMES.map((t) => (
                      <option key={t.name} value={t.name} className="bg-market-bg text-white">
                        {t.name}
                      </option>
                    ))}
              </select>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-market-text-muted block">Data de encerramento</label>
              <input
                type="datetime-local"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                required
                className="market-input"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-market-text-muted block">Regras e critérios de resolução</label>
            <textarea
              placeholder="Descreva exatamente como e com que fonte oficial o mercado será resolvido."
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="market-input resize-none"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-market-text-muted block">Contexto adicional (opcional)</label>
            <textarea
              placeholder="Notas importantes sobre casos de empate, prazos ou esclarecimentos adicionais..."
              rows={2}
              value={additionalContext}
              onChange={(e) => setAdditionalContext(e.target.value)}
              className="market-input resize-none"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className="text-xs font-semibold text-market-text-muted block">
                Imagem de capa (Upload ou URL opcional)
              </label>
              <div className="flex items-center gap-3">
                {(imagePreview || sanitizeHttpUrl(customImage)) && (
                  <div className="relative shrink-0">
                    <img
                      src={imagePreview || sanitizeHttpUrl(customImage) || ''}
                      alt="Preview"
                      className="w-12 h-12 rounded-xl object-cover border border-market-border"
                    />
                    {imagePreview && (
                      <button
                        type="button"
                        onClick={handleClearImageFile}
                        className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-red-600 text-white text-[10px] font-bold flex items-center justify-center"
                        title="Remover imagem"
                      >
                        ✕
                      </button>
                    )}
                  </div>
                )}
                <div className="flex-1 space-y-1.5">
                  <label className="flex items-center justify-center gap-2 py-2 px-3 rounded-lg bg-market-bg border border-dashed border-market-border hover:border-market-green text-xs font-semibold text-market-text-muted hover:text-white cursor-pointer transition-colors">
                    <Upload className="w-3.5 h-3.5 text-market-green" />
                    <span className="truncate">{imageFile ? imageFile.name : 'Carregar ficheiro (Storage)'}</span>
                    <input
                      type="file"
                      accept="image/jpeg,image/png,image/webp,image/gif"
                      onChange={handleImageFileChange}
                      className="hidden"
                    />
                  </label>
                  {!imageFile && (
                    <input
                      type="url"
                      placeholder="Ou cole URL https://..."
                      value={customImage}
                      onChange={(e) => setCustomImage(e.target.value)}
                      className="market-input py-1.5 text-xs"
                    />
                  )}
                </div>
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-market-text-muted block">Entidade resolutora</label>
              <input
                type="text"
                placeholder="MarketPay Oracle"
                value={resolverName}
                onChange={(e) => setResolverName(e.target.value)}
                className="market-input"
              />
            </div>
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full market-button-primary py-3 text-sm flex items-center justify-center gap-2"
          >
            {loading ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                A criar mercado...
              </>
            ) : (
              <>
                <Check className="w-4 h-4" />
                Publicar mercado (2.000 KZ)
              </>
            )}
          </button>
        </form>

        <div className="lg:col-span-5 space-y-5">
          <div className="market-card p-5 space-y-3">
            <h2 className="text-sm font-semibold text-white">Como funciona o Cofre de Liquidez</h2>
            <ul className="space-y-2 text-xs text-market-text-muted leading-relaxed">
              <li>1. Os 2.000,00 KZ vão 100% para o Cofre de Liquidez do AMM (20 pares iniciais: 20 Sim + 20 Não a 50,00 KZ).</li>
              <li>2. Fica registado como Provedor de Liquidez (LP) detentor das shares remanescentes do pool.</li>
              <li>3. Cada share vencedora liquida por 100,00 KZ brutos (99,00 KZ líquidos após taxa de levantamento de 1%).</li>
              <li>4. A resolução final é validada pela administração com fonte pública oficial.</li>
            </ul>
          </div>

          <div className="market-card p-5 space-y-3">
            <h2 className="text-sm font-semibold text-white">Os seus mercados ({userMarkets.length})</h2>
            {userMarkets.length === 0 ? (
              <p className="text-xs text-market-text-muted py-4">Ainda não criou nenhum mercado.</p>
            ) : (
              <div className="space-y-2.5 max-h-[300px] overflow-y-auto">
                {userMarkets.map((m) => (
                  <Link
                    key={m.id}
                    to={`/market/${m.id}`}
                    className="block p-3 bg-market-bg border border-market-border hover:border-market-green/40 rounded-lg space-y-1.5 transition-colors"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <span className="text-xs font-semibold text-white line-clamp-2">{m.question}</span>
                      <span className="text-[11px] font-medium text-market-text-muted shrink-0">
                        {m.resolved ? 'Resolvido' : 'Ativo'}
                      </span>
                    </div>
                    <div className="flex justify-between text-xs font-mono tabular-nums text-market-text-muted">
                      <span>Vol: {(m.volume || 0).toLocaleString('pt-AO')} KZ</span>
                      <span className="text-market-green">+{(Number((m as any).creator_fee_earned) || 0).toFixed(2)} KZ</span>
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {showQuickModal && (
        <CreateMarketModal
          user={user}
          categories={categories}
          onClose={() => setShowQuickModal(false)}
          onBalanceUpdate={onBalanceUpdate}
          onSuccess={async (createdId) => {
            addToast('Mercado criado! 2.000,00 KZ alocados ao Cofre de Liquidez.', 'success');
            await Promise.resolve(onRefreshData());
            if (createdId) navigate(`/market/${createdId}`);
          }}
        />
      )}
    </div>
  );
};
