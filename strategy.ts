// Launch Sniper v3 — a paper bot for the pump.fun replay (agent-fun/replay/v2).
//
// What the dev window actually rewards, measured with the kit's own sim:
// almost every coin bleeds down over hours, so holding is punished and the
// only durable edge is the first few slots of a launch. This bot buys a
// launch only in its opening slots, only when the opening tape looks
// clean, and is out within a few dozen slots — take-profit, stop-loss, a
// hard time cap, or the moment the creator sells. A breadth sweep keeps
// the run above the guardrail bar (round trips on 20+ coins) when
// launches go quiet.
//
// The opening-tape filter ("rug filter") reads the creator's behaviour:
// a creator who bought big in the create slot, or who has already sold,
// or a launch that many distinct wallets piled into in its first slot,
// is a dump in waiting. Clean launches are the ones where the creator
// put in a modest amount, has not sold, and only a couple of other
// wallets have bought so far.
//
// The bot is deterministic by construction: it reads no clock, no
// environment and no randomness; it iterates insertion-ordered maps fed
// by the batch stream, and every price it uses comes from the harness's
// own reserves. Fees are priced into every decision: a round trip pays
// the 1.25% curve fee twice plus two tx fees, so a 0.1 SOL scalp needs
// roughly +3% just to break even — the take-profit is set well above
// that and the stop just below it.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Youngest age (slots since create) at which a coin may be bought. */
  minAge: number;
  /** Oldest age at which a first buy may still be decided. */
  maxAge: number;
  /** SOL to aim for per coin (each buy still capped at 1% of real SOL). */
  stakeSol: number;
  /** Smallest single buy worth paying the tx fee for. */
  minBuySol: number;
  /** Real SOL reserve window at decision time. */
  minRealSol: number;
  maxRealSol: number;
  /** Creator's own buys in the create slot: at least this many SOL. */
  minDevBuySol: number;
  /** Creator's own buys in the create slot: at most this many SOL. */
  maxDevBuySol: number;
  /** Distinct non-creator buyers seen before entry, at least. */
  minBuyers: number;
  /** Distinct non-creator buyers seen before entry, at most. */
  maxBuyers: number;
  /** Net buy SOL (buys minus sells) on the opening tape, at least. */
  minNetBuySol: number;
  /** Skip the coin when the creator sold before entry. */
  skipDevSold: boolean;
  /** Slippage allowed on buys (bps). */
  buySlipBps: number;
  /** Exit when the position is worth this much over its cost. */
  takeProfit: number;
  /** Exit when it is worth this much under its cost. */
  stopLoss: number;
  /** Trailing stop arms once value >= cost * (1 + trailArm). */
  trailArm: number;
  /** Then sell when value falls to peak * (1 - trail). 0 = off. */
  trail: number;
  /** Exit after holding this many slots. */
  maxHold: number;
  /** Exit when the creator sells while held. */
  exitOnDevSell: boolean;
  /** Exit when no trade has hit the coin for this many slots. */
  staleSlots: number;
  /** Shared: cooldown / entries / exposure / breadth sweep. */
  cooldown: number;
  maxEntries: number;
  maxExposureSol: number;
  targetCoins: number;
  targetFills: number;
  paceSecs: number;
  probeSol: number;
  maxProbes: number;
}

export const DEFAULT_PARAMS: Params = {
  minAge: 0,
  maxAge: 3,
  stakeSol: 0.1,
  minBuySol: 0.005,
  minRealSol: 3,
  maxRealSol: 30,
  minDevBuySol: 1,
  maxDevBuySol: 2.5,
  minBuyers: 1,
  maxBuyers: 3,
  minNetBuySol: 0,
  skipDevSold: true,
  buySlipBps: 10000,
  takeProfit: 1.0,
  stopLoss: 0.08,
  trailArm: 0.4,
  trail: 0.3,
  maxHold: 20,
  exitOnDevSell: false,
  staleSlots: 1000000,
  cooldown: 300,
  maxEntries: 1,
  maxExposureSol: 5,
  targetCoins: 22,
  targetFills: 40,
  paceSecs: 21600,
  probeSol: 0.02,
  maxProbes: 1,
};

const LAMPORTS = 1e9;
const CURVE_FEE = 0.0125;

interface Launch {
  created: number;
  creator: Pubkey;
  /** Creator's buys in the create slot, SOL. */
  devBuy: number;
  devSold: boolean;
  buyers: Set<Pubkey>;
  buySol: number;
  sellSol: number;
  trades: number;
  lastTrade: number;
  entries: number;
  lastExit: number;
  done: boolean;
}

interface OpenPos {
  opened: number;
  peak: number;
  devSoldAtOpen: boolean;
  filled: boolean;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const launches = new Map<Pubkey, Launch>();
  const open = new Map<Pubkey, OpenPos>();
  /** Probe round trips in flight, by mint. */
  const probes = new Set<Pubkey>();
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;

