/**
 * OpSpawn x CRE — End-to-End Demo Script
 *
 * Demonstrates the full flow: discover → pay → invoke → result
 * Runs an in-process gateway and shows real HTTP calls with per-step timing.
 *
 * Usage:
 *   npx ts-node --esm demo/run-demo.ts
 *   # or after build:
 *   node dist/demo/run-demo.js
 *
 * With real wallet (Base Sepolia):
 *   PAYER_PRIVATE_KEY=0x... node dist/demo/run-demo.js
 *
 * Expected runtime: ~10-15 seconds
 */

import express from "express";
import { createServer } from "http";
import { AgentClient } from "../src/agent-client.js";
import { CREEndpointClient } from "../src/cre-endpoint-client.js";
import { X402CREPaymentGateway } from "../src/payment-gateway.js";
import { CREWorkflowRegistry } from "../src/cre-registry.js";
import { WorkflowOrchestrator } from "../src/workflow-orchestrator.js";
import { sanitizePrivateKey } from "../src/wallet-signer.js";
import type { X402RealProof } from "../src/x402-verifier.js";

// ─── Config ───────────────────────────────────────────────────────────────────

const DEMO_PORT = parseInt(process.env.DEMO_PORT ?? "3199", 10);
const RECIPIENT = "0x7483a9F237cf8043704D6b17DA31c12BfFF860DD";
const PAYER = "0xDemoAgent000000000000000000000000000000000";
const PRIVATE_KEY = process.env.PAYER_PRIVATE_KEY;
const HAS_REAL_WALLET = Boolean(PRIVATE_KEY);

// ─── ANSI Colors ──────────────────────────────────────────────────────────────

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";
const BLUE = "\x1b[34m";
const MAGENTA = "\x1b[35m";
const DIM = "\x1b[2m";

// ─── Step Timing ──────────────────────────────────────────────────────────────

interface StepRecord {
  n: number;
  title: string;
  ms: number;
  success: boolean;
}

const stepLog: StepRecord[] = [];
let _stepStart = 0;
let _stepN = 0;
let _stepTitle = "";

function startStep(n: number, title: string): void {
  _stepStart = Date.now();
  _stepN = n;
  _stepTitle = title;
  console.log(`${BOLD}${BLUE}[Step ${n}]${RESET} ${BOLD}${title}${RESET}`);
}

function endStep(success = true): number {
  const ms = Date.now() - _stepStart;
  stepLog.push({ n: _stepN, title: _stepTitle, ms, success });
  const icon = success ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
  console.log(`  ${icon} ${DIM}completed in ${ms}ms${RESET}`);
  return ms;
}

function ok(msg: string): void {
  console.log(`  ${GREEN}✓${RESET} ${msg}`);
}

function fail(msg: string): void {
  console.log(`  ${RED}✗${RESET} ${msg}`);
}

function info(msg: string): void {
  console.log(`  ${DIM}→${RESET} ${msg}`);
}

function result(label: string, value: unknown): void {
  const json = typeof value === "object" ? JSON.stringify(value, null, 2) : String(value);
  const indented = json.split("\n").map((l) => `    ${l}`).join("\n");
  console.log(`  ${MAGENTA}${label}:${RESET}\n${YELLOW}${indented}${RESET}`);
}

function banner(text: string): void {
  const line = "═".repeat(60);
  console.log(`\n${BOLD}${CYAN}╔${line}╗${RESET}`);
  console.log(`${BOLD}${CYAN}║${RESET}  ${BOLD}${text.padEnd(58)}${RESET}${BOLD}${CYAN}║${RESET}`);
  console.log(`${BOLD}${CYAN}╚${line}╝${RESET}\n`);
}

function separator(): void {
  console.log(`\n${DIM}${"─".repeat(62)}${RESET}\n`);
}

function catalogTable(workflows: Array<{ name: string; priceUSDC: number; capabilities: Array<{ type: string }> }>): void {
  const nameW = 24;
  const priceW = 10;
  const capsW = 42;
  const hdr = `  ${"Workflow".padEnd(nameW)} ${"Price".padEnd(priceW)} ${"Capabilities".padEnd(capsW)}`;
  const div = `  ${"─".repeat(nameW)} ${"─".repeat(priceW)} ${"─".repeat(capsW)}`;
  console.log(`\n${BOLD}${hdr}${RESET}`);
  console.log(`${DIM}${div}${RESET}`);
  for (const wf of workflows) {
    const caps = wf.capabilities.map((c) => c.type).join(", ");
    const price = `$${wf.priceUSDC.toFixed(4)}`;
    console.log(
      `  ${CYAN}${wf.name.padEnd(nameW)}${RESET} ${YELLOW}${price.padEnd(priceW)}${RESET} ${DIM}${caps.slice(0, capsW)}${RESET}`
    );
  }
  console.log();
}

