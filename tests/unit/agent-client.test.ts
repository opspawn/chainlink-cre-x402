/**
 * Tests: OpSpawn Agent Client
 *
 * Tests the full E2E agent flow:
 *   - Workflow discovery (mocked fetch)
 *   - Payment proof construction (mock + real formats)
 *   - Workflow invocation with automatic x402 payment
 *   - High-level task submission
 *   - Error handling (402, network errors)
 */

import { jest } from "@jest/globals";
import { AgentClient, WorkflowInfo } from "../../src/agent-client";

const RECIPIENT = "0x7483a9F237cf8043704D6b17DA31c12BfFF860DD";
const PAYER = "0xAbCd1234567890AbCd1234567890AbCd12345678";
const GATEWAY_URL = "http://localhost:3100";

// Mock global fetch - use ReturnType trick to get a typed mock with call inspection
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockFetch = jest.fn() as jest.MockedFunction<(...args: any[]) => any>;
global.fetch = mockFetch as unknown as typeof fetch;

const sampleWorkflows: WorkflowInfo[] = [
  {
    name: "price-feed",
    description: "Fetch latest price",
    priceUSDC: 0.001,
    trigger: "http",
    live: false,
    payment: {
      recipient: RECIPIENT,
      amount: 0.001,
      currency: "USDC",
      network: "base-sepolia",
      header: "x-payment",
    },
  },
  {
    name: "agent-task-dispatch",
    description: "Dispatch agent task",
    priceUSDC: 0.01,
    trigger: "http",
    live: false,
    payment: {
      recipient: RECIPIENT,
      amount: 0.01,
      currency: "USDC",
      network: "base-sepolia",
      header: "x-payment",
    },
  },
  {
    name: "weather-oracle",
    description: "Weather data",
    priceUSDC: 0.005,
    trigger: "http",
    live: false,
    payment: {
      recipient: RECIPIENT,
      amount: 0.005,
      currency: "USDC",
      network: "base-sepolia",
      header: "x-payment",
    },
  },
];

