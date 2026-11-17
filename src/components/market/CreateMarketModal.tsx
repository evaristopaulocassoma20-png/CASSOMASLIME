import React, { useState, useEffect } from 'react';
import { X, Plus, Trash2, Upload, Loader2 } from 'lucide-react';
import { supabaseService } from '../../lib/supabase-service';
import { uploadMarketImage, validateMarketImageFile } from '../../lib/storage-upload';
import { formatKz, sanitizeHttpUrl, sanitizePlainText } from '../../lib/sanitize';
import { Category, User } from '../../types';

interface CreateMarketModalProps {
  user?: User | null;
  categories?: Category[];
  onClose: () => void;
  onSuccess: (createdMarketId?: string) => void | Promise<void>;
  onBalanceUpdate?: (newBalanceKz: number) => void;
}

const DEFAULT_CATEGORIES = ['Finanças', 'Angola', 'Crypto', 'Desporto', 'Política', 'Tech'];

export function CreateMarketModal({
  user,
  categories,
  onClose,
  onSuccess,
  onBalanceUpdate,
}: CreateMarketModalProps) {
  const [question, setQuestion] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState(categories?.[0]?.name || 'Finanças');
  const [endDate, setEndDate] = useState(
    new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 16)
  );
  const [isMulti, setIsMulti] = useState(false);
  const [outcomesList, setOutcomesList] = useState<string[]>(['', '']);
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [imageUrlInput, setImageUrlInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    return () => {
      if (imagePreview) {
        URL.revokeObjectURL(imagePreview);
      }
    };
  }, [imagePreview]);

  const handleAddOutcome = () => {
    if (outcomesList.length >= 12) {
      setError('Máximo de 12 opções permitidas por mercado.');
      return;
    }
    setOutcomesList((prev) => [...prev, '']);
  };

  const handleOutcomeChange = (index: number, value: string) => {
    setOutcomesList((prev) => prev.map((item, i) => (i === index ? value : item)));
  };

  const handleRemoveOutcome = (index: number) => {
    if (outcomesList.length <= 2) return;
    setOutcomesList((prev) => prev.filter((_, i) => i !== index));
  };

  const handleImageChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const validationErr = validateMarketImageFile(file);
    if (validationErr) {
      setError(validationErr);
      e.target.value = '';
      return;
    }

    setError(null);
    if (imagePreview) URL.revokeObjectURL(imagePreview);
    setImageFile(file);
    setImagePreview(URL.createObjectURL(file));
  };

  const handleClearImage = () => {
    if (imagePreview) URL.revokeObjectURL(imagePreview);
    setImageFile(null);
    setImagePreview(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!user) {
      setError('Inicie sessão para criar um mercado.');
      return;
    }

    if (Number(user.balance || 0) < 2000) {
      setError(
        `Saldo insuficiente. São necessários 2.000,00 Kz para o cofre de liquidez inicial. Disponível: ${formatKz(user.balance || 0)}.`
      );
      return;
    }

    const cleanQuestion = sanitizePlainText(question, 160);
    if (cleanQuestion.length < 5) {
      setError('A pergunta do mercado deve ter pelo menos 5 caracteres.');
      return;
    }

    const cleanDescription =
      sanitizePlainText(description, 2000) ||
      `Este mercado resolve com base no resultado oficial para: ${cleanQuestion}.`;

    let formattedOutcomes: any[] | undefined;
    if (isMulti) {
      const cleanedNames = outcomesList
        .map((o) => sanitizePlainText(o, 80))
        .filter((o) => o.length > 0);

      if (cleanedNames.length < 2) {
        setError('Mercados multi-opção precisam de pelo menos 2 opções preenchidas.');
        return;
      }

      if (new Set(cleanedNames.map((n) => n.toLowerCase())).size !== cleanedNames.length) {
        setError('Os nomes das opções não podem ser repetidos.');
        return;
      }

      const equalProb = Number((1 / cleanedNames.length).toFixed(4));
      const poolPerOutcome = Math.max(10, Math.round(2000 / cleanedNames.length));
      formattedOutcomes = cleanedNames.map((name, idx) => ({
        id: String(idx + 1),
        name,
        price: equalProb,
        pool: poolPerOutcome,
        change_24h: 0,
      }));
    }

    const trimmedUrlInput = imageUrlInput.trim();
    const safeExternalUrl = trimmedUrlInput ? sanitizeHttpUrl(trimmedUrlInput) : null;
    if (trimmedUrlInput && !safeExternalUrl) {
      setError('O URL da imagem deve começar por http:// ou https://.');
      return;
    }

    setLoading(true);
    try {
      let finalImageUrl = safeExternalUrl || '';
      if (imageFile) {
        finalImageUrl = await uploadMarketImage(imageFile);
      }

      const createdId = await supabaseService.createUserMarket(user.id, {
        question: cleanQuestion,
        description: cleanDescription,
        category: sanitizePlainText(category, 40) || 'Finanças',
        image_url: finalImageUrl,
        tags: [sanitizePlainText(category, 40) || 'Finanças', isMulti ? 'Multi-Opção' : 'Comunidade'],
        end_date: new Date(endDate).toISOString(),
        is_multi: isMulti,
        outcomes: formattedOutcomes,
        b: 2000,
        status: 'active',
      });

      onBalanceUpdate?.(Math.max(0, Number((Number(user.balance || 0) - 2000).toFixed(4))));
      await Promise.resolve(onSuccess(createdId));
      onClose();
    } catch (err: any) {
      setError(err?.message || 'Erro ao criar mercado.');
    } finally {
      setLoading(false);
    }
  };

  const categoryOptions =
    categories && categories.length > 0
      ? categories.map((c) => c.name)
      : DEFAULT_CATEGORIES;

  return (
    <div className="fixed inset-0 bg-[#0b1016]/80 backdrop-blur-sm flex items-center justify-center z-50 p-4 overflow-y-auto">
      <div className="bg-[#14191f] border border-[#28313e] rounded-2xl w-full max-w-xl p-6 text-white shadow-2xl my-8">
        <div className="flex justify-between items-center mb-5 border-b border-[#242c37] pb-4">
          <div>
            <h2 className="text-lg font-bold">Criar Novo Mercado Preditivo</h2>
            <p className="text-xs text-[#8b96a6] mt-0.5">
              Cofre inicial de liquidez AMM: 2.000,00 Kz
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-[#8b96a6] hover:text-white hover:bg-[#1b222c] transition-colors"
            title="Fechar"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {error && (
          <div className="bg-red-500/10 border border-red-500/30 text-red-400 p-3 rounded-xl mb-4 text-xs">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-semibold text-[#c5d0de] mb-1">
              Pergunta do Evento
            </label>
            <input
              type="text"
              required
              maxLength={160}
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder={
                isMulti
                  ? 'Ex: Qual será a decisão do Banco Central na próxima reunião?'
                  : 'Ex: O USD/KZ fecha acima de 950 Kz este mês?'
              }
              className="w-full bg-[#1b222c] border border-[#28313e] rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-[#2d8cff]"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-semibold text-[#c5d0de] mb-1">Categoria</label>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="w-full bg-[#1b222c] border border-[#28313e] rounded-xl px-3 py-2.5 text-sm text-white focus:outline-none focus:border-[#2d8cff]"
              >
                {categoryOptions.map((cat) => (
                  <option key={cat} value={cat}>
                    {cat}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-semibold text-[#c5d0de] mb-1">Encerramento</label>
              <input
                type="datetime-local"
                required
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="w-full bg-[#1b222c] border border-[#28313e] rounded-xl px-3 py-2.5 text-xs text-white focus:outline-none focus:border-[#2d8cff]"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-[#c5d0de] mb-1">Formato</label>
              <button
                type="button"
                onClick={() => setIsMulti((v) => !v)}
                className={`w-full py-2.5 px-3 rounded-xl text-xs font-bold transition-all border ${
                  isMulti
                    ? 'bg-[#153e2b] border-[#3dd68c]/50 text-[#3dd68c]'
                    : 'bg-[#1b222c] border-[#28313e] text-[#c5d0de] hover:text-white'
                }`}
              >
                {isMulti ? 'Multi-Opção' : 'Sim / Não'}
              </button>
            </div>
          </div>

          {isMulti && (
            <div className="bg-[#1b222c]/70 p-4 rounded-xl border border-[#28313e] space-y-2.5">
              <div className="flex items-center justify-between">
                <label className="text-xs font-semibold text-[#3dd68c]">
                  Opções do Evento ({outcomesList.length})
                </label>
                <button
                  type="button"
                  onClick={handleAddOutcome}
                  className="text-xs text-[#2d8cff] font-semibold hover:underline inline-flex items-center gap-1"
                >
                  <Plus className="w-3.5 h-3.5" /> Adicionar opção
                </button>
              </div>
              {outcomesList.map((outcomeName, idx) => (
                <div key={idx} className="flex gap-2">
                  <input
                    type="text"
                    maxLength={80}
                    value={outcomeName}
                    onChange={(e) => handleOutcomeChange(idx, e.target.value)}
                    placeholder={`Opção ${idx + 1} (Ex: Corte de 50 bps)`}
                    className="flex-1 bg-[#14191f] border border-[#28313e] rounded-lg px-3 py-2 text-xs text-white outline-none focus:border-[#2d8cff]"
                    required
                  />
                  {outcomesList.length > 2 && (
                    <button
                      type="button"
                      onClick={() => handleRemoveOutcome(idx)}
                      className="px-2.5 py-1.5 bg-red-500/15 text-red-400 rounded-lg text-xs font-bold hover:bg-red-500/25"
                      title="Remover"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}

          <div>
            <label className="block text-xs font-semibold text-[#c5d0de] mb-1">
              Contexto e Regras
            </label>
            <textarea
              rows={3}
              maxLength={2000}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Explique as regras de resolução e fontes oficiais..."
              className="w-full bg-[#1b222c] border border-[#28313e] rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-[#2d8cff] resize-none"
            />
          </div>

          <div className="space-y-2">
            <label className="block text-xs font-semibold text-[#c5d0de]">
              Imagem de Capa do Mercado (Supabase Storage ou URL)
            </label>
            <div className="flex items-center gap-3">
              {(imagePreview || sanitizeHttpUrl(imageUrlInput)) && (
                <div className="relative shrink-0">
                  <img
                    src={imagePreview || sanitizeHttpUrl(imageUrlInput) || ''}
                    alt="Pré-visualização"
                    className="w-14 h-14 rounded-xl object-cover border border-[#323d4d]"
                  />
                  {imagePreview && (
                    <button
                      type="button"
                      onClick={handleClearImage}
                      className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-red-600 text-white flex items-center justify-center text-[10px] font-bold"
                      title="Remover ficheiro"
                    >
                      ✕
                    </button>
                  )}
                </div>
              )}
              <div className="flex-1 space-y-2">
                <label className="flex items-center justify-center gap-2 w-full py-2 px-3 rounded-xl bg-[#1b222c] border border-dashed border-[#38465a] hover:border-[#3dd68c] text-xs font-semibold text-[#c5d0de] hover:text-white cursor-pointer transition-colors">
                  <Upload className="w-3.5 h-3.5 text-[#3dd68c]" />
                  <span>{imageFile ? imageFile.name : 'Carregar imagem (JPG, PNG, WEBP · máx. 5MB)'}</span>
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp,image/gif"
                    onChange={handleImageChange}
                    className="hidden"
                  />
                </label>
                {!imageFile && (
                  <input
                    type="url"
                    value={imageUrlInput}
                    onChange={(e) => setImageUrlInput(e.target.value)}
                    placeholder="Ou cole um URL https://..."
                    className="w-full bg-[#1b222c] border border-[#28313e] rounded-xl px-3 py-1.5 text-xs text-white focus:outline-none focus:border-[#2d8cff]"
                  />
                )}
              </div>
            </div>
          </div>

          <div className="bg-[#1b222c] p-3 rounded-xl border border-[#28313e] text-xs text-[#8b96a6] flex justify-between items-center tabular-nums">
            <span>Cofre de Liquidez Inicial obrigatório:</span>
            <span className="text-[#3dd68c] font-bold">2.000,00 Kz</span>
          </div>

          <div className="flex gap-3 pt-3 border-t border-[#242c37]">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 bg-[#1b222c] hover:bg-[#242e3b] text-[#c5d0de] font-semibold py-2.5 rounded-xl text-xs transition-colors"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={loading}
              className="flex-1 bg-[#1a73e8] hover:bg-[#1967d2] text-white font-bold py-2.5 rounded-xl text-xs transition-colors disabled:opacity-50 inline-flex items-center justify-center gap-2"
            >
              {loading && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              {loading ? 'A criar mercado...' : 'Criar Mercado (2.000,00 Kz)'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