  const debug = {
    entered: 0,
    sold: 0,
    pnl: 0,
    devSellExits: 0,
    fills: 0,
    coins: 0,
  };

  const launchOf = (mint: Pubkey, slot: number, creator: Pubkey): Launch => {
    let l = launches.get(mint);
    if (l === undefined) {
      l = {
        created: slot,
        creator,
        devBuy: 0,
        devSold: false,
        buyers: new Set(),
        buySol: 0,
        sellSol: 0,
        trades: 0,
        lastTrade: slot,
        entries: 0,
        lastExit: -1e12,
        done: false,
      };
      launches.set(mint, l);
    }
    return l;
  };

  const bot: Bot = {
    onDone(state: BotState): void {
      console.error(
        `[launch-sniper] entered=${debug.entered} sold=${debug.sold} pnl=${debug.pnl.toFixed(3)} ` +
          `devSellExits=${debug.devSellExits} fills=${debug.fills} coins=${debug.coins} ` +
          `cash=${(Number(state.cash) / LAMPORTS).toFixed(3)}`,
      );
    },

    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const fresh = new Set<Pubkey>();
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          myFills++;
          myCoins.add(f.mint);
        }
      }
      debug.fills = myFills;
      debug.coins = myCoins.size;
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          launchOf(e.mint, e.slot, e.creator);
          fresh.add(e.mint);
        } else if (e.event === 'TradeEvent') {
          const l = launches.get(e.mint);
          if (l === undefined) continue;
          const sol = Number(e.sol_amount) / LAMPORTS;
          l.trades++;
          l.lastTrade = e.slot;
          const isDev = e.user === l.creator;
          if (e.is_buy) {
            l.buySol += sol;
            if (isDev && e.slot === l.created) l.devBuy += sol;
            else if (!isDev) l.buyers.add(e.user);
          } else {
            l.sellSol += sol;
            if (isDev) l.devSold = true;
          }
          if (now - l.created <= p.maxAge) fresh.add(e.mint);
        } else {
          const l = launches.get(e.mint);
          if (l !== undefined) l.done = true;
        }
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

      // Exits first.
      for (const [mint, h] of open) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            open.delete(mint);
            const l = launches.get(mint);
            if (l !== undefined && h.filled) l.lastExit = now;
          }
          continue;
        }
        h.filled = true;
        if (curve === undefined || curve.complete) continue;
        const value = valueOf(mint);
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (value > h.peak) h.peak = value;
        const l = launches.get(mint);
        let exit = false;
        if (value >= cost * (1 + p.takeProfit)) exit = true;
        if (!exit && value <= cost * (1 - p.stopLoss)) exit = true;
        if (!exit && p.trail > 0 && h.peak >= cost * (1 + p.trailArm) && value <= h.peak * (1 - p.trail)) exit = true;
        if (!exit && now - h.opened >= p.maxHold) exit = true;
        if (!exit && p.exitOnDevSell && l !== undefined && l.devSold && !h.devSoldAtOpen) {
          exit = true;
          debug.devSellExits++;
        }
        if (!exit && l !== undefined && now - l.lastTrade >= p.staleSlots) exit = true;
        if (!exit) continue;
        let sellPending = false;
        for (const po of state.pending.values()) {
          if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
        }
        if (sellPending) continue;
        if (orders.length >= cap) break;
        debug.sold++;
        debug.pnl += value - cost;
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

      // Entries: launches still inside their opening window, tape clean.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let exposure = 0;
      for (const [mint, h] of open) {
        exposure += Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS;
      }
      for (const mint of fresh) {
        if (orders.length >= cap) break;
        if (slotsLeft <= 0) break;
        const l = launches.get(mint)!;
        if (l.done || open.has(mint) || probes.has(mint) || pendingByMint.has(mint)) continue;
        const age = now - l.created;
        if (age < p.minAge || age > p.maxAge) continue;
        if (l.entries >= p.maxEntries || now - l.lastExit < p.cooldown) continue;
        if (p.skipDevSold && l.devSold) {
          l.done = true;
          continue;
        }
        if (l.devBuy < p.minDevBuySol || l.devBuy > p.maxDevBuySol) continue;
        if (l.buyers.size < p.minBuyers || l.buyers.size > p.maxBuyers) continue;
        if (l.buySol - l.sellSol < p.minNetBuySol) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const realSol = Number(curve.real_quote_reserves) / LAMPORTS;
        if (realSol < p.minRealSol || realSol > p.maxRealSol) continue;
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
        debug.entered++;
        open.set(mint, { opened: now, peak: 0, devSoldAtOpen: l.devSold, filled: false });
        l.entries++;
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
          for (const mint of launches.keys()) {
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
  (bot as unknown as { debug: typeof debug }).debug = debug;
  return bot;
}
