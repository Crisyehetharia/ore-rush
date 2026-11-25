// ORE RUSH — end-to-end devnet test (headless).
// Runs one full game round against the deployed program + the devnet-us ER:
//   initialize_house -> fund_pot -> start_round -> delegate_session
//   -> mine x N (on ER) -> finish_round (on ER) -> claim (base) -> leaderboard
// Usage: node e2e-devnet.mjs [mines]
// Requires: deployer funded with devnet SOL (see README). No real funds.
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE_RPC = "https://api.devnet.solana.com";
const ER_RPC = "https://devnet-us.magicblock.app";
const PROGRAM_ID = new PublicKey("FknaFskJcLQm3Tw4uRUEnMXvwa5xsED1FKB9NGyMY8HS");
const DELEGATION_PROGRAM_ID = new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");
const MAGIC_PROGRAM_ID = new PublicKey("Magic11111111111111111111111111111111111111");
const MAGIC_CONTEXT_ID = new PublicKey("MagicContext1111111111111111111111111111111");
const ER_VALIDATOR = new PublicKey("MUS3hc9TCw4cGC12vHNoYcCGzJG1txjgQLZWVoeNHNd");

const MINES = Number(process.argv[2] ?? 45);
const PRIZE_SOL = 0.05;

const base = new Connection(BASE_RPC, "confirmed");
const er = new Connection(ER_RPC, "confirmed");

const disc = (name) =>
  createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
const u64le = (n) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};
const explorer = (sig) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
const pda = (seeds, program = PROGRAM_ID) =>
  PublicKey.findProgramAddressSync(seeds, program)[0];

function loadKeypair(path) {
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(path, "utf8")))
  );
}

// Send + confirm via HTTP polling only. The VM's egress proxy breaks the
// websocket (wss) subscription that web3.js `sendAndConfirmTransaction`
// relies on (TLS EPROTO "wrong version number"), so confirmations never
// arrive even though the tx lands on-chain. Polling getSignatureStatuses
// over plain HTTPS works. `opts.commitment` defaults to "confirmed"; the
// mine loop passes "processed" to stay inside the 60s round window.
const CONF_RANK = { processed: 0, confirmed: 1, finalized: 2 };
async function send(conn, ix, signers, opts = {}) {
  const tx = new Transaction().add(ix);
  tx.feePayer = signers[0].publicKey;
  const { blockhash, lastValidBlockHeight } =
    await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.sign(...signers);
  const sig = await conn.sendRawTransaction(tx.serialize(), {
    skipPreflight: opts.skipPreflight ?? false,
  });
  const want = opts.commitment ?? "confirmed";
  const pollMs = opts.pollMs ?? 250;
  const deadline = Date.now() + 90_000;
  let polls = 0;
  while (Date.now() < deadline) {
    const [st] = (await conn.getSignatureStatuses([sig])).value;
    if (st) {
      if (st.err) throw new Error(`tx failed: ${JSON.stringify(st.err)} (${sig})`);
      if (CONF_RANK[st.confirmationStatus] >= CONF_RANK[want]) return sig;
    }
    if (++polls % 8 === 0) {
      const height = await conn.getBlockHeight("confirmed").catch(() => 0);
      if (height > lastValidBlockHeight)
        throw new Error(`tx expired (block height exceeded): ${sig}`);
    }
    await sleep(pollMs);
  }
  throw new Error(`tx confirmation timeout: ${sig}`);
}

function decodeSession(data) {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    player: new PublicKey(data.subarray(8, 40)).toBase58(),
    score: Number(v.getBigUint64(40, true)),
    startedAt: Number(v.getBigInt64(48, true)),
    endsAt: Number(v.getBigInt64(56, true)),
    status: v.getUint8(64),
    claimed: v.getUint8(65) === 1,
  };
}

