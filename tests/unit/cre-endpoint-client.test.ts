/**
 * CREEndpointClient unit tests
 *
 * Tests for:
 *   - Simulation mode discovery (no network calls)
 *   - findWorkflow() — by name
 *   - findByCapability() — capability filtering
 *   - isWorkflowActive() — active check
 *   - Owner filter — restrict workflows by owner address
 *   - Live mode error paths — network failure, timeout, malformed response
 *   - Getters — registryUrl, donId, simulationMode
 */

import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import {
  CREEndpointClient,
  MOCK_CRE_WORKFLOWS,
  type CRERegistryResponse,
} from "../../src/cre-endpoint-client.js";

const OWNER_ADDRESS = "0x7483a9F237cf8043704D6b17DA31c12BfFF860DD";
const UNKNOWN_ADDRESS = "0x0000000000000000000000000000000000000001";

// ─── Simulation mode ──────────────────────────────────────────────────────────

describe("CREEndpointClient — simulation mode", () => {
  let client: CREEndpointClient;

  beforeEach(() => {
    client = new CREEndpointClient({ simulationMode: true });
  });

  it("defaults to simulation mode when not specified", () => {
    const c = new CREEndpointClient();
    expect(c.simulationMode).toBe(true);
  });

  it("discoverWorkflows() returns 4 mock workflows", async () => {
    const result = await client.discoverWorkflows();
    expect(result.workflows.length).toBe(4);
  });

  it("discoverWorkflows() returns mode: simulation", async () => {
    const result = await client.discoverWorkflows();
    expect(result.mode).toBe("simulation");
  });

  it("discoverWorkflows() includes donId in response", async () => {
    const result = await client.discoverWorkflows();
    expect(result.donId).toBe("don-testnet-001");
  });

  it("discoverWorkflows() includes registryVersion", async () => {
    const result = await client.discoverWorkflows();
    expect(result.registryVersion).toBeDefined();
    expect(typeof result.registryVersion).toBe("string");
  });

  it("discoverWorkflows() includes ISO timestamp", async () => {
    const result = await client.discoverWorkflows();
    expect(() => new Date(result.timestamp)).not.toThrow();
    expect(new Date(result.timestamp).getTime()).not.toBeNaN();
  });

  it("price-feed workflow has correct priceUSDC", async () => {
    const result = await client.discoverWorkflows();
    const pf = result.workflows.find((w) => w.name === "price-feed");
    expect(pf?.payment.priceUSDC).toBe(0.001);
  });

  it("agent-task-dispatch workflow has correct priceUSDC", async () => {
    const result = await client.discoverWorkflows();
    const atd = result.workflows.find((w) => w.name === "agent-task-dispatch");
    expect(atd?.payment.priceUSDC).toBe(0.01);
  });

  it("weather-oracle workflow has correct priceUSDC", async () => {
    const result = await client.discoverWorkflows();
    const wo = result.workflows.find((w) => w.name === "weather-oracle");
    expect(wo?.payment.priceUSDC).toBe(0.005);
  });

  it("compute-task workflow has correct priceUSDC", async () => {
    const result = await client.discoverWorkflows();
    const ct = result.workflows.find((w) => w.name === "compute-task");
    expect(ct?.payment.priceUSDC).toBe(0.002);
  });

  it("all workflows are active", async () => {
    const result = await client.discoverWorkflows();
    for (const wf of result.workflows) {
      expect(wf.active).toBe(true);
    }
  });

  it("all workflows have currency USDC", async () => {
    const result = await client.discoverWorkflows();
    for (const wf of result.workflows) {
      expect(wf.payment.currency).toBe("USDC");
    }
  });

  it("all workflows have base-sepolia network", async () => {
    const result = await client.discoverWorkflows();
    for (const wf of result.workflows) {
      expect(wf.payment.network).toBe("base-sepolia");
    }
  });
});

// ─── findWorkflow ─────────────────────────────────────────────────────────────

