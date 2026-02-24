/**
 * Tests: x402 Payment Gate Middleware
 *
 * Verifies that requireX402Payment() correctly:
 *   - Returns HTTP 402 when no/invalid payment provided
 *   - Returns 402 with x402-compliant payment instructions
 *   - Calls next() and sets res.locals on valid payment
 *   - Supports both mock and real x402 proof formats
 */

import { Request, Response, NextFunction } from "express";
import { requireX402Payment, X402MiddlewareConfig, X402PaymentContext } from "../../src/payment-middleware";
import { createMockPaymentProof, createRealX402Proof } from "../../src/x402-verifier";

const RECIPIENT = "0x7483a9F237cf8043704D6b17DA31c12BfFF860DD";
const PAYER = "0xAbCd1234567890AbCd1234567890AbCd12345678";

// ---- Test helpers ----

function makeReq(paymentHeader?: string): Partial<Request> {
  return {
    headers: paymentHeader ? { "x-payment": paymentHeader } : {},
    originalUrl: "/invoke/price-feed",
  };
}

type MockRes = {
  statusCode: number;
  body: unknown;
  locals: Record<string, unknown>;
  status: (code: number) => MockRes;
  json: (body: unknown) => MockRes;
};

function makeRes(): MockRes {
  const res: MockRes = {
    statusCode: 200,
    body: null,
    locals: {},
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  };
  return res;
}

function makeNext(): NextFunction & { called: boolean } {
  const fn = (() => {
    fn.called = true;
  }) as NextFunction & { called: boolean };
  fn.called = false;
  return fn;
}

const defaultConfig: X402MiddlewareConfig = {
  recipientAddress: RECIPIENT,
  requiredAmountUSDC: 0.001,
  simulationMode: true,
};

// ---- Tests ----

