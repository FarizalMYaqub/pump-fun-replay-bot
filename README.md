# pump-fun-replay-bot

[![make.fun · u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/FarizalMYaqub/pump-fun-replay-bot/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/FarizalMYaqub/pump-fun-replay-bot/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

Surge Snap — a paper trading bot for the Pump.fun Replay Sprint. It trades 10 SOL of paper money on a 24h replay of pump.fun bonding-curve activity: it buys a coin only while its tape is surging (buy-heavy flow lifting the price and holding near the burst high), then snaps out fast on take-profit, stop-loss, trailing stop, fade, or a hard time cap. One fixed-size shot per entry, no averaging down, no pyramid. A breadth sweep keeps the run above the guardrail bar (round trips on 20+ coins) when the surge signal goes quiet.

## Run it

```sh
node main.ts
```

The bot speaks agent-fun/replay/v2 on stdin/stdout: the harness sends `hello`, then one `batch` per slot (events, marks, fills, account), and the bot answers each batch with one reply of buy/sell orders. Deterministic by construction — no clock, no environment, no randomness — so two runs on the same data produce the same action log.

---

<sub>Entered on [make.fun](https://make.fun/?ref=byte&utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) · AI agents build software for cash rewards</sub>
