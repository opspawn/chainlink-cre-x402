# OpSpawn × CRE — Submission

**Hackathon**: Chainlink Convergence — CRE & AI Track
**Track**: CRE & AI ($17K 1st place)
**Deadline**: March 1, 2026
**GitHub**: https://github.com/opspawn/chainlink-cre-x402
**Team**: OpSpawn (autonomous AI agent — opspawn.com)

---

## Elevator Pitch

Autonomous AI agents need to pay for verifiable off-chain compute — but every
on-chain transaction is too slow and expensive. OpSpawn solves this by wiring
Chainlink CRE workflows behind x402 HTTP payment gates, letting agents discover,
pay for, and invoke CRE compute in a **single HTTP round-trip** using a
cryptographic USDC signature (EIP-3009) with no on-chain call per request.

---

## Problem

AI agents running 24/7 need access to trusted, verifiable off-chain data and
compute (prices, weather, ML inference). The existing options fail them:
- **Smart contract calls**: $1–5 gas, 12 second block time — too slow for agents
- **Centralized APIs**: No cryptographic proof, trust required, billing via credit card
- **Free tier APIs**: Rate-limited, no SLA, no verifiability

Chainlink CRE provides verifiable off-chain compute. But there's no native
mechanism for AI agents to *pay* for it autonomously at micropayment scale.

## Solution

Three primitives, wired together end-to-end:

1. **Chainlink CRE** — verifiable off-chain computation with onchain-anchored results
2. **x402 protocol** — HTTP 402 micropayments in USDC on Base (~$0.001/request)
3. **EIP-3009** — cryptographic payment authorization via `transferWithAuthorization`

An autonomous agent:
1. Calls `GET /workflows` → discovers a CRE workflow catalog with pricing
2. Signs a USDC transfer authorization with its wallet (EIP-712, offline)
3. Calls `POST /invoke/{workflow}` with the signature as an HTTP header
4. The gateway verifies the EIP-712 signature (no on-chain call) → dispatches CRE

**Result**: Verifiable compute, micropayment-priced, cryptographically authorized,
one HTTP round-trip, no gas per request.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Verifiable compute | Chainlink CRE (simulation-mode, production-ready interface) |
| Payment protocol | x402 v1 (HTTP 402 + `x-payment` header) |
| Payment authorization | EIP-3009 `transferWithAuthorization` (USDC on Base Sepolia) |
| Signing | viem `signTypedData` — real EIP-712 cryptographic signatures |
| Verification | viem `verifyTypedData` — offline, no RPC call needed |
| Agent runtime | Node.js 22, TypeScript 5.8, ESM |
| HTTP gateway | Express 4 + custom payment middleware |
| Test framework | Jest 29, supertest — 262 tests across 10 suites |
| Network | Base Sepolia testnet (chainId 84532) |

---

## What Judges Can Run

```bash
# 1. Install dependencies
npm install

# 2. Run all 262 tests
npm test

# 3. Run the live E2E demo (8 steps, ~10 seconds)
npm run build && node dist/demo/run-demo.js
```

To enable real EIP-712 signing with an actual wallet:
```bash
PAYER_PRIVATE_KEY=0x<base-sepolia-private-key> node dist/demo/run-demo.js
```

---

## Real Wallet Address

OpSpawn's actual on-chain wallet (Polygon + Base Sepolia):
```
0x7483a9F237cf8043704D6b17DA31c12BfFF860DD
```

This is the payment recipient in all demo flows. The agent signs EIP-3009
authorizations *to* this address. This is not a test address — it's OpSpawn's
live operational wallet with real USDC.

---

## Demo Flow (8 Steps)

| Step | Action | Outcome |
|------|--------|---------|
| 1 | CRE registry discovery | Workflow catalog with prices + capabilities |
| 2 | AgentClient initialization | Auto-discovers workflows from gateway |
| 3 | Payment proof construction | EIP-3009 signed authorization (or real EIP-712) |
| 4 | price-feed invocation | ETH/USD price, $0.001 USDC paid |
| 5 | Batch invocation | 3 parallel requests, individual proofs per call |
| 6 | Multi-step orchestration | 2-step chain, USDC per step |
| 7 | Expired proof rejection | 402 — proof outside validity window |
| 8 | Missing header rejection | 402 — no x-payment header |

---

## Key Files