describe("CREEndpointClient.findWorkflow()", () => {
  let client: CREEndpointClient;

  beforeEach(() => {
    client = new CREEndpointClient({ simulationMode: true });
  });

  it("returns price-feed workflow by name", async () => {
    const wf = await client.findWorkflow("price-feed");
    expect(wf).not.toBeNull();
    expect(wf?.name).toBe("price-feed");
  });

  it("returns agent-task-dispatch by name", async () => {
    const wf = await client.findWorkflow("agent-task-dispatch");
    expect(wf).not.toBeNull();
    expect(wf?.name).toBe("agent-task-dispatch");
  });

  it("returns null for nonexistent workflow", async () => {
    const wf = await client.findWorkflow("nonexistent-workflow");
    expect(wf).toBeNull();
  });

  it("returns null for empty string", async () => {
    const wf = await client.findWorkflow("");
    expect(wf).toBeNull();
  });

  it("found workflow has workflowId", async () => {
    const wf = await client.findWorkflow("price-feed");
    expect(wf?.workflowId).toBeDefined();
    expect(typeof wf?.workflowId).toBe("string");
  });

  it("found workflow has triggerUrl", async () => {
    const wf = await client.findWorkflow("price-feed");
    expect(wf?.triggerUrl).toContain("price-feed");
  });
});

// ─── findByCapability ─────────────────────────────────────────────────────────

describe("CREEndpointClient.findByCapability()", () => {
  let client: CREEndpointClient;

  beforeEach(() => {
    client = new CREEndpointClient({ simulationMode: true });
  });

  it("finds workflows with data-streams capability", async () => {
    const results = await client.findByCapability("data-streams");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].name).toBe("price-feed");
  });

  it("finds workflows with compute capability", async () => {
    const results = await client.findByCapability("compute");
    expect(results.length).toBe(1);
    expect(results[0].name).toBe("compute-task");
  });

  it("finds all 4 workflows with x402-payment capability", async () => {
    const results = await client.findByCapability("x402-payment");
    expect(results.length).toBe(4);
  });

  it("finds workflows with http-outbound capability", async () => {
    const results = await client.findByCapability("http-outbound");
    expect(results.length).toBeGreaterThan(0);
  });

  it("returns empty array for nonexistent capability", async () => {
    const results = await client.findByCapability("nonexistent-capability");
    expect(results).toEqual([]);
  });

  it("capability search is case-sensitive", async () => {
    const results = await client.findByCapability("DATA-STREAMS");
    expect(results).toEqual([]);
  });

  it("returned workflows all have the requested capability active", async () => {
    const results = await client.findByCapability("http-trigger");
    for (const wf of results) {
      const cap = wf.capabilities.find((c) => c.type === "http-trigger");
      expect(cap?.active).toBe(true);
    }
  });
});

// ─── isWorkflowActive ─────────────────────────────────────────────────────────

describe("CREEndpointClient.isWorkflowActive()", () => {
  let client: CREEndpointClient;

  beforeEach(() => {
    client = new CREEndpointClient({ simulationMode: true });
  });

  it("returns true for price-feed", async () => {
    expect(await client.isWorkflowActive("price-feed")).toBe(true);
  });

  it("returns true for compute-task", async () => {
    expect(await client.isWorkflowActive("compute-task")).toBe(true);
  });

  it("returns false for nonexistent workflow", async () => {
    expect(await client.isWorkflowActive("does-not-exist")).toBe(false);
  });
});

// ─── Owner filter ─────────────────────────────────────────────────────────────

describe("CREEndpointClient — owner filter", () => {
  it("with correct owner returns all 4 workflows", async () => {
    const client = new CREEndpointClient({
      simulationMode: true,
      ownerFilter: OWNER_ADDRESS,
    });
    const result = await client.discoverWorkflows();
    expect(result.workflows.length).toBe(4);
  });

  it("with wrong owner returns empty list", async () => {
    const client = new CREEndpointClient({
      simulationMode: true,
      ownerFilter: UNKNOWN_ADDRESS,
    });
    const result = await client.discoverWorkflows();
    expect(result.workflows.length).toBe(0);
  });

  it("owner filter is case-insensitive", async () => {
    const client = new CREEndpointClient({
      simulationMode: true,
      ownerFilter: OWNER_ADDRESS.toLowerCase(),
    });
    const result = await client.discoverWorkflows();
    expect(result.workflows.length).toBe(4);
  });

  it("without owner filter returns all workflows", async () => {
    const client = new CREEndpointClient({ simulationMode: true });
    const result = await client.discoverWorkflows();
    expect(result.workflows.length).toBe(4);
  });
});

