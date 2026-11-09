import net from 'node:net';
import readline from 'node:readline';
import {
  targetFromDifficulty,
  targetToBufBE,
  meetsTarget,
  merkleRoot,
  dsha256,
  displayHash,
  buildHeader,
} from './lib.mjs';

const HOST = '127.0.0.1';
const PORT = 3333;
const TARGET_SHARES = Number(process.argv[2] ?? 3);
const WORKER = process.argv[3] ?? 'worker1';

let nextId = 1;
const pending = new Map();
let extranonce1 = null;
let extranonce2Size = 4;
let shareTargetBE = null;
let latestJob = null;
let jobSeq = 0;
let accepted = 0;

const socket = net.createConnection({ host: HOST, port: PORT });
const rl = readline.createInterface({ input: socket });

function send(msg) {
  socket.write(JSON.stringify(msg) + '\n');
}

function call(method, params) {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    send({ id, method, params });
  });
}

function finish() {
  console.log(`[miner] done: ${accepted} share(s) accepted`);
  rl.close();
  socket.end();
  setTimeout(() => process.exit(0), 150);
}

function parseJob([id, prevhash, coinb1, coinb2, branch, version, nbits, ntimeHex, clean]) {
  return {
    id,
    prevhash: Buffer.from(prevhash, 'hex'),
    coinb1: Buffer.from(coinb1, 'hex'),
    coinb2: Buffer.from(coinb2, 'hex'),
    branch: branch.map((h) => Buffer.from(h, 'hex')),
    version: parseInt(version, 16),
    nbits,
    ntime: parseInt(ntimeHex, 16),
    ntimeHex,
    clean,
  };
}

async function startMining(job) {
  if (!shareTargetBE || !extranonce1) return;
  const seq = ++jobSeq;

  const en2 = Buffer.alloc(extranonce2Size);
  const coinbase = Buffer.concat([job.coinb1, extranonce1, en2, job.coinb2]);
  const merkle = merkleRoot(coinbase, job.branch);
  const header = buildHeader({
    version: job.version,
    prevhash: job.prevhash,
    merkle,
    ntime: job.ntime,
    nbits: job.nbits,
    nonce: 0,
  });

  console.log(`[miner] job ${job.id}: coinbase=${coinbase.length}B  en2=${en2.toString('hex')}`);
  console.log(`[miner] merkle root ${merkle.toString('hex')}`);
  console.log(`[miner] header(${header.length}B) ${header.toString('hex')}`);
  console.log(`[miner] share target ${Buffer.from(shareTargetBE).toString('hex')}`);
  console.log('[miner] hashing...');

  let nonce = 0;
  let hashes = 0;
  let windowStart = Date.now();

  while (nonce <= 0xffffffff) {
    if (seq !== jobSeq) {
      console.log(`[miner] job ${job.id} superseded, switching`);
      return;
    }
    header.writeUInt32LE(nonce >>> 0, 76);
    const hash = dsha256(header);
    hashes++;

    if (meetsTarget(hash, shareTargetBE)) {
      const nonceHex = Buffer.from(header.subarray(76, 80)).toString('hex');
      const seconds = (Date.now() - windowStart) / 1000;
      console.log(`[miner] FOUND nonce=${nonceHex} hash=${displayHash(hash)}`);
      console.log(
        `[miner] ${hashes.toLocaleString()} hashes in ${seconds.toFixed(2)}s = ` +
          `${Math.round(hashes / seconds).toLocaleString()} H/s`,
      );

      const ok = await call('mining.submit', [
        WORKER,
        job.id,
        en2.toString('hex'),
        job.ntimeHex,
        nonceHex,
      ]);
      console.log(`[miner] submit -> ${ok ? 'accepted' : 'rejected'}`);

      if (ok) accepted++;
      if (accepted >= TARGET_SHARES) return finish();

      hashes = 0;
      windowStart = Date.now();
    }

    nonce++;
    if ((nonce & 0x1fff) === 0) await new Promise((resolve) => setImmediate(resolve));
  }
}

function maybeStart() {
  if (latestJob && shareTargetBE) startMining(latestJob);
}

rl.on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }

  if (msg.id !== undefined && msg.id !== null && pending.has(msg.id)) {
    const resolve = pending.get(msg.id);
    pending.delete(msg.id);
    resolve(msg.result ?? null);
    return;
  }

  if (msg.method === 'mining.set_difficulty') {
    const difficulty = msg.params[0];
    shareTargetBE = targetToBufBE(targetFromDifficulty(difficulty));
    console.log(`[miner] set_difficulty ${difficulty}`);
    maybeStart();
    return;
  }

  if (msg.method === 'mining.notify') {
    latestJob = parseJob(msg.params);
    console.log(`[miner] notify job=${latestJob.id} bits=${latestJob.nbits} ntime=${latestJob.ntimeHex}`);
    maybeStart();
  }
});

socket.on('connect', async () => {
  console.log(`[miner] connected to ${HOST}:${PORT}`);
  const sub = await call('mining.subscribe', ['stratum-lab/0.1']);
  if (!sub) return finish();
  extranonce1 = Buffer.from(sub[1], 'hex');
  extranonce2Size = sub[2];
  console.log(`[miner] subscribed extranonce1=${sub[1]} extranonce2_size=${sub[2]}`);

  const ok = await call('mining.authorize', [WORKER, 'x']);
  console.log(`[miner] authorize ${WORKER} -> ${ok}`);
});

socket.on('error', (err) => console.log(`[miner] socket error: ${err.message}`));