function decodeBoard(data) {
  const out = [];
  for (let i = 0; i < 5; i++) {
    const off = 8 + i * 40;
    const player = new PublicKey(data.subarray(off, off + 32)).toBase58();
    const score = Number(
      new DataView(data.buffer, data.byteOffset + off + 32, 8).getBigUint64(0, true)
    );
    if (score > 0) out.push({ player: `${player.slice(0, 4)}…${player.slice(-4)}`, score });
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const deployer = loadKeypair(join(__dirname, "..", "deployer-keypair.json"));
  const playerPath = join(__dirname, "player-keypair.json");
  const player = existsSync(playerPath)
    ? loadKeypair(playerPath)
    : Keypair.generate();
  if (!existsSync(playerPath))
    writeFileSync(playerPath, JSON.stringify(Array.from(player.secretKey)));
  console.log("deployer:", deployer.publicKey.toBase58());
  console.log("player:   ", player.publicKey.toBase58());

  const house = pda([Buffer.from("house")]);
  const board = pda([Buffer.from("leaderboard")]);
  const session = pda([Buffer.from("session"), player.publicKey.toBuffer()]);
  const buffer = pda([Buffer.from("buffer"), session.toBuffer()]);
  const record = pda(
    [Buffer.from("delegation"), session.toBuffer()],
    DELEGATION_PROGRAM_ID
  );
  const metadata = pda(
    [Buffer.from("delegation-metadata"), session.toBuffer()],
    DELEGATION_PROGRAM_ID
  );
  console.log("house:    ", house.toBase58());
  console.log("session:  ", session.toBase58());

  const bal = (k) => base.getBalance(k).then((b) => (b / 1e9).toFixed(4));
  console.log("deployer balance:", await bal(deployer.publicKey), "SOL");
  console.log("player balance:  ", await bal(player.publicKey), "SOL");

  // Fund the player from the deployer (avoids a second faucet call).
  const pBal = await base.getBalance(player.publicKey);
  if (pBal < 0.2 * 1e9) {
    const sig = await send(
      base,
      SystemProgram.transfer({
        fromPubkey: deployer.publicKey,
        toPubkey: player.publicKey,
        lamports: 300_000_000,
      }),
      [deployer]
    );
    console.log("funded player 0.3 SOL:", explorer(sig));
  }

  // 1. initialize_house (skip if already initialized)
  if (!(await base.getAccountInfo(house))) {
    const sig = await send(
      base,
      new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: house, isSigner: false, isWritable: true },
          { pubkey: board, isSigner: false, isWritable: true },
          { pubkey: deployer.publicKey, isSigner: true, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: Buffer.concat([disc("initialize_house")]),
      }),
      [deployer]
    );
    console.log("initialize_house:", explorer(sig));
  } else {
    console.log("house already initialized, skipping");
  }

  // 2. fund_pot 1 SOL — only if the pot is low (prize is 0.05 SOL).
  // Unconditional funding drained the deployer across re-runs.
  const houseInfo0 = await base.getAccountInfo(house);
  const rentExempt = await base.getMinimumBalanceForRentExemption(
    houseInfo0.data.length
  );
  const potLamports = houseInfo0.lamports - rentExempt;
  let sig;
  if (potLamports < 500_000_000) {
    sig = await send(
      base,
      new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: house, isSigner: false, isWritable: true },
          { pubkey: deployer.publicKey, isSigner: true, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: Buffer.concat([disc("fund_pot"), u64le(1_000_000_000)]),
      }),
      [deployer]
    );
    console.log("fund_pot 1 SOL:", explorer(sig));
  } else {
    console.log(
      `pot already funded (${(potLamports / 1e9).toFixed(2)} SOL), skipping fund_pot`
    );
  }

  // 3. start_round (base)
  sig = await send(
    base,
    new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: house, isSigner: false, isWritable: false },
        { pubkey: session, isSigner: false, isWritable: true },
        { pubkey: player.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: disc("start_round"),
    }),
    [player]
  );
  console.log("start_round:", explorer(sig));
  let s = decodeSession((await base.getAccountInfo(session)).data);
  console.log("round ends at:", new Date(s.endsAt * 1000).toISOString());

  // 4. delegate_session (base)
  sig = await send(
    base,
    new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: player.publicKey, isSigner: true, isWritable: true },
        { pubkey: buffer, isSigner: false, isWritable: true },
        { pubkey: record, isSigner: false, isWritable: true },
        { pubkey: metadata, isSigner: false, isWritable: true },
        { pubkey: session, isSigner: false, isWritable: true },
        { pubkey: PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: DELEGATION_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: ER_VALIDATOR, isSigner: false, isWritable: false },
      ],
      data: disc("delegate_session"),
    }),
    [player]
  );
  console.log("delegate_session:", explorer(sig));
  const owner = (await base.getAccountInfo(session))?.owner.toBase58();
  console.log("session owner after delegate:", owner);

  // 5. mine x N on the ER
  console.log(`mining ${MINES}x on ER...`);
  const latencies = [];
  for (let i = 0; i < MINES; i++) {
    const t0 = Date.now();
    sig = await send(
      er,
      new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: session, isSigner: false, isWritable: true },
          { pubkey: player.publicKey, isSigner: true, isWritable: false },
        ],
        data: disc("mine"),
      }),
      [player],
      { skipPreflight: true, commitment: "processed", pollMs: 150 }
    );
    latencies.push(Date.now() - t0);
    if ((i + 1) % 10 === 0) console.log(`  mined ${i + 1}/${MINES} (last: ${explorer(sig)})`);
  }
  latencies.sort((a, b) => a - b);
  console.log(
    `mine latency ms: median ${latencies[Math.floor(latencies.length / 2)]}, p90 ${latencies[Math.floor(latencies.length * 0.9)]}, max ${latencies.at(-1)}`
  );

  // 6. finish_round on the ER (commit + undelegate)
  sig = await send(
    er,
    new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: player.publicKey, isSigner: true, isWritable: true },
        { pubkey: session, isSigner: false, isWritable: true },
        { pubkey: MAGIC_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: MAGIC_CONTEXT_ID, isSigner: false, isWritable: true },
      ],
      data: disc("finish_round"),
    }),
    [player],
    { skipPreflight: true }
  );
  console.log("finish_round (ER):", explorer(sig));

  // Wait until the session is back under program ownership on base.
  for (let i = 0; i < 30; i++) {
    const info = await base.getAccountInfo(session);
    if (info?.owner.equals(PROGRAM_ID)) break;
    await sleep(1000);
  }
  s = decodeSession((await base.getAccountInfo(session)).data);
  console.log("session after finish:", JSON.stringify(s));

  // 7. wait for the round window to end, then claim on base.
  const waitMs = s.endsAt * 1000 - Date.now() + 1000;
  if (waitMs > 0) {
    console.log(`waiting ${(waitMs / 1000).toFixed(0)}s for round window to end...`);
    await sleep(waitMs);
  }
  const before = await base.getBalance(player.publicKey);
  sig = await send(
    base,
    new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: house, isSigner: false, isWritable: true },
        { pubkey: board, isSigner: false, isWritable: true },
        { pubkey: session, isSigner: false, isWritable: true },
        { pubkey: player.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: disc("claim"),
    }),
    [player]
  );
  console.log("claim:", explorer(sig));
  const after = await base.getBalance(player.publicKey);
  console.log(
    `player balance: ${(before / 1e9).toFixed(4)} -> ${(after / 1e9).toFixed(4)} SOL (delta ${(after - before) / 1e9} SOL, expected prize ${s.score >= 40 ? PRIZE_SOL : 0} SOL)`
  );
  const boardData = await base.getAccountInfo(board);
  console.log("leaderboard:", JSON.stringify(decodeBoard(boardData.data)));
  console.log("E2E DONE — score:", s.score);
}

main().catch((e) => {
  console.error("E2E FAILED:", e);
  process.exit(1);
});
