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

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const ADDRESS = arg('address');
const STRATUM_PORT = Number(arg('stratum-port', 3333));
const SHARE_DIFFICULTY = Number(arg('share-diff', 0.0001));
const RPC_PORT = Number(arg('rpc-port', 18443));
const RPC_USER = arg('rpc-user', 'lab');
const RPC_PASSWORD = arg('rpc-password', 'labpass');

if (!ADDRESS) {
  console.error('usage: node gbt.mjs --address bcrt1... [--share-diff 0.0001]');
  process.exit(1);
}

const SHARE_TARGET_BE = targetToBufBE(targetFromDifficulty(SHARE_DIFFICULTY));

async function rpc(method, params = []) {
  const response = await fetch(`http://127.0.0.1:${RPC_PORT}/`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Basic ${Buffer.from(`${RPC_USER}:${RPC_PASSWORD}`).toString('base64')}`,
    },
    body: JSON.stringify({ jsonrpc: '1.0', id: 'gbt-lab', method, params }),
  });
  const body = await response.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

function varint(n) {
  if (n < 0xfd) return Buffer.from([n]);
  if (n <= 0xffff) {
    const buf = Buffer.alloc(3);
    buf[0] = 0xfd;
    buf.writeUInt16LE(n, 1);
    return buf;
  }
  const buf = Buffer.alloc(5);
  buf[0] = 0xfe;
  buf.writeUInt32LE(n, 1);
  return buf;
}

function u64le(n) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(n));
  return buf;
}

function numberScript(n) {
  const out = [];
  let value = n;
  while (value > 0) {
    out.push(value & 0xff);
    value = Math.floor(value / 256);
  }
  if (out.length === 0) return Buffer.alloc(0);
  if (out[out.length - 1] & 0x80) out.push(0x00);
  return Buffer.from(out);
}

function pushData(data) {
  if (data.length < 0x4c) return Buffer.concat([Buffer.from([data.length]), data]);
  if (data.length <= 0xff) return Buffer.concat([Buffer.from([0x4c, data.length]), data]);
  return Buffer.concat([Buffer.from([0x4d]), Buffer.from([data.length & 0xff, data.length >> 8]), data]);
}

function heightPush(height) {
  if (height === 0) return Buffer.from([0x00]);
  if (height >= 1 && height <= 16) return Buffer.from([0x50 + height]);
  return pushData(numberScript(height));
}

function txOutput(value, script) {
  return Buffer.concat([u64le(value), varint(script.length), script]);
}

function branchForCoinbase(txids) {
  let level = [Buffer.alloc(32), ...txids];
  const branch = [];
  while (level.length > 1) {
    if (level.length % 2) level.push(level[level.length - 1]);
    branch.push(level[1]);
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(dsha256(Buffer.concat([level[i], level[i + 1]])));
    }
    level = next;
  }
  return branch;
}

let jobCounter = 0;
let currentJob = null;
const clients = new Set();

function buildJob(template, scriptPubKey) {
  const txids = template.transactions.map((tx) => Buffer.from(tx.txid, 'hex').reverse());
  const branch = branchForCoinbase(txids);
  const segwit = Boolean(template.default_witness_commitment);

  const scriptSigPrefix = Buffer.concat([
    heightPush(template.height),
    pushData(Buffer.from('stratum-lab')),
  ]);
  const scriptSigLen = scriptSigPrefix.length + 8;

  const outputs = [txOutput(template.coinbasevalue, scriptPubKey)];
  if (segwit) outputs.push(txOutput(0, Buffer.from(template.default_witness_commitment, 'hex')));

  const coinb1 = Buffer.concat([
    uint32LE(2),
    ...(segwit ? [Buffer.from([0x00, 0x01])] : []),
    Buffer.from([0x01]),
    Buffer.alloc(32),
    Buffer.from('ffffffff', 'hex'),
    Buffer.from([scriptSigLen]),
    scriptSigPrefix,
  ]);

  const coinb2 = Buffer.concat([
    Buffer.from('ffffffff', 'hex'),
    varint(outputs.length),
    ...outputs,
    ...(segwit ? [Buffer.from([0x01, 0x20]), Buffer.alloc(32)] : []),
    Buffer.alloc(4),
  ]);

  return {
    id: (jobCounter++).toString(16),
    template,
    prevhash: Buffer.from(template.previousblockhash, 'hex').reverse(),
    coinb1,
    coinb2,
    branch,
    segwit,
  };
}

function notifyParams(job) {
  return [
    job.id,
    job.prevhash.toString('hex'),
    job.coinb1.toString('hex'),
    job.coinb2.toString('hex'),
    job.branch.map((node) => node.toString('hex')),
    BigInt(job.template.version).toString(16).padStart(8, '0'),
    job.template.bits,
    BigInt(job.template.curtime).toString(16).padStart(8, '0'),
    true,
  ];
}

async function refreshTemplate() {
  const template = await rpc('getblocktemplate', [{ rules: ['segwit'] }]);
  const info = await rpc('validateaddress', [ADDRESS]);
  if (!info.isvalid) throw new Error(`invalid coinbase address: ${ADDRESS}`);
  currentJob = buildJob(template, Buffer.from(info.scriptPubKey, 'hex'));
  console.log(
    `[gbt] template height=${template.height} bits=${template.bits} txs=${template.transactions.length} ` +
      `coinbase=${template.coinbasevalue} segwit=${currentJob.segwit}`,
  );
  for (const client of clients) {
    if (!client.authorized) continue;
    client.job = currentJob;
    client.send({ id: null, method: 'mining.notify', params: notifyParams(currentJob) });
  }
}

function assembleBlock(job, header, coinbase) {
  const txs = job.template.transactions.map((tx) => Buffer.from(tx.data, 'hex'));
  return Buffer.concat([header, varint(1 + txs.length), coinbase, ...txs]);
}

const server = net.createServer((socket) => {
  const en1 = randomBytes(4);
  const en2Size = 4;
  const client = { socket, en1, en2Size, authorized: false, job: currentJob, send: null };
  clients.add(client);

  let buffer = '';
  const send = (msg) => socket.write(JSON.stringify(msg) + '\n');
  client.send = send;
  const reject = (id, code, message) => send({ id, result: null, error: [code, message, null] });

  async function verifySubmit(msg) {
    const [worker, jobId, en2Hex, ntimeHex, nonceHex] = msg.params ?? [];
    const job = client.job;
    if (!client.authorized) return reject(msg.id, 24, 'Unauthorized worker');
    if (!job || jobId !== job.id) return reject(msg.id, 21, 'Job not found');

    const en2 = Buffer.from(en2Hex ?? '', 'hex');
    const nonce = Buffer.from(nonceHex ?? '', 'hex');
    if (en2.length !== en2Size || nonce.length !== 4) return reject(msg.id, 20, 'Bad params');

    const coinbase = Buffer.concat([job.coinb1, en1, en2, job.coinb2]);
    const merkle = merkleRoot(coinbase, job.branch);
    const header = Buffer.alloc(80);
    uint32LE(job.template.version).copy(header, 0);
    job.prevhash.copy(header, 4);
    merkle.copy(header, 36);
    uint32LE(parseInt(ntimeHex, 16)).copy(header, 68);
    uint32LE(parseInt(job.template.bits, 16)).copy(header, 72);
    nonce.copy(header, 76);

    const hash = dsha256(header);
    const shareOk = meetsTarget(hash, SHARE_TARGET_BE);
    const blockOk = meetsTarget(hash, targetToBufBE(bitsToTarget(job.template.bits)));

    console.log(
      `[gbt] submit ${worker} job=${jobId} nonce=${nonceHex} hash=${displayHash(hash)} ` +
        `share=${shareOk} block=${blockOk}`,
    );

    if (!shareOk) return reject(msg.id, 23, 'Low difficulty share');

    if (blockOk) {
      const block = assembleBlock(job, header, coinbase);
      const result = await rpc('submitblock', [block.toString('hex')]);
      if (result === null) {
        console.log(`[gbt] BLOCK ACCEPTED ${displayHash(hash)} size=${block.length}B`);
        send({ id: msg.id, result: true, error: null });
        await refreshTemplate();
        return;
      }
      console.log(`[gbt] submitblock rejected: ${JSON.stringify(result)}`);
      return reject(msg.id, 22, `Block rejected: ${result}`);
    }

    send({ id: msg.id, result: true, error: null });
  }

  async function handle(msg) {
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
      console.log(`[gbt] subscribe en1=${en1.toString('hex')}`);
      return;
    }

    if (msg.method === 'mining.authorize') {
      client.authorized = true;
      client.job = currentJob;
      send({ id: msg.id, result: true, error: null });
      send({ id: null, method: 'mining.set_difficulty', params: [SHARE_DIFFICULTY] });
      if (client.job) send({ id: null, method: 'mining.notify', params: notifyParams(client.job) });
      console.log(`[gbt] authorize ${msg.params?.[0]} job=${client.job?.id}`);
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
        handle(JSON.parse(line)).catch((err) => console.log(`[gbt] handler error: ${err.message}`));
      } catch (err) {
        console.log(`[gbt] bad message: ${err.message}`);
      }
    }
  });

  socket.on('error', (err) => console.log(`[gbt] socket error: ${err.message}`));
  socket.on('close', () => {
    clients.delete(client);
    console.log('[gbt] miner disconnected');
  });
});

await refreshTemplate();
server.listen(STRATUM_PORT, '127.0.0.1', () => {
  console.log(`[gbt] Stratum listening on 127.0.0.1:${STRATUM_PORT}`);
  console.log(`[gbt] share difficulty ${SHARE_DIFFICULTY} address ${ADDRESS}`);
});
