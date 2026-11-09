import net from 'node:net';
import { randomBytes } from 'node:crypto';
import {
  bitsToTarget,
  targetFromDifficulty,
  targetToBufBE,
  meetsTarget,
  merkleRoot,
  dsha256,
  displayHash,
  uint32LE,
} from './lib.mjs';

const HOST = '127.0.0.1';
const PORT = 3333;

const SHARE_DIFFICULTY = 0.0001;
const NETWORK_BITS = '1d00ffff';
const VERSION = 0x20000000;

const SHARE_TARGET = targetFromDifficulty(SHARE_DIFFICULTY);
const NETWORK_TARGET = bitsToTarget(NETWORK_BITS);
const SHARE_TARGET_BE = targetToBufBE(SHARE_TARGET);
const NETWORK_TARGET_BE = targetToBufBE(NETWORK_TARGET);

// scriptSig = 03 010000 (height 1) + extranonce1 + extranonce2, 12 bytes total
const coinb1 = Buffer.from(
  '01000000' + '01' + '00'.repeat(32) + 'ffffffff' + '0c' + '03010000',
  'hex',
);
const coinb2 = Buffer.from(
  'ffffffff' + '01' + '00f2052a01000000' + '19' + '76a914' + '00'.repeat(20) + '88ac' + '00000000',
  'hex',
);

const prevhash = randomBytes(32);
const branch = [randomBytes(32), randomBytes(32)];
let jobCounter = 0;

function makeJob() {
  return {
    id: (jobCounter++).toString(16),
    prevhash,
    coinb1,
    coinb2,
    branch,
    version: VERSION,
    nbits: NETWORK_BITS,
    ntime: Math.floor(Date.now() / 1000),
  };
}

function notifyParams(job) {
  return [
    job.id,
    job.prevhash.toString('hex'),
    job.coinb1.toString('hex'),
    job.coinb2.toString('hex'),
    job.branch.map((h) => h.toString('hex')),
    job.version.toString(16).padStart(8, '0'),
    job.nbits,
    job.ntime.toString(16).padStart(8, '0'),
    true,
  ];
}

const server = net.createServer((socket) => {
  const en1 = randomBytes(4);
  const en2Size = 4;
  const job = makeJob();
  let authorized = false;
  let buffer = '';

  const send = (msg) => socket.write(JSON.stringify(msg) + '\n');
  const reject = (id, code, message) => send({ id, result: null, error: [code, message, null] });

  function verifySubmit(msg) {
    const [worker, jobId, en2Hex, ntimeHex, nonceHex] = msg.params ?? [];
    if (!authorized) return reject(msg.id, 24, 'Unauthorized worker');
    if (jobId !== job.id) return reject(msg.id, 21, 'Job not found');

    const en2 = Buffer.from(en2Hex ?? '', 'hex');
    const nonce = Buffer.from(nonceHex ?? '', 'hex');
    if (en2.length !== en2Size || nonce.length !== 4) return reject(msg.id, 20, 'Bad params');

    const coinbase = Buffer.concat([job.coinb1, en1, en2, job.coinb2]);
    const merkle = merkleRoot(coinbase, job.branch);
    const header = Buffer.concat([
      uint32LE(job.version),
      job.prevhash,
      merkle,
      uint32LE(parseInt(ntimeHex, 16)),
      uint32LE(parseInt(job.nbits, 16)),
      nonce,
    ]);

    const hash = dsha256(header);
    const accepted = meetsTarget(hash, SHARE_TARGET_BE);
    const block = meetsTarget(hash, NETWORK_TARGET_BE);

    console.log(`[pool] submit ${worker} job=${jobId} en2=${en2Hex} nonce=${nonceHex}`);
    console.log(`       hash=${displayHash(hash)}`);
    console.log(`       share ${accepted ? 'ACCEPTED' : 'REJECTED'}` + (block ? '  *** BLOCK CANDIDATE ***' : ''));

    if (!accepted) return reject(msg.id, 23, 'Low difficulty share');
    send({ id: msg.id, result: true, error: null });
  }

  function handle(msg) {
    if (msg.method === 'mining.subscribe') {
      send({
        id: msg.id,
        result: [
          [['mining.set_difficulty', 's1'], ['mining.notify', 's1']],
          en1.toString('hex'),
          en2Size,
        ],
        error: null,
      });
      console.log(`[pool] subscribe from ${socket.remoteAddress}:${socket.remotePort} en1=${en1.toString('hex')}`);
      return;
    }

    if (msg.method === 'mining.authorize') {
      authorized = true;
      send({ id: msg.id, result: true, error: null });
      console.log(`[pool] authorize ${msg.params?.[0]} -> job ${job.id} (${branch.length} merkle branches)`);
      send({ id: null, method: 'mining.set_difficulty', params: [SHARE_DIFFICULTY] });
      send({ id: null, method: 'mining.notify', params: notifyParams(job) });
      return;
    }

    if (msg.method === 'mining.submit') return verifySubmit(msg);
    if (msg.id !== undefined && msg.id !== null) reject(msg.id, 20, 'Unknown method');
  }

  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      try {
        handle(JSON.parse(line));
      } catch (err) {
        console.log(`[pool] bad message: ${err.message}`);
      }
    }
  });

  socket.on('error', (err) => console.log(`[pool] socket error: ${err.message}`));
  socket.on('close', () => console.log('[pool] miner disconnected'));
});

server.listen(PORT, HOST, () => {
  console.log(`[pool] Stratum v1 listening on ${HOST}:${PORT}`);
  console.log(`[pool] share difficulty ${SHARE_DIFFICULTY} -> target ${SHARE_TARGET.toString(16).padStart(64, '0')}`);
  console.log(`[pool] network bits ${NETWORK_BITS} -> target ${NETWORK_TARGET.toString(16).padStart(64, '0')}`);
});
