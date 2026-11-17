import React, { useState, useEffect, useMemo } from 'react';
import { Market, MarketOutcome } from '../../types';
import { formatKz, sanitizePlainText } from '../../lib/sanitize';

interface MultiOutcomeMarketViewProps {
  market: Pick<Market, 'id' | 'is_multi' | 'outcomes'> & { outcomes?: Array<MarketOutcome | string> };
  selectedOutcome?: string;
  onSelectOutcome?: (outcomeName: string) => void;
}

export function MultiOutcomeMarketView({
  market,
  selectedOutcome,
  onSelectOutcome,
}: MultiOutcomeMarketViewProps) {
  const normalizedOutcomes = useMemo(() => {
    if (!Array.isArray(market?.outcomes)) return [];
    const total = market.outcomes.length || 1;
    return market.outcomes
      .map((item, idx) => {
        if (typeof item === 'string') {
          const name = sanitizePlainText(item, 80);
          if (!name) return null;
          const prob = 1 / total;
          return { id: String(idx + 1), name, prob, priceKz: prob * 100 };
        }
        const name = sanitizePlainText(item?.name, 80);
        if (!name) return null;
        const prob = Math.max(0.01, Math.min(0.99, Number(item?.price || 1 / total)));
        return {
          id: String(item?.id || idx + 1),
          name,
          prob,
          priceKz: prob * 100,
        };
      })
      .filter(Boolean) as Array<{ id: string; name: string; prob: number; priceKz: number }>;
  }, [market?.outcomes]);

  const [internalSelected, setInternalSelected] = useState<string>(
    normalizedOutcomes[0]?.name || 'Sim'
  );

  useEffect(() => {
    if (normalizedOutcomes.length > 0) {
      setInternalSelected(normalizedOutcomes[0].name);
    }
  }, [market?.id]);

  const activeOutcome = selectedOutcome ?? internalSelected;

  if (!market?.is_multi || normalizedOutcomes.length === 0) {
    return null;
  }

  return (
    <div dir="ltr" className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {normalizedOutcomes.map((item, idx) => {
          const isSelected = activeOutcome === item.name;
          return (
            <button
              key={item.id || idx}
              type="button"
              onClick={() => {
                setInternalSelected(item.name);
                onSelectOutcome?.(item.name);
              }}
              className={`p-4 rounded-2xl border text-left transition-all flex justify-between items-center gap-3 ${
                isSelected
                  ? 'bg-[#153e2b]/60 border-[#3dd68c] text-white shadow-lg shadow-[#3dd68c]/10'
                  : 'bg-[#1b222c] border-[#28313e] text-[#c5d0de] hover:border-[#3d4c60] hover:text-white'
              }`}
            >
              <div className="min-w-0">
                <span className="text-[11px] text-[#8b96a6] block mb-0.5">
                  Opção #{idx + 1} · {Math.round(item.prob * 100)}%
                </span>
                <span className="font-bold text-sm truncate block">{item.name}</span>
              </div>
              <span className="text-[#3dd68c] font-mono font-bold text-sm tabular-nums shrink-0">
                {formatKz(item.priceKz)}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
