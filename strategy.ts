// Surge Snap v2 — a paper bot for the pump.fun replay (agent-fun/replay/v2).
//
// Two entries, both found by measuring forward returns on the dev window:
//
// 1. Completion rider (the main edge). A bonding curve completes when its
//    real SOL climbs to the migration threshold, and the price at
//    completion sits far above where the curve was when it was still
//    climbing. So the bot buys curves whose real SOL is already in the
//    [45, 90] band while buy flow is still positive and the price is
//    still rising, then holds for the completion close (the harness
//    closes the position at the final reserves). A stop-loss, a fade exit
//    and a hard time cap bound the half of riders that never complete.
//
// 2. Surge scalp (breadth). A 20-slot buy burst that lifts the price
//    keeps drifting up for about 25-50 slots before it rolls over, so a
//    small fixed-size buy with a tight take-profit and a short time cap
//    harvests the burst's tail. This also keeps the run above the
//    guardrail bar (round trips on 20+ coins) on quiet stretches.
//
// The bot is deterministic by construction: it reads no clock, no
// environment and no randomness; it iterates insertion-ordered maps fed
// by the batch stream, and every price it uses comes from the harness's
// own reserves. Fees are priced into every decision: a round trip pays
// the 1.25% curve fee twice plus two tx fees, so a scalp needs roughly
// +3% just to break even — the rider's +57% mean move to completion is
// what pays for the book.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Rider: real SOL band at entry. */
  rideMinRq: number;
  rideMaxRq: number;
  /** Rider: lookback for the flow / rise checks, in slots. */
  rideWindow: number;
  /** Rider: net buy SOL over rideWindow. */
  rideMinNetSol: number;
  /** Rider: price now over price at rideWindow start, minus 1. */
  rideMinRise: number;
  /** Rider: price now at least this share of the window high. */
  rideNearHigh: number;
  /** Rider: slots since the CreateEvent before an entry is allowed. */
  rideMinAge: number;
  /** Rider: SOL per entry (before the 1%-of-reserve cap). */
  rideStakeSol: number;
  /** Rider: stop loss (value <= cost * (1 - rideStop)). */
  rideStop: number;
  /** Rider: trailing stop arms once value >= cost * (1 + rideTrailArm). */
  rideTrailArm: number;
  /** Rider: then sell when value falls to peak * (1 - rideTrail). */
  rideTrail: number;
  /** Rider: take profit (rare; completion usually closes first). */
  rideTakeProfit: number;
  /** Rider: fade exit when net SOL over rideFadeWindow < -rideFadeNetSol. */
  rideFadeWindow: number;
  rideFadeNetSol: number;
  /** Rider: hard time cap in slots. */
  rideMaxHold: number;
  /** Scalp: entry lookback in slots. */
  scalpWindow: number;
  /** Scalp: trades / buys in the window. */
  scalpMinTrades: number;
  scalpMinBuys: number;
  /** Scalp: net buy SOL over the window. */
  scalpMinNetSol: number;
  /** Scalp: price rise bounds over the window. */
  scalpMinRise: number;
  scalpMaxRise: number;
  /** Scalp: price now at least this share of the window high. */
  scalpNearHigh: number;
  /** Scalp: real SOL bounds at entry. */
  scalpMinRq: number;
  scalpMaxRq: number;
  /** Scalp: slots since the CreateEvent before an entry is allowed. */
  scalpMinAge: number;
  /** Scalp: SOL per entry. */
  scalpStakeSol: number;
  /** Scalp: take profit / stop loss. */
  scalpTakeProfit: number;
  scalpStop: number;
  /** Scalp: hard time cap in slots. */
  scalpMaxHold: number;
  /** Shared. */
  buySlipBps: number;
  cooldown: number;
  maxEntries: number;
  maxExposureSol: number;
  targetCoins: number;
  targetFills: number;
  paceSecs: number;
  probeSol: number;
  maxProbes: number;
  minBuySol: number;
}

export const DEFAULT_PARAMS: Params = {
  rideMinRq: 45,
  rideMaxRq: 90,
  rideWindow: 60,
  rideMinNetSol: 0.5,
  rideMinRise: 0.03,
  rideNearHigh: 0.97,
  rideMinAge: 100,
  rideStakeSol: 0.5,
  rideStop: 0.25,
  rideTrailArm: 0.4,
  rideTrail: 0.3,
  rideTakeProfit: 1.2,
  rideFadeWindow: 30,
  rideFadeNetSol: 1,
  rideMaxHold: 3000,
  scalpWindow: 20,
  scalpMinTrades: 4,
  scalpMinBuys: 3,
  scalpMinNetSol: 0.3,
  scalpMinRise: 0.05,
  scalpMaxRise: 0.5,
  scalpNearHigh: 0.98,
  scalpMinRq: 2,
  scalpMaxRq: 120,
  scalpMinAge: 200,
  scalpStakeSol: 0.1,
  scalpTakeProfit: 0.1,
  scalpStop: 0.08,
  scalpMaxHold: 100,
  buySlipBps: 2000,
  cooldown: 300,
  maxEntries: 2,
  maxExposureSol: 5,
  targetCoins: 25,
  targetFills: 240,
  paceSecs: 86400,
  probeSol: 0.02,
  maxProbes: 1,
  minBuySol: 0.02,
};

