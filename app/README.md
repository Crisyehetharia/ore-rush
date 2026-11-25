# ORE RUSH — Frontend

Static HTML/JS frontend for **ORE RUSH**, a real-time mining game on Solana
devnet + MagicBlock Ephemeral Rollup (Solana Blitz v10 hackathon).

No build step. No backend. No framework. One page: `index.html` + `app.js`.

## Run it

```bash
cd ~/workspace/solana-blitz-v10/ore-rush/app
python3 -m http.server 8000
```

Then open http://localhost:8000 in a browser (phone works — the page is
mobile-first). All traffic is **devnet only — play money, no real funds**.

## Demo flow

1. **Wallet** — a demo keypair is generated in the browser and saved in
   `localStorage` (never used on mainnet). Hit **Airdrop 2 SOL** to fund it.
   ⚠️ The devnet **RPC faucet is closed cluster-wide** (HTTP 410, verified
   2026-11-25 on `api.devnet.solana.com` and `rpcpool` — "Request test SOL
   at https://faucet.solana.com"). If the button fails, the app links you
   to the **web faucet** ([faucet.solana.com](https://faucet.solana.com)):
   paste the demo wallet address there, then hit Refresh. (Optional:
   **Connect Phantom** appears if the Phantom extension is installed.)
2. **Setup** — **Init House** creates the house vault + leaderboard PDAs
   (once, by whoever runs it first), **Fund Pot 0.2 SOL** tops up the prize
   pot, **Start Round** opens a 60s window for your session PDA,
   **Delegate to ER** delegates the session to the Ephemeral Rollup.
   Every step logs its transaction with a Solana Explorer (devnet) link.
3. **Mine!** — tap the big **⛏️ MINE** button. Each tap is one transaction
   on the ER (gasless, ~10 ms). The ore count, a 60s countdown bar, per-tap
   latency, and the last mine transaction are shown live. Mining disables
   when time is up.
4. **Finish Round** — sends `finish_round` to the ER (commits state back to
   the base layer and undelegates the session). Then **Claim Prize** settles
   on the base layer: 0.05 SOL from the house vault if you mined ≥ 40 ores,
   and your score lands on the leaderboard.
5. **Leaderboard** — reads the leaderboard PDA, shows the top 5
   (shortened pubkey + score). Refresh any time.

## How it is built

- `@solana/web3.js` **1.98.0**, pinned UMD build from jsDelivr:
  `https://cdn.jsdelivr.net/npm/@solana/web3.js@1.98.0/lib/index.iife.min.js`
  (verified: HTTP 200, `application/javascript`, 459,806 bytes, exposes the
  `solanaWeb3` global).
- No `@coral-xyz/anchor` in the browser. Instructions are encoded manually:
  discriminator = first 8 bytes of `sha256("global:<instruction_name>")`
  (computed at boot with `crypto.subtle`), args as little-endian borsh
  (`fund_pot` takes one `u64`).
- Base-layer RPC: `https://api.devnet.solana.com`
  (commitment `"confirmed"`, standard preflight).
- Ephemeral Rollup RPC: `https://devnet-us.magicblock.app`
  (commitment `"confirmed"`, `skipPreflight: true` — required on the ER).
- Program ID (devnet): `FknaFskJcLQm3Tw4uRUEnMXvwa5xsED1FKB9NGyMY8HS`
- Delegation program: `DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh`
- ER validator (remaining account on `delegate_session`):
  `MUS3hc9TCw4cGC12vHNoYcCGzJG1txjgQLZWVoeNHNd`
- PDAs: `house = ["house"]`, `session = ["session", player]`,
  `leaderboard = ["leaderboard"]`. Delegation PDAs: `buffer = ["buffer",
  session]` (owner program), `delegation = ["delegation", session]` and
  `delegation-metadata = ["delegation-metadata", session]` (delegation
  program).

## Account lists — source of truth

The account list of every instruction in `app.js` (`IDL_ACCOUNTS`) is taken
from the program IDL at `../target/idl/ore_rush.json`. The `#[delegate]` and
`#[commit]` macros inject extra accounts (`delegate_session` gains the
buffer / delegation-record / delegation-metadata PDAs plus owner program,
delegation program, system program; `finish_round` gains the Magic program
and Magic context). Those lists were derived by expanding the
`ephemeral-rollups-sdk` 0.20.0 macros against the program source and
**verified against the IDL on 2026-11-25** — all 7 game instructions match
(names, order, signer/writable flags, discriminators, PDA seeds). If
`anchor build` regenerates the IDL, re-check; the IDL wins. (Note: the IDL
also contains an extra `process_undelegation` instruction injected by the
`#[ephemeral]` macro — not part of the game flow, not used by this UI.)

## Status / what is tested

- Page loads with no console errors (headless-Chromium check, clean run:
  single navigation, no exceptions, no failed requests).
- Demo wallet generation verified live in headless Chromium (wallet created,
  balances read from base + ER RPCs, house correctly reported "not
  initialized" — program not deployed yet). **Airdrop could NOT complete:
  the devnet RPC faucet is closed cluster-wide (HTTP 410 on
  api.devnet.solana.com and rpcpool; Alchemy demo key 429). The app now
  detects the 410 and links to the web faucet (faucet.solana.com). No
  funded devnet wallet exists in this project (deployer wallet balance is
  0 SOL), so the 2 SOL balance display is untested until the web faucet
  is used.**
- In-browser instruction build + transaction serialization verified for all
  7 instructions (correct keys, discriminators, `fund_pot` u64 encoding;
  `mine` serializes to 211 bytes, `delegate_session` to 410 bytes).
- Node harness (41 checks): discriminators, PDAs (incl. delegation PDAs),
  instruction data/keys, and House/Session/Leaderboard decoders on synthetic
  buffers — all pass against independent computations.
- **IDL verification (2026-11-25):** all 7 game instructions match
  `target/idl/ore_rush.json` exactly — names, account order, signer/writable
  flags, discriminators, PDA seeds, and account struct layouts.
- Game transactions (start → delegate → mine → finish → claim) need the
  deployed program — not sent until the coordinator deploys.
