/**
 * OpSpawn x CRE — Live Demo Server
 *
 * A standalone Express demo server that showcases the x402 + CRE integration
 * with a rich HTML dashboard for judges and live demos.
 *
 * Features:
 *   - HTML dashboard at GET /  with live stats
 *   - Workflow catalog with USDC pricing
 *   - Recent invocations log (in-memory ring buffer)
 *   - Test-mode indicator + wallet address
 *   - REST API for triggering workflows from the dashboard
 *
 * Run:
 *   npx ts-node --esm demo/server.ts
 *   # or after build:
 *   node dist/demo/server.js
 *
 * Access: http://localhost:3100
 */

import express, { Request, Response, NextFunction } from "express";
import { AgentClient } from "../src/agent-client.js";
import { WorkflowOrchestrator } from "../src/workflow-orchestrator.js";
import { BUILT_IN_WORKFLOWS } from "../src/cre-registry.js";

// ─── Config ──────────────────────────────────────────────────────────────────

const DEMO_PORT = parseInt(process.env.DEMO_PORT ?? "3100", 10);
const WALLET_ADDRESS = "0x7483a9F237cf8043704D6b17DA31c12BfFF860DD";
const GATEWAY_URL = process.env.GATEWAY_URL ?? `http://localhost:${DEMO_PORT}`;

// ─── Invocation Log (ring buffer, max 50 entries) ────────────────────────────

interface InvocationLogEntry {
  id: string;
  workflowName: string;
  status: "success" | "failed" | "orchestrated";
  pricePaid?: number;
  executionMs?: number;
  payer: string;
  timestamp: string;
  summary?: string;
}

const invocationLog: InvocationLogEntry[] = [];
const MAX_LOG_ENTRIES = 50;

function logInvocation(entry: InvocationLogEntry): void {
  invocationLog.unshift(entry); // newest first
  if (invocationLog.length > MAX_LOG_ENTRIES) {
    invocationLog.splice(MAX_LOG_ENTRIES);
  }
}

// ─── In-process gateway (simulation mode, no network needed) ─────────────────
// Import gateway components directly so the demo is self-contained.

import { X402CREPaymentGateway } from "../src/payment-gateway.js";
import { CREWorkflowRegistry } from "../src/cre-registry.js";

const registry = new CREWorkflowRegistry();
const gateway = new X402CREPaymentGateway(
  { recipientAddress: WALLET_ADDRESS, simulationMode: true },
  registry
);

// AgentClient wired to localhost gateway for orchestration demos
const agentClient = new AgentClient({
  gatewayUrl: GATEWAY_URL,
  payerAddress: WALLET_ADDRESS,
  simulationMode: true,
});

const orchestrator = new WorkflowOrchestrator(agentClient);

// ─── HTML Dashboard ───────────────────────────────────────────────────────────

