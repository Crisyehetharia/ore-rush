# ORE RUSH — Solana Blitz v10

A real-time mining game on Solana devnet + MagicBlock Ephemeral Rollup.
Entertainment Finance: compete in 60-second rounds, mine ore on the rollup
(gasless, ~10ms per tap), and win devnet SOL from the house pot.

- **Event:** Solana Blitz v10 (MagicBlock), online. Deadline **Fri 27 Nov 2026,
  22:00 SGT (21:00 WIB)**. Submit at
  https://build.magicblock.app/?stage=blitz#submit (Luma:
  https://luma.com/hedv5sgh).
- **Prizes:** 1st $500, 2nd $250, 3rd $150, Wizardio's Choice $100 USDC.
- **Hard requirement met:** integrates **Ephemeral Rollups** (session PDA
  delegated to the devnet-us ER, gameplay txs on the ER, commit back to base).
- **Network:** Solana **devnet only**. No real funds anywhere.

## How the game works

1. House operator runs `initialize_house` once, then `fund_pot` (devnet SOL).
2. Player clicks **Start Round** — a session PDA is created (60s window).
3. Player clicks **Delegate to ER** — the session PDA is delegated to the
   MagicBlock delegation program for the devnet-us ephemeral rollup.
4. Player taps **MINE** — each tap is a transaction on the ER (gasless,
   real-time). Score = ores mined.
5. Round ends → **Finish Round** commits the ER state back to base and
   undelegates the session.
6. **Claim Prize** (base layer) — score ≥ 40 ores wins **0.05 devnet SOL**
   from the house vault; the on-chain leaderboard (top 5) is updated.

## Layout

- `programs/ore-rush/` — Anchor program (Rust, anchor-lang 1.2.2,
  ephemeral-rollups-sdk 0.20.0). Program ID:
  `FknaFskJcLQm3Tw4uRUEnMXvwa5xsED1FKB9NGyMY8HS`
- `app/` — static frontend (plain HTML/JS, `@solana/web3.js` from CDN).
  Serve with `python3 -m http.server` inside `app/` and open
  http://localhost:8000. Devnet only; demo wallet is generated in-browser.
- `scripts/e2e-devnet.mjs` — headless end-to-end test (full round on devnet
  + ER). Run with `node e2e-devnet.mjs [mines]` from `scripts/`.
- `target/idl/ore_rush.json` — program IDL (source of truth for accounts).

## Endpoints

- Base RPC: `https://api.devnet.solana.com`
- ER RPC (validator 2.0, devnet-us): `https://devnet-us.magicblock.app`
- ER validator: `MUS3hc9TCw4cGC12vHNoYcCGzJG1txjgQLZWVoeNHNd`
- Delegation program: `DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh`

## Devnet funding (throwaway keypairs only)

- `deployer-keypair.json` — house operator / deployer (devnet only, never
  commit; gitignored). Needs ~3.5 SOL: ~1.72 SOL program rent + 1 SOL pot +
  player funding + fees.
- Devnet SOL comes from the faucet only (`solana airdrop` /
  https://faucet.solana.com). Never use real funds or mainnet keys.

## Status

See `BUILD_LOG.md`.
