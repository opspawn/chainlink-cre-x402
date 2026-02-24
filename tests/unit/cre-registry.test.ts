/**
 * Tests: CRE Workflow Registry
 */

import { CREWorkflowRegistry, BUILT_IN_WORKFLOWS } from "../../src/cre-registry";
import { CREWorkflowDefinition } from "../../src/types";

describe("CREWorkflowRegistry", () => {
  let registry: CREWorkflowRegistry;

  beforeEach(() => {
    registry = new CREWorkflowRegistry();
  });

  describe("listWorkflows()", () => {
    it("returns all built-in workflows", () => {
      const workflows = registry.listWorkflows();
      expect(workflows.length).toBe(BUILT_IN_WORKFLOWS.length);
      expect(workflows.length).toBeGreaterThanOrEqual(4);
    });

    it("includes required workflow names", () => {
      const names = registry.listWorkflows().map((w) => w.name);
      expect(names).toContain("price-feed");
      expect(names).toContain("agent-task-dispatch");
      expect(names).toContain("weather-oracle");
      expect(names).toContain("compute-task");
    });
  });

  describe("getWorkflow()", () => {
    it("returns a workflow by name", () => {
      const wf = registry.getWorkflow("price-feed");
      expect(wf).toBeDefined();
      expect(wf!.name).toBe("price-feed");
      expect(wf!.priceUSDC).toBeGreaterThan(0);
    });

    it("returns undefined for unknown workflow", () => {
      const wf = registry.getWorkflow("nonexistent-workflow");
      expect(wf).toBeUndefined();
    });
  });

  describe("registerWorkflow()", () => {
    it("registers a custom workflow", () => {
      const custom: CREWorkflowDefinition = {
        name: "custom-test-workflow",
        description: "Test workflow",
        priceUSDC: 0.0001,
        trigger: "http",
        live: false,
        handler: async () => ({ result: "custom" }),
      };

      registry.registerWorkflow(custom);
      expect(registry.getWorkflow("custom-test-workflow")).toBeDefined();
      expect(registry.listWorkflows()).toHaveLength(BUILT_IN_WORKFLOWS.length + 1);
    });
  });

  describe("execute()", () => {
    it("executes price-feed workflow successfully", async () => {
      const result = await registry.execute({
        requestId: "test-req-1",
        workflowName: "price-feed",
        payload: { pair: "ETH/USD" },
        createdAt: new Date().toISOString(),
      });

      expect(result.status).toBe("success");
      expect(result.result).toMatchObject({
        pair: "ETH/USD",
        price: expect.any(Number),
        source: "chainlink-data-streams-simulation",
      });
      expect(result.executionMs).toBeGreaterThanOrEqual(0);
    });

    it("executes compute-task workflow with sum operation", async () => {
      const result = await registry.execute({
        requestId: "test-req-2",
        workflowName: "compute-task",
        payload: { data: [10, 20, 30, 40], operation: "sum" },
        createdAt: new Date().toISOString(),
      });

      expect(result.status).toBe("success");
      const r = result.result as Record<string, unknown>;
      expect(r.result).toBe(100);
      expect(r.operation).toBe("sum");
      expect(r.verified).toBe(true);
    });

    it("executes compute-task with mean operation", async () => {
      const result = await registry.execute({
        requestId: "test-req-3",
        workflowName: "compute-task",
        payload: { data: [10, 20, 30], operation: "mean" },
        createdAt: new Date().toISOString(),
      });

      expect(result.status).toBe("success");
      const r = result.result as Record<string, unknown>;
      expect(r.result).toBe(20);
    });

    it("returns failed status for unknown workflow", async () => {
      const result = await registry.execute({
        requestId: "test-req-4",
        workflowName: "does-not-exist",
        payload: {},
        createdAt: new Date().toISOString(),
      });

      expect(result.status).toBe("failed");
      expect(result.error).toContain("Workflow not found");
    });

    it("returns failed status when handler throws", async () => {
      const result = await registry.execute({
        requestId: "test-req-5",
        workflowName: "compute-task",
        payload: { data: null, operation: "sum" }, // Invalid data
        createdAt: new Date().toISOString(),
      });

      expect(result.status).toBe("failed");
      expect(result.error).toBeTruthy();
    });

    it("executes agent-task-dispatch workflow", async () => {
      const result = await registry.execute({
        requestId: "test-req-6",
        workflowName: "agent-task-dispatch",
        payload: { task: "analyze sentiment", params: { text: "great product!" } },
        createdAt: new Date().toISOString(),
      });

      expect(result.status).toBe("success");
      const r = result.result as Record<string, unknown>;
      expect(r.orchestratedBy).toBe("CRE-simulation");
    });
  });
});
