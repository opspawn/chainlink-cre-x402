/**
 * Tests: X402 Payment Verifier
 */

import {
  X402Verifier,
  createMockPaymentProof,
  createRealX402Proof,
  decodePaymentProof,
  isMockProof,
  isRealX402Proof,
} from "../../src/x402-verifier";

const RECIPIENT = "0x7483a9F237cf8043704D6b17DA31c12BfFF860DD";
const PAYER = "0xAbCd1234567890AbCd1234567890AbCd12345678";

describe("X402Verifier", () => {
  let verifier: X402Verifier;

  beforeEach(() => {
    verifier = new X402Verifier({
      recipientAddress: RECIPIENT,
      requiredAmountUSDC: 0.001,
      simulationMode: true,
    });
  });

  describe("verify() — mock proof format", () => {
    it("returns invalid when payment proof is empty", async () => {
      const result = await verifier.verify("");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Missing x402 payment proof");
    });

    it("returns invalid when proof is malformed", async () => {
      const result = await verifier.verify("not-valid-base64-json-!!!");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Failed to decode");
    });

    it("returns invalid when recipient does not match", async () => {
      const proof = createMockPaymentProof(PAYER, "0x0000000000000000000000000000000000000000", 0.01);
      const result = await verifier.verify(proof);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("recipient mismatch");
    });

    it("returns invalid when amount is insufficient", async () => {
      const proof = createMockPaymentProof(PAYER, RECIPIENT, 0.0001); // Too small
      const result = await verifier.verify(proof);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Insufficient payment");
    });

    it("returns valid for a correct mock payment proof", async () => {
      const proof = createMockPaymentProof(PAYER, RECIPIENT, 0.005);
      const result = await verifier.verify(proof);
      expect(result.valid).toBe(true);
      expect(result.payer).toBe(PAYER);
      expect(result.recipient.toLowerCase()).toBe(RECIPIENT.toLowerCase());
      expect(result.amount).toBeGreaterThanOrEqual(5000n); // 0.005 USDC = 5000 micro-USDC
    });

    it("accepts payment that exactly meets the minimum amount", async () => {
      const proof = createMockPaymentProof(PAYER, RECIPIENT, 0.001);
      const result = await verifier.verify(proof);
      expect(result.valid).toBe(true);
    });
  });

  describe("verify() — real x402 proof format (EIP-3009, simulation mode)", () => {
    it("verifies a real x402 proof with correct recipient and amount", async () => {
      const proof = createRealX402Proof(PAYER, RECIPIENT, 0.005, "base-sepolia");
      const result = await verifier.verify(proof);
      expect(result.valid).toBe(true);
      expect(result.payer.toLowerCase()).toBe(PAYER.toLowerCase());
      expect(result.recipient.toLowerCase()).toBe(RECIPIENT.toLowerCase());
      expect(result.amount).toBeGreaterThanOrEqual(5000n);
    });

    it("returns invalid when real x402 proof has wrong recipient", async () => {
      const wrongRecipient = "0x0000000000000000000000000000000000000000";
      const proof = createRealX402Proof(PAYER, wrongRecipient, 0.005, "base-sepolia");
      const result = await verifier.verify(proof);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("recipient mismatch");
    });

    it("returns invalid when real x402 proof has insufficient amount", async () => {
      const proof = createRealX402Proof(PAYER, RECIPIENT, 0.00001, "base-sepolia");
      const result = await verifier.verify(proof);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Insufficient payment");
    });

    it("returns invalid when real x402 proof is expired", async () => {
      // Create an expired proof by patching validBefore to the past
      const proofStr = createRealX402Proof(PAYER, RECIPIENT, 0.005, "base-sepolia");
      const decoded = JSON.parse(Buffer.from(proofStr, "base64").toString("utf-8"));
      decoded.payload.authorization.validBefore = "1000"; // epoch 1000 = 1970
      decoded.payload.authorization.validAfter = "0";
      const expiredProof = Buffer.from(JSON.stringify(decoded)).toString("base64");

      const result = await verifier.verify(expiredProof);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("expired");
    });
  });

  describe("createMockPaymentProof()", () => {
    it("creates a decodable base64 payment proof", () => {
      const proof = createMockPaymentProof(PAYER, RECIPIENT, 0.01);
      expect(typeof proof).toBe("string");
      expect(proof.length).toBeGreaterThan(50);

      const decoded = decodePaymentProof(proof);
      expect(isMockProof(decoded)).toBe(true);
      if (isMockProof(decoded)) {
        expect(decoded.payer).toBe(PAYER);
        expect(decoded.recipient).toBe(RECIPIENT);
        expect(decoded.network).toBe("base-sepolia");
      }
    });

    it("encodes amount as USDC micro-units (6 decimals)", () => {
      const proof = createMockPaymentProof(PAYER, RECIPIENT, 1.5);
      const decoded = decodePaymentProof(proof);
      expect(isMockProof(decoded)).toBe(true);
      if (isMockProof(decoded)) {
        // 1.5 USDC = 1,500,000 micro-USDC
        expect(String(decoded.amount)).toBe("1500000");
      }
    });
  });

  describe("createRealX402Proof()", () => {
    it("creates a real x402 proof in EIP-3009 format", () => {
      const proof = createRealX402Proof(PAYER, RECIPIENT, 0.005, "base-sepolia");
      expect(typeof proof).toBe("string");

      const decoded = decodePaymentProof(proof);
      expect(isRealX402Proof(decoded)).toBe(true);
      if (isRealX402Proof(decoded)) {
        expect(decoded.x402Version).toBe(1);
        expect(decoded.scheme).toBe("exact");
        expect(decoded.network).toBe("base-sepolia");
        expect(decoded.payload.authorization.from).toBe(PAYER);
        expect(decoded.payload.authorization.to).toBe(RECIPIENT);
        expect(decoded.payload.authorization.value).toBe("5000"); // 0.005 * 1e6
      }
    });

    it("encodes amount as USDC micro-units in authorization.value", () => {
      const proof = createRealX402Proof(PAYER, RECIPIENT, 1.5, "base-sepolia");
      const decoded = decodePaymentProof(proof);
      if (isRealX402Proof(decoded)) {
        expect(decoded.payload.authorization.value).toBe("1500000");
      }
    });

    it("sets validAfter and validBefore within expected time window", () => {
      const before = Math.floor(Date.now() / 1000);
      const proof = createRealX402Proof(PAYER, RECIPIENT, 0.001, "base-sepolia");
      const after = Math.floor(Date.now() / 1000);
      const decoded = decodePaymentProof(proof);
      if (isRealX402Proof(decoded)) {
        const validAfter = parseInt(decoded.payload.authorization.validAfter);
        const validBefore = parseInt(decoded.payload.authorization.validBefore);
        expect(validAfter).toBeLessThanOrEqual(before);
        expect(validBefore).toBeGreaterThanOrEqual(after);
      }
    });
  });

  describe("type guards", () => {
    it("isMockProof returns true for mock proof", () => {
      const proof = createMockPaymentProof(PAYER, RECIPIENT, 0.001);
      const decoded = decodePaymentProof(proof);
      expect(isMockProof(decoded)).toBe(true);
      expect(isRealX402Proof(decoded)).toBe(false);
    });

    it("isRealX402Proof returns true for real x402 proof", () => {
      const proof = createRealX402Proof(PAYER, RECIPIENT, 0.001, "base-sepolia");
      const decoded = decodePaymentProof(proof);
      expect(isRealX402Proof(decoded)).toBe(true);
      expect(isMockProof(decoded)).toBe(false);
    });
  });
});
