import { createHash } from 'node:crypto';

export const sha256 = (buf) => createHash('sha256').update(buf).digest();
export const dsha256 = (buf) => sha256(sha256(buf));

export function uint32LE(n) {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(n >>> 0);
  return buf;
}

export function bitsToTarget(bits) {
  const n = typeof bits === 'string' ? parseInt(bits, 16) : bits;
  const exponent = (n >>> 24) & 0xff;
  let mantissa = BigInt(n & 0x7fffff);
  if (exponent <= 3) mantissa >>= 8n * BigInt(3 - exponent);
  else mantissa <<= 8n * BigInt(exponent - 3);
  return mantissa;
}

export function targetFromDifficulty(difficulty) {
  const scale = 1_000_000n;
  const d = BigInt(Math.round(difficulty * Number(scale)));
  return (bitsToTarget('1d00ffff') * scale) / d;
}

export function targetToBufBE(target) {
  return Buffer.from(target.toString(16).padStart(64, '0'), 'hex');
}

export function meetsTarget(hash, targetBE) {
  for (let i = 31; i >= 0; i--) {
    const t = targetBE[31 - i];
    if (hash[i] !== t) return hash[i] < t;
  }
  return true;
}

function readVarint(buf, offset) {
  const first = buf[offset];
  if (first < 0xfd) return { value: first, size: 1 };
  if (first === 0xfd) return { value: buf.readUInt16LE(offset + 1), size: 3 };
  if (first === 0xfe) return { value: buf.readUInt32LE(offset + 1), size: 5 };
  return { value: Number(buf.readBigUInt64LE(offset + 1)), size: 9 };
}

export function stripWitness(tx) {
  if (tx.length < 6 || tx[4] !== 0x00 || tx[5] !== 0x01) return tx;

  let pos = 6;
  const vinStart = pos;
  const vinCount = readVarint(tx, pos);
  pos += vinCount.size;
  for (let i = 0; i < vinCount.value; i++) {
    pos += 36;
    const scriptLen = readVarint(tx, pos);
    pos += scriptLen.size + scriptLen.value + 4;
  }
  const vinEnd = pos;

  const voutCount = readVarint(tx, pos);
  pos += voutCount.size;
  for (let i = 0; i < voutCount.value; i++) {
    pos += 8;
    const scriptLen = readVarint(tx, pos);
    pos += scriptLen.size + scriptLen.value;
  }

  return Buffer.concat([tx.subarray(0, 4), tx.subarray(vinStart, pos), tx.subarray(tx.length - 4)]);
}

export function merkleRoot(coinbase, branch) {
  let root = dsha256(stripWitness(coinbase));
  for (const node of branch) root = dsha256(Buffer.concat([root, node]));
  return root;
}

export function displayHash(hash) {
  return Buffer.from(hash).reverse().toString('hex');
}

export function buildHeader({ version, prevhash, merkle, ntime, nbits, nonce }) {
  const header = Buffer.alloc(80);
  uint32LE(version).copy(header, 0);
  prevhash.copy(header, 4);
  merkle.copy(header, 36);
  uint32LE(ntime).copy(header, 68);
  uint32LE(parseInt(nbits, 16)).copy(header, 72);
  uint32LE(nonce).copy(header, 76);
  return header;
}