// ─── Expired Proof Builder ────────────────────────────────────────────────────

function createExpiredProof(from: string, to: string, amountUSDC: number): string {
  const now = Math.floor(Date.now() / 1000);
  const proof: X402RealProof = {
    x402Version: 1,
    scheme: "exact",
    network: "base-sepolia",
    payload: {
      signature: `0x${"a".repeat(130)}`,
      authorization: {
        from,
        to,
        value: BigInt(Math.round(amountUSDC * 1_000_000)).toString(),
        validAfter: (now - 600).toString(),   // 10 minutes ago
        validBefore: (now - 300).toString(),   // 5 minutes ago (EXPIRED)
        nonce: `0x${"b".repeat(64)}`,
      },
    },
  };
  return Buffer.from(JSON.stringify(proof)).toString("base64");
}

// ─── In-process Gateway Setup ─────────────────────────────────────────────────

async function startGateway(): Promise<() => void> {
  const app = express();
  app.use(express.json());

  const registry = new CREWorkflowRegistry();
  const gateway = new X402CREPaymentGateway(
    { recipientAddress: RECIPIENT, simulationMode: true, debug: false },
    registry
  );

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "demo-gateway", simulationMode: true });
  });

  app.get("/workflows", (_req, res) => {
    const workflows = registry.listWorkflows().map((wf) => ({
      name: wf.name,
      description: wf.description,
      priceUSDC: wf.priceUSDC,
      trigger: wf.trigger,
      payment: { recipient: RECIPIENT, amount: wf.priceUSDC, currency: "USDC", network: "base-sepolia", header: "x-payment" },
    }));
    res.json({ workflows, count: workflows.length, simulationMode: true });
  });

  app.post("/invoke/:workflow", async (req, res, next) => {
    try {
      const workflowName = String(req.params.workflow);
      const paymentProof = (req.headers["x-payment"] as string) ?? "";
      const r = await gateway.invoke(workflowName, req.body as Record<string, unknown>, paymentProof);
      if (!r.allowed) {
        res.status(402).json({ error: "Payment Required", message: r.error });
        return;
      }
      res.json({ success: true, result: r.workflowResult?.result, meta: { workflowName, executionMs: r.workflowResult?.executionMs, pricePaid: r.pricePaid } });
    } catch (err) { next(err); }
  });

  app.post("/agent/task", async (req, res, next) => {
    try {
      const paymentProof = (req.headers["x-payment"] as string) ?? "";
      const taskReq = req.body as { task: string; params?: Record<string, unknown> };
      const r = await gateway.orchestrateAgentTask(taskReq, paymentProof);
      res.json({ success: true, taskId: r.taskId, task: r.task, result: r.result });
    } catch (err) { next(err); }
  });

  return new Promise((resolve, reject) => {
    const server = createServer(app);
    server.listen(DEMO_PORT, () => resolve(() => server.close()));
    server.on("error", reject);
  });
}

