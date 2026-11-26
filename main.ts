// Tiny Bot: beat buy-and-hold on hourly Solana bars.
//
// Strategy, tuned on the kit's dev window (136 hourly bars of FARTCOIN,
// JITOSOL, POPCAT, RAY, SOL, WETH, WIF) and checked across nine sliding
// 72-bar windows, the length of the final window:
//   - Core trend: EMA(8) crossing above EMA(21) buys a full stake, but
//     only while SOL itself sits above its own EMA(21) — the market
//     regime gate. In a broad downtrend the bot stays in cash, which is
//     where buy-and-hold bleeds.
//   - Scalp: EMA(5) crossing above EMA(13) buys a small stake (15% of a
//     full stake) in any regime, so the bot still trades — and still
//     catches bounces — while the market gate is shut. Its stop is
//     tighter, so a whipsaw costs little.
//   - Exits: the whole position goes when EMA(8) crosses back under
//     EMA(21), when a scalp position's own EMA(5) crosses under its
//     EMA(13), at a 5% stop (3% for scalp) under cost, or at 12% over
//     cost. Protection: once a position has been up 6% (4% for a scalp),
//     its stop moves to breakeven — a winner that fades is scratched
//     instead of ridden back to the stop.
//   - No trade is taken before a symbol has 22 closes: early EMA values
//     are seeded from the first close and are too noisy to trust.
//   - One full stake is equity / 7, so the bot can hold the whole
//     universe and never breaches the 25% per-symbol weight cap.
//
// Deterministic: float64 EMAs on + - * / alone, no clock, no
// environment, no randomness. Every bar's orders are decided from
// closes only, so two runs on the same bars give the same replies.