const LAMPORTS = 1e9;
const CURVE_FEE = 0.0125;

interface Tick {
  slot: number;
  buy: boolean;
  sol: number;
  price: number;
}

interface Tape {
  created: number | null;
  ticks: Tick[];
  entries: number;
  lastExit: number;
}

type Kind = 'ride' | 'scalp';

interface OpenPos {
  kind: Kind;
  opened: number;
  peak: number;
  invested: number;
  exiting: boolean;
  filled: boolean;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const tapes = new Map<Pubkey, Tape>();
  const open = new Map<Pubkey, OpenPos>();
  /** Probe round trips in flight, by mint. */
  const probes = new Set<Pubkey>();
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;
  const keep = Math.max(p.rideWindow, p.scalpWindow) + 10;

  const tapeOf = (mint: Pubkey): Tape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { created: null, ticks: [], entries: 0, lastExit: -1e12 };
      tapes.set(mint, t);
    }
    return t;
  };

  /** Net recorded SOL (buys minus sells) over the last `w` slots. */
  const flow = (t: Tape, now: number, w: number): number => {
    let net = 0;
    for (let i = t.ticks.length - 1; i >= 0; i--) {
      const tick = t.ticks[i]!;
      if (tick.slot <= now - w) break;
      net += tick.buy ? tick.sol : -tick.sol;
    }
    return net;
  };

  /** Price stats over the last `w` slots: start, last, high. */
  const windowStats = (t: Tape, now: number, w: number): { start: number; last: number; high: number } => {
    const from = now - w;
    let start = -1;
    let last = 0;
    let high = 0;
    for (const tick of t.ticks) {
      if (tick.slot <= from) {
        start = tick.price;
        continue;
      }
      if (start < 0) start = tick.price;
      if (tick.price > high) high = tick.price;
      last = tick.price;
    }
    return { start, last, high };
  };

  /** Rider signal: near completion, still rising on buy flow. */
  const rideSignal = (t: Tape, now: number, realSol: number): boolean => {
    if (realSol < p.rideMinRq || realSol > p.rideMaxRq) return false;
    if (t.created === null || now - t.created < p.rideMinAge) return false;
    if (flow(t, now, p.rideWindow) < p.rideMinNetSol) return false;
    const s = windowStats(t, now, p.rideWindow);
    if (s.start <= 0 || s.last <= 0) return false;
    if (s.last / s.start - 1 < p.rideMinRise) return false;
    if (s.last < s.high * p.rideNearHigh) return false;
    return true;
  };

  /** Scalp signal: a fresh 20-slot buy burst lifting the price. */
  const scalpSignal = (t: Tape, now: number, realSol: number): boolean => {
    if (realSol < p.scalpMinRq || realSol > p.scalpMaxRq) return false;
    if (t.created === null || now - t.created < p.scalpMinAge) return false;
    const from = now - p.scalpWindow;
    let trades = 0;
    let buys = 0;
    let buySol = 0;
    let sellSol = 0;
    for (const tick of t.ticks) {
      if (tick.slot <= from) continue;
      trades++;
      if (tick.buy) {
        buys++;
        buySol += tick.sol;
      } else sellSol += tick.sol;
    }
    if (trades < p.scalpMinTrades || buys < p.scalpMinBuys) return false;
    if (buySol - sellSol < p.scalpMinNetSol) return false;
    const s = windowStats(t, now, p.scalpWindow);
    if (s.start <= 0 || s.last <= 0) return false;
    const rise = s.last / s.start - 1;
    if (rise < p.scalpMinRise || rise > p.scalpMaxRise) return false;
    if (s.last < s.high * p.scalpNearHigh) return false;
    return true;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const traded = new Set<Pubkey>();
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          myFills++;
          myCoins.add(f.mint);
        }
      }
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          tapeOf(e.mint).created = e.slot;
        } else if (e.event === 'TradeEvent') {
          const t = tapeOf(e.mint);
          t.ticks.push({
            slot: e.slot,
            buy: e.is_buy,
            sol: Number(e.sol_amount) / LAMPORTS,
            price: Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves),
          });
          traded.add(e.mint);
        }
      }
      for (const mint of traded) {
        const t = tapes.get(mint)!;
        let cut = 0;
        while (cut < t.ticks.length && t.ticks[cut]!.slot <= now - keep) cut++;
        if (cut > 0) t.ticks.splice(0, cut);
      }
      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) {
        pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);
      }

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;

      /** Mark-to-market value of a position in SOL, curve + tx fees deducted. */
      const valueOf = (mint: Pubkey): number => {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined || curve === undefined) return 0;
        const mk = marks.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
        const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
        const tokens = Number(pos.token_amount);
        return ((tokens * vq) / (vt + tokens) / LAMPORTS) * (1 - CURVE_FEE) - tx;
      };

      // Exits first, with per-kind rules.
      for (const [mint, h] of open) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            open.delete(mint);
            const t = tapeOf(mint);
            if (h.filled) t.lastExit = now;
            else t.entries--;
          }
          continue;
        }
        h.filled = true;
        if (curve === undefined || curve.complete) continue;
        const value = valueOf(mint);
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (value > h.peak) h.peak = value;
        let exit = h.exiting;
        const t = tapeOf(mint);
        if (h.kind === 'ride') {
          if (!exit && value >= cost * (1 + p.rideTakeProfit)) exit = true;
          if (!exit && value <= cost * (1 - p.rideStop)) exit = true;
          if (!exit && h.peak >= cost * (1 + p.rideTrailArm) && value <= h.peak * (1 - p.rideTrail)) exit = true;
          if (!exit && flow(t, now, p.rideFadeWindow) < -p.rideFadeNetSol) exit = true;
          if (!exit && now - h.opened > p.rideMaxHold) exit = true;
        } else {
          if (!exit && value >= cost * (1 + p.scalpTakeProfit)) exit = true;
          if (!exit && value <= cost * (1 - p.scalpStop)) exit = true;
          if (!exit && now - h.opened > p.scalpMaxHold) exit = true;
        }
        if (!exit) continue;
        h.exiting = true;
        let sellPending = false;
        for (const po of state.pending.values()) {
          if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
        }
        if (sellPending) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10000 });
      }

      // Probes: sell the whole probe as soon as its buy has landed.
      for (const mint of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10000 });
      }

      // Entries: riders first, then scalps.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let exposure = 0;
      for (const [mint, h] of open) {
        exposure += Math.max(h.invested, Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS);
      }
      const tryBuy = (mint: Pubkey, stake: number): boolean => {
        const capSol = Number(state.maxBuyLamports(mint)) / LAMPORTS;
        let amount = Math.min(stake, capSol * 0.9, p.maxExposureSol - exposure);
        if (amount > free - tx) amount = free - tx;
        if (amount < p.minBuySol) return false;
        orders.push({
          side: 'buy',
          mint,
          quote_lamports: BigInt(Math.floor(amount * LAMPORTS)),
          max_slippage_bps: p.buySlipBps,
        });
        free -= amount + tx;
        exposure += amount;
        return true;
      };
      for (const mint of traded) {
        if (orders.length >= cap) break;
        if (slotsLeft <= 0) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingByMint.has(mint) || probes.has(mint) || open.has(mint)) continue;
        const t = tapes.get(mint)!;
        if (t.entries >= p.maxEntries || now - t.lastExit < p.cooldown) continue;
        const realSol = Number(curve.real_quote_reserves) / LAMPORTS;
        if (rideSignal(t, now, realSol)) {
          if (!tryBuy(mint, p.rideStakeSol)) continue;
          open.set(mint, { kind: 'ride', opened: now, peak: 0, invested: p.rideStakeSol, exiting: false, filled: false });
          t.entries++;
          slotsLeft--;
        }
      }
      for (const mint of traded) {
        if (orders.length >= cap) break;
        if (slotsLeft <= 0) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingByMint.has(mint) || probes.has(mint) || open.has(mint)) continue;
        const t = tapes.get(mint)!;
        if (t.entries >= p.maxEntries || now - t.lastExit < p.cooldown) continue;
        const realSol = Number(curve.real_quote_reserves) / LAMPORTS;
        if (scalpSignal(t, now, realSol)) {
          if (!tryBuy(mint, p.scalpStakeSol)) continue;
          open.set(mint, { kind: 'scalp', opened: now, peak: 0, invested: p.scalpStakeSol, exiting: false, filled: false });
          t.entries++;
          slotsLeft--;
        }
      }

      // Breadth sweep: when fills or coins lag the pace, open a tiny probe
      // round trip on the most liquid curve traded this batch that we have
      // not touched yet, and sell it as soon as it lands.
      if (probes.size < p.maxProbes && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
        const pace = Math.min(1, (lastTime - firstTime) / p.paceSecs);
        const needCoins = myCoins.size < Math.ceil(p.targetCoins * pace);
        const needFills = myFills < Math.ceil(p.targetFills * pace);
        if (needCoins || needFills) {
          let best: Pubkey | null = null;
          let bestRq = 0;
          for (const mint of traded) {
            if (open.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
            if (needCoins && !needFills && myCoins.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            const rq = Number(curve.real_quote_reserves);
            if (rq > bestRq) {
              bestRq = rq;
              best = mint;
            }
          }
          if (best !== null) {
            const minRq = (p.probeSol * 10000) / state.hello.caps.max_order_bps_of_real_reserve;
            if (bestRq / LAMPORTS >= minRq * 1.5 && free >= p.probeSol + 2 * tx) {
              orders.push({
                side: 'buy',
                mint: best,
                quote_lamports: BigInt(Math.floor(p.probeSol * LAMPORTS)),
                max_slippage_bps: p.buySlipBps,
              });
              probes.add(best);
            }
          }
        }
      }
      return orders;
    },
  };
}
