/**
 * Motor Matemático AMM CPMM (x * y = k) em Kwanza (Kz)
 * Regras:
 * - Cada share vencedora vale 100,00 Kz brutos na liquidação (perdedora = 0,00 Kz).
 * - Par completo (1 share SIM + 1 share NÃO) = 100,00 Kz de lastro no cofre.
 * - Preço = Probabilidade entre 1,00 Kz e 99,00 Kz (ex: 54,00 Kz = 54%).
 * - Taxa de operação (compra/venda): 1% bruto vai para platform_revenue; 99% líquidos entram no AMM.
 * - Taxa de levantamento/liquidação no encerramento: 1% sobre o valor bruto.
 * - Criação de mercado: 2.000,00 Kz -> 20 pares iniciais (20 SIM + 20 NÃO) a 50,00 Kz / 50%.
 */

export const SHARE_SETTLEMENT_KZ = 100;
export const TRADING_FEE_RATE = 0.01;
export const WITHDRAWAL_FEE_RATE = 0.01;
export const MARKET_CREATION_LIQUIDITY_KZ = 2000;
export const INITIAL_LP_PAIRS = 20;

export function round4(val: number): number {
  return Math.round((val + Number.EPSILON) * 10_000) / 10_000;
}

export function round2(val: number): number {
  return Math.round((val + Number.EPSILON) * 100) / 100;
}

export function normalizeOutcomeSide(outcome: string): 'Yes' | 'No' {
  const lower = String(outcome || '').trim().toLowerCase();
  if (lower === 'no' || lower === 'nao' || lower === 'não') return 'No';
  return 'Yes';
}

export function getCpmmSpotPricesKz(poolYesRaw: number, poolNoRaw: number): {
  yesPriceKz: number;
  noPriceKz: number;
  yesProb: number;
  noProb: number;
} {
  const poolYes = Math.max(0.0001, Number(poolYesRaw) || INITIAL_LP_PAIRS);
  const poolNo = Math.max(0.0001, Number(poolNoRaw) || INITIAL_LP_PAIRS);
  const total = poolYes + poolNo;
  const rawYesProb = poolNo / total;
  const yesPriceKz = Math.max(1, Math.min(99, round4(rawYesProb * 100)));
  const noPriceKz = round4(100 - yesPriceKz);
  return {
    yesPriceKz,
    noPriceKz,
    yesProb: round4(yesPriceKz / 100),
    noProb: round4(noPriceKz / 100),
  };
}

export interface CpmmBuyQuote {
  outcome: 'Yes' | 'No';
  grossAmountKz: number;
  feeKz: number;
  netAmountKz: number;
  pairsMinted: number;
  sharesReceived: number;
  spotPriceBeforeKz: number;
  spotPriceAfterKz: number;
  avgExecPriceKz: number;
  priceImpactPct: number;
  newPoolYes: number;
  newPoolNo: number;
  grossPayoutIfWinKz: number;
  withdrawalFeeIfWinKz: number;
  netPayoutIfWinKz: number;
}

export function quoteCpmmBuy(params: {
  poolYes: number;
  poolNo: number;
  outcome: 'Yes' | 'No';
  grossAmountKz: number;
}): CpmmBuyQuote {
  const poolYes = Math.max(0.0001, Number(params.poolYes) || INITIAL_LP_PAIRS);
  const poolNo = Math.max(0.0001, Number(params.poolNo) || INITIAL_LP_PAIRS);
  const outcome = normalizeOutcomeSide(params.outcome);
  const grossAmountKz = Math.max(0, round4(Number(params.grossAmountKz) || 0));

  const before = getCpmmSpotPricesKz(poolYes, poolNo);
  const spotPriceBeforeKz = outcome === 'Yes' ? before.yesPriceKz : before.noPriceKz;

  if (grossAmountKz <= 0) {
    return {
      outcome,
      grossAmountKz: 0,
      feeKz: 0,
      netAmountKz: 0,
      pairsMinted: 0,
      sharesReceived: 0,
      spotPriceBeforeKz,
      spotPriceAfterKz: spotPriceBeforeKz,
      avgExecPriceKz: spotPriceBeforeKz,
      priceImpactPct: 0,
      newPoolYes: poolYes,
      newPoolNo: poolNo,
      grossPayoutIfWinKz: 0,
      withdrawalFeeIfWinKz: 0,
      netPayoutIfWinKz: 0,
    };
  }

  const feeKz = round4(grossAmountKz * TRADING_FEE_RATE);
  const netAmountKz = round4(grossAmountKz - feeKz);
  const pairs = round4(netAmountKz / SHARE_SETTLEMENT_KZ);

  let newPoolYes = poolYes;
  let newPoolNo = poolNo;
  let sharesReceived = 0;

  if (outcome === 'Yes') {
    newPoolNo = round4(poolNo + pairs);
    newPoolYes = round4((poolYes * poolNo) / newPoolNo);
    sharesReceived = Math.max(0, round4((poolYes + pairs) - newPoolYes));
  } else {
    newPoolYes = round4(poolYes + pairs);
    newPoolNo = round4((poolYes * poolNo) / newPoolYes);
    sharesReceived = Math.max(0, round4((poolNo + pairs) - newPoolNo));
  }

  const avgExecPriceKz = sharesReceived > 0 ? round4(netAmountKz / sharesReceived) : spotPriceBeforeKz;
  const after = getCpmmSpotPricesKz(newPoolYes, newPoolNo);
  const spotPriceAfterKz = outcome === 'Yes' ? after.yesPriceKz : after.noPriceKz;
  const priceImpactPct = spotPriceBeforeKz > 0 ? round2(((spotPriceAfterKz - spotPriceBeforeKz) / spotPriceBeforeKz) * 100) : 0;

  const grossPayoutIfWinKz = round4(sharesReceived * SHARE_SETTLEMENT_KZ);
  const withdrawalFeeIfWinKz = round4(grossPayoutIfWinKz * WITHDRAWAL_FEE_RATE);
  const netPayoutIfWinKz = round4(grossPayoutIfWinKz - withdrawalFeeIfWinKz);

  return {
    outcome,
    grossAmountKz,
    feeKz,
    netAmountKz,
    pairsMinted: pairs,
    sharesReceived,
    spotPriceBeforeKz,
    spotPriceAfterKz,
    avgExecPriceKz,
    priceImpactPct,
    newPoolYes,
    newPoolNo,
    grossPayoutIfWinKz,
    withdrawalFeeIfWinKz,
    netPayoutIfWinKz,
  };
}

