# Bitcoin regtest mining lab

A small Stratum v1 mining stack on Bitcoin Core regtest: a simulated pool for protocol practice, a CPU miner, and a pool that builds blocks from real `getblocktemplate` data and submits them to the node.

## Files

| File | Purpose |
| --- | --- |
| `lib.mjs` | Hashing, difficulty/target math, header building, witness-stripped merkle root |
| `miner.mjs` | Stratum v1 client + single-thread CPU miner |
| `pool.mjs` | Simulated pool — fixed fake template, no node required |
| `gbt.mjs` | Real pool — `getblocktemplate`, coinbase construction, `submitblock` |

## Requirements

- Node.js 24+
- Bitcoin Core 32.1 (portable Windows zip)
- Bash shell (the commands below use Git Bash paths)

Download `bitcoin-32.1-win64.zip` from bitcoincore.org, verify it, and extract to `core/bitcoin-32.1`:

```bash
sha256sum bitcoin-32.1-win64.zip
# b5b0c2cd007d69e96880907c79f9ae19ae82728f95fc8c923b4a07dab795b45d
```

## Setup

### 1. Start the regtest node

```bash
mkdir -p /e/testnet/regtest-data
/e/testnet/core/bitcoin-32.1/bin/bitcoind.exe \
  -regtest \
  -datadir=E:/testnet/regtest-data \
  -listen=0 \
  -rpcuser=lab -rpcpassword=labpass
```

RPC listens on `127.0.0.1:18443`. Keep the process running.

### 2. Create a wallet and coinbase address

```bash
CLI="/e/testnet/core/bitcoin-32.1/bin/bitcoin-cli.exe -regtest -datadir=E:/testnet/regtest-data -rpcuser=lab -rpcpassword=labpass"
$CLI createwallet lab
$CLI -rpcwallet=lab getnewaddress
```

`-rpcwallet` is required whenever more than one wallet is loaded. Save the printed address as `ADDR`.

### 3. Start the GBT pool

```bash
cd /e/testnet
node gbt.mjs --address "$ADDR" --stratum-port 3333 --share-diff 0.0001
```

Expected startup:

```
[gbt] template height=1 bits=207fffff txs=0 coinbase=5000000000 segwit=true
[gbt] Stratum listening on 127.0.0.1:3333
[gbt] share difficulty 0.0001 address bcrt1q...
```

### 4. Mine

In a second shell:

```bash
cd /e/testnet
node miner.mjs 3          # 3 shares, worker "worker1"
node miner.mjs 3 rig01    # 3 shares, worker "rig01"
```

Each share found above the network target is also a valid block, so on regtest the miner normally produces one block per share:

```
[miner] FOUND nonce=07590200 hash=00000cc8...
[miner] submit -> accepted
[miner] done: 3 share(s) accepted
```

The miner exits after the requested number of accepted shares.

## Simulated pool (no node)

`pool.mjs` serves a fixed template so the Stratum exchange can be exercised without Bitcoin Core:

```bash
node pool.mjs     # terminal 1
node miner.mjs 3  # terminal 2
```

Shares are accepted, but no block is produced: the fake template uses mainnet-style bits `1d00ffff`, so a hash can clear the share target without clearing the block target (`chain height` stays unchanged).

## Verify

```bash
$CLI getblockcount
$CLI getblock $( $CLI getbestblockhash ) 1
$CLI -rpcwallet=lab getbalances
$CLI -rpcwallet=lab listunspent 1
```

## GBT pool options

| Flag | Default | Meaning |
| --- | --- | --- |
| `--address` | required | Regtest address receiving the coinbase output |
| `--stratum-port` | `3333` | Stratum listen port |
| `--share-diff` | `0.0001` | Share difficulty (independent of network difficulty) |
| `--rpc-port` | `18443` | Bitcoin Core RPC port |
| `--rpc-user` | `lab` | RPC username |
| `--rpc-password` | `labpass` | RPC password |

## How it works

- `gbt.mjs` calls `getblocktemplate`, builds a segwit coinbase: BIP34 height push (`OP_1`..`OP_16` for heights 1-16), extranonce split, 50 BTC output plus the `default_witness_commitment`.
- The miner computes the witness-stripped merkle root, assembles the 80-byte header, and scans the nonce against the share target.
- On submit the pool rebuilds coinbase, merkle root, and header from its own data, verifies share and block targets, then calls `submitblock`. `null` means accepted.
- The coinbase address is resolved with `validateaddress`, which needs no wallet, so the pool runs with any number of loaded wallets.

## Notes

- **Coinbase maturity:** rewards are spendable after **101 confirmations** (spending block must be at least 100 blocks above the coinbase block). `getbalances` shows them as `immature` until then.
- **Template freshness:** the pool builds a template at startup and after each accepted block. After `generatetoaddress`, restart the pool or its next job will point at an old tip and be rejected as `bad-prevblk`.
- **Break-even target:** regtest bits `207fffff` make essentially every hash a valid block, so block rate here says nothing about real mining.
- **Scope:** regtest only — no real value, no peer networking, no vardiff, one client per pool process. Not a production pool.
- Logs (`*.log`), the node datadir, and the Bitcoin Core binaries are gitignored.

## Disclaimer

This project is provided for **educational and research purposes only**. It runs exclusively on Bitcoin Core regtest and produces no real bitcoin and no monetary value.

Nothing here is financial, investment, or legal advice. Cryptocurrency mining and trading are restricted or unsupported in some jurisdictions, including Bangladesh; verify the applicable law before applying any of this to a real network. The author accepts no liability for misuse or for any loss arising from use of this code.

---

Powered by **Md. Atikur Rahman Mridha** — [github.com/sulmak](https://github.com/sulmak)