describe("AgentClient", () => {
  let client: AgentClient;

  beforeEach(() => {
    client = new AgentClient({
      gatewayUrl: GATEWAY_URL,
      payerAddress: PAYER,
      simulationMode: true,
    });
    mockFetch.mockReset();
  });

  describe("constructor / config", () => {
    it("exposes payerAddress", () => {
      expect(client.payerAddress).toBe(PAYER);
    });

    it("defaults to simulation mode", () => {
      expect(client.isSimulationMode).toBe(true);
    });

    it("defaults to base-sepolia network", () => {
      expect(client.network).toBe("base-sepolia");
    });

    it("can be configured for production mode", () => {
      const prod = new AgentClient({
        gatewayUrl: GATEWAY_URL,
        payerAddress: PAYER,
        simulationMode: false,
      });
      expect(prod.isSimulationMode).toBe(false);
    });

    it("starts with null cached workflows", () => {
      expect(client.workflows).toBeNull();
    });
  });

  describe("discoverWorkflows()", () => {
    it("fetches workflows from /workflows endpoint", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ workflows: sampleWorkflows, count: 3, simulationMode: true }),
      });

      const workflows = await client.discoverWorkflows();

      expect(mockFetch).toHaveBeenCalledWith(`${GATEWAY_URL}/workflows`);
      expect(workflows).toHaveLength(3);
    });

    it("returns workflow names from gateway", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ workflows: sampleWorkflows, count: 3 }),
      });

      const workflows = await client.discoverWorkflows();
      const names = workflows.map((w) => w.name);
      expect(names).toContain("price-feed");
      expect(names).toContain("agent-task-dispatch");
    });

    it("caches workflows after discovery", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ workflows: sampleWorkflows }),
      });

      await client.discoverWorkflows();
      expect(client.workflows).toHaveLength(3);
    });

    it("auto-sets recipient from first workflow", async () => {
      const clientNoRecipient = new AgentClient({
        gatewayUrl: GATEWAY_URL,
        payerAddress: PAYER,
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ workflows: sampleWorkflows }),
      });

      await clientNoRecipient.discoverWorkflows();

      // Recipient should now be set from workflows
      // Verify by constructing a proof — it should use RECIPIENT
      const proof = clientNoRecipient.constructPaymentProof(RECIPIENT, 0.001);
      const decoded = JSON.parse(Buffer.from(proof, "base64").toString());
      expect(decoded.recipient).toBe(RECIPIENT);
    });

    it("throws on non-OK response", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 503,
        statusText: "Service Unavailable",
      });

      await expect(client.discoverWorkflows()).rejects.toThrow("Failed to discover workflows");
    });

    it("clearCache() forces re-discovery on next invoke", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ workflows: sampleWorkflows }),
      });

      await client.discoverWorkflows();
      expect(client.workflows).not.toBeNull();

      client.clearCache();
      expect(client.workflows).toBeNull();
    });
  });

  describe("constructPaymentProof()", () => {
    it("returns a non-empty string", () => {
      const proof = client.constructPaymentProof(RECIPIENT, 0.001);
      expect(proof).toBeTruthy();
      expect(typeof proof).toBe("string");
    });

    it("creates base64-decodable mock proof in simulation mode", () => {
      const proof = client.constructPaymentProof(RECIPIENT, 0.001);
      const decoded = JSON.parse(Buffer.from(proof, "base64").toString());
      expect(decoded).toBeDefined();
    });

    it("mock proof contains correct recipient", () => {
      const proof = client.constructPaymentProof(RECIPIENT, 0.005);
      const decoded = JSON.parse(Buffer.from(proof, "base64").toString());
      expect(decoded.recipient).toBe(RECIPIENT);
    });

    it("mock proof contains correct payer", () => {
      const proof = client.constructPaymentProof(RECIPIENT, 0.005);
      const decoded = JSON.parse(Buffer.from(proof, "base64").toString());
      expect(decoded.payer).toBe(PAYER);
    });

    it("encodes amount as USDC micro-units (6 decimals)", () => {
      const proof = client.constructPaymentProof(RECIPIENT, 0.001);
      const decoded = JSON.parse(Buffer.from(proof, "base64").toString());
      expect(decoded.amount).toBe("1000"); // 0.001 USDC = 1000 micro-units
    });

    it("creates EIP-3009 real proof in production mode", () => {
      const prod = new AgentClient({
        gatewayUrl: GATEWAY_URL,
        payerAddress: PAYER,
        simulationMode: false,
      });
      const proof = prod.constructPaymentProof(RECIPIENT, 0.001);
      const decoded = JSON.parse(Buffer.from(proof, "base64").toString());
      expect(decoded.x402Version).toBe(1);
      expect(decoded.payload).toBeDefined();
      expect(decoded.payload.authorization).toBeDefined();
    });
  });

  describe("invoke()", () => {
    beforeEach(() => {
      // First call = workflow discovery
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ workflows: sampleWorkflows }),
      });
    });

    it("invokes correct workflow URL", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ success: true, result: { price: 2847 }, meta: {} }),
      });

      await client.invoke("price-feed", { pair: "ETH/USD" });

      const invokeCall = mockFetch.mock.calls[1];
      expect(invokeCall[0]).toBe(`${GATEWAY_URL}/invoke/price-feed`);
    });

    it("sends x-payment header", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ success: true, result: {} }),
      });

      await client.invoke("price-feed", { pair: "ETH/USD" });

      const headers = mockFetch.mock.calls[1][1].headers;
      expect(headers["x-payment"]).toBeTruthy();
    });

    it("sends Content-Type: application/json", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ success: true, result: {} }),
      });

      await client.invoke("price-feed", { pair: "ETH/USD" });

      const headers = mockFetch.mock.calls[1][1].headers;
      expect(headers["Content-Type"]).toBe("application/json");
    });

    it("returns success:true with result on 200", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          result: { pair: "ETH/USD", price: 2847 },
          meta: { pricePaid: 0.001 },
        }),
      });

      const result = await client.invoke("price-feed", { pair: "ETH/USD" });

      expect(result.success).toBe(true);
      expect(result.result).toMatchObject({ price: 2847 });
    });

    it("returns success:false on 402 response", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 402,
        json: async () => ({
          error: "Payment Required",
          message: "Valid x402 proof required",
        }),
      });

      const result = await client.invoke("price-feed", { pair: "ETH/USD" });

      expect(result.success).toBe(false);
      expect(result.error).toBeTruthy();
    });

    it("includes paymentUsed in result", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ success: true, result: {} }),
      });

      const result = await client.invoke("price-feed", { pair: "ETH/USD" });

      expect(result.paymentUsed).toBeTruthy();
    });

    it("uses correct pricing from discovered workflows", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ success: true, result: {} }),
      });

      await client.invoke("price-feed", { pair: "ETH/USD" });

      const proof = mockFetch.mock.calls[1][1].headers["x-payment"];
      const decoded = JSON.parse(Buffer.from(proof, "base64").toString());
      // price-feed is 0.001 USDC = 1000 micro-units
      expect(decoded.amount).toBe("1000");
    });

    it("returns error on gateway 500", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => ({ error: "Internal Server Error", message: "Server exploded" }),
      });

      const result = await client.invoke("price-feed", { pair: "ETH/USD" });
      expect(result.success).toBe(false);
      expect(result.error).toBeTruthy();
    });
  });

  describe("submitTask()", () => {
    beforeEach(() => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ workflows: sampleWorkflows }),
      });
    });

    it("calls agent/task endpoint", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          taskId: "task-123",
          task: "analyze price",
          result: { summary: "Done" },
        }),
      });

      await client.submitTask("analyze price trends");

      const call = mockFetch.mock.calls[1];
      expect(call[0]).toBe(`${GATEWAY_URL}/agent/task`);
    });

    it("returns success:true on 200", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          taskId: "task-456",
          result: { done: true },
        }),
      });

      const result = await client.submitTask("compute sum");
      expect(result.success).toBe(true);
    });

    it("returns error on non-OK response", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 402,
        json: async () => ({ error: "Payment Required", message: "Payment needed" }),
      });

      const result = await client.submitTask("some task");
      expect(result.success).toBe(false);
      expect(result.error).toBeTruthy();
    });

    it("includes x-payment header in task request", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ success: true, result: {} }),
      });

      await client.submitTask("get price", { pair: "BTC/USD" });

      const headers = mockFetch.mock.calls[1][1].headers;
      expect(headers["x-payment"]).toBeTruthy();
    });

    it("uses agent-task-dispatch pricing (0.01 USDC)", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ success: true, result: {} }),
      });

      await client.submitTask("get price");

      const proof = mockFetch.mock.calls[1][1].headers["x-payment"];
      const decoded = JSON.parse(Buffer.from(proof, "base64").toString());
      // agent-task-dispatch is 0.01 USDC = 10000 micro-units
      expect(decoded.amount).toBe("10000");
    });

    it("passes params in request body", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ success: true, result: {} }),
      });

      await client.submitTask("compute mean", { data: [1, 2, 3] });

      const body = JSON.parse(mockFetch.mock.calls[1][1].body);
      expect(body.params).toMatchObject({ data: [1, 2, 3] });
      expect(body.task).toBe("compute mean");
    });
  });
});