function renderDashboard(): string {
  const workflows = BUILT_IN_WORKFLOWS.map((wf) => ({
    name: wf.name,
    description: wf.description,
    priceUSDC: wf.priceUSDC,
    trigger: wf.trigger,
  }));

  const recentLog = invocationLog.slice(0, 20);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>OpSpawn × CRE — x402 Payment Gateway</title>
  <style>
    :root {
      --bg: #0d1117;
      --surface: #161b22;
      --border: #30363d;
      --accent: #58a6ff;
      --accent2: #3fb950;
      --accent3: #f78166;
      --text: #e6edf3;
      --muted: #8b949e;
      --badge-sim: #1f6feb;
      --badge-live: #238636;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', monospace;
      min-height: 100vh;
    }
    header {
      background: var(--surface);
      border-bottom: 1px solid var(--border);
      padding: 16px 32px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .brand-logo {
      font-size: 24px;
      font-weight: 800;
      background: linear-gradient(135deg, var(--accent), var(--accent2));
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    .brand-sub { color: var(--muted); font-size: 13px; }
    .badge {
      display: inline-block;
      padding: 3px 10px;
      border-radius: 20px;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .badge-sim { background: var(--badge-sim); color: #fff; }
    .badge-live { background: var(--badge-live); color: #fff; }
    main { max-width: 1200px; margin: 0 auto; padding: 32px; }
    .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin-bottom: 24px; }
    .grid-3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin-bottom: 24px; }
    .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 20px;
    }
    .card h3 {
      font-size: 12px;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 1px;
      margin-bottom: 8px;
    }
    .card .value {
      font-size: 28px;
      font-weight: 700;
      color: var(--text);
    }
    .card .sub { font-size: 12px; color: var(--muted); margin-top: 4px; }
    .section-title {
      font-size: 18px;
      font-weight: 600;
      margin-bottom: 16px;
      color: var(--text);
    }
    .wallet-box {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 20px;
      margin-bottom: 24px;
    }
    .wallet-label { font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: 1px; }
    .wallet-addr {
      font-family: monospace;
      font-size: 16px;
      color: var(--accent);
      margin-top: 6px;
      word-break: break-all;
    }
    .network-pill {
      display: inline-block;
      background: #1c2128;
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 2px 8px;
      font-size: 12px;
      color: var(--muted);
      margin-top: 8px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 14px;
    }
    th {
      text-align: left;
      padding: 10px 12px;
      font-size: 11px;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.5px;
      border-bottom: 1px solid var(--border);
    }
    td {
      padding: 12px 12px;
      border-bottom: 1px solid var(--border);
      vertical-align: middle;
    }
    tr:last-child td { border-bottom: none; }
    .wf-name {
      font-family: monospace;
      color: var(--accent);
      font-weight: 600;
    }
    .price-tag {
      background: #1c2128;
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 2px 8px;
      font-size: 12px;
      font-family: monospace;
      color: var(--accent2);
    }
    .status-success { color: var(--accent2); }
    .status-failed { color: var(--accent3); }
    .status-orchestrated { color: var(--accent); }
    .log-table { font-size: 13px; }
    .log-table td { padding: 8px 12px; }
    .ts { font-size: 11px; color: var(--muted); font-family: monospace; }
    .trigger-form {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 20px;
      margin-bottom: 24px;
    }
    .trigger-form h2 { font-size: 16px; font-weight: 600; margin-bottom: 16px; }
    .form-row { display: flex; gap: 12px; align-items: flex-end; flex-wrap: wrap; }
    .form-group { display: flex; flex-direction: column; gap: 6px; }
    .form-group label { font-size: 12px; color: var(--muted); }
    select, input[type=text] {
      background: var(--bg);
      border: 1px solid var(--border);
      color: var(--text);
      border-radius: 6px;
      padding: 8px 12px;
      font-size: 14px;
      min-width: 200px;
    }
    button {
      background: var(--accent);
      color: #0d1117;
      border: none;
      border-radius: 6px;
      padding: 9px 18px;
      font-size: 14px;
      font-weight: 700;
      cursor: pointer;
      transition: opacity 0.15s;
    }
    button:hover { opacity: 0.85; }
    button.btn-orchestrate { background: var(--accent2); }
    .result-box {
      margin-top: 16px;
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 16px;
      font-family: monospace;
      font-size: 13px;
      white-space: pre-wrap;
      max-height: 200px;
      overflow-y: auto;
      display: none;
    }
    .auto-refresh { font-size: 12px; color: var(--muted); text-align: right; margin-top: 8px; }
  </style>
</head>
<body>
  <header>
    <div class="brand">
      <div class="brand-logo">OpSpawn × CRE</div>
      <div class="brand-sub">x402 Micropayment Gateway — Chainlink Convergence Hackathon</div>
    </div>
    <span class="badge badge-sim">Simulation Mode</span>
  </header>

  <main>
    <!-- Wallet -->
    <div class="wallet-box">
      <div class="wallet-label">Connected Wallet (Agent Recipient)</div>
      <div class="wallet-addr">${WALLET_ADDRESS}</div>
      <span class="network-pill">Base Sepolia (Testnet)</span>
      <span class="network-pill" style="margin-left:8px">USDC — EIP-3009 / x402</span>
    </div>

    <!-- Stats -->
    <div class="grid-3">
      <div class="card">
        <h3>Workflows Available</h3>
        <div class="value">${workflows.length}</div>
        <div class="sub">CRE simulation mode</div>
      </div>
      <div class="card">
        <h3>Invocations (Session)</h3>
        <div class="value" id="stat-total">${invocationLog.length}</div>
        <div class="sub">x402 payment-gated</div>
      </div>
      <div class="card">
        <h3>Protocol</h3>
        <div class="value" style="font-size:18px">x402</div>
        <div class="sub">HTTP 402 Payment Required</div>
      </div>
    </div>

    <!-- Quick Trigger -->
    <div class="trigger-form">
      <h2>Trigger Workflow</h2>
      <div class="form-row">
        <div class="form-group">
          <label>Workflow</label>
          <select id="wf-select">
            ${workflows.map((wf) => `<option value="${wf.name}">${wf.name} ($${wf.priceUSDC.toFixed(4)})</option>`).join("")}
          </select>
        </div>
        <div class="form-group">
          <label>Payload (JSON)</label>
          <input type="text" id="wf-payload" value='{"pair":"ETH/USD"}' style="min-width:280px">
        </div>
        <button onclick="triggerWorkflow()">Invoke →</button>
        <button class="btn-orchestrate" onclick="triggerOrchestration()">Orchestrate Chain →</button>
      </div>
      <pre id="result-box" class="result-box"></pre>
    </div>

    <!-- Workflows Table -->
    <div class="section-title">Available Workflows</div>
    <div class="card" style="padding:0; margin-bottom:24px; overflow:hidden">
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Description</th>
            <th>Price</th>
            <th>Trigger</th>
            <th>x402 Header</th>
          </tr>
        </thead>
        <tbody>
          ${workflows
            .map(
              (wf) => `
          <tr>
            <td><span class="wf-name">${wf.name}</span></td>
            <td style="color:var(--muted);font-size:13px">${wf.description}</td>
            <td><span class="price-tag">$${wf.priceUSDC.toFixed(4)} USDC</span></td>
            <td style="color:var(--muted);font-size:12px">${wf.trigger}</td>
            <td style="font-family:monospace;font-size:12px;color:var(--muted)">x-payment</td>
          </tr>`
            )
            .join("")}
        </tbody>
      </table>
    </div>

    <!-- Invocation Log -->
    <div class="section-title">Recent Invocations</div>
    <div class="card" style="padding:0; overflow:hidden">
      <table class="log-table">
        <thead>
          <tr>
            <th>Time</th>
            <th>Workflow</th>
            <th>Status</th>
            <th>Price Paid</th>
            <th>Exec Time</th>
            <th>Payer</th>
          </tr>
        </thead>
        <tbody id="log-tbody">
          ${
            recentLog.length === 0
              ? `<tr><td colspan="6" style="text-align:center;color:var(--muted);padding:24px">No invocations yet — trigger a workflow above</td></tr>`
              : recentLog
                  .map(
                    (entry) => `
          <tr>
            <td class="ts">${new Date(entry.timestamp).toLocaleTimeString()}</td>
            <td><span class="wf-name">${entry.workflowName}</span></td>
            <td class="status-${entry.status}">${entry.status.toUpperCase()}</td>
            <td style="font-family:monospace">${entry.pricePaid != null ? `$${entry.pricePaid.toFixed(4)}` : "—"}</td>
            <td style="font-family:monospace">${entry.executionMs != null ? `${entry.executionMs}ms` : "—"}</td>
            <td class="ts">${entry.payer.slice(0, 10)}…</td>
          </tr>`
                  )
                  .join("")
          }
        </tbody>
      </table>
    </div>

    <div class="auto-refresh">Auto-refreshes every 5s · <a href="/" style="color:var(--accent)">Refresh now</a></div>
  </main>

  <script>
    async function triggerWorkflow() {
      const wf = document.getElementById('wf-select').value;
      const payloadRaw = document.getElementById('wf-payload').value;
      const box = document.getElementById('result-box');
      box.style.display = 'block';
      box.textContent = 'Invoking ' + wf + ' ...';
      let payload = {};
      try { payload = JSON.parse(payloadRaw); } catch(e) { box.textContent = 'Invalid JSON payload'; return; }
      try {
        const res = await fetch('/demo/invoke/' + wf, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        box.textContent = JSON.stringify(data, null, 2);
        setTimeout(() => window.location.reload(), 800);
      } catch(e) {
        box.textContent = 'Error: ' + e.message;
      }
    }

    async function triggerOrchestration() {
      const box = document.getElementById('result-box');
      box.style.display = 'block';
      box.textContent = 'Orchestrating chain: price-feed → risk-assessment → portfolio-rebalance ...';
      try {
        const res = await fetch('/demo/orchestrate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chain: ['price-feed', 'compute-task', 'agent-task-dispatch'] })
        });
        const data = await res.json();
        box.textContent = JSON.stringify(data, null, 2);
        setTimeout(() => window.location.reload(), 800);
      } catch(e) {
        box.textContent = 'Error: ' + e.message;
      }
    }

    // Auto-refresh every 5s
    setTimeout(() => window.location.reload(), 5000);
  </script>
</body>
</html>`;
}

// ─── Express App ──────────────────────────────────────────────────────────────

export const demoApp = express();
demoApp.use(express.json());

// Dashboard
demoApp.get("/", (_req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/html");
  res.send(renderDashboard());
});

// Demo invoke — routes through in-process gateway
demoApp.post("/demo/invoke/:workflow", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const workflowName = String(req.params.workflow);
    const payload = (req.body ?? {}) as Record<string, unknown>;
    const start = Date.now();

    // Build a mock payment proof for the demo
    const { createMockPaymentProof } = await import("../src/x402-verifier.js");
    const wfDef = registry.getWorkflow(workflowName);
    const priceUSDC = wfDef?.priceUSDC ?? 0.001;
    const paymentProof = createMockPaymentProof(WALLET_ADDRESS, WALLET_ADDRESS, priceUSDC);

    const result = await gateway.invoke(workflowName, payload, paymentProof);
    const executionMs = Date.now() - start;

    logInvocation({
      id: `demo-${Date.now()}`,
      workflowName,
      status: result.allowed ? "success" : "failed",
      pricePaid: result.pricePaid,
      executionMs,
      payer: WALLET_ADDRESS,
      timestamp: new Date().toISOString(),
    });

    res.json({
      success: result.allowed,
      workflowName,
      result: result.workflowResult?.result,
      pricePaid: result.pricePaid,
      executionMs,
    });
  } catch (err) {
    next(err);
  }
});

// Demo orchestration chain
demoApp.post("/demo/orchestrate", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const chain = (req.body?.chain as string[]) ?? ["price-feed", "agent-task-dispatch"];
    const start = Date.now();

    // Use gateway directly (agentClient.invoke would need a running server on the same port)
    const { createMockPaymentProof } = await import("../src/x402-verifier.js");

    const stepResults = [];
    let currentPayload: Record<string, unknown> = { pair: "ETH/USD", operation: "sum", data: [1, 2, 3] };

    for (const workflowName of chain) {
      const wfDef = registry.getWorkflow(workflowName);
      const priceUSDC = wfDef?.priceUSDC ?? 0.001;
      const proof = createMockPaymentProof(WALLET_ADDRESS, WALLET_ADDRESS, priceUSDC);
      const result = await gateway.invoke(workflowName, currentPayload, proof);

      stepResults.push({
        workflowName,
        status: result.allowed ? "success" : "failed",
        result: result.workflowResult?.result,
        pricePaid: result.pricePaid,
      });

      if (result.allowed && result.workflowResult?.result) {
        const prev = result.workflowResult.result;
        currentPayload =
          typeof prev === "object" && prev !== null
            ? { ...(prev as Record<string, unknown>), previousResult: prev, task: `analyze-${workflowName}` }
            : { previousResult: prev, task: `analyze-${workflowName}` };
      }

      logInvocation({
        id: `orch-${Date.now()}`,
        workflowName,
        status: "orchestrated",
        pricePaid: result.pricePaid,
        executionMs: result.workflowResult?.executionMs,
        payer: WALLET_ADDRESS,
        timestamp: new Date().toISOString(),
        summary: `Step in chain: ${chain.join(" → ")}`,
      });
    }

    res.json({
      success: true,
      chain,
      steps: stepResults,
      totalExecutionMs: Date.now() - start,
      totalPaid: stepResults.reduce((sum, s) => sum + (s.pricePaid ?? 0), 0),
    });
  } catch (err) {
    next(err);
  }
});

// Workflows JSON API
demoApp.get("/workflows", (_req: Request, res: Response) => {
  res.json({
    workflows: BUILT_IN_WORKFLOWS.map((wf) => ({
      name: wf.name,
      description: wf.description,
      priceUSDC: wf.priceUSDC,
      trigger: wf.trigger,
      payment: {
        recipient: WALLET_ADDRESS,
        amount: wf.priceUSDC,
        currency: "USDC",
        network: "base-sepolia",
        header: "x-payment",
      },
    })),
    count: BUILT_IN_WORKFLOWS.length,
    simulationMode: true,
  });
});

// Health check
demoApp.get("/health", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    service: "opspawn-cre-demo",
    wallet: WALLET_ADDRESS,
    simulationMode: true,
    workflows: BUILT_IN_WORKFLOWS.length,
    invocations: invocationLog.length,
    timestamp: new Date().toISOString(),
  });
});

// Error handler
demoApp.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error("[Demo Error]", err.message);
  res.status(500).json({ error: err.message });
});

// ─── Start Server ─────────────────────────────────────────────────────────────

if (process.env.NODE_ENV !== "test") {
  demoApp.listen(DEMO_PORT, () => {
    console.log(`
╔══════════════════════════════════════════════════════════════════╗
║     OpSpawn × CRE — x402 Demo Dashboard                         ║
╠══════════════════════════════════════════════════════════════════╣
║  Dashboard:  http://localhost:${DEMO_PORT.toString().padEnd(34)}║
║  Wallet:     ${WALLET_ADDRESS.padEnd(50)}║
║  Mode:       SIMULATION (no real payments)                       ║
╚══════════════════════════════════════════════════════════════════╝
`);
  });
}

export { invocationLog, registry, gateway };
