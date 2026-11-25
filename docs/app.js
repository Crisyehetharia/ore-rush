/* ORE RUSH — frontend (static, no build step, no backend)
 *
 * Devnet only. Play money only. No real funds, no secrets in this file.
 *
 * How it works:
 *  - Base layer (https://api.devnet.solana.com): wallet, airdrop,
 *    initialize_house / fund_pot / start_round / delegate_session / claim.
 *  - Ephemeral Rollup (https://devnet-us.magicblock.app): mine + finish_round.
 *    ER transactions are sent with skipPreflight: true, commitment "confirmed".
 *  - Instructions are encoded manually with @solana/web3.js (no Anchor in the
 *    browser). Discriminator = first 8 bytes of sha256("global:<ix_name>").
 *  - The account list of every instruction is taken from the program IDL
 *    (target/idl/ore_rush.json). The #[delegate] / #[commit] macros inject
 *    extra accounts — those are listed in IDL_ACCOUNTS below, copied from the
 *    IDL, never guessed.
 */

"use strict";

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

const PROGRAM_ID = new solanaWeb3.PublicKey("FknaFskJcLQm3Tw4uRUEnMXvwa5xsED1FKB9NGyMY8HS");
const DELEGATION_PROGRAM_ID = new solanaWeb3.PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");
// Magic program + Magic context (injected by the #[commit] macro).
const MAGIC_PROGRAM_ID = new solanaWeb3.PublicKey("Magic11111111111111111111111111111111111111");
const MAGIC_CONTEXT_ID = new solanaWeb3.PublicKey("MagicContext1111111111111111111111111111111");
// Devnet-us ER validator pubkey — passed as a remaining account on delegate_session.
const ER_VALIDATOR = new solanaWeb3.PublicKey("MUS3hc9TCw4cGC12vHNoYcCGzJG1txjgQLZWVoeNHNd");

const BASE_RPC = "https://api.devnet.solana.com";
const ER_RPC = "https://devnet-us.magicblock.app";
const EXPLORER_TX = (sig) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
const EXPLORER_ADDR = (addr) => `https://explorer.solana.com/address/${addr}?cluster=devnet`;

const ROUND_SECONDS = 60;
const MIN_SCORE = 40;
const PRIZE_SOL = 0.05;
const LAMPORTS_PER_SOL = 1_000_000_000;
const WALLET_STORAGE_KEY = "ore-rush-demo-wallet-v1";

/* ------------------------------------------------------------------ */
/* IDL-derived account lists (source of truth: target/idl/ore_rush.json)
 *
 * Each entry: { name, isSigner, isWritable } in IDL order.
 * "pda" entries are resolved at call time (house / session / leaderboard).
 * "pdaFn" entries are PDAs derived from the session PDA (see derivePdas).
 * "pubkey" entries are fixed program/context addresses.
 * "remaining" entries are appended after the IDL accounts.
 *
 * delegate_session / finish_round lists below come from expanding the
 * ephemeral-rollups-sdk 0.20.0 #[delegate] / #[commit] macros against the
 * program source, and were VERIFIED against target/idl/ore_rush.json
 * (2026-11-25, IDL check script: all 7 instructions — names, order,
 * signer/writable flags, discriminators, PDA seeds — match the IDL).
 * If `anchor build` regenerates the IDL, re-run that check; the IDL wins.
 * ------------------------------------------------------------------ */

