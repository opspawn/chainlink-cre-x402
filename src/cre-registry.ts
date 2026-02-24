/**
 * CRE Workflow Registry
 *
 * Manages the catalog of available CRE workflows with x402 pricing.
 * In simulation mode, workflows are executed locally via their handler functions.
 * In production, the CRE SDK dispatches them to the CRE gateway (requires registration).
 *
 * CRE SDK docs: https://docs.chain.link/cre
 * Package: @chainlink/cre-sdk (requires Bun >= 1.2.21 for WASM compilation)
 */

import { CREWorkflowDefinition, WorkflowRequest, WorkflowResult } from "./types.js";

/**
 * Built-in simulation workflows that match the CRE pattern.
 * These replicate what live CRE workflows would do.
 *
 * When CRE SDK is integrated:
 *   - HTTP trigger workflows: cre.handler(http.trigger(...), handler)
 *   - Compiled to WASM via: cre workflow simulate / cre workflow deploy
 */
export const BUILT_IN_WORKFLOWS: CREWorkflowDefinition[] = [
  {
    name: "price-feed",
    description: "Fetch latest price data for a token pair from Chainlink Data Streams",
    priceUSDC: 0.001,
    trigger: "http",
    live: false,
    handler: async (payload) => {
      const pair = String(payload.pair ?? "ETH/USD");
      // Simulate CRE Data Streams fetch
      // In live CRE: uses runtime.dataStreams.getReport(feedId)
      const mockPrices: Record<string, number> = {
        "ETH/USD": 2847.32 + Math.random() * 10 - 5,
        "BTC/USD": 52341.18 + Math.random() * 100 - 50,
        "LINK/USD": 14.73 + Math.random() * 0.5 - 0.25,
      };
      const price = mockPrices[pair] ?? 1.0;
      return {
        pair,
        price: Math.round(price * 100) / 100,
        timestamp: Date.now(),
        source: "chainlink-data-streams-simulation",
        confidence: 0.9999,
      };
    },
  },
  {
    name: "agent-task-dispatch",
    description: "Dispatch an AI agent task and return structured result via CRE orchestration",
    priceUSDC: 0.01,
    trigger: "http",
    live: false,
    handler: async (payload) => {
      const task = String(payload.task ?? "unknown");
      const params = (payload.params as Record<string, unknown>) ?? {};

      // Simulate CRE HTTP capability call to an AI agent
      // In live CRE: uses runtime.fetch(agentUrl, { method: "POST", body: JSON.stringify({task, params}) })
      await new Promise((resolve) => setTimeout(resolve, 50)); // Simulate network latency

      return {
        taskId: `task-${Date.now()}`,
        task,
        params,
        result: {
          summary: `Task "${task}" processed by CRE-orchestrated agent`,
          confidence: 0.87,
          data: Object.keys(params).length > 0 ? params : { processed: true },
        },
        orchestratedBy: "CRE-simulation",
        timestamp: Date.now(),
      };
    },
  },
  {
    name: "weather-oracle",
    description: "Fetch verified weather data for parametric insurance or prediction markets",
    priceUSDC: 0.005,
    trigger: "http",
    live: false,
    handler: async (payload) => {
      const location = String(payload.location ?? "Denver, CO");
      const date = String(payload.date ?? new Date().toISOString().split("T")[0]);

      // Simulate CRE HTTPClient call to weather API
      // In live CRE: uses runtime.http.get("https://api.weather.gov/...")
      const conditions = ["sunny", "cloudy", "rainy", "snowy", "windy"];
      const condition = conditions[Math.floor(Math.random() * conditions.length)];
      const temp = Math.round(Math.random() * 60 + 20); // 20-80°F

      return {
        location,
        date,
        condition,
        temperature_f: temp,
        precipitation_inches: condition === "rainy" ? Math.round(Math.random() * 100) / 100 : 0,
        verified: true,
        oracle: "chainlink-weather-simulation",
        timestamp: Date.now(),
      };
    },
  },
  {
    name: "compute-task",
    description: "Run verifiable off-chain computation via CRE (e.g. scoring, ranking, ML inference)",
    priceUSDC: 0.002,
    trigger: "http",
    live: false,
    handler: async (payload) => {
      const data = payload.data as number[] | undefined;
      const operation = String(payload.operation ?? "sum");

      if (!data || !Array.isArray(data)) {
        throw new Error("Payload must include 'data' array");
      }

      let result: number;
      switch (operation) {
        case "sum":
          result = data.reduce((a, b) => a + b, 0);
          break;
        case "mean":
          result = data.reduce((a, b) => a + b, 0) / data.length;
          break;
        case "max":
          result = Math.max(...data);
          break;
        case "min":
          result = Math.min(...data);
          break;
        default:
          throw new Error(`Unknown operation: ${operation}`);
      }

      return {
        operation,
        input: data,
        result: Math.round(result * 1000) / 1000,
        verified: true,
        computedBy: "CRE-verifiable-compute-simulation",
      };
    },
  },
];

export class CREWorkflowRegistry {
  private workflows: Map<string, CREWorkflowDefinition>;

  constructor(workflows?: CREWorkflowDefinition[]) {
    this.workflows = new Map();
    const all = [...BUILT_IN_WORKFLOWS, ...(workflows ?? [])];
    for (const wf of all) {
      this.workflows.set(wf.name, wf);
    }
  }

  getWorkflow(name: string): CREWorkflowDefinition | undefined {
    return this.workflows.get(name);
  }

  listWorkflows(): CREWorkflowDefinition[] {
    return Array.from(this.workflows.values());
  }

  registerWorkflow(workflow: CREWorkflowDefinition): void {
    this.workflows.set(workflow.name, workflow);
  }

  async execute(request: WorkflowRequest): Promise<WorkflowResult> {
    const start = Date.now();
    const workflow = this.workflows.get(request.workflowName);

    if (!workflow) {
      return {
        requestId: request.requestId,
        workflowName: request.workflowName,
        status: "failed",
        error: `Workflow not found: ${request.workflowName}. Available: ${[...this.workflows.keys()].join(", ")}`,
        executionMs: Date.now() - start,
      };
    }

    try {
      const result = await workflow.handler(request.payload);
      return {
        requestId: request.requestId,
        workflowName: request.workflowName,
        status: "success",
        result,
        executionMs: Date.now() - start,
      };
    } catch (err) {
      return {
        requestId: request.requestId,
        workflowName: request.workflowName,
        status: "failed",
        error: (err as Error).message,
        executionMs: Date.now() - start,
      };
    }
  }
}
