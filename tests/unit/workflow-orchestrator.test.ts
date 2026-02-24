/**
 * Tests: WorkflowOrchestrator
 *
 * Covers:
 *   - Sequential workflow chaining
 *   - Payload passing between steps
 *   - Failure handling (stop-on-failure vs continueOnFailure)
 *   - Partial success scenarios
 *   - Empty and single-workflow chains
 *   - Custom payload transformer
 *   - batchOrchestrate parallel execution
 *   - OrchestrationResult fields (status, totalSpentUSDC, stepsCompleted)
 *   - Network-level errors
 *   - WorkflowOrchestrator.summarize() static method
 */

import { jest } from "@jest/globals";
import { AgentClient } from "../../src/agent-client";
import {
  WorkflowOrchestrator,
  OrchestrationResult,
  StepResult,
} from "../../src/workflow-orchestrator";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const PAYER = "0x7483a9F237cf8043704D6b17DA31c12BfFF860DD";

function makeClient(): AgentClient {
  return new AgentClient({
    gatewayUrl: "http://localhost:3100",
    payerAddress: PAYER,
    simulationMode: true,
  });
}

/** Build a successful invoke result */
function successResult(result: unknown, pricePaid = 0.001) {
  return {
    success: true,
    result,
    meta: { pricePaid, executionMs: 10, workflowName: "test", requestId: "r1" },
    paymentUsed: "mock-proof",
  };
}