const IDL_ACCOUNTS = {
  initialize_house: [
    { name: "house", pda: "house", isSigner: false, isWritable: true },
    { name: "leaderboard", pda: "leaderboard", isSigner: false, isWritable: true },
    { name: "authority", who: "payer", isSigner: true, isWritable: true },
    { name: "system_program", program: "SystemProgram", isSigner: false, isWritable: false },
  ],
  fund_pot: [
    { name: "house", pda: "house", isSigner: false, isWritable: true },
    { name: "funder", who: "payer", isSigner: true, isWritable: true },
    { name: "system_program", program: "SystemProgram", isSigner: false, isWritable: false },
  ],
  start_round: [
    { name: "house", pda: "house", isSigner: false, isWritable: false },
    { name: "session", pda: "session", isSigner: false, isWritable: true },
    { name: "player", who: "payer", isSigner: true, isWritable: true },
    { name: "system_program", program: "SystemProgram", isSigner: false, isWritable: false },
  ],
  // #[delegate] macro expansion (ephemeral-rollups-sdk 0.20.0):
  // for the `del` field `session` it injects buffer / delegation_record /
  // delegation_metadata PDAs before the field, then appends owner_program,
  // delegation_program, system_program. Order = struct field order.
  delegate_session: [
    { name: "payer", who: "payer", isSigner: true, isWritable: false },
    { name: "buffer_session", pdaFn: "delegate_buffer", isSigner: false, isWritable: true },
    { name: "delegation_record_session", pdaFn: "delegation_record", isSigner: false, isWritable: true },
    { name: "delegation_metadata_session", pdaFn: "delegation_metadata", isSigner: false, isWritable: true },
    { name: "session", pda: "session", isSigner: false, isWritable: true },
    { name: "owner_program", pubkey: "FknaFskJcLQm3Tw4uRUEnMXvwa5xsED1FKB9NGyMY8HS", isSigner: false, isWritable: false },
    { name: "delegation_program", pubkey: "DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh", isSigner: false, isWritable: false },
    { name: "system_program", program: "SystemProgram", isSigner: false, isWritable: false },
  ],
  mine: [
    { name: "session", pda: "session", isSigner: false, isWritable: true },
    { name: "player", who: "payer", isSigner: true, isWritable: false },
  ],
  // #[commit] macro expansion: appends magic_program, then magic_context.
  finish_round: [
    { name: "payer", who: "payer", isSigner: true, isWritable: true },
    { name: "session", pda: "session", isSigner: false, isWritable: true },
    { name: "magic_program", pubkey: "Magic11111111111111111111111111111111111111", isSigner: false, isWritable: false },
    { name: "magic_context", pubkey: "MagicContext1111111111111111111111111111111", isSigner: false, isWritable: true },
  ],
  claim: [
    { name: "house", pda: "house", isSigner: false, isWritable: true },
    { name: "leaderboard", pda: "leaderboard", isSigner: false, isWritable: true },
    { name: "session", pda: "session", isSigner: false, isWritable: true },
    { name: "player", who: "payer", isSigner: true, isWritable: true },
    { name: "system_program", program: "SystemProgram", isSigner: false, isWritable: false },
  ],
};

/* ------------------------------------------------------------------ */
/* Connections + state                                                 */
/* ------------------------------------------------------------------ */

const baseConn = new solanaWeb3.Connection(BASE_RPC, "confirmed");
const erConn = new solanaWeb3.Connection(ER_RPC, "confirmed");

const state = {
  keypair: null,          // demo Keypair (or null when Phantom is active)
  phantom: null,          // window.solana provider when connected
  publicKey: null,        // active player pubkey
  discriminators: {},     // ix name -> Uint8Array(8), computed at boot
  housePda: null, sessionPda: null, leaderboardPda: null,
  delegateBufferPda: null, delegationRecordPda: null, delegationMetadataPda: null,
  houseBump: 0, sessionBump: 0, leaderboardBump: 0,
  session: null,          // last decoded Session account (or null)
  sessionOnEr: false,     // true after delegate, until finish/claim
  endsAt: 0,              // unix seconds, from session.ends_at
  timerHandle: null,
  mining: false,          // a mine tx is in flight
  lastMineSig: null,
};

/* ------------------------------------------------------------------ */
/* Small DOM + log helpers                                             */
/* ------------------------------------------------------------------ */

const $ = (id) => document.getElementById(id);

// Browsers have no Node Buffer — UTF-8 bytes via TextEncoder instead.
const utf8 = (s) => new TextEncoder().encode(s);

function shortAddr(pk) {
  const s = pk.toBase58 ? pk.toBase58() : String(pk);
  return s.slice(0, 4) + "…" + s.slice(-4);
}

