# ORE RUSH — Build Log

## 2026-11-25 ~13:05 WIB — kickoff
- Concept chosen: **ORE RUSH**, a real-time mining game. Player delegates a
  session PDA to the MagicBlock Ephemeral Rollup (devnet-us), taps to mine
  ore gaslessly for 60s, commits back, and claims a 0.05 devnet SOL prize
  from the house vault if score >= 40. On-chain top-5 leaderboard.
- Why this concept: smallest viable MVP that genuinely uses an Ephemeral
  Rollup (the hard requirement), needs no price feed, no VRF, no NFT mint,
  no backend server. Past Blitz winners with the same shape: BlitzMine,
  Ultra Pong (one mechanic, real-time, ER-powered).

## 2026-11-25 ~13:08 WIB — research (subagent)
- Submission: Luma + MagicBlock X confirm deadline Fri 27 Nov 22:00 SGT
  (21:00 WIB), submit at build.magicblock.app/?stage=blitz#submit, hard
  requirement = ER / PER / VRF integration. Exact v10 form fields NOT
  verified (static crawl shows "No open events" — likely JS-rendered;
  needs a live-browser check with wallet connected before the deadline).
- Version matrix pinned from official docs + docs.rs + the official
  `magicblock-engine-examples` repo: installed toolchain Anchor 1.2.2 /
  Solana CLI 4.1.2 / Rust 1.100.0; `ephemeral-rollups-sdk 0.20.0`
  (requires Anchor 1.2.2+, targets Solana 3.0 + Validator v2); TS SDK
  0.20.x with the **devnet-us** ER only (validator 2.0); TS SDK 0.18.x is
  the legacy line for 1.1.1 ERs — do not mix.
- Endpoints verified live: devnet RPC ok, `devnet-us.magicblock.app` ok,
  `devnet.magicblock.app` ok, npm + GitHub reachable from the VM.

## 2026-11-25 ~13:15–13:30 WIB — program
- Scaffold: `anchor init ore-rush` (Anchor 1.2.2 layout, no Anchor.toml
  [provider] cluster left on localnet — switched to devnet).
- Program written: `programs/ore-rush/src/lib.rs` — 7 instructions
  (`initialize_house`, `fund_pot`, `start_round`, `delegate_session`,
  `mine`, `finish_round`, `claim`) + macro-generated `process_undelegation`.
  Session PDA is the only delegated account; house vault + leaderboard
  never leave the base layer.
- Build fixes (all from reading the vendored SDK 0.20.0 source):
  - `#[delegate]` generates `delegate_<field>` (here `delegate_session`),
    not `delegate_pda` as in SDK 0.16.2.
  - Anchor 1.2.2 `CpiContext::new` takes a `Pubkey`, not an `AccountInfo` —
    system transfers rewritten with raw `invoke` / `invoke_signed`.
  - Scaffold test `test_initialize.rs` referenced the template counter
    program — removed (it broke IDL generation).
- **Build SUCCEEDED 13:28 WIB**: `target/deploy/ore_rush.so` (338,280 bytes),
  IDL at `target/idl/ore_rush.json`. Rent-exempt minimum for deploy:
  **1.71911264 SOL**.

## 2026-11-25 ~13:30–13:45 WIB — BLOCKED: devnet SOL (RPC faucet CLOSED)
- `solana airdrop` from this VM fails. Root cause VERIFIED by direct RPC
  call 13:45 WIB: `{"code": 410, "message": "The RPC faucet is closed on
  this cluster. Request test SOL at https://faucet.solana.com"}`. The
  devnet RPC faucet is closed cluster-wide — NOT a rate limit, NOT
  IP-specific. The background airdrop retry loop was killed (futile).
  Ankr RPC needs an API key; Alchemy demo endpoint unreachable from the VM.
  No existing funded keypair on the VM (`~/.config/solana/id.json` absent).
- Deployer (throwaway): `oB6dRK5HDYnTDdH44B3SwhBv7phmiaWoxWQxnsecST3`, balance 0.
  Needs ~3.5 SOL total (1.72 rent + 1.0 pot + 0.3 player + fees).
- ONLY path left: request devnet SOL at https://faucet.solana.com in the
  live browser for the deployer address above (needs a human/CAPTCHA flow).
