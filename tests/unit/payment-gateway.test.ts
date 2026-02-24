/**
 * Tests: X402 Payment Gateway (Integration of x402 + CRE)
 *
 * This is the core integration test — verifies the full flow:
 *   Payment Proof → Verification → CRE Workflow Execution → Result
 */

import { X402CREPaymentGateway } from "../../src/payment-gateway";
import { CREWorkflowRegistry } from "../../src/cre-registry";
import { createMockPaymentProof } from "../../src/x402-verifier";

const RECIPIENT = "0x7483a9F237cf8043704D6b17DA31c12BfFF860DD";
const PAYER = "0xAbCd1234567890AbCd1234567890AbCd12345678";

describe("X402CREPaymentGateway", () => {
  let gateway: X402CREPaymentGateway;

  beforeEach(() => {
    const registry = new CREWorkflowRegistry();
    gateway = new X402CREPaymentGateway(
      {
        recipientAddress: RECIPIENT,
        simulationMode: true,
        debug: false,
      },
      registry
    );
  });

  describe("invoke()", () => {
    it("allows access when valid x402 payment is provided", async () => {
      const proof = createMockPaymentProof(PAYER, RECIPIENT, 0.005);
      const result = await gateway.invoke("price-feed", { pair: "ETH/USD" }, proof);

      expect(result.allowed).toBe(true);
      expect(result.workflowResult?.status).toBe("success");
      expect(result.pricePaid).toBeGreaterThan(0);
    });

    it("denies access when no payment proof is provided", async () => {
      const result = await gateway.invoke("price-feed", { pair: "BTC/USD" }, "");

      expect(result.allowed).toBe(false);
      expect(result.error).toContain("Missing x402 payment proof");
      expect(result.workflowResult).toBeUndefined();
    });

    it("denies access when payment amount is insufficient", async () => {
      const proof = createMockPaymentProof(PAYER, RECIPIENT, 0.000001); // Too small
      const result = await gateway.invoke("agent-task-dispatch", {}, proof);

      expect(result.allowed).toBe(false);
      expect(result.error).toContain("Insufficient payment");
    });

    it("returns 402-like denial when recipient address is wrong", async () => {
      const wrongRecipient = "0x1111111111111111111111111111111111111111";
      const proof = createMockPaymentProof(PAYER, wrongRecipient, 1.0);
      const result = await gateway.invoke("price-feed", {}, proof);

      expect(result.allowed).toBe(false);
      expect(result.error).toContain("recipient mismatch");
    });

    it("executes compute workflow with payment gate", async () => {
      const proof = createMockPaymentProof(PAYER, RECIPIENT, 0.01);
      const result = await gateway.invoke(
        "compute-task",
        { data: [5, 10, 15], operation: "sum" },
        proof
      );

      expect(result.allowed).toBe(true);
      expect(result.workflowResult?.status).toBe("success");
      const r = result.workflowResult?.result as Record<string, unknown>;
      expect(r.result).toBe(30);
    });

    it("returns workflow error details when workflow fails", async () => {
      const proof = createMockPaymentProof(PAYER, RECIPIENT, 0.01);
      // compute-task with invalid data should fail
      const result = await gateway.invoke(
        "compute-task",
        { data: "not-an-array", operation: "sum" },
        proof
      );

      // Payment is still allowed, but workflow failed
      expect(result.allowed).toBe(true);
      expect(result.workflowResult?.status).toBe("failed");
    });
  });

  describe("orchestrateAgentTask()", () => {
    it("routes price task to price-feed workflow", async () => {
      const proof = createMockPaymentProof(PAYER, RECIPIENT, 0.01);
      const result = await gateway.orchestrateAgentTask(
        { task: "get current ETH price", params: { pair: "ETH/USD" } },
        proof
      );

      expect(result.workflowsInvoked).toContain("price-feed");
      expect(result.totalSpentUSDC).toBeGreaterThan(0);
      expect(result.paymentGated).toBe(true);
    });

    it("routes weather task to weather-oracle workflow", async () => {
      const proof = createMockPaymentProof(PAYER, RECIPIENT, 0.01);
      const result = await gateway.orchestrateAgentTask(
        { task: "check weather conditions", params: { location: "Denver, CO" } },
        proof
      );

      expect(result.workflowsInvoked).toContain("weather-oracle");
      expect(result.result).toBeDefined();
    });

    it("routes compute task to compute-task workflow", async () => {
      const proof = createMockPaymentProof(PAYER, RECIPIENT, 0.01);
      const result = await gateway.orchestrateAgentTask(
        { task: "calculate sum of values", params: { data: [1, 2, 3], operation: "sum" } },
        proof
      );

      expect(result.workflowsInvoked).toContain("compute-task");
    });

    it("throws when payment is denied", async () => {
      await expect(
        gateway.orchestrateAgentTask({ task: "get price" }, "")
      ).rejects.toThrow("Missing x402 payment proof");
    });

    it("assigns unique taskId per orchestration", async () => {
      const proof = createMockPaymentProof(PAYER, RECIPIENT, 0.01);
      const result1 = await gateway.orchestrateAgentTask({ task: "get price" }, proof);
      const proof2 = createMockPaymentProof(PAYER, RECIPIENT, 0.01);
      const result2 = await gateway.orchestrateAgentTask({ task: "get price" }, proof2);

      expect(result1.taskId).not.toBe(result2.taskId);
    });
  });

  describe("simulationMode", () => {
    it("reports simulation mode correctly", () => {
      expect(gateway.simulationMode).toBe(true);
    });

    it("exposes the workflow registry", () => {
      expect(gateway.workflowRegistry).toBeInstanceOf(CREWorkflowRegistry);
    });
  });
});
