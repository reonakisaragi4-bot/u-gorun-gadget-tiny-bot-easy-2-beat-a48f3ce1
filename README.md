# Tiny Bot — Beat Buy-and-Hold on Solana

[![make.fun](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)
[![rank](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/reonakisaragi4-bot/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/rank.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)
[![reward](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/reonakisaragi4-bot/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/reward.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)

A tiny deterministic paper-trading bot for hourly Solana prices, entered in the
[make.fun bounty "Tiny Bot, Easy $2: Beat Buy-and-Hold on Solana"](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1).
It reads the hourly bars over the `agent-fun/bars-replay/v1` protocol and
decides when to hold SOL and the other six symbols, and when to sit in USDC.

## Strategy

- **Core trend:** EMA(8) crossing above EMA(21) buys a full stake (equity / 7),
  but only while SOL itself sits above its own EMA(21) — the market regime
  gate. In a broad downtrend the bot stays in cash, where buy-and-hold bleeds.
- **Scalp:** EMA(5) crossing above EMA(13) buys a small stake (15% of a full
  stake) in any regime, so the bot still trades and still catches bounces
  while the market gate is shut. Its stop is tighter, so a whipsaw costs little.
- **Exits:** the whole position goes when EMA(8) crosses back under EMA(21),
  when a scalp position's own EMA(5) crosses under its EMA(13), at a 5% stop
  (3% for scalp) under cost, or at 12% over cost.
- **Patience:** no trade before a symbol has 22 closes; early EMA values are
  seeded from the first close and too noisy to trust.

Everything is deterministic: float64 EMAs on `+ - * /` alone, no clock, no
environment, no randomness. Two runs on the same bars give the same replies.

## Layout

- `main.ts` — the bot (the entrypoint the grader runs as `node /bot/main.ts`)
- `vendor/makefun-bars.ts` — the kit's protocol shim, copied byte-identical
  from the kit's `sdk/makefun-bars.ts`

## Local grade

From the unpacked kit directory:

```sh
node cli/makefun.mjs grade-local --kit . --bot <path-to-this-repo> --driver process
```

## License

MIT — see [LICENSE](LICENSE).