function log(msg, kind = "info") {
  const el = $("log");
  const line = document.createElement("div");
  const time = new Date().toLocaleTimeString([], { hour12: false });
  line.innerHTML = `<span class="t-info">[${time}]</span> <span class="t-${kind}">${msg}</span>`;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
}

function logTx(label, sig) {
  log(`${label} <a class="t-tx" href="${EXPLORER_TX(sig)}" target="_blank" rel="noopener">${shortAddr({ toBase58: () => sig })} ↗</a>`, "tx");
}

function setBusy(btn, busy, labelWhileBusy) {
  if (!btn) return;
  if (busy) { btn.dataset.label = btn.textContent; btn.textContent = labelWhileBusy || "Working…"; btn.disabled = true; }
  else { btn.textContent = btn.dataset.label || btn.textContent; btn.disabled = false; }
}

/* ------------------------------------------------------------------ */
/* Discriminators: first 8 bytes of sha256("global:<name>")           */
/* ------------------------------------------------------------------ */

async function computeDiscriminators() {
  const names = ["initialize_house", "fund_pot", "start_round", "delegate_session", "mine", "finish_round", "claim"];
  for (const name of names) {
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`global:${name}`));
    state.discriminators[name] = new Uint8Array(hash).slice(0, 8);
  }
}

function discHex(name) {
  return [...state.discriminators[name]].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/* ------------------------------------------------------------------ */
/* PDAs                                                                */
/* ------------------------------------------------------------------ */

function derivePdas() {
  const [house, hb] = solanaWeb3.PublicKey.findProgramAddressSync([utf8("house")], PROGRAM_ID);
  const [lb, lbb] = solanaWeb3.PublicKey.findProgramAddressSync([utf8("leaderboard")], PROGRAM_ID);
  const [session, sb] = solanaWeb3.PublicKey.findProgramAddressSync(
    [utf8("session"), state.publicKey.toBuffer()], PROGRAM_ID);
  state.housePda = house; state.houseBump = hb;
  state.leaderboardPda = lb; state.leaderboardBump = lbb;
  state.sessionPda = session; state.sessionBump = sb;
  // Delegation PDAs (magicblock-delegation-program-api 3.1.0 pda.rs):
  // buffer is seeded under the owner program; record/metadata under the
  // delegation program. All are seeded with the delegated account (session).
  const [buf] = solanaWeb3.PublicKey.findProgramAddressSync(
    [utf8("buffer"), session.toBuffer()], PROGRAM_ID);
  const [rec] = solanaWeb3.PublicKey.findProgramAddressSync(
    [utf8("delegation"), session.toBuffer()], DELEGATION_PROGRAM_ID);
  const [meta] = solanaWeb3.PublicKey.findProgramAddressSync(
    [utf8("delegation-metadata"), session.toBuffer()], DELEGATION_PROGRAM_ID);
  state.delegateBufferPda = buf;
  state.delegationRecordPda = rec;
  state.delegationMetadataPda = meta;
}

function pdaFor(entry) {
  if (entry.pda === "house") return state.housePda;
  if (entry.pda === "session") return state.sessionPda;
  if (entry.pda === "leaderboard") return state.leaderboardPda;
  if (entry.pdaFn === "delegate_buffer") return state.delegateBufferPda;
  if (entry.pdaFn === "delegation_record") return state.delegationRecordPda;
  if (entry.pdaFn === "delegation_metadata") return state.delegationMetadataPda;
  throw new Error(`Unknown PDA entry: ${entry.pda || entry.pdaFn}`);
}

/* ------------------------------------------------------------------ */
/* Instruction builders (manual encoding, no Anchor in the browser)   */
/* ------------------------------------------------------------------ */

function u64le(n) {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(n), true);
  return b;
}

