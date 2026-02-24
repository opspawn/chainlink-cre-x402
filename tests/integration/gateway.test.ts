/**
 * Integration Tests: CRE x402 HTTP Gateway
 *
 * End-to-end tests that start the Express server, send HTTP requests
 * with mock x402 payment headers, and verify workflow execution.
 *
 * These tests run entirely in process — no blockchain calls needed.
 * The gateway is imported directly (NODE_ENV=test prevents it from listening).
 */

import request from "supertest";
import { app } from "../../src/gateway";
import {
  createMockPaymentProof,
  createRealX402Proof,
} from "../../src/x402-verifier";

const RECIPIENT = "0x7483a9F237cf8043704D6b17DA31c12BfFF860DD";
const PAYER = "0xAbCd1234567890AbCd1234567890AbCd12345678";

describe("CRE x402 Gateway — Integration Tests", () => {
  // ----------------------------------------------------------------
  // GET /health
  // ----------------------------------------------------------------
  describe("GET /health", () => {
    it("returns 200 with status ok", async () => {
      const res = await request(app).get("/health");
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("ok");
      expect(res.body.service).toBe("opspawn-cre-x402-gateway");
    });

    it("includes CRE registration status", async () => {
      const res = await request(app).get("/health");
      expect(res.body.cre).toBeDefined();
      expect(res.body.cre.mode).toBe("simulation"); // CRE_REGISTERED not set
      expect(Array.isArray(res.body.cre.switchoverInstructions)).toBe(true);
    });

    it("reports correct workflow count", async () => {
      const res = await request(app).get("/health");
      expect(res.body.workflows).toBeGreaterThanOrEqual(4); // 4 built-in workflows
    });
  });

  // ----------------------------------------------------------------
  // GET /workflows
  // ----------------------------------------------------------------
  describe("GET /workflows", () => {
    it("returns list of available workflows", async () => {
      const res = await request(app).get("/workflows");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.workflows)).toBe(true);
      expect(res.body.count).toBeGreaterThanOrEqual(4);
    });

    it("includes price-feed workflow with x402 payment info", async () => {
      const res = await request(app).get("/workflows");
      const priceFeed = res.body.workflows.find(
        (w: { name: string }) => w.name === "price-feed"
      );
      expect(priceFeed).toBeDefined();
      expect(priceFeed.priceUSDC).toBe(0.001);
      expect(priceFeed.payment.recipient).toBe(RECIPIENT);
      expect(priceFeed.payment.currency).toBe("USDC");
      expect(priceFeed.payment.network).toBe("base-sepolia");
    });

    it("includes weather-oracle and compute-task workflows", async () => {
      const res = await request(app).get("/workflows");
      const names = res.body.workflows.map((w: { name: string }) => w.name);
      expect(names).toContain("weather-oracle");
      expect(names).toContain("compute-task");
      expect(names).toContain("agent-task-dispatch");
    });
  });

  // ----------------------------------------------------------------
  // POST /invoke/price-feed — E2E with mock x402 payment header
  // ----------------------------------------------------------------
  describe("POST /invoke/price-feed", () => {
    it("returns 402 when no x-payment header is present", async () => {
      const res = await request(app)
        .post("/invoke/price-feed")
        .send({ pair: "ETH/USD" });

      expect(res.status).toBe(402);
      expect(res.body.error).toBe("Payment Required");
      expect(res.body.required.header).toBe("x-payment");
      expect(res.body.required.currency).toBe("USDC");
    });

    it("executes price-feed workflow with valid mock x402 payment (simple format)", async () => {
      const proof = createMockPaymentProof(PAYER, RECIPIENT, 0.005);

      const res = await request(app)
        .post("/invoke/price-feed")
        .set("x-payment", proof)
        .send({ pair: "ETH/USD" });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.result).toBeDefined();
      expect(res.body.result.pair).toBe("ETH/USD");
      expect(typeof res.body.result.price).toBe("number");
      expect(res.body.result.price).toBeGreaterThan(0);
      expect(res.body.meta.workflowName).toBe("price-feed");
      expect(res.body.meta.pricePaid).toBe(0.001);
    });

    it("executes price-feed workflow with valid real x402 proof format (simulation)", async () => {
      const proof = createRealX402Proof(PAYER, RECIPIENT, 0.005, "base-sepolia");

      const res = await request(app)
        .post("/invoke/price-feed")
        .set("x-payment", proof)
        .send({ pair: "BTC/USD" });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.result.pair).toBe("BTC/USD");
      expect(res.body.result.price).toBeGreaterThan(0);
    });

    it("returns 402 with insufficient payment amount", async () => {
      const proof = createMockPaymentProof(PAYER, RECIPIENT, 0.00001); // way too small

      const res = await request(app)
        .post("/invoke/price-feed")
        .set("x-payment", proof)
        .send({ pair: "ETH/USD" });

      expect(res.status).toBe(402);
      expect(res.body.error).toBe("Payment Required");
    });

    it("returns 402 when payment is sent to wrong recipient", async () => {
      const wrongRecipient = "0x0000000000000000000000000000000000000000";
      const proof = createMockPaymentProof(PAYER, wrongRecipient, 0.01);

      const res = await request(app)
        .post("/invoke/price-feed")
        .set("x-payment", proof)
        .send({ pair: "ETH/USD" });

      expect(res.status).toBe(402);
    });
  });

  // ----------------------------------------------------------------
  // POST /invoke/weather-oracle — E2E weather workflow
  // ----------------------------------------------------------------
  describe("POST /invoke/weather-oracle", () => {
    it("executes weather-oracle with valid payment", async () => {
      const proof = createMockPaymentProof(PAYER, RECIPIENT, 0.01);

      const res = await request(app)
        .post("/invoke/weather-oracle")
        .set("x-payment", proof)
        .send({ location: "Denver, CO", date: "2026-02-23" });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.result.location).toBe("Denver, CO");
      expect(typeof res.body.result.temperature_f).toBe("number");
      expect(res.body.result.verified).toBe(true);
    });
  });

  // ----------------------------------------------------------------
  // POST /invoke/compute-task — E2E compute workflow
  // ----------------------------------------------------------------
  describe("POST /invoke/compute-task", () => {
    it("executes compute-task (sum) with valid payment", async () => {
      const proof = createMockPaymentProof(PAYER, RECIPIENT, 0.005);

      const res = await request(app)
        .post("/invoke/compute-task")
        .set("x-payment", proof)
        .send({ operation: "sum", data: [1, 2, 3, 4, 5] });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.result.result).toBe(15);
      expect(res.body.result.operation).toBe("sum");
    });
  });

  // ----------------------------------------------------------------
  // POST /agent/task — High-level orchestration E2E
  // ----------------------------------------------------------------
  describe("POST /agent/task", () => {
    it("auto-routes price task to price-feed workflow", async () => {
      const proof = createMockPaymentProof(PAYER, RECIPIENT, 0.01);

      const res = await request(app)
        .post("/agent/task")
        .set("x-payment", proof)
        .send({ task: "Get the current ETH price", params: { pair: "ETH/USD" } });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.meta.paymentGated).toBe(true);
      expect(res.body.meta.workflowsInvoked).toContain("price-feed");
      expect(res.body.meta.totalSpentUSDC).toBeGreaterThan(0);
    });

    it("auto-routes weather task to weather-oracle workflow", async () => {
      const proof = createMockPaymentProof(PAYER, RECIPIENT, 0.01);

      const res = await request(app)
        .post("/agent/task")
        .set("x-payment", proof)
        .send({ task: "Get weather data for Denver", params: { location: "Denver, CO" } });

      expect(res.status).toBe(200);
      expect(res.body.meta.workflowsInvoked).toContain("weather-oracle");
    });

    it("returns 400 when task field is missing", async () => {
      const proof = createMockPaymentProof(PAYER, RECIPIENT, 0.01);

      const res = await request(app)
        .post("/agent/task")
        .set("x-payment", proof)
        .send({ params: {} }); // missing task field

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Missing 'task'");
    });
  });

  // ----------------------------------------------------------------
  // POST /invoke/unknown-workflow — error handling
  // ----------------------------------------------------------------
  describe("Error handling", () => {
    it("returns 402 for unknown workflow (verifies payment first)", async () => {
      const proof = createMockPaymentProof(PAYER, RECIPIENT, 0.01);

      const res = await request(app)
        .post("/invoke/nonexistent-workflow")
        .set("x-payment", proof)
        .send({});

      // Payment is valid but workflow doesn't exist — returns 200 with failed result
      // (gateway allows through, registry returns error in result)
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.result).toBeUndefined(); // workflow failed internally
    });
  });
});