export interface CpmmSellQuote {
  outcome: 'Yes' | 'No';
  sharesToSell: number;
  pairsBurned: number;
  grossReturnKz: number;
  feeKz: number;
  netReturnKz: number;
  spotPriceBeforeKz: number;
  spotPriceAfterKz: number;
  avgExecPriceKz: number;
  priceImpactPct: number;
  newPoolYes: number;
  newPoolNo: number;
}

export function quoteCpmmSell(params: {
  poolYes: number;
  poolNo: number;
  outcome: 'Yes' | 'No';
  sharesToSell: number;
}): CpmmSellQuote {
  const poolYes = Math.max(0.0001, Number(params.poolYes) || INITIAL_LP_PAIRS);
  const poolNo = Math.max(0.0001, Number(params.poolNo) || INITIAL_LP_PAIRS);
  const outcome = normalizeOutcomeSide(params.outcome);
  const sharesToSell = Math.max(0, round4(Number(params.sharesToSell) || 0));

  const before = getCpmmSpotPricesKz(poolYes, poolNo);
  const spotPriceBeforeKz = outcome === 'Yes' ? before.yesPriceKz : before.noPriceKz;

  if (sharesToSell <= 0) {
    return {
      outcome,
      sharesToSell: 0,
      pairsBurned: 0,
      grossReturnKz: 0,
      feeKz: 0,
      netReturnKz: 0,
      spotPriceBeforeKz,
      spotPriceAfterKz: spotPriceBeforeKz,
      avgExecPriceKz: spotPriceBeforeKz,
      priceImpactPct: 0,
      newPoolYes: poolYes,
      newPoolNo: poolNo,
    };
  }

  const b = poolYes + poolNo + sharesToSell;
  const targetReserve = outcome === 'Yes' ? poolNo : poolYes;
  const discriminant = Math.max(0, b * b - 4 * sharesToSell * targetReserve);
  const pairsBurned = Math.max(0, round4((b - Math.sqrt(discriminant)) / 2));

  let newPoolYes = poolYes;
  let newPoolNo = poolNo;
  if (outcome === 'Yes') {
    newPoolYes = round4(poolYes + sharesToSell - pairsBurned);
    newPoolNo = Math.max(0.0001, round4(poolNo - pairsBurned));
  } else {
    newPoolNo = round4(poolNo + sharesToSell - pairsBurned);
    newPoolYes = Math.max(0.0001, round4(poolYes - pairsBurned));
  }

  const grossReturnKz = round4(pairsBurned * SHARE_SETTLEMENT_KZ);
  const feeKz = round4(grossReturnKz * TRADING_FEE_RATE);
  const netReturnKz = round4(grossReturnKz - feeKz);
  const avgExecPriceKz = sharesToSell > 0 ? round4(grossReturnKz / sharesToSell) : spotPriceBeforeKz;

  const after = getCpmmSpotPricesKz(newPoolYes, newPoolNo);
  const spotPriceAfterKz = outcome === 'Yes' ? after.yesPriceKz : after.noPriceKz;
  const priceImpactPct = spotPriceBeforeKz > 0 ? round2(((spotPriceAfterKz - spotPriceBeforeKz) / spotPriceBeforeKz) * 100) : 0;

  return {
    outcome,
    sharesToSell,
    pairsBurned,
    grossReturnKz,
    feeKz,
    netReturnKz,
    spotPriceBeforeKz,
    spotPriceAfterKz,
    avgExecPriceKz,
    priceImpactPct,
    newPoolYes,
    newPoolNo,
  };
}