import { BPS, runBars, type Bar, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const CORE_FAST = 8;
const CORE_SLOW = 21;
const SCALP_FAST = 5;
const SCALP_SLOW = 13;
const MIN_CLOSES = 22;
const SCALP_SHARE_NUM = 15n;
const SCALP_SHARE_DEN = 100n;
const MAX_SLIPPAGE_BPS = 100;

/** One EMA, seeded at the first close it sees. */
class Ema {
  readonly span: number;
  value: number | null = null;

  constructor(span: number) {
    this.span = span;
  }

  push(close: number): void {
    if (this.value === null) {
      this.value = close;
      return;
    }
    this.value += (2 / (this.span + 1)) * (close - this.value);
  }
}

interface Series {
  coreFast: Ema;
  coreSlow: Ema;
  scalpFast: Ema;
  scalpSlow: Ema;
  closes: number;
  coreGap: number | null;
  coreNow: number | null;
  scalpGap: number | null;
  scalpNow: number | null;
  coreUp: boolean;
  coreDown: boolean;
  scalpUp: boolean;
  scalpDown: boolean;
}

const series = new Map<string, Series>();
/** Which tier bought each held symbol: 'core' for a full stake, 'scalp' for a small one. */
const tier = new Map<string, 'core' | 'scalp'>();
/** Best a held position has done, in basis points of its cost, for breakeven protection. */
const peakBps = new Map<string, bigint>();

function getSeries(symbol: string): Series {
  let s = series.get(symbol);
  if (s === undefined) {
    s = {
      coreFast: new Ema(CORE_FAST),
      coreSlow: new Ema(CORE_SLOW),
      scalpFast: new Ema(SCALP_FAST),
      scalpSlow: new Ema(SCALP_SLOW),
      closes: 0,
      coreGap: null,
      coreNow: null,
      scalpGap: null,
      scalpNow: null,
      coreUp: false,
      coreDown: false,
      scalpUp: false,
      scalpDown: false,
    };
    series.set(symbol, s);
  }
  return s;
}

function pushBar(bar: Bar): Series {
  const s = getSeries(bar.symbol);
  const close = Number(bar.c);
  s.coreFast.push(close);
  s.coreSlow.push(close);
  s.scalpFast.push(close);
  s.scalpSlow.push(close);
  s.closes++;
  s.coreGap = s.coreNow;
  s.scalpGap = s.scalpNow;
  s.coreNow =
    s.coreFast.value !== null && s.coreSlow.value !== null ? s.coreFast.value - s.coreSlow.value : null;
  s.scalpNow =
    s.scalpFast.value !== null && s.scalpSlow.value !== null ? s.scalpFast.value - s.scalpSlow.value : null;
  s.coreUp = false;
  s.coreDown = false;
  s.scalpUp = false;
  s.scalpDown = false;
  if (bar.v === '0' || s.coreGap === null || s.coreNow === null || s.scalpGap === null || s.scalpNow === null) {
    return s;
  }
  if (s.coreNow > 0 && s.coreGap <= 0) s.coreUp = true;
  if (s.coreNow < 0 && s.coreGap >= 0) s.coreDown = true;
  if (s.scalpNow > 0 && s.scalpGap <= 0) s.scalpUp = true;
  if (s.scalpNow < 0 && s.scalpGap >= 0) s.scalpDown = true;
  return s;
}

/** Exit a held position on its stop, its take-profit, a trend cross down, or a faded winner. */
function exits(state: BarsState, symbol: string, held: { qty: bigint; cost: bigint }, s: Series): boolean {
  const value = state.value(symbol, held.qty);
  const scalp = tier.get(symbol) === 'scalp';
  const stopNum = scalp ? 97n : 95n;
  // Breakeven protection: track the best the position has done, in basis
  // points of its cost. Once it has been up 6% (4% for a scalp), never let
  // it turn into a loss — exit at breakeven instead of riding it back to
  // the 5% (3%) stop. With a ~21% win rate against a 5% stop, fading
  // winners are the main bleed; scratching them beats paying the stop.
  const pctBps = (value * 10000n) / held.cost;
  const seen = peakBps.get(symbol) ?? 0n;
  const best = pctBps > seen ? pctBps : seen;
  if (pctBps > seen) peakBps.set(symbol, pctBps);
  const protectBps = scalp ? 10400n : 10600n;
  if (best >= protectBps && pctBps <= 10000n) return true;
  if (value * 100n <= held.cost * stopNum) return true;
  if (value * 100n >= held.cost * 112n) return true;
  if (s.coreDown) return true;
  if (scalp && s.scalpDown) return true;
  return false;
}

await runBars({
  onBatch(state, batch) {
    const fresh = new Set<string>();
    for (const bar of batch.bars) {
      pushBar(bar);
      fresh.add(bar.symbol);
    }
    // Warm-up bars build history only; the replay rejects every order decided on one.
    if (state.warmingUp) return [];
    const { caps, fees } = state.hello;
    // Drop tiers (and their breakeven peaks) for positions the market no longer holds (a rejected buy, a filled sell).
    for (const symbol of [...tier.keys()]) {
      if (!state.positions.has(symbol)) {
        tier.delete(symbol);
        peakBps.delete(symbol);
      }
    }
    const sol = series.get('SOL');
    const marketUp =
      sol !== undefined && sol.coreSlow.value !== null && state.close('SOL') !== null
        ? Number(state.close('SOL')) > sol.coreSlow.value
        : true;

    const sells: SellInput[] = [];
    const buys: BuyInput[] = [];
    for (const { symbol } of state.hello.symbols) {
      if (!fresh.has(symbol)) continue;
      const s = series.get(symbol);
      if (s === undefined || s.closes < MIN_CLOSES) continue;
      const held = state.positions.get(symbol);
      if (held !== undefined) {
        if (exits(state, symbol, held, s)) {
          sells.push({ side: 'sell', symbol, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
          tier.delete(symbol);
        }
      } else if (marketUp && s.coreUp) {
        buys.push({ side: 'buy', symbol, notional_quote_units: 0n, max_slippage_bps: MAX_SLIPPAGE_BPS });
        tier.set(symbol, 'core');
      } else if (s.scalpUp) {
        buys.push({ side: 'buy', symbol, notional_quote_units: 0n, max_slippage_bps: MAX_SLIPPAGE_BPS });
        tier.set(symbol, 'scalp');
      }
    }

    const orders: (SellInput | BuyInput)[] = sells.slice(0, caps.max_orders_per_bar);
    const stake = state.equity / 7n;
    let cash = state.cash;
    for (const buy of buys) {
      if (orders.length >= caps.max_orders_per_bar) break;
      const full = tier.get(buy.symbol) === 'core';
      let slice = full ? stake : (stake * SCALP_SHARE_NUM) / SCALP_SHARE_DEN;
      const room = state.weightRoom(buy.symbol);
      if (slice > room) slice = room;
      if (slice > cash) slice = cash;
      if (slice === 0n || slice < BigInt(fees.min_notional_quote_units)) {
        tier.delete(buy.symbol);
        continue;
      }
      buy.notional_quote_units = slice;
      orders.push(buy);
      cash -= slice;
    }
    return orders;
  },
});