function concatBytes(...parts) {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

// Build the AccountMeta list for an instruction from its IDL account list.
function buildKeys(ixName, remaining = []) {
  const spec = IDL_ACCOUNTS[ixName];
  if (spec === "PENDING-IDL" || !spec) {
    throw new Error(`${ixName}: account list not loaded from the IDL yet — see README.md`);
  }
  const keys = spec.map((e) => {
    let pubkey;
    if (e.pda || e.pdaFn) pubkey = pdaFor(e);
    else if (e.who === "payer") pubkey = state.publicKey;
    else if (e.program === "SystemProgram") pubkey = solanaWeb3.SystemProgram.programId;
    else if (e.pubkey) pubkey = new solanaWeb3.PublicKey(e.pubkey);
    else throw new Error(`${ixName}: cannot resolve account ${e.name}`);
    return { pubkey, isSigner: e.isSigner, isWritable: e.isWritable };
  });
  for (const r of remaining) keys.push(r);
  return keys;
}

function buildIx(ixName, data, remaining = []) {
  return new solanaWeb3.TransactionInstruction({
    programId: PROGRAM_ID,
    keys: buildKeys(ixName, remaining),
    data,
  });
}

const ixBuilders = {
  initialize_house: () => buildIx("initialize_house", state.discriminators.initialize_house),
  fund_pot: (amountLamports) =>
    buildIx("fund_pot", concatBytes(state.discriminators.fund_pot, u64le(amountLamports))),
  start_round: () => buildIx("start_round", state.discriminators.start_round),
  delegate_session: () => buildIx("delegate_session", state.discriminators.delegate_session, [
    // ER validator pubkey is passed as a remaining account (key only).
    { pubkey: ER_VALIDATOR, isSigner: false, isWritable: false },
  ]),
  mine: () => buildIx("mine", state.discriminators.mine),
  finish_round: () => buildIx("finish_round", state.discriminators.finish_round),
  claim: () => buildIx("claim", state.discriminators.claim),
};

/* ------------------------------------------------------------------ */
/* Sending                                                             */
/* ------------------------------------------------------------------ */

// Sign with the demo keypair, or with Phantom when it is the active wallet.
async function signTx(tx) {
  if (state.phantom) {
    return await state.phantom.signTransaction(tx);
  }
  tx.partialSign(state.keypair);
  return tx;
}

// Base-layer send (standard preflight).
async function sendBase(ix, label) {
  const tx = new solanaWeb3.Transaction().add(ix);
  tx.feePayer = state.publicKey;
  tx.recentBlockhash = (await baseConn.getLatestBlockhash("confirmed")).blockhash;
  const signed = await signTx(tx);
  const sig = await baseConn.sendRawTransaction(signed.serialize(), { skipPreflight: false });
  log(`${label} sent — awaiting confirmation…`, "info");
  await baseConn.confirmTransaction(sig, "confirmed");
  logTx(`${label} confirmed`, sig);
  return sig;
}

// Ephemeral Rollup send: skipPreflight + "confirmed" (ER requirement).
async function sendEr(ix, label) {
  const tx = new solanaWeb3.Transaction().add(ix);
  tx.feePayer = state.publicKey;
  tx.recentBlockhash = (await erConn.getLatestBlockhash("confirmed")).blockhash;
  const signed = await signTx(tx);
  const t0 = performance.now();
  const sig = await erConn.sendRawTransaction(signed.serialize(), { skipPreflight: true });
  await erConn.confirmTransaction(sig, "confirmed");
  const ms = Math.round(performance.now() - t0);
  logTx(`${label} confirmed on ER in ${ms} ms`, sig);
  return { sig, ms };
}

/* ------------------------------------------------------------------ */
/* Account decoding (layouts from the IDL account structs)             */
/*                                                                     */
/* House:       disc(8) + authority(32) + prize(8) + min_score(8)     */
/*              + round_duration(8) + total_paid(8) + bump(1)         */
/* Session:     disc(8) + player(32) + score(8) + started_at(8)       */
/*              + ends_at(8) + status(1) + claimed(1) + bump(1)       */
/* Leaderboard: disc(8) + 5 x (player(32) + score(8))                 */
/* ------------------------------------------------------------------ */

function readU64(buf, off) { return Number(new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getBigUint64(off, true)); }
function readI64(buf, off) { return Number(new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getBigInt64(off, true)); }

function decodeHouse(data) {
  if (!data || data.length < 73) return null;
  return {
    authority: new solanaWeb3.PublicKey(data.slice(8, 40)),
    prizeLamports: readU64(data, 40),
    minScore: readU64(data, 48),
    roundDuration: readI64(data, 56),
    totalPaid: readU64(data, 64),
    bump: data[72],
  };
}

function decodeSession(data) {
  if (!data || data.length < 59) return null;
  return {
    player: new solanaWeb3.PublicKey(data.slice(8, 40)),
    score: readU64(data, 40),
    startedAt: readI64(data, 48),
    endsAt: readI64(data, 56),
    status: data[64],
    claimed: data[65] === 1,
    bump: data[66],
  };
}

function decodeLeaderboard(data) {
  if (!data || data.length < 208) return [];
  const entries = [];
  for (let i = 0; i < 5; i++) {
    const off = 8 + i * 40;
    const player = new solanaWeb3.PublicKey(data.slice(off, off + 32));
    const score = readU64(data, off + 32);
    if (score > 0) entries.push({ player, score });
  }
  return entries;
}

/* ------------------------------------------------------------------ */
/* Reads                                                               */
/* ------------------------------------------------------------------ */

async function refreshWallet() {
  if (!state.publicKey) return;
  $("walletAddr").textContent = shortAddr(state.publicKey);
  try {
    const lamports = await baseConn.getBalance(state.publicKey, "confirmed");
    $("walletBalance").textContent = (lamports / LAMPORTS_PER_SOL).toFixed(4) + " SOL";
  } catch (e) { $("walletBalance").textContent = "error"; log(`Balance read failed: ${e.message}`, "err"); }
  try {
    const erLamports = await erConn.getBalance(state.publicKey, "confirmed");
    $("erBalance").textContent = (erLamports / LAMPORTS_PER_SOL).toFixed(4) + " SOL";
  } catch (e) { $("erBalance").textContent = "n/a (ER down?)"; }
}

async function refreshHouse() {
  try {
    const info = await baseConn.getAccountInfo(state.housePda, "confirmed");
    if (!info) {
      $("houseStatus").innerHTML = '<span class="pill grey">not initialized</span>';
      $("potBalance").textContent = "—";
      return false;
    }
    const house = decodeHouse(info.data);
    $("potBalance").textContent = (info.lamports / LAMPORTS_PER_SOL).toFixed(4) + " SOL";
    $("houseStatus").innerHTML = '<span class="pill green">live</span>';
    return house;
  } catch (e) { log(`House read failed: ${e.message}`, "err"); return false; }
}

// While delegated, the ER holds the fresh session state — read there first.
async function refreshSession() {
  try {
    let info = null;
    if (state.sessionOnEr) {
      try { info = await erConn.getAccountInfo(state.sessionPda, "confirmed"); } catch (_) { /* fall through to base */ }
    }
    if (!info) info = await baseConn.getAccountInfo(state.sessionPda, "confirmed");
    if (!info) { state.session = null; updateGameUi(); return null; }
    state.session = decodeSession(info.data);
    updateGameUi();
    return state.session;
  } catch (e) { log(`Session read failed: ${e.message}`, "err"); return null; }
}

async function refreshLeaderboard() {
  const box = $("leaderboard");
  try {
    const info = await baseConn.getAccountInfo(state.leaderboardPda, "confirmed");
    if (!info) { box.innerHTML = '<p class="muted">Leaderboard not initialized yet (house not set up).</p>'; return; }
    const entries = decodeLeaderboard(info.data);
    if (entries.length === 0) { box.innerHTML = '<p class="muted">No scores yet — be the first to mine!</p>'; return; }
    box.innerHTML = entries.map((e, i) =>
      `<div class="lb-row"><span><span class="lb-rank">#${i + 1}</span> <span class="mono">${shortAddr(e.player)}</span></span><b>${e.score} ores</b></div>`
    ).join("");
  } catch (e) { box.innerHTML = `<p class="muted">Failed to load: ${e.message}</p>`; }
}

async function refreshAll() {
  await refreshWallet();
  await refreshHouse();
  await refreshSession();
  await refreshLeaderboard();
}

/* ------------------------------------------------------------------ */
/* Game UI: countdown, mine button state                               */
/* ------------------------------------------------------------------ */

function roundActive() {
  if (!state.session || state.session.status !== 1) return false;
  return Date.now() / 1000 < state.session.endsAt;
}

function updateGameUi() {
  const s = state.session;
  const active = roundActive();
  $("oreCount").textContent = s ? s.score : 0;
  $("mineBtn").disabled = !active || !state.sessionOnEr || state.mining;
  if (!s) {
    $("roundStatus").innerHTML = '<span class="pill grey">idle</span>';
    $("timerText").textContent = "No active round — start one above.";
    $("timerBar").style.width = "100%";
    $("timerBar").style.background = "var(--green)";
    return;
  }
  if (s.status === 1 && active) {
    $("roundStatus").innerHTML = '<span class="pill green">● mining live</span>';
  } else if (s.status === 1) {
    $("roundStatus").innerHTML = '<span class="pill red">time up — finish the round</span>';
  } else {
    $("roundStatus").innerHTML = s.claimed
      ? '<span class="pill grey">claimed</span>'
      : '<span class="pill grey">finished — claim below</span>';
  }
  if (!state.sessionOnEr && s.status === 1) {
    $("timerText").textContent = "Round started — delegate to the ER to mine.";
  } else if (s.status !== 1) {
    $("timerText").textContent = s.claimed
      ? "✅ Round over — prize claimed. Start a new round to play again."
      : "🏁 Round over — hit Claim to close the round.";
  }
}

function tickTimer() {
  if (!state.session || state.session.status !== 1) return;
  const now = Date.now() / 1000;
  const remain = Math.max(0, state.session.endsAt - now);
  const total = state.session.endsAt - state.session.startedAt || ROUND_SECONDS;
  const pct = Math.max(0, Math.min(100, (remain / total) * 100));
  $("timerBar").style.width = pct + "%";
  $("timerBar").style.background = remain <= 10 ? "var(--red)" : remain <= 20 ? "var(--accent)" : "var(--green)";
  $("timerText").textContent = remain > 0
    ? `⏱ ${Math.ceil(remain)}s left — mine fast!`
    : "⏱ Time's up! Hit Finish Round, then Claim.";
  if (remain <= 0) updateGameUi();
}

/* ------------------------------------------------------------------ */
/* Actions                                                             */
/* ------------------------------------------------------------------ */

async function doAirdrop(btn) {
  setBusy(btn, true, "Requesting…");
  try {
    const sig = await baseConn.requestAirdrop(state.publicKey, 2 * LAMPORTS_PER_SOL);
    await baseConn.confirmTransaction(sig, "confirmed");
    logTx("Airdrop of 2 SOL confirmed", sig);
    await refreshWallet();
  } catch (e) {
    // The RPC faucet is closed cluster-wide (HTTP 410, verified 2026-11-25
    // on api.devnet.solana.com and rpcpool). Point at the web faucet instead.
    if (/410|faucet is closed/i.test(e.message)) {
      log(`Airdrop failed: the devnet RPC faucet is closed (410). Get test SOL at <a href="https://faucet.solana.com" target="_blank" rel="noopener">faucet.solana.com</a> for ${shortAddr(state.publicKey)}, then hit Refresh.`, "err");
    } else {
      log(`Airdrop failed: ${e.message}`, "err");
    }
  } finally { setBusy(btn, false); }
}

async function doInitHouse(btn) {
  setBusy(btn, true);
  try {
    const sig = await sendBase(ixBuilders.initialize_house(), "Initialize house");
    log(`House PDA: ${state.housePda.toBase58()}`, "info");
    await refreshHouse(); await refreshLeaderboard();
  } catch (e) { log(`Initialize house failed: ${e.message}`, "err"); }
  finally { setBusy(btn, false); }
}

async function doFundPot(btn) {
  setBusy(btn, true);
  try {
    await sendBase(ixBuilders.fund_pot(0.2 * LAMPORTS_PER_SOL), "Fund pot (+0.2 SOL)");
    await refreshHouse();
  } catch (e) { log(`Fund pot failed: ${e.message}`, "err"); }
  finally { setBusy(btn, false); }
}

async function doStartRound(btn) {
  setBusy(btn, true);
  try {
    await sendBase(ixBuilders.start_round(), "Start round");
    state.sessionOnEr = false;
    await refreshSession();
    log("Round started — 60s window open. Now delegate to the ER to mine.", "ok");
  } catch (e) { log(`Start round failed: ${e.message}`, "err"); }
  finally { setBusy(btn, false); }
}

async function doDelegate(btn) {
  setBusy(btn, true);
  try {
    await sendBase(ixBuilders.delegate_session(), "Delegate session to ER");
    state.sessionOnEr = true;
    await refreshSession();
    log("Session delegated — MINE button is live on the Ephemeral Rollup.", "ok");
    updateGameUi();
  } catch (e) { log(`Delegate failed: ${e.message}`, "err"); }
  finally { setBusy(btn, false); }
}

async function doMine() {
  if (state.mining || !roundActive() || !state.sessionOnEr) return;
  state.mining = true;
  updateGameUi();
  try {
    const { sig, ms } = await sendEr(ixBuilders.mine(), "Mine ⛏️");
    $("lastLatency").textContent = ms + " ms";
    $("lastMineTx").innerHTML = `<a href="${EXPLORER_TX(sig)}" target="_blank" rel="noopener">${shortAddr({ toBase58: () => sig })}</a>`;
    // Optimistic +1; the true score is re-read right after.
    if (state.session) state.session.score += 1;
    updateGameUi();
    refreshSession(); // background re-read from the ER (no await — keep taps fast)
  } catch (e) {
    log(`Mine failed: ${e.message}`, "err");
  } finally {
    state.mining = false;
    updateGameUi();
  }
}

async function doFinish(btn) {
  setBusy(btn, true);
  try {
    await sendEr(ixBuilders.finish_round(), "Finish round (commit + undelegate)");
    state.sessionOnEr = false;
    await refreshSession();
    log("Round finished and session returned to the base layer. Claim when the timer has ended.", "ok");
  } catch (e) { log(`Finish round failed: ${e.message}`, "err"); }
  finally { setBusy(btn, false); }
}

async function doClaim(btn) {
  setBusy(btn, true);
  try {
    const scoreBefore = state.session ? state.session.score : 0;
    await sendBase(ixBuilders.claim(), "Claim");
    await refreshSession(); await refreshHouse(); await refreshLeaderboard(); await refreshWallet();
    const won = scoreBefore >= MIN_SCORE;
    const box = $("resultBox");
    box.classList.remove("hidden");
    box.textContent = won
      ? `🎉 YOU WON! ${scoreBefore} ores — ${PRIZE_SOL} SOL paid to your wallet.`
      : `😢 ${scoreBefore} ores — need ${MIN_SCORE} to win. No prize this round.`;
    box.style.color = won ? "var(--green)" : "var(--red)";
    log(won ? `Prize of ${PRIZE_SOL} SOL claimed.` : "Round claimed — below the win threshold.", won ? "ok" : "info");
  } catch (e) { log(`Claim failed: ${e.message}`, "err"); }
  finally { setBusy(btn, false); }
}

/* ------------------------------------------------------------------ */
/* Wallet: demo keypair in localStorage (+ optional Phantom)           */
/* ------------------------------------------------------------------ */

function loadOrCreateWallet() {
  try {
    const saved = localStorage.getItem(WALLET_STORAGE_KEY);
    if (saved) {
      const secret = Uint8Array.from(JSON.parse(saved));
      state.keypair = solanaWeb3.Keypair.fromSecretKey(secret);
      log("Demo wallet restored from this browser.", "info");
      return;
    }
  } catch (e) { log(`Could not restore saved wallet: ${e.message}`, "err"); }
  createNewWallet();
}

function createNewWallet() {
  state.keypair = solanaWeb3.Keypair.generate();
  state.phantom = null;
  try {
    localStorage.setItem(WALLET_STORAGE_KEY, JSON.stringify([...state.keypair.secretKey]));
  } catch (e) { log(`Could not save wallet: ${e.message}`, "err"); }
  state.publicKey = state.keypair.publicKey;
  derivePdas();
  log(`New demo wallet created: ${state.publicKey.toBase58()}`, "ok");
}

async function connectPhantom() {
  try {
    const provider = window.solana;
    const resp = await provider.connect();
    state.phantom = provider;
    state.keypair = null;
    state.publicKey = resp.publicKey;
    derivePdas();
    log(`Phantom connected: ${state.publicKey.toBase58()}`, "ok");
    await refreshAll();
  } catch (e) { log(`Phantom connect failed: ${e.message}`, "err"); }
}

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

async function boot() {
  log("ORE RUSH loading… (devnet only)", "info");
  if (typeof solanaWeb3 === "undefined") {
    log("ERROR: @solana/web3.js failed to load from the CDN. Check your connection and reload.", "err");
    return;
  }
  await computeDiscriminators();
  log("Instruction discriminators computed (sha256 global:<name>).", "info");
  for (const [name, d] of Object.entries(state.discriminators)) {
    log(`disc ${name} = ${discHex(name)}`, "info");
  }

  // Phantom is optional — demo wallet is primary.
  if (window.solana && window.solana.isPhantom) {
    $("phantomBtn").classList.remove("hidden");
    log("Phantom detected — optional connect available.", "info");
  }

  loadOrCreateWallet();
  state.publicKey = state.publicKey || state.keypair.publicKey;
  derivePdas();
  $("programLink").href = EXPLORER_ADDR(PROGRAM_ID.toBase58());
  $("programLink").textContent = PROGRAM_ID.toBase58();
  log(`House PDA: ${state.housePda.toBase58()}`, "info");
  log(`Session PDA: ${state.sessionPda.toBase58()}`, "info");
  log(`Leaderboard PDA: ${state.leaderboardPda.toBase58()}`, "info");

  // Wire up buttons.
  $("newWalletBtn").addEventListener("click", async () => {
    createNewWallet(); state.sessionOnEr = false; state.session = null;
    $("resultBox").classList.add("hidden"); updateGameUi(); await refreshAll();
  });
  $("airdropBtn").addEventListener("click", (e) => doAirdrop(e.currentTarget));
  $("phantomBtn").addEventListener("click", connectPhantom);
  $("initHouseBtn").addEventListener("click", (e) => doInitHouse(e.currentTarget));
  $("fundPotBtn").addEventListener("click", (e) => doFundPot(e.currentTarget));
  $("startRoundBtn").addEventListener("click", (e) => doStartRound(e.currentTarget));
  $("delegateBtn").addEventListener("click", (e) => doDelegate(e.currentTarget));
  $("mineBtn").addEventListener("click", doMine);
  $("finishBtn").addEventListener("click", (e) => doFinish(e.currentTarget));
  $("claimBtn").addEventListener("click", (e) => doClaim(e.currentTarget));
  $("refreshLbBtn").addEventListener("click", refreshLeaderboard);
  $("refreshAllBtn").addEventListener("click", refreshAll);
  $("clearLogBtn").addEventListener("click", () => { $("log").innerHTML = ""; });

  state.timerHandle = setInterval(tickTimer, 250);
  await refreshAll();
  log("Ready. Airdrop 2 SOL, then Start Round → Delegate → MINE!", "ok");
}

// Debug handle for automated checks (not part of the game UI).
window.ORE_RUSH_DEBUG = {
  state, PROGRAM_ID, IDL_ACCOUNTS, ixBuilders, decodeHouse, decodeSession, decodeLeaderboard,
  derivePdas, discHex, EXPLORER_TX,
};

document.addEventListener("DOMContentLoaded", boot);
