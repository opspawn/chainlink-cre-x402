/**
 * OpSpawn x CRE Gateway Server
 *
 * HTTP server that exposes CRE workflows behind x402 payment gates.
 * Agents can discover available workflows and pay per invocation.
 *
 * Endpoints:
 *   GET  /workflows          — List available workflows + pricing
 *   POST /invoke/:workflow   — Invoke workflow (requires x-payment header)
 *   POST /agent/task         — High-level agent task (auto-routes to workflow)
 *   GET  /health             — Health check
 */

import express, { Request, Response, NextFunction } from "express";
import { X402CREPaymentGateway } from "./payment-gateway.js";
import { CREWorkflowRegistry } from "./cre-registry.js";
import { AgentTaskRequest } from "./types.js";
import { getCREStatus } from "./cre-handler.js";

const RECIPIENT_ADDRESS =
  process.env.RECIPIENT_ADDRESS ?? "0x7483a9F237cf8043704D6b17DA31c12BfFF860DD";
const PORT = parseInt(process.env.PORT ?? "3100", 10);
const SIMULATION_MODE = process.env.SIMULATION_MODE !== "false";

const registry = new CREWorkflowRegistry();
const gateway = new X402CREPaymentGateway(
  {
    recipientAddress: RECIPIENT_ADDRESS,
    simulationMode: SIMULATION_MODE,
    debug: process.env.DEBUG === "true",
  },
  registry
);

const app = express();
app.use(express.json());

// --- Health check ---
app.get("/health", (_req: Request, res: Response) => {
  const creStatus = getCREStatus();
  res.json({
    status: "ok",
    service: "opspawn-cre-x402-gateway",
    version: "0.2.0",
    simulationMode: SIMULATION_MODE,
    cre: creStatus,
    workflows: registry.listWorkflows().length,
    timestamp: new Date().toISOString(),
  });
});

// --- List available workflows ---
app.get("/workflows", (_req: Request, res: Response) => {
  const workflows = registry.listWorkflows().map((wf) => ({
    name: wf.name,
    description: wf.description,
    priceUSDC: wf.priceUSDC,
    trigger: wf.trigger,
    live: wf.live,
    // x402 payment instructions
    payment: {
      recipient: RECIPIENT_ADDRESS,
      amount: wf.priceUSDC,
      currency: "USDC",
      network: "base-sepolia",
      header: "x-payment",
    },
  }));

  res.json({
    workflows,
    count: workflows.length,
    simulationMode: SIMULATION_MODE,
    message: SIMULATION_MODE
      ? "Running in simulation mode. x402 payment proofs are validated structurally."
      : "Running in production mode. x402 payments verified on-chain.",
  });
});

// --- Invoke a specific workflow ---
app.post("/invoke/:workflow", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const workflowName = String(req.params.workflow);
    const paymentProof = (req.headers["x-payment"] as string) ?? "";
    const payload = req.body as Record<string, unknown>;

    const result = await gateway.invoke(workflowName, payload, paymentProof);

    if (!result.allowed) {
      res.status(402).json({
        error: "Payment Required",
        message: result.error,
        required: {
          header: "x-payment",
          amount: registry.getWorkflow(workflowName)?.priceUSDC ?? 0.001,
          currency: "USDC",
          recipient: RECIPIENT_ADDRESS,
          network: "base-sepolia",
        },
      });
      return;
    }

    res.json({
      success: true,
      result: result.workflowResult?.result,
      meta: {
        requestId: result.workflowResult?.requestId,
        workflowName,
        executionMs: result.workflowResult?.executionMs,
        pricePaid: result.pricePaid,
        paymentTx: result.payment.txHash,
      },
    });
  } catch (err) {
    next(err);
  }
});

// --- Agent task orchestration endpoint ---
app.post("/agent/task", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const paymentProof = (req.headers["x-payment"] as string) ?? "";
    const task = req.body as AgentTaskRequest;

    if (!task.task) {
      res.status(400).json({ error: "Missing 'task' field in request body" });
      return;
    }

    const result = await gateway.orchestrateAgentTask(task, paymentProof);

    res.json({
      success: true,
      taskId: result.taskId,
      task: result.task,
      result: result.result,
      meta: {
        workflowsInvoked: result.workflowsInvoked,
        totalSpentUSDC: result.totalSpentUSDC,
        paymentGated: result.paymentGated,
      },
    });
  } catch (err) {
    next(err);
  }
});

// Error handler
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error("[Gateway Error]", err.message);
  res.status(500).json({ error: "Internal server error", message: err.message });
});

if (process.env.NODE_ENV !== "test") {
  app.listen(PORT, () => {
    console.log(`
╔═══════════════════════════════════════════════════════════════╗
║       OpSpawn x CRE — x402 Payment Gateway                   ║
╠═══════════════════════════════════════════════════════════════╣
║  Listening on http://localhost:${PORT.toString().padEnd(33)}║
║  Mode: ${(SIMULATION_MODE ? "SIMULATION" : "PRODUCTION").padEnd(53)}║
║  Recipient: ${RECIPIENT_ADDRESS.slice(0, 42).padEnd(49)}║
╚═══════════════════════════════════════════════════════════════╝
    `);
  });
}

export { app, gateway, registry };