// ─── Getters ──────────────────────────────────────────────────────────────────

describe("CREEndpointClient — getters", () => {
  it("registryUrl defaults to CRE live endpoint", () => {
    const client = new CREEndpointClient();
    expect(client.registryUrl).toBe("https://registry.cre.chain.link");
  });

  it("registryUrl uses custom value when provided", () => {
    const client = new CREEndpointClient({ registryUrl: "http://localhost:9999" });
    expect(client.registryUrl).toBe("http://localhost:9999");
  });

  it("donId defaults to don-testnet-001", () => {
    const client = new CREEndpointClient();
    expect(client.donId).toBe("don-testnet-001");
  });

  it("donId uses custom value when provided", () => {
    const client = new CREEndpointClient({ donId: "don-custom-42" });
    expect(client.donId).toBe("don-custom-42");
  });

  it("custom donId appears in discoverWorkflows response", async () => {
    const client = new CREEndpointClient({ simulationMode: true, donId: "don-custom-42" });
    const result = await client.discoverWorkflows();
    expect(result.donId).toBe("don-custom-42");
  });

  it("simulationMode getter returns configured value", () => {
    const sim = new CREEndpointClient({ simulationMode: true });
    expect(sim.simulationMode).toBe(true);

    const live = new CREEndpointClient({ simulationMode: false });
    expect(live.simulationMode).toBe(false);
  });
});

// ─── Live mode error paths ────────────────────────────────────────────────────

describe("CREEndpointClient — live mode error paths", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("throws on network failure", async () => {
    globalThis.fetch = jest.fn(() =>
      Promise.reject(new Error("ECONNREFUSED"))
    ) as typeof fetch;

    const client = new CREEndpointClient({
      simulationMode: false,
      registryUrl: "http://localhost:19999",
    });

    await expect(client.discoverWorkflows()).rejects.toThrow("ECONNREFUSED");
  });

  it("throws on non-200 HTTP response", async () => {
    globalThis.fetch = jest.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: "Not Found" }), {
          status: 404,
          statusText: "Not Found",
          headers: { "Content-Type": "application/json" },
        })
      )
    ) as typeof fetch;

    const client = new CREEndpointClient({ simulationMode: false });
    await expect(client.discoverWorkflows()).rejects.toThrow("404");
  });

  it("throws on AbortError when request times out", async () => {
    const abortError = new DOMException("The operation was aborted.", "AbortError");
    globalThis.fetch = jest.fn(() => Promise.reject(abortError)) as typeof fetch;

    const client = new CREEndpointClient({ simulationMode: false, timeoutMs: 1 });
    await expect(client.discoverWorkflows()).rejects.toThrow(/timed out|aborted/i);
  });

  it("returns empty workflows when server returns empty catalog", async () => {
    const emptyResponse: CRERegistryResponse = {
      workflows: [],
      donId: "don-testnet-001",
      registryVersion: "1.0.0",
      timestamp: new Date().toISOString(),
      mode: "live",
    };

    globalThis.fetch = jest.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify(emptyResponse), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      )
    ) as typeof fetch;

    const client = new CREEndpointClient({ simulationMode: false });
    const result = await client.discoverWorkflows();
    expect(result.workflows).toEqual([]);
  });
});

// ─── MOCK_CRE_WORKFLOWS export ────────────────────────────────────────────────

describe("MOCK_CRE_WORKFLOWS", () => {
  it("exports 4 workflows", () => {
    expect(MOCK_CRE_WORKFLOWS.length).toBe(4);
  });

  it("all exported workflows have workflowId", () => {
    for (const wf of MOCK_CRE_WORKFLOWS) {
      expect(wf.workflowId).toBeDefined();
      expect(wf.workflowId.startsWith("wf-")).toBe(true);
    }
  });

  it("all exported workflows have at least one capability", () => {
    for (const wf of MOCK_CRE_WORKFLOWS) {
      expect(wf.capabilities.length).toBeGreaterThan(0);
    }
  });
});