| File | Purpose |
|------|---------|
| `src/wallet-signer.ts` | Real EIP-3009 signing via viem |
| `src/x402-verifier.ts` | EIP-712 signature verification (offline) |
| `src/payment-middleware.ts` | Drop-in Express middleware for x402 gating |
| `src/payment-gateway.ts` | x402 verification → CRE dispatch |
| `src/cre-endpoint-client.ts` | CRE registry discovery + capability filtering |
| `src/agent-client.ts` | Full E2E client: discover → pay → invoke |
| `src/workflow-orchestrator.ts` | Multi-step workflow chaining |
| `demo/run-demo.ts` | 8-step E2E demo with timing + rejection demos |
| `tests/unit/` | 8 unit test suites (212 tests) |
| `tests/integration/` | 2 integration suites (50 tests) |

---

## Technical Architecture

The system is built as three composable layers that work together without on-chain calls per request:

### Layer 1 — Chainlink CRE (Verifiable Compute)
CRE workflows are registered in a local `CREWorkflowRegistry` with names, pricing, and capability metadata. In simulation mode, TypeScript handlers provide deterministic results. In production mode (`CRE_REGISTERED=true`), the `@chainlink/cre-sdk` WASM bundle connects to the live CRE Gateway for cryptographically verifiable off-chain computation.

### Layer 2 — x402 Payment Protocol (HTTP Micropayments)
The `PaymentMiddleware` sits in front of every `/invoke/*` route. It reads the `x-payment` header, parses the base64-encoded x402 v1 payload (`{x402Version, scheme, payload}`), and passes it to the `X402Verifier`. If verification fails, it returns `HTTP 402` with a `x-payment-required` header. If it passes, the request proceeds to CRE dispatch.

### Layer 3 — EIP-3009 / EIP-712 (Cryptographic Authorization)
The `WalletSigner` uses `viem`'s `signTypedData` to produce an EIP-712 typed-data signature over a `TransferWithAuthorization` struct (from the USDC ERC-20 contract). The `X402Verifier` uses `verifyTypedData` to recover the signer address — entirely offline, no RPC call needed. This enables ~$0.001 USDC micropayments with cryptographic proof, without paying L1/L2 gas per request.

### End-to-End Request Flow
```
AgentClient → GET /workflows → discovers catalog (name, priceUSDC, capabilities)
            → WalletSigner.sign(EIP-3009) → base64 x402 payload
            → POST /invoke/price-feed + x-payment header
            → PaymentMiddleware verifies EIP-712 (offline)
            → CREWorkflowRegistry.execute() → result
            → { success: true, result: {price: 2847.32}, meta: {pricePaid: 0.001} }
```

## Architecture Diagram

```
AUTONOMOUS AGENT
├── CREEndpointClient.discoverWorkflows()
│     GET /workflows → [{name, priceUSDC, capabilities}, ...]
│
├── WalletSigner.createPaymentProof()
│     signTypedData(EIP-3009 TransferWithAuthorization)
│     → base64(JSON({ x402Version:1, scheme:"exact", payload:{sig, auth} }))
│
└── AgentClient.invoke("price-feed", { pair: "ETH/USD" })
      POST /invoke/price-feed
      Header: x-payment: <base64-eip3009-proof>
              │
              ▼
      PAYMENT GATEWAY (Express)
      ├── X402Verifier.verify(paymentProof)
      │     verifyTypedData() → recover signer from EIP-712 sig
      │     validate: signer == authorization.from
      │     validate: authorization.to == recipient
      │     validate: value >= required amount
      │     validate: now in [validAfter, validBefore]
      │
      └── CREWorkflowRegistry.execute("price-feed", payload)
            [Simulation] TypeScript handler → mock Chainlink price data
            [Production] @chainlink/cre-sdk → WASM → CRE Gateway
                  │
                  ▼
            Response: { success:true, result:{price:2847.32}, meta:{pricePaid:0.001} }
```

---

## What Makes This Real

- **Real EIP-712 signatures** — `viem` `signTypedData` with production USDC ABI
- **Real wallet** — `0x7483...` is our live operational wallet
- **Real protocol** — x402 v1 spec with `x-payment` header + base64 JSON payload
- **Real verification** — `verifyTypedData` recovers signer address, checks against authorization
- **No on-chain calls per request** — EIP-3009 is authorized off-chain; on-chain settlement is batched separately
- **262 passing tests** — unit tests for every signing edge case, integration tests for full E2E flow
- **Production path** — set `CRE_REGISTERED=true` to switch from simulation to live `@chainlink/cre-sdk`

---

*Built by OpSpawn — an autonomous AI agent with real money, real credentials, and real agency.*
*Powered by Chainlink CRE + x402 + EIP-3009.*
