# OpSpawn × CRE — Demo Instructions for Judges

**Hackathon**: Chainlink Convergence — CRE & AI Track
**Time to demo**: ~3 minutes
**Prerequisite**: Node.js 18+

---

## Quick Start (3 commands)

```bash
npm install
npm test
npm run demo
```

That's it. The full demo runs in ~10 seconds and shows 8 steps.

---

## Step-by-Step Demo

### 1. Install dependencies

```bash
npm install
```

### 2. Run all 262 tests

```bash
npm test
```

Expected output:
```
Test Suites: 10 passed, 10 total
Tests:       262 passed, 262 total
Time:        ~10s
```

All 10 suites cover: EIP-712 signing, x402 verification, CRE registry, payment
middleware, AgentClient E2E, workflow orchestration, gateway integration.

### 3. Build TypeScript

```bash
npm run build
```

Compiles `src/` and `demo/` to `dist/`.

### 4. Run the E2E demo

```bash
npm run demo
```

OR using the shell script (installs, builds, and runs in one command):

```bash
./scripts/demo.sh
```

---

## What the Demo Shows

The demo starts an **in-process gateway** on port 3199 — no external network
calls needed. It walks through 8 steps:

| Step | What Happens | What to Look For |
|------|-------------|-----------------|
| 1 | **CRE Registry Discovery** | Lists 4 workflows with USDC prices |
| 2 | **AgentClient Init** | Auto-discovers workflows from gateway |
| 3 | **Payment Proof Construction** | EIP-3009 signed authorization (base64) |
| 4 | **Invoke price-feed** | `POST /invoke/price-feed` → ETH/USD price + paid $0.001 |
| 5 | **Batch Invoke** | 3 parallel requests (ETH, BTC, weather) all succeed |
| 6 | **Multi-step Orchestration** | 2-step chain: price-feed → agent-task-dispatch |
| 7 | **Rejection: Expired proof** | `HTTP 402` — proof outside validity window |
| 8 | **Rejection: No payment** | `HTTP 402` — missing x-payment header |

Steps 7 and 8 demonstrate that the gateway **correctly enforces payment** — bad
proofs are rejected before any compute runs.

---

## With Real EIP-712 Signing

To enable production-grade cryptographic signing with an actual Base Sepolia wallet:

```bash
PAYER_PRIVATE_KEY=0x<your-base-sepolia-private-key> npm run demo
```

The wallet signer uses `viem` `signTypedData` to produce a real EIP-712
`TransferWithAuthorization` signature. Without `PAYER_PRIVATE_KEY`, the demo
uses mock proofs — the protocol flow is identical.

OpSpawn's live wallet (payment recipient in all flows):
```
0x7483a9F237cf8043704D6b17DA31c12BfFF860DD
```

---

## Start the Dashboard Server

For a live HTML dashboard with workflow catalog and invocation log:

```bash
npm start
# → http://localhost:3100
```

Exposes REST endpoints:
- `GET  /workflows` — workflow catalog + x402 payment instructions
- `POST /invoke/:workflow` — payment-gated invocation
- `GET  /health` — gateway status

---

## Environment Variables

```bash
PORT=3100                          # Dashboard server port (default: 3100)
DEMO_PORT=3199                     # E2E demo gateway port (default: 3199)
RECIPIENT_ADDRESS=0x7483...        # Payment recipient wallet
SIMULATION_MODE=true               # false = real EIP-712 verification
PAYER_PRIVATE_KEY=0x...            # Agent wallet (enables real signing)
CRE_REGISTERED=false               # true = production @chainlink/cre-sdk path
```

---

## Key Technical Points for Judges

1. **No on-chain call per request** — EIP-3009 authorizations are signed
   off-chain; the gateway verifies with `viem verifyTypedData` (CPU-only)

2. **Real x402 protocol** — `x-payment` header carries base64-encoded JSON
   with `x402Version`, `scheme`, `network`, and `payload.authorization`

3. **402 responses are x402-compliant** — include `accepts[]` array with
   payment instructions so any x402-aware client knows exactly what to send

4. **CRE production path** — set `CRE_REGISTERED=true` to switch from
   simulation handlers to `@chainlink/cre-sdk` WASM runtime

5. **262 tests** — full coverage of all signing edge cases, expiry validation,
   nonce checks, and end-to-end HTTP flows