/** Build a failed invoke result */
function failResult(error: string) {
  return { success: false, error, paymentUsed: "mock-proof" };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("WorkflowOrchestrator", () => {
  let client: AgentClient;
  let orchestrator: WorkflowOrchestrator;
  let invokeSpy: jest.SpiedFunction<typeof client.invoke>;

  beforeEach(() => {
    client = makeClient();
    orchestrator = new WorkflowOrchestrator(client);
    invokeSpy = jest.spyOn(client, "invoke");
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ─ Test 1: Single workflow chain succeeds ────────────────────────────────
  it("executes a single-workflow chain successfully", async () => {
    invokeSpy.mockResolvedValueOnce(successResult({ price: 2847.32 }));

    const result = await orchestrator.orchestrate(["price-feed"]);

    expect(result.status).toBe("completed");
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0].status).toBe("success");
    expect(result.steps[0].workflowName).toBe("price-feed");
  });

  // ─ Test 2: Multi-step chain — all succeed ───────────────────────────────
  it("chains three workflows and returns completed status", async () => {
    invokeSpy
      .mockResolvedValueOnce(successResult({ price: 2847.32 }, 0.001))
      .mockResolvedValueOnce(successResult({ riskScore: 0.42 }, 0.002))
      .mockResolvedValueOnce(successResult({ action: "rebalance" }, 0.005));

    const result = await orchestrator.orchestrate([
      "price-feed",
      "risk-assessment",
      "portfolio-rebalance",
    ]);

    expect(result.status).toBe("completed");
    expect(result.steps).toHaveLength(3);
    expect(result.steps.every((s) => s.status === "success")).toBe(true);
    expect(invokeSpy).toHaveBeenCalledTimes(3);
  });

  // ─ Test 3: Total USDC calculation ───────────────────────────────────────
  it("sums USDC spent across all steps", async () => {
    invokeSpy
      .mockResolvedValueOnce(successResult({}, 0.001))
      .mockResolvedValueOnce(successResult({}, 0.002))
      .mockResolvedValueOnce(successResult({}, 0.005));

    const result = await orchestrator.orchestrate(["a", "b", "c"]);

    expect(result.totalSpentUSDC).toBeCloseTo(0.008);
  });

  // ─ Test 4: Final result is last successful step's output ────────────────
  it("sets finalResult to the output of the last successful step", async () => {
    const lastResult = { action: "buy", amount: 100 };
    invokeSpy
      .mockResolvedValueOnce(successResult({ price: 2847 }))
      .mockResolvedValueOnce(successResult(lastResult));

    const result = await orchestrator.orchestrate(["price-feed", "portfolio-rebalance"]);

    expect(result.finalResult).toEqual(lastResult);
  });

  // ─ Test 5: Stop-on-failure (default) ────────────────────────────────────
  it("stops at the first failure by default (continueOnFailure=false)", async () => {
    invokeSpy
      .mockResolvedValueOnce(successResult({ price: 2847 }))
      .mockResolvedValueOnce(failResult("Workflow unavailable"));

    const result = await orchestrator.orchestrate([
      "price-feed",
      "risk-assessment",
      "portfolio-rebalance",
    ]);

    expect(result.status).toBe("failed");
    expect(result.steps[0].status).toBe("success");
    expect(result.steps[1].status).toBe("failed");
    expect(result.steps[2].status).toBe("skipped");
    // Third step should NOT have been invoked
    expect(invokeSpy).toHaveBeenCalledTimes(2);
  });

  // ─ Test 6: continueOnFailure=true ───────────────────────────────────────
  it("continues executing steps after failure when continueOnFailure=true", async () => {
    invokeSpy
      .mockResolvedValueOnce(successResult({ price: 2847 }))
      .mockResolvedValueOnce(failResult("Workflow down"))
      .mockResolvedValueOnce(successResult({ action: "rebalance" }));

    const result = await orchestrator.orchestrate(
      ["price-feed", "risk-assessment", "portfolio-rebalance"],
      { continueOnFailure: true }
    );

    expect(result.status).toBe("partial");
    expect(result.steps[0].status).toBe("success");
    expect(result.steps[1].status).toBe("failed");
    expect(result.steps[2].status).toBe("success");
    expect(invokeSpy).toHaveBeenCalledTimes(3);
  });

  // ─ Test 7: All steps fail → status "failed" ─────────────────────────────
  it("returns status 'failed' when all steps fail", async () => {
    invokeSpy
      .mockResolvedValueOnce(failResult("Error A"))
      .mockResolvedValueOnce(failResult("Error B"));

    const result = await orchestrator.orchestrate(["a", "b"], { continueOnFailure: true });

    expect(result.status).toBe("failed");
    expect(result.finalResult).toBeUndefined();
  });

  // ─ Test 8: Empty chain ───────────────────────────────────────────────────
  it("handles an empty workflow chain gracefully", async () => {
    const result = await orchestrator.orchestrate([]);

    expect(result.status).toBe("completed");
    expect(result.steps).toHaveLength(0);
    expect(result.totalSpentUSDC).toBe(0);
    expect(result.stepsCompleted).toBe(0);
    expect(invokeSpy).not.toHaveBeenCalled();
  });

  // ─ Test 9: stepsCompleted excludes skipped steps ────────────────────────
  it("counts only non-skipped steps in stepsCompleted", async () => {
    invokeSpy
      .mockResolvedValueOnce(successResult({}))
      .mockResolvedValueOnce(failResult("Failure"));

    const result = await orchestrator.orchestrate(["a", "b", "c"]);

    // step a: success, step b: failed, step c: skipped
    expect(result.stepsCompleted).toBe(2); // a + b (not c)
    expect(result.steps[2].status).toBe("skipped");
  });

  // ─ Test 10: Payload chaining — previous output as next input ────────────
  it("passes previous step result as payload to the next step", async () => {
    const priceData = { price: 2847.32, pair: "ETH/USD" };
    invokeSpy
      .mockResolvedValueOnce(successResult(priceData))
      .mockResolvedValueOnce(successResult({ riskScore: 0.5 }));

    await orchestrator.orchestrate(["price-feed", "risk-assessment"]);

    // Second invoke should receive payload containing the first step's result
    const secondCallPayload = invokeSpy.mock.calls[1][1] as Record<string, unknown>;
    expect(secondCallPayload).toMatchObject({ previousResult: priceData });
  });

  // ─ Test 11: initialPayload is passed to first step ──────────────────────
  it("passes initialPayload to the first workflow", async () => {
    invokeSpy.mockResolvedValueOnce(successResult({ price: 2847 }));

    const initialPayload = { pair: "BTC/USD", customFlag: true };
    await orchestrator.orchestrate(["price-feed"], { initialPayload });

    expect(invokeSpy).toHaveBeenCalledWith("price-feed", initialPayload);
  });

  // ─ Test 12: Custom payloadTransformer ───────────────────────────────────
  it("uses custom payloadTransformer to shape inter-step payloads", async () => {
    invokeSpy
      .mockResolvedValueOnce(successResult({ price: 2847 }))
      .mockResolvedValueOnce(successResult({ risk: 0.3 }));

    const transformer = jest.fn(
      (result: unknown, _next: string) => ({ transformed: true, data: result })
    );

    await orchestrator.orchestrate(["price-feed", "risk-assessment"], {
      payloadTransformer: transformer,
    });

    expect(transformer).toHaveBeenCalledTimes(1);
    const secondCallPayload = invokeSpy.mock.calls[1][1] as Record<string, unknown>;
    expect(secondCallPayload).toEqual({ transformed: true, data: { price: 2847 } });
  });

  // ─ Test 13: Network-level error (invoke throws) ──────────────────────────
  it("handles network-level errors (invoke throws) as step failures", async () => {
    invokeSpy.mockRejectedValueOnce(new Error("Connection refused"));

    const result = await orchestrator.orchestrate(["price-feed"]);

    expect(result.status).toBe("failed");
    expect(result.steps[0].status).toBe("failed");
    expect(result.steps[0].error).toContain("Connection refused");
  });

  // ─ Test 14: orchestrationId is unique per run ────────────────────────────
  it("generates a unique orchestrationId for each orchestration", async () => {
    invokeSpy.mockResolvedValue(successResult({}));

    const r1 = await orchestrator.orchestrate(["price-feed"]);
    const r2 = await orchestrator.orchestrate(["price-feed"]);

    expect(r1.orchestrationId).not.toBe(r2.orchestrationId);
    expect(r1.orchestrationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
  });

  // ─ Test 15: startedAt and completedAt are valid ISO timestamps ───────────
  it("records startedAt and completedAt as valid ISO timestamps", async () => {
    invokeSpy.mockResolvedValueOnce(successResult({}));

    const before = new Date().toISOString();
    const result = await orchestrator.orchestrate(["price-feed"]);
    const after = new Date().toISOString();

    expect(result.startedAt >= before).toBe(true);
    expect(result.completedAt <= after).toBe(true);
    expect(result.completedAt >= result.startedAt).toBe(true);
  });

  // ─ Test 16: workflowChain preserves order ───────────────────────────────
  it("preserves the workflow chain order in the result", async () => {
    invokeSpy.mockResolvedValue(successResult({}));
    const chain = ["price-feed", "risk-assessment", "portfolio-rebalance"];

    const result = await orchestrator.orchestrate(chain);

    expect(result.workflowChain).toEqual(chain);
  });

  // ─ Test 17: OrchestrationStep objects with payload override ─────────────
  it("uses step-level payload override when provided as OrchestrationStep", async () => {
    invokeSpy
      .mockResolvedValueOnce(successResult({ price: 100 }))
      .mockResolvedValueOnce(successResult({}));

    const fixedPayload = { operation: "sum", data: [1, 2, 3] };
    await orchestrator.orchestrate([
      "price-feed",
      { workflowName: "compute-task", payload: fixedPayload },
    ]);

    expect(invokeSpy.mock.calls[1][1]).toEqual(fixedPayload);
  });

  // ─ Test 18: batchOrchestrate runs chains in parallel ────────────────────
  it("batchOrchestrate executes multiple chains and returns one result per chain", async () => {
    invokeSpy.mockResolvedValue(successResult({ result: "ok" }));

    const results = await orchestrator.batchOrchestrate([
      ["price-feed"],
      ["weather-oracle"],
      ["compute-task"],
    ]);

    expect(results).toHaveLength(3);
    expect(results.every((r) => r.status === "completed")).toBe(true);
  });

  // ─ Test 19: WorkflowOrchestrator.summarize() static method ──────────────
  it("summarize() returns a human-readable string with chain and status", () => {
    const mockResult: OrchestrationResult = {
      orchestrationId: "abc-123",
      workflowChain: ["price-feed", "risk-assessment"],
      steps: [
        { workflowName: "price-feed", stepIndex: 0, status: "success", spentUSDC: 0.001 },
        { workflowName: "risk-assessment", stepIndex: 1, status: "failed", error: "timeout" },
      ],
      finalResult: undefined,
      totalSpentUSDC: 0.001,
      stepsCompleted: 2,
      status: "partial",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    };

    const summary = WorkflowOrchestrator.summarize(mockResult);

    expect(summary).toContain("PARTIAL");
    expect(summary).toContain("price-feed");
    expect(summary).toContain("risk-assessment");
    expect(summary).toContain("price-feed → risk-assessment");
  });

  // ─ Test 20: stepIndex is correct for each step ───────────────────────────
  it("assigns correct stepIndex to each step result", async () => {
    invokeSpy.mockResolvedValue(successResult({}));

    const result = await orchestrator.orchestrate(["a", "b", "c"]);

    expect(result.steps[0].stepIndex).toBe(0);
    expect(result.steps[1].stepIndex).toBe(1);
    expect(result.steps[2].stepIndex).toBe(2);
  });
});