- Frontend builder subagent is working in parallel (waits for the IDL, which
  now exists). E2E script `scripts/e2e-devnet.mjs` is written and its deps
  installed; it runs the full round once the program is deployed + funded.

## 2026-11-25 ~13:48 WIB — FRONTEND DONE (verified as far as possible w/o deploy)
- Frontend subagent finished: `app/index.html` + `app/app.js` (31 KB) +
  `app/README.md`. Static, mobile-first, 5 panels (wallet, setup, game,
  leaderboard, status log). @solana/web3.js 1.98.0 pinned via jsDelivr UMD.
- Verified: page loads with no console errors (headless Chromium); demo
  wallet generation live-verified; all 7 instructions build + serialize
  in-browser; Node harness 41 checks pass (discriminators, PDAs incl.
  delegation PDAs, decoders); all 7 instruction account lists match the IDL.
- Not testable until deploy: game transactions + the 2 SOL balance display.
  The app detects the RPC-faucet 410 and links to faucet.solana.com.
- Top-level build log written: `~/workspace/solana-blitz-v10/FINDINGS.md`.
- REMAINING (blocked on SOL): fund deployer → `anchor deploy` → run
  `scripts/e2e-devnet.mjs` → screenshot/recording → GitHub repo (needs
  Crisye's go-ahead) → submit before Fri 27 Nov 21:00 WIB.

## Still to do
1. Fund deployer (~3.5 devnet SOL) → `anchor deploy` → verify program on
   devnet explorer.
2. Run `scripts/e2e-devnet.mjs` end-to-end (delegate → mine on ER →
   finish → claim) and record tx signatures + mine latency.
3. Finish frontend, screenshot/record the demo, verify the page end-to-end
   in a browser.
4. README polish + submission checklist (GitHub repo creation, Luma
   registration, submit click — all need Crisye's go-ahead; nothing
   submitted yet).

## Deploy + E2E — 25 Nov 2026 ~14:05-14:25 WIB (deployer funded 5 SOL by Crisye)
- `anchor deploy` OK. Program `FknaFskJcLQm3Tw4uRUEnMXvwa5xsED1FKB9NGyMY8HS`,
  ProgramData `6tmTmPZi7tnL719KNhVPS99jmrrPUpwTCzMhTHYLgSVa`, slot 526068910,
  IDL metadata `CrbKSiN3R3bwU3pRZuHSHZLqGyR6FZZ7VDZEhfvL1PC`.
  Explorer: https://explorer.solana.com/address/FknaFskJcLQm3Tw4uRUEnMXvwa5xsED1FKB9NGyMY8HS?cluster=devnet
- E2E run 2 (first full attempt): initialize_house
  `2wbacvwR12SV5T3paUzVs1Z2vjuCaB47pzWaJ7zVB6nF8aYxidt7MRDg1vEEBMhYEMPvBMyujqCg61SKJKDDE14H`,
  fund_pot 1 SOL `zeu54j1H...`, start_round `52s1Su7x...`,
  delegate_session `3H7z9sCi...` (session owner = delegation program OK),
  45 mines on ER OK (median 260 ms, p90 264 ms, max 1482 ms),
  then finish_round FAILED `Custom 2000`.
- BUG #1 (E2E script, not program): finish_round passed `magic_context` as
  non-writable, but the `#[commit]` macro declares it `mut` -> Anchor
  `ConstraintMut`. Fixed in `scripts/e2e-devnet.mjs` (`isWritable: true`).
  Frontend already had it right.
- BUG #0 (infra): VM egress proxy breaks wss, so web3.js
  `sendAndConfirmTransaction` never confirms even though txs land on-chain
  (verified: first transfer finalized on-chain while the script reported
  "block height exceeded"). `send()` in `scripts/e2e-devnet.mjs` rewritten to
  HTTP-poll `getSignatureStatuses`; mine loop confirms at "processed"
  (150 ms poll) to stay inside the 60 s round window.
- E2E run 4: 45 mines OK (median 241 ms, p90 248 ms, max 1494 ms),
  finish_round OK `p9CHBUZnScriFBcL2QJYhe3q28KBor9AWhLx559HVGEBmHYNMkzBnUMv5j9xPuDfwbyE1yAQMfLcqk782nftNXN`,
  session committed back to base with score 45, then claim FAILED:
  `Transfer: 'from' must not carry data`.
- BUG #2 (REAL program bug): `claim` paid the prize via a System Program
  transfer out of the house PDA, but the house account carries data (owned by
  the program) so the runtime rejects it. Fixed in `programs/ore-rush/src/lib.rs`:
  prize now moves by direct lamport arithmetic
  (`try_borrow_mut_lamports` on house/player). Rebuilt OK (`anchor build`).
- E2E run 4 also exposed: unconditional `fund_pot 1 SOL` per run drained the
  deployer. Script now funds the pot only if it holds < 0.5 SOL.
- BLOCKED — redeploy needs a new buffer account (rent 1.7172 SOL) but the
  deployer is short. Funding trail: 5 SOL in -> deploy ~1.735 -> players
  0.3+0.3 -> fund_pot 1+1 (house pot now 2.001 SOL). Both test players drained
  back (sigs `59REm4SFSfnMbWAU2VvSKkJFwk45jZZHGka6afC1aVy56d8JwwZbUKVnPNWCDpWLVjNPb6oTcq8pxHW56JjGctGN`,
  `4pBRTSY1GRd5REpiQT97kF1bNr315rMudC3tWqNRi7coRGVxXm13YfLyuKrT5JqFWTr5qNhF4bp2c4XeSoHMyJ3p`).
  Deployer now 1.248958854 SOL; shortfall ~0.47 SOL for the buffer, plus
  ~0.3 SOL player funding for the next E2E run. NEED ~1 SOL more devnet SOL
  from Crisye (same method as before) to redeploy + re-run E2E.
- State ready for re-run once funded: house pot 2.001 SOL; player 2 session
  `HyqzPRCGYBxqJnUv3tPx6uGx29LEf7MGQFL52xktrzoL` (score 45, claimed false,
  round over, undelegated — `start_round` will open a fresh round).
- E2E logs: `e2e-run3.log` (interrupted by VM service restart, /tmp wiped),
  `e2e-run4.log` in this directory.

## Redeploy + E2E run 5 + browser round — 25 Nov ~14:20–14:50 WIB (post-funding 5 SOL)
- Crisye sent 5 more devnet SOL (same wallet-to-wallet method) — deployer
  verified 6.248958854 SOL on-chain before redeploy.
- Redeploy attempt 1 FAILED: anchor tried to resume from the previous run's
  buffer keypair file (`DvG4q3f...`) whose account no longer exists on-chain
  (closed after the first upgrade). Attempt 2 with a fresh buffer FAILED on
  chunk writes ("Max retries exceeded" — flaky devnet RPC via VM proxy).
  Root cause found: BOTH buffer accounts actually exist on-chain (anchor's
  fetch failed, not the creation) — 2 x 1.7172 SOL rent locked. Reclaimed the
  stale buffer (`solana program close DvG4q3f...`, +1.7172 SOL back, deployer
  4.5297 SOL), resumed deploy from the live buffer `Ds16FcCB...`.
- Redeploy attempt 3 SUCCEEDED: upgrade tx
  `3oQMoUijhF8H7LrqDmdaF8jP28mMuny3nKdT3waiK45NN16SPVv6DL5LodiJMuMZSMjmMX2gUfbGN1Zn9x9mBSG8`,
  program `FknaFskJcLQm3Tw4uRUEnMXvwa5xsED1FKB9NGyMY8HS`, ProgramData
  `6tmTmPZi7tnL719KNhVPS99jmrrPUpwTCzMhTHYLgSVa`, last deployed slot 526076154,
  IDL metadata `CrbKSiN3R3bwU3pRZuHSHZLqGyR6FZZ7VDZEhfvL1PC` re-initialized.
  Explorer: https://explorer.solana.com/address/FknaFskJcLQm3Tw4uRUEnMXvwa5xsED1FKB9NGyMY8HS?cluster=devnet
- E2E run 5 (`e2e-run5.log`): 7/7 STEPS PASS. Player
  `7yn4UhK9ygQkJBiKYMxVeBLfknowRoWHzxpJVwFujcAX`, session
  `HyqzPRCGYBxqJnUv3tPx6uGx29LEf7MGQFL52xktrzoL`:
  fund player 0.3 SOL `2odW8GMi5jFwRDd548k6WojVHyjhPLC2njdaS4zRSe2EQpPyVHbX5iwLDhvZQwBmhHhR9TZEBWHpn89aUqcyvuxM`,
  start_round `3JaYV5g4EEcrrdCJFfJPqFHViN69xRTgRZUPpVJA96wvMVFVxzfM8EXiAoNy9wpBcqehjQPaZjMRMQi6yqjQpyYN`,
  delegate_session `2UodyFfsQVTmMmnikTwCh8hrKrxVnHAvfBrafMzneWbQT1DqH7YzfeSyJwsA6N1gcGTmc2mGGXHPUpGrJMGPKoGX`
  (owner -> `DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh`),
  mine 45x on ER (latency median 246 ms, p90 252 ms, max 1454 ms),
  finish_round `3K85ehrJopBs861bGGvN3tkeQ7fb7BSnB2A79mcfDrSKGgnGNKnbrVv73gt8zFrrWwoaaJpdJ9sACUt4FtpVGA3X`
  (score 45 committed, status 1, claimed false),
  CLAIM `3bZcVBejJvxfbAcXNUSCHLJUhCeUizwwmkhYsGFbfX9ZWisP4XzGLbkauviMazQoq6xZtLwsZzgFodWLCTL2URea`
  — player balance 0.2979 -> 0.3479 SOL (delta 0.049995, expected prize 0.05
  minus 0.000005 tx fee). Leaderboard: [{7yn4...jcAX, 45}]. BUG #2 FIX VERIFIED ON-CHAIN.
- Browser round (headless Chromium, same player keypair seeded in
  localStorage): full round played end-to-end from the real frontend —
  Start Round -> Delegate -> 45x MINE (last tap 209 ms) -> Finish -> Claim.
  Result: "YOU WON! 45 ores — 0.05 SOL paid to your wallet." Player balance
  0.3449 -> 0.3919 SOL; pot 1.9510 -> 1.9010 SOL; leaderboard now #1/#2 both
  7yn4...jcAX 45 ores. Browser claim tx `5FEk...jrgj` (full sig in page log).
- Screenshots (this directory): `shot-1-loaded.png` (live on-chain state),
  `shot-2-mining.png` (19 ores mid-round), `shot-3-mined-45.png` (45 ores,
  23s left, log full of ER-confirmed mines ~210 ms),
  `shot-4-after-claim.png` (YOU WON, 0.3919 SOL, leaderboard #1/#2).
- Test-env notes (NOT product bugs): headless Chromium in this VM cannot use
  the egress proxy for localhost (Playwright proxy option breaks loopback) and
  cannot open wss through it — the screenshot run used a local vendored
  web3.js copy + local JSON-RPC forwarders (ports 8546/8547) + an HTTP-polling
  confirm patch, all in /tmp only. The deliverable `app/` is untouched (CDN
  web3.js, websocket confirm). Real users' browsers are unaffected.
- Minor cosmetic issue (frontend, no redeploy needed): after Claim, the timer
  line still reads "Round started — delegate to the ER to mine." instead of a
  post-claim message. Optional 1-line fix in app.js.
- Final balances: deployer 5.945113598 SOL; player 0.3919 SOL; house pot
  1.9010 SOL. No GitHub repo created, nothing submitted/registered.

## Timer-text fix (submit prep, 2026-11-25 ~08:00 UTC)
- Fixed `app/app.js` `updateGameUi()`: finished sessions now set the timer line
  explicitly — claimed: "✅ Round over — prize claimed. Start a new round to
  play again."; finished/unclaimed: "🏁 Round over — hit Claim to close the
  round." Previously the text kept the stale "Round started — delegate to the
  ER to mine." after Claim (tickTimer returns early once status != 1).
- Verified in headless Chromium with the real run-5 winning wallet
  (7yn4…jcAX, 45 ores, claimed): timer shows the new message, round status
  pill "claimed", zero console/page/request errors. Screenshot:
  `shot-5-round-claimed.png`. (Note: this session's egress proxy blocks the
  browser's CDN/RPC; verification ran against a /tmp copy with web3.js 1.98.0
  vendored byte-identical + RPC via a local forwarder to the real devnet —
  shipped `app/` is unchanged apart from the timer fix.)
