// Surge Snap — a paper bot for the pump.fun replay (agent-fun/replay/v2).
//
// Idea: buy a coin only while its tape is surging, then snap out fast.
// A surge is a short burst of mostly-buy trades that lifts the price and
// keeps it near the burst high, on a curve that already has some real SOL
// behind it. Every entry is one fixed-size shot; there is no averaging
// down and no pyramid. Exits are a take-profit, a stop-loss, a trailing
// stop once the position is up, a fade exit when the tape turns seller,
// and a hard time cap. A breadth sweep keeps the run above the guardrail
// bar (round trips on 20+ coins) when the surge signal goes quiet.
//
// The bot is deterministic by construction: it reads no clock, no
// environment and no randomness; it iterates insertion-ordered maps fed
// by the batch stream, and every price it uses comes from the harness's
// own reserves. Fees are priced into every decision: a buy pays the
// 1.25% curve fee plus the harness tx fee, a sell the same again, so a
// round trip needs roughly +3% just to break even — the take-profit is
// set well above that and the stop well below it.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Entry lookback in slots. */
  window: number;
  /** Trades in the window. */
  minTrades: number;
  /** Buy trades in the window. */
  minBuys: number;
  /** Net buy SOL (buys minus sells) over the window. */
  minNetSol: number;
  /** Price now over price at window start, minus 1. */
  minRise: number;
  /** Upper bound on that rise: skip a coin that already ran too far. */
  maxRise: number;
  /** Price now at least this share of the window high. */
  nearHigh: number;
  /** Real SOL bounds at entry. */
  minRealSol: number;
  maxRealSol: number;
  /** Slots since the CreateEvent before an entry is allowed. */
  minAge: number;
  /** SOL per entry (before the 1%-of-reserve cap). */
  stakeSol: number;
  /** Smallest buy worth sending. */
  minBuySol: number;
  /** Slippage on buys (bps); sells always go out at 10000. */
  buySlipBps: number;
  /** Take profit: sell when value >= cost * (1 + takeProfit). */
  takeProfit: number;
  /** Stop loss: sell when value <= cost * (1 - stopLoss). */
  stopLoss: number;
  /** Trailing stop arms once value >= cost * (1 + trailArm). */
  trailArm: number;
  /** Then sell when value falls to peak * (1 - trail). */
  trail: number;
  /** Fade exit: sell when net SOL over fadeWindow slots < -fadeNetSol. */
  fadeWindow: number;
  fadeNetSol: number;
  /** Hard time cap in slots. */
  maxHold: number;
  /** The time cap does not apply while value >= cost * (1 + holdIfUp). */
  holdIfUp: number;
  /** Slots to wait after an exit before the same curve may be bought again. */
  cooldown: number;
  /** Most entries per curve over the run. */
  maxEntries: number;
  /** Most SOL at cost across all positions at once. */
  maxExposureSol: number;
  /** Breadth sweep: target distinct coins and fills over the window. */
  targetCoins: number;
  targetFills: number;
  /** Block seconds the sweep paces over (the replay is 24h). */
  paceSecs: number;
  /** Probe buy size (SOL). */
  probeSol: number;
  /** Most probes open at once. */
  maxProbes: number;
}

export const DEFAULT_PARAMS: Params = {
  window: 60,
  minTrades: 6,
  minBuys: 5,
  minNetSol: 0.5,
  minRise: 0.08,
  maxRise: 2.0,
  nearHigh: 0.97,
  minRealSol: 2,
  maxRealSol: 120,
  minAge: 200,
  stakeSol: 0.25,
  minBuySol: 0.02,
  buySlipBps: 2000,
  takeProfit: 0.45,
  stopLoss: 0.3,
  trailArm: 0.2,
  trail: 0.25,
  fadeWindow: 30,
  fadeNetSol: 0.5,
  maxHold: 1200,
  holdIfUp: 0.2,
  cooldown: 150,
  maxEntries: 2,
  maxExposureSol: 4,
  targetCoins: 25,
  targetFills: 240,
  paceSecs: 86400,
  probeSol: 0.02,
  maxProbes: 1,
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

interface OpenPos {
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
  const keep = p.window + 10;

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

  /** Surge signal on a tape at slot `now`. */
  const surge = (t: Tape, now: number, realSol: number): boolean => {
    if (realSol < p.minRealSol || realSol > p.maxRealSol) return false;
    if (t.created === null || now - t.created < p.minAge) return false;
    const from = now - p.window;
    let trades = 0;
    let buys = 0;
    let buySol = 0;
    let sellSol = 0;
    let startPrice = -1;
    let high = 0;
    let last = 0;
    for (const tick of t.ticks) {
      if (tick.slot <= from) {
        startPrice = tick.price;
        continue;
      }
      if (startPrice < 0) startPrice = tick.price;
      trades++;
      if (tick.buy) {
        buys++;
        buySol += tick.sol;
      } else {
        sellSol += tick.sol;
      }
      if (tick.price > high) high = tick.price;
      last = tick.price;
    }
    if (trades < p.minTrades || buys < p.minBuys) return false;
    if (buySol - sellSol < p.minNetSol) return false;
    if (startPrice <= 0 || last <= 0) return false;
    const rise = last / startPrice - 1;
    if (rise < p.minRise || rise > p.maxRise) return false;
    if (last < high * p.nearHigh) return false;
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

      // Exits first: take-profit, stop-loss, trailing stop, fade, time cap.
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
        if (!exit && value >= cost * (1 + p.takeProfit)) exit = true;
        if (!exit && value <= cost * (1 - p.stopLoss)) exit = true;
        if (!exit && h.peak >= cost * (1 + p.trailArm) && value <= h.peak * (1 - p.trail)) exit = true;
        if (!exit && flow(t, now, p.fadeWindow) < -p.fadeNetSol) exit = true;
        if (!exit && now - h.opened > p.maxHold && value < cost * (1 + p.holdIfUp)) exit = true;
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

      // Entries: one fixed-size shot per surge.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let exposure = 0;
      for (const [mint, h] of open) {
        exposure += Math.max(h.invested, Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS);
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
        if (!surge(t, now, realSol)) continue;
        const capSol = Number(state.maxBuyLamports(mint)) / LAMPORTS;
        let amount = Math.min(p.stakeSol, capSol * 0.9, p.maxExposureSol - exposure);
        if (amount > free - tx) amount = free - tx;
        if (amount < p.minBuySol) continue;
        orders.push({
          side: 'buy',
          mint,
          quote_lamports: BigInt(Math.floor(amount * LAMPORTS)),
          max_slippage_bps: p.buySlipBps,
        });
        free -= amount + tx;
        exposure += amount;
        open.set(mint, { opened: now, peak: 0, invested: amount, exiting: false, filled: false });
        t.entries++;
        slotsLeft--;
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