// ─── Main Demo ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const demoStart = Date.now();

  banner("OpSpawn × CRE — E2E Payment-Gated Agent Demo");

  console.log(`${BOLD}Configuration${RESET}`);
  info(`Gateway:    http://localhost:${DEMO_PORT}`);
  info(`Recipient:  ${RECIPIENT}`);
  info(`Network:    Base Sepolia (testnet)`);
  info(`Mode:       ${HAS_REAL_WALLET ? `${GREEN}PRODUCTION${RESET} — real EIP-712 signing` : `${YELLOW}SIMULATION${RESET} — mock proofs`}`);
  if (HAS_REAL_WALLET && PRIVATE_KEY) {
    info(`Wallet:     ${sanitizePrivateKey(PRIVATE_KEY)} (loaded from PAYER_PRIVATE_KEY)`);
  }

  separator();

  // Start in-process gateway
  info("Starting in-process gateway...");
  const stopGateway = await startGateway();
  ok(`Gateway running on http://localhost:${DEMO_PORT}`);

  separator();

  // ── Step 1: CRE Workflow Catalog ──────────────────────────────────────────
  startStep(1, "CRE Registry Discovery — workflow catalog");

  const creClient = new CREEndpointClient({ simulationMode: true });
  const registry = await creClient.discoverWorkflows();

  ok(`Discovered ${registry.workflows.length} workflows from CRE registry (DON: ${registry.donId})`);
  catalogTable(
    registry.workflows.map((wf) => ({
      name: wf.name,
      priceUSDC: wf.payment.priceUSDC,
      capabilities: wf.capabilities,
    }))
  );

  const dataStreamsWorkflows = await creClient.findByCapability("data-streams");
  const computeWorkflows = await creClient.findByCapability("compute");
  ok(`Workflows with 'data-streams': ${dataStreamsWorkflows.map((w) => w.name).join(", ")}`);
  ok(`Workflows with 'compute':      ${computeWorkflows.map((w) => w.name).join(", ")}`);
  endStep();

  separator();

  // ── Step 2: Agent Client Setup ────────────────────────────────────────────
  startStep(2, "Initialize AgentClient with x402 payment capability");

  const agent = new AgentClient({
    gatewayUrl: `http://localhost:${DEMO_PORT}`,
    payerAddress: HAS_REAL_WALLET ? "auto" : PAYER,
    simulationMode: !HAS_REAL_WALLET,
    privateKey: PRIVATE_KEY,
    network: "base-sepolia",
  });

  info(`Client mode: ${agent.isSimulationMode ? "simulation" : "production"}`);
  info(`Has real signer: ${agent.hasRealSigner}`);
  if (agent.hasRealSigner) {
    info(`Signer address: ${agent.signerAddress}`);
  }

  const workflows = await agent.discoverWorkflows();
  ok(`Agent discovered ${workflows.length} workflows from gateway`);
  endStep();

  separator();

  // ── Step 3: Construct Payment Proof ──────────────────────────────────────
  startStep(3, "Construct x402 payment proof (EIP-3009 authorization)");

  const priceFeedWorkflow = workflows.find((w) => w.name === "price-feed");
  if (!priceFeedWorkflow) throw new Error("price-feed workflow not found");

  const proof = await agent.constructPaymentProofAsync(
    priceFeedWorkflow.payment.recipient,
    priceFeedWorkflow.priceUSDC
  );

  const decoded = JSON.parse(Buffer.from(proof, "base64").toString()) as Record<string, unknown>;
  ok(`Payment proof created (${proof.length} chars base64)`);
  const isReal = "x402Version" in decoded;
  result("Proof structure", {
    x402Version: decoded.x402Version ?? "mock",
    scheme: decoded.scheme ?? "mock",
    network: decoded.network ?? "base-sepolia",
    type: isReal ? "real-x402-eip3009" : "mock",
    ...(isReal && "payload" in decoded && typeof decoded.payload === "object" && decoded.payload !== null ? {
      authorization: {
        from: `${String(((decoded.payload as Record<string, unknown>).authorization as Record<string, unknown>)?.from ?? "").slice(0, 10)}...`,
        value: `${((decoded.payload as Record<string, unknown>).authorization as Record<string, unknown>)?.value} micro-USDC`,
      }
    } : { payer: decoded.payer, amount: `${decoded.amount} micro-USDC` }),
  });
  endStep();

  separator();

  // ── Step 4: Invoke Price Feed Workflow ────────────────────────────────────
  startStep(4, "Invoke price-feed workflow with x402 payment");
  info(`POST http://localhost:${DEMO_PORT}/invoke/price-feed`);
  info(`Headers: x-payment: <base64-eip3009-proof>`);
  info(`Body: { pair: "ETH/USD" }`);

  const priceResult = await agent.invoke("price-feed", { pair: "ETH/USD" });

  if (priceResult.success) {
    ok(`Workflow invoked successfully — paid $${priceFeedWorkflow.priceUSDC} USDC`);
    result("ETH/USD Price Response", priceResult.result);
    info(`Execution time: ${(priceResult.meta?.executionMs ?? 0)}ms`);
    endStep(true);
  } else {
    fail(`Failed: ${priceResult.error}`);
    endStep(false);
  }

  separator();

  // ── Step 5: Batch Invocation ──────────────────────────────────────────────
  startStep(5, "Batch invoke — 3 parallel x402-gated requests");
  info("Dispatching ETH/USD + BTC/USD prices + weather oracle simultaneously...");

  const batchResult = await agent.batchInvoke([
    { workflowName: "price-feed", payload: { pair: "ETH/USD" } },
    { workflowName: "price-feed", payload: { pair: "BTC/USD" } },
    { workflowName: "weather-oracle", payload: { location: "Denver, CO" } },
  ]);

  ok(`Batch complete: ${batchResult.succeeded}/${batchResult.totalRequested} succeeded in ${batchResult.totalExecutionMs}ms`);
  for (const r of batchResult.results) {
    const statusIcon = r.status === "success" ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
    info(`  ${statusIcon} ${r.workflowName}: ${r.status}`);
  }
  endStep(batchResult.succeeded === batchResult.totalRequested);

  separator();

  // ── Step 6: Multi-step Orchestration ─────────────────────────────────────
  startStep(6, "Multi-step workflow orchestration (payment per step)");
  info("Chain: price-feed → agent-task-dispatch");

  const orchestrator = new WorkflowOrchestrator(agent);
  const orchResult = await orchestrator.orchestrate(
    ["price-feed", "agent-task-dispatch"],
    { initialPayload: { pair: "LINK/USD" } }
  );

  ok(`Orchestration complete: ${orchResult.steps.length} steps, ${orchResult.stepsCompleted} completed`);
  ok(`Total paid: $${orchResult.totalSpentUSDC.toFixed(4)} USDC`);
  for (const s of orchResult.steps) {
    const statusIcon = s.status === "success" ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
    info(`  ${statusIcon} Step ${s.stepIndex + 1} [${s.workflowName}]: ${s.executionMs}ms`);
  }
  endStep(orchResult.stepsCompleted > 0);

  separator();

  // ── Step 7: Rejection — Expired Payment Proof ─────────────────────────────
  startStep(7, "Rejection demo — expired payment proof returns 402");
  info("Constructing a proof that expired 5 minutes ago...");

  const expiredProof = createExpiredProof(PAYER, RECIPIENT, 0.001);
  const expiredResp = await fetch(`http://localhost:${DEMO_PORT}/invoke/price-feed`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-payment": expiredProof },
    body: JSON.stringify({ pair: "ETH/USD" }),
  });

  const expiredBody = await expiredResp.json() as Record<string, unknown>;
  if (expiredResp.status === 402) {
    ok(`Gateway returned HTTP 402 — expired proof correctly rejected`);
    result("402 Response (expired)", {
      status: expiredResp.status,
      error: expiredBody.error,
      message: String(expiredBody.message ?? "").slice(0, 100),
    });
    endStep(true);
  } else {
    fail(`Expected 402, got ${expiredResp.status}`);
    endStep(false);
  }

  separator();

  // ── Step 8: Rejection — Missing Payment Header ───────────────────────────
  startStep(8, "Rejection demo — no x-payment header returns 402");
  info(`POST http://localhost:${DEMO_PORT}/invoke/price-feed (no payment)`);

  const noPayResp = await fetch(`http://localhost:${DEMO_PORT}/invoke/price-feed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pair: "ETH/USD" }),
  });

  const err402 = await noPayResp.json() as Record<string, unknown>;
  if (noPayResp.status === 402) {
    ok(`Gateway returned HTTP 402 — missing header correctly rejected`);
    result("402 Response (no header)", {
      status: noPayResp.status,
      error: err402.error,
      message: String(err402.message ?? "").slice(0, 80),
    });
    endStep(true);
  } else {
    fail(`Expected 402, got ${noPayResp.status}`);
    endStep(false);
  }

  separator();

  // ── Done ──────────────────────────────────────────────────────────────────
  stopGateway();

  const demoMs = Date.now() - demoStart;
  const completedSteps = stepLog.filter((s) => s.success).length;

  banner("Demo Complete");

  // Final summary table
  console.log(`${BOLD}Step Results:${RESET}`);
  const stepNameW = 52;
  const stepMsW = 8;
  console.log(`  ${BOLD}${"Step".padEnd(6)}${"Description".padEnd(stepNameW)}${"Time".padEnd(stepMsW)}${RESET}`);
  console.log(`  ${DIM}${"─".repeat(6)}${"─".repeat(stepNameW)}${"─".repeat(stepMsW)}${RESET}`);
  for (const s of stepLog) {
    const icon = s.success ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
    const n = `${s.n}.`.padEnd(6);
    const title = s.title.padEnd(stepNameW);
    const ms = `${s.ms}ms`.padEnd(stepMsW);
    console.log(`  ${icon} ${DIM}${n}${RESET}${title}${DIM}${ms}${RESET}`);
  }

  console.log();
  console.log(`${BOLD}Summary:${RESET}`);
  ok(`${completedSteps}/${stepLog.length} steps completed in ${demoMs}ms total`);
  ok(`Real EIP-712 signing: ${HAS_REAL_WALLET ? `${GREEN}YES${RESET} (${sanitizePrivateKey(PRIVATE_KEY!)})` : `${YELLOW}NO${RESET} (set PAYER_PRIVATE_KEY=0x... to enable)`}`);
  ok(`Recipient wallet: ${RECIPIENT}`);
  ok(`Protocol: x402 v1 + EIP-3009 transferWithAuthorization on Base Sepolia`);

  console.log();
  console.log(`${DIM}Run with PAYER_PRIVATE_KEY=0x... to enable real EIP-712 signing.${RESET}`);
  console.log(`${DIM}All requests run in-process — no external network calls required.${RESET}`);
  console.log();
}

// ─── Entry point ──────────────────────────────────────────────────────────────

main().catch((err) => {
  console.error("\n✗ Demo failed:", err);
  process.exit(1);
});