describe("requireX402Payment middleware", () => {
  describe("no payment header", () => {
    it("returns HTTP 402", async () => {
      const middleware = requireX402Payment(defaultConfig);
      const res = makeRes();
      await middleware(makeReq() as Request, res as unknown as Response, makeNext());
      expect(res.statusCode).toBe(402);
    });

    it("does not call next()", async () => {
      const middleware = requireX402Payment(defaultConfig);
      const next = makeNext();
      await middleware(makeReq() as Request, makeRes() as unknown as Response, next);
      expect(next.called).toBe(false);
    });

    it("includes 'Payment Required' error in response", async () => {
      const middleware = requireX402Payment(defaultConfig);
      const res = makeRes();
      await middleware(makeReq() as Request, res as unknown as Response, makeNext());
      expect((res.body as Record<string, unknown>).error).toBe("Payment Required");
    });

    it("includes x402Version: 1 in response", async () => {
      const middleware = requireX402Payment(defaultConfig);
      const res = makeRes();
      await middleware(makeReq() as Request, res as unknown as Response, makeNext());
      expect((res.body as Record<string, unknown>).x402Version).toBe(1);
    });

    it("includes 'accepts' array with payment instructions", async () => {
      const middleware = requireX402Payment(defaultConfig);
      const res = makeRes();
      await middleware(makeReq() as Request, res as unknown as Response, makeNext());
      const accepts = (res.body as Record<string, unknown>).accepts as unknown[];
      expect(Array.isArray(accepts)).toBe(true);
      expect(accepts.length).toBeGreaterThan(0);
    });

    it("includes correct payTo address in accepts", async () => {
      const middleware = requireX402Payment(defaultConfig);
      const res = makeRes();
      await middleware(makeReq() as Request, res as unknown as Response, makeNext());
      const accepts = (res.body as Record<string, unknown>).accepts as Record<string, unknown>[];
      expect(accepts[0].payTo).toBe(RECIPIENT);
    });

    it("includes network in accepts", async () => {
      const middleware = requireX402Payment(defaultConfig);
      const res = makeRes();
      await middleware(makeReq() as Request, res as unknown as Response, makeNext());
      const accepts = (res.body as Record<string, unknown>).accepts as Record<string, unknown>[];
      expect(accepts[0].network).toBe("base-sepolia");
    });

    it("includes maxAmountRequired in micro-USDC units", async () => {
      const middleware = requireX402Payment({ ...defaultConfig, requiredAmountUSDC: 0.001 });
      const res = makeRes();
      await middleware(makeReq() as Request, res as unknown as Response, makeNext());
      const accepts = (res.body as Record<string, unknown>).accepts as Record<string, unknown>[];
      expect(accepts[0].maxAmountRequired).toBe("1000"); // 0.001 USDC = 1000 micro-units
    });

    it("includes scheme: exact in accepts", async () => {
      const middleware = requireX402Payment(defaultConfig);
      const res = makeRes();
      await middleware(makeReq() as Request, res as unknown as Response, makeNext());
      const accepts = (res.body as Record<string, unknown>).accepts as Record<string, unknown>[];
      expect(accepts[0].scheme).toBe("exact");
    });
  });

  describe("valid mock payment proof", () => {
    it("calls next() on valid payment", async () => {
      const middleware = requireX402Payment(defaultConfig);
      const next = makeNext();
      const proof = createMockPaymentProof(PAYER, RECIPIENT, 0.005);
      await middleware(makeReq(proof) as Request, makeRes() as unknown as Response, next);
      expect(next.called).toBe(true);
    });

    it("does NOT return 402 on valid payment", async () => {
      const middleware = requireX402Payment(defaultConfig);
      const res = makeRes();
      const proof = createMockPaymentProof(PAYER, RECIPIENT, 0.005);
      await middleware(makeReq(proof) as Request, res as unknown as Response, makeNext());
      expect(res.statusCode).toBe(200);
    });

    it("attaches x402Payment to res.locals", async () => {
      const middleware = requireX402Payment(defaultConfig);
      const res = makeRes();
      const proof = createMockPaymentProof(PAYER, RECIPIENT, 0.005);
      await middleware(makeReq(proof) as Request, res as unknown as Response, makeNext());
      expect(res.locals.x402Payment).toBeDefined();
    });

    it("x402Payment context has valid=true", async () => {
      const middleware = requireX402Payment(defaultConfig);
      const res = makeRes();
      const proof = createMockPaymentProof(PAYER, RECIPIENT, 0.005);
      await middleware(makeReq(proof) as Request, res as unknown as Response, makeNext());
      const ctx = res.locals.x402Payment as X402PaymentContext;
      expect(ctx.valid).toBe(true);
    });

    it("x402Payment context has correct payer", async () => {
      const middleware = requireX402Payment(defaultConfig);
      const res = makeRes();
      const proof = createMockPaymentProof(PAYER, RECIPIENT, 0.005);
      await middleware(makeReq(proof) as Request, res as unknown as Response, makeNext());
      const ctx = res.locals.x402Payment as X402PaymentContext;
      expect(ctx.payer).toBe(PAYER);
    });

    it("x402Payment context has correct recipient", async () => {
      const middleware = requireX402Payment(defaultConfig);
      const res = makeRes();
      const proof = createMockPaymentProof(PAYER, RECIPIENT, 0.005);
      await middleware(makeReq(proof) as Request, res as unknown as Response, makeNext());
      const ctx = res.locals.x402Payment as X402PaymentContext;
      expect(ctx.recipient).toBe(RECIPIENT);
    });

    it("x402Payment context has correct amount in bigint", async () => {
      const middleware = requireX402Payment(defaultConfig);
      const res = makeRes();
      const proof = createMockPaymentProof(PAYER, RECIPIENT, 0.005);
      await middleware(makeReq(proof) as Request, res as unknown as Response, makeNext());
      const ctx = res.locals.x402Payment as X402PaymentContext;
      expect(ctx.amount).toBe(5000n); // 0.005 USDC = 5000 micro-units
    });
  });

  describe("insufficient payment", () => {
    it("returns 402 for underpayment", async () => {
      const middleware = requireX402Payment({ ...defaultConfig, requiredAmountUSDC: 0.1 });
      const proof = createMockPaymentProof(PAYER, RECIPIENT, 0.001);
      const res = makeRes();
      await middleware(makeReq(proof) as Request, res as unknown as Response, makeNext());
      expect(res.statusCode).toBe(402);
    });

    it("does not call next() on underpayment", async () => {
      const middleware = requireX402Payment({ ...defaultConfig, requiredAmountUSDC: 0.1 });
      const proof = createMockPaymentProof(PAYER, RECIPIENT, 0.001);
      const next = makeNext();
      await middleware(makeReq(proof) as Request, makeRes() as unknown as Response, next);
      expect(next.called).toBe(false);
    });

    it("includes correct maxAmountRequired for higher price", async () => {
      const middleware = requireX402Payment({ ...defaultConfig, requiredAmountUSDC: 0.01 });
      const proof = createMockPaymentProof(PAYER, RECIPIENT, 0.001);
      const res = makeRes();
      await middleware(makeReq(proof) as Request, res as unknown as Response, makeNext());
      const accepts = (res.body as Record<string, unknown>).accepts as Record<string, unknown>[];
      expect(accepts[0].maxAmountRequired).toBe("10000"); // 0.01 USDC
    });
  });

  describe("wrong recipient", () => {
    it("returns 402 when payment sent to wrong address", async () => {
      const wrong = "0x1111111111111111111111111111111111111111";
      const middleware = requireX402Payment(defaultConfig);
      const proof = createMockPaymentProof(PAYER, wrong, 0.005);
      const res = makeRes();
      await middleware(makeReq(proof) as Request, res as unknown as Response, makeNext());
      expect(res.statusCode).toBe(402);
    });
  });

  describe("real x402 proof format", () => {
    it("accepts valid real x402 proof in simulation mode", async () => {
      const middleware = requireX402Payment(defaultConfig);
      const proof = createRealX402Proof(PAYER, RECIPIENT, 0.005);
      const next = makeNext();
      await middleware(makeReq(proof) as Request, makeRes() as unknown as Response, next);
      expect(next.called).toBe(true);
    });

    it("rejects real x402 proof with wrong recipient", async () => {
      const wrong = "0x2222222222222222222222222222222222222222";
      const middleware = requireX402Payment(defaultConfig);
      const proof = createRealX402Proof(PAYER, wrong, 0.005);
      const res = makeRes();
      await middleware(makeReq(proof) as Request, res as unknown as Response, makeNext());
      expect(res.statusCode).toBe(402);
    });
  });

  describe("custom configuration", () => {
    it("uses custom description in 402 response", async () => {
      const middleware = requireX402Payment({
        ...defaultConfig,
        description: "Price Feed Query",
      });
      const res = makeRes();
      await middleware(makeReq() as Request, res as unknown as Response, makeNext());
      const accepts = (res.body as Record<string, unknown>).accepts as Record<string, unknown>[];
      expect(accepts[0].description).toBe("Price Feed Query");
    });

    it("uses 'base' network when configured", async () => {
      const middleware = requireX402Payment({ ...defaultConfig, network: "base" });
      const res = makeRes();
      await middleware(makeReq() as Request, res as unknown as Response, makeNext());
      const accepts = (res.body as Record<string, unknown>).accepts as Record<string, unknown>[];
      expect(accepts[0].network).toBe("base");
    });

    it("includes USDC asset address in accepts", async () => {
      const middleware = requireX402Payment(defaultConfig);
      const res = makeRes();
      await middleware(makeReq() as Request, res as unknown as Response, makeNext());
      const accepts = (res.body as Record<string, unknown>).accepts as Record<string, unknown>[];
      expect(accepts[0].asset).toBeTruthy();
      expect(String(accepts[0].asset)).toMatch(/^0x/);
    });

    it("includes resource URL (originalUrl) in accepts", async () => {
      const middleware = requireX402Payment(defaultConfig);
      const res = makeRes();
      await middleware(makeReq() as Request, res as unknown as Response, makeNext());
      const accepts = (res.body as Record<string, unknown>).accepts as Record<string, unknown>[];
      expect(accepts[0].resource).toBe("/invoke/price-feed");
    });
  });
});
