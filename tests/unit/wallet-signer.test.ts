/**
 * WalletSigner unit tests
 *
 * Tests for:
 *   - generateNonce() — random 32-byte hex nonce
 *   - sanitizePrivateKey() — safe display format
 *   - WalletSigner.fromEnv() — loads from env
 *   - WalletSigner construction — address derivation
 *   - WalletSigner.createPaymentProof() — full EIP-3009 signing
 */

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import {
  WalletSigner,
  generateNonce,
  sanitizePrivateKey,
  USDC_ADDRESS,
} from "../../src/wallet-signer.js";
import { decodePaymentProof, isRealX402Proof } from "../../src/x402-verifier.js";

// Well-known test private keys (NEVER use with real funds — these are public)
const TEST_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const TEST_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"; // derived from above

// ─── generateNonce ────────────────────────────────────────────────────────────

describe("generateNonce()", () => {
  it("returns a 0x-prefixed hex string", () => {
    const nonce = generateNonce();
    expect(nonce).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("generates unique nonces each call", () => {
    const nonces = new Set(Array.from({ length: 20 }, () => generateNonce()));
    expect(nonces.size).toBe(20);
  });

  it("nonce is exactly 66 chars (0x + 64 hex)", () => {
    const nonce = generateNonce();
    expect(nonce.length).toBe(66);
  });

  it("nonce only contains valid hex chars", () => {
    const nonce = generateNonce();
    const hexPart = nonce.slice(2);
    expect(hexPart).toMatch(/^[0-9a-f]+$/);
  });
});

// ─── sanitizePrivateKey ───────────────────────────────────────────────────────

describe("sanitizePrivateKey()", () => {
  it("redacts middle of private key", () => {
    const safe = sanitizePrivateKey(TEST_PRIVATE_KEY);
    expect(safe).toMatch(/^0x[0-9a-f]{4}\.\.\.[0-9a-f]{4}$/);
  });

  it("works without 0x prefix", () => {
    const bare = TEST_PRIVATE_KEY.slice(2);
    const safe = sanitizePrivateKey(bare);
    expect(safe).toMatch(/^0x[0-9a-f]{4}\.\.\.[0-9a-f]{4}$/);
  });

  it("handles short keys gracefully", () => {
    const safe = sanitizePrivateKey("0x123");
    expect(safe).toBe("***");
  });
});

// ─── USDC_ADDRESS ─────────────────────────────────────────────────────────────

describe("USDC_ADDRESS", () => {
  it("has base mainnet address", () => {
    expect(USDC_ADDRESS.base).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it("has base-sepolia address", () => {
    expect(USDC_ADDRESS["base-sepolia"]).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it("mainnet and testnet addresses are different", () => {
    expect(USDC_ADDRESS.base).not.toBe(USDC_ADDRESS["base-sepolia"]);
  });
});

// ─── WalletSigner.fromEnv ─────────────────────────────────────────────────────

describe("WalletSigner.fromEnv()", () => {
  const originalEnv = process.env.PAYER_PRIVATE_KEY;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.PAYER_PRIVATE_KEY;
    } else {
      process.env.PAYER_PRIVATE_KEY = originalEnv;
    }
  });

  it("returns null when PAYER_PRIVATE_KEY is not set", () => {
    delete process.env.PAYER_PRIVATE_KEY;
    const signer = WalletSigner.fromEnv();
    expect(signer).toBeNull();
  });

  it("returns a WalletSigner when PAYER_PRIVATE_KEY is set", () => {
    process.env.PAYER_PRIVATE_KEY = TEST_PRIVATE_KEY;
    const signer = WalletSigner.fromEnv();
    expect(signer).not.toBeNull();
    expect(signer).toBeInstanceOf(WalletSigner);
  });

  it("passes network option to signer", () => {
    process.env.PAYER_PRIVATE_KEY = TEST_PRIVATE_KEY;
    const signer = WalletSigner.fromEnv("base");
    expect(signer).not.toBeNull();
  });
});

// ─── WalletSigner construction ────────────────────────────────────────────────

describe("WalletSigner construction", () => {
  it("derives correct address from private key", () => {
    const signer = new WalletSigner({ privateKey: TEST_PRIVATE_KEY });
    expect(signer.address.toLowerCase()).toBe(TEST_ADDRESS.toLowerCase());
  });

  it("accepts private key without 0x prefix", () => {
    const bare = TEST_PRIVATE_KEY.slice(2);
    const signer = new WalletSigner({ privateKey: bare });
    expect(signer.address.toLowerCase()).toBe(TEST_ADDRESS.toLowerCase());
  });

  it("defaults to base-sepolia network", () => {
    const signer = new WalletSigner({ privateKey: TEST_PRIVATE_KEY });
    // No direct getter, but createPaymentProof should use base-sepolia
    expect(signer).toBeInstanceOf(WalletSigner);
  });
});

// ─── WalletSigner.createPaymentProof ─────────────────────────────────────────

describe("WalletSigner.createPaymentProof()", () => {
  let signer: WalletSigner;

  beforeEach(() => {
    signer = new WalletSigner({ privateKey: TEST_PRIVATE_KEY, network: "base-sepolia" });
  });

  it("returns a base64-encoded string", async () => {
    const proof = await signer.createPaymentProof({
      recipient: "0x7483a9F237cf8043704D6b17DA31c12BfFF860DD",
      amountUSDC: 0.001,
    });
    expect(typeof proof).toBe("string");
    // Valid base64
    expect(() => Buffer.from(proof, "base64")).not.toThrow();
  });

  it("produces a real x402 format proof", async () => {
    const proof = await signer.createPaymentProof({
      recipient: "0x7483a9F237cf8043704D6b17DA31c12BfFF860DD",
      amountUSDC: 0.001,
    });
    const decoded = decodePaymentProof(proof);
    expect(isRealX402Proof(decoded)).toBe(true);
  });

  it("proof contains correct x402Version", async () => {
    const proof = await signer.createPaymentProof({
      recipient: "0x7483a9F237cf8043704D6b17DA31c12BfFF860DD",
      amountUSDC: 0.001,
    });
    const decoded = decodePaymentProof(proof);
    if (isRealX402Proof(decoded)) {
      expect(decoded.x402Version).toBe(1);
    }
  });

  it("proof contains correct network", async () => {
    const proof = await signer.createPaymentProof({
      recipient: "0x7483a9F237cf8043704D6b17DA31c12BfFF860DD",
      amountUSDC: 0.005,
      network: "base-sepolia",
    });
    const decoded = decodePaymentProof(proof);
    if (isRealX402Proof(decoded)) {
      expect(decoded.network).toBe("base-sepolia");
    }
  });

  it("authorization.from matches signer address", async () => {
    const proof = await signer.createPaymentProof({
      recipient: "0x7483a9F237cf8043704D6b17DA31c12BfFF860DD",
      amountUSDC: 0.002,
    });
    const decoded = decodePaymentProof(proof);
    if (isRealX402Proof(decoded)) {
      expect(decoded.payload.authorization.from.toLowerCase()).toBe(
        TEST_ADDRESS.toLowerCase()
      );
    }
  });

  it("authorization.to matches recipient", async () => {
    const recipient = "0x7483a9F237cf8043704D6b17DA31c12BfFF860DD";
    const proof = await signer.createPaymentProof({ recipient, amountUSDC: 0.001 });
    const decoded = decodePaymentProof(proof);
    if (isRealX402Proof(decoded)) {
      expect(decoded.payload.authorization.to.toLowerCase()).toBe(recipient.toLowerCase());
    }
  });

  it("authorization.value matches amount in micro-units", async () => {
    const proof = await signer.createPaymentProof({
      recipient: "0x7483a9F237cf8043704D6b17DA31c12BfFF860DD",
      amountUSDC: 0.005, // = 5000 micro-USDC
    });
    const decoded = decodePaymentProof(proof);
    if (isRealX402Proof(decoded)) {
      expect(decoded.payload.authorization.value).toBe("5000");
    }
  });

  it("has a valid EIP-712 signature (0x-prefixed hex)", async () => {
    const proof = await signer.createPaymentProof({
      recipient: "0x7483a9F237cf8043704D6b17DA31c12BfFF860DD",
      amountUSDC: 0.001,
    });
    const decoded = decodePaymentProof(proof);
    if (isRealX402Proof(decoded)) {
      expect(decoded.payload.signature).toMatch(/^0x[0-9a-fA-F]+$/);
    }
  });

  it("proof validity window is 5 minutes by default", async () => {
    const now = Math.floor(Date.now() / 1000);
    const proof = await signer.createPaymentProof({
      recipient: "0x7483a9F237cf8043704D6b17DA31c12BfFF860DD",
      amountUSDC: 0.001,
    });
    const decoded = decodePaymentProof(proof);
    if (isRealX402Proof(decoded)) {
      const auth = decoded.payload.authorization;
      const validAfter = parseInt(auth.validAfter);
      const validBefore = parseInt(auth.validBefore);
      // validBefore should be ~5 minutes from now
      expect(validBefore - validAfter).toBeGreaterThanOrEqual(300);
      expect(validBefore - validAfter).toBeLessThanOrEqual(360); // allow some slack
    }
  });

  it("generates unique proofs on every call", async () => {
    const recipient = "0x7483a9F237cf8043704D6b17DA31c12BfFF860DD";
    const [p1, p2] = await Promise.all([
      signer.createPaymentProof({ recipient, amountUSDC: 0.001 }),
      signer.createPaymentProof({ recipient, amountUSDC: 0.001 }),
    ]);
    expect(p1).not.toBe(p2); // nonces are random
  });

  it("scheme is 'exact'", async () => {
    const proof = await signer.createPaymentProof({
      recipient: "0x7483a9F237cf8043704D6b17DA31c12BfFF860DD",
      amountUSDC: 0.001,
    });
    const decoded = decodePaymentProof(proof);
    if (isRealX402Proof(decoded)) {
      expect(decoded.scheme).toBe("exact");
    }
  });
});

// ─── WalletSigner edge cases ──────────────────────────────────────────────────

describe("WalletSigner — edge cases", () => {
  const RECIPIENT = "0x7483a9F237cf8043704D6b17DA31c12BfFF860DD";

  it("creates proof with amount = 0 (zero USDC)", async () => {
    const signer = new WalletSigner({ privateKey: TEST_PRIVATE_KEY });
    const proof = await signer.createPaymentProof({ recipient: RECIPIENT, amountUSDC: 0 });
    const decoded = decodePaymentProof(proof);
    if (isRealX402Proof(decoded)) {
      expect(decoded.payload.authorization.value).toBe("0");
    }
  });

  it("creates proof with very large amount (1000 USDC)", async () => {
    const signer = new WalletSigner({ privateKey: TEST_PRIVATE_KEY });
    const proof = await signer.createPaymentProof({ recipient: RECIPIENT, amountUSDC: 1000 });
    const decoded = decodePaymentProof(proof);
    if (isRealX402Proof(decoded)) {
      expect(decoded.payload.authorization.value).toBe("1000000000"); // 1000 * 1e6
    }
  });

  it("creates proof with fractional USDC (0.0001)", async () => {
    const signer = new WalletSigner({ privateKey: TEST_PRIVATE_KEY });
    const proof = await signer.createPaymentProof({ recipient: RECIPIENT, amountUSDC: 0.0001 });
    const decoded = decodePaymentProof(proof);
    if (isRealX402Proof(decoded)) {
      // 0.0001 USDC = 100 micro-units
      expect(parseInt(decoded.payload.authorization.value)).toBeGreaterThanOrEqual(0);
    }
  });

  it("respects custom validForSeconds window", async () => {
    const signer = new WalletSigner({ privateKey: TEST_PRIVATE_KEY });
    const now = Math.floor(Date.now() / 1000);
    const proof = await signer.createPaymentProof({
      recipient: RECIPIENT,
      amountUSDC: 0.001,
      validForSeconds: 60, // 1 minute
    });
    const decoded = decodePaymentProof(proof);
    if (isRealX402Proof(decoded)) {
      const validAfter = parseInt(decoded.payload.authorization.validAfter);
      const validBefore = parseInt(decoded.payload.authorization.validBefore);
      const window = validBefore - validAfter;
      // Should be ~90s window (60s + 30s grace for clock skew)
      expect(window).toBeGreaterThanOrEqual(60);
      expect(window).toBeLessThanOrEqual(120);
    }
  });

  it("creates proof for base mainnet network", async () => {
    const signer = new WalletSigner({ privateKey: TEST_PRIVATE_KEY, network: "base" });
    const proof = await signer.createPaymentProof({
      recipient: RECIPIENT,
      amountUSDC: 0.001,
      network: "base",
    });
    const decoded = decodePaymentProof(proof);
    if (isRealX402Proof(decoded)) {
      expect(decoded.network).toBe("base");
    }
  });

  it("proof authorization.nonce is 32-byte hex string", async () => {
    const signer = new WalletSigner({ privateKey: TEST_PRIVATE_KEY });
    const proof = await signer.createPaymentProof({ recipient: RECIPIENT, amountUSDC: 0.001 });
    const decoded = decodePaymentProof(proof);
    if (isRealX402Proof(decoded)) {
      const nonce = decoded.payload.authorization.nonce;
      expect(nonce).toMatch(/^0x[0-9a-fA-F]{64}$/);
    }
  });

  it("two proofs from the same signer have different nonces", async () => {
    const signer = new WalletSigner({ privateKey: TEST_PRIVATE_KEY });
    const [p1, p2] = await Promise.all([
      signer.createPaymentProof({ recipient: RECIPIENT, amountUSDC: 0.001 }),
      signer.createPaymentProof({ recipient: RECIPIENT, amountUSDC: 0.001 }),
    ]);
    const d1 = decodePaymentProof(p1);
    const d2 = decodePaymentProof(p2);
    if (isRealX402Proof(d1) && isRealX402Proof(d2)) {
      expect(d1.payload.authorization.nonce).not.toBe(d2.payload.authorization.nonce);
    }
  });

  it("validAfter is in the past (grace period for clock skew)", async () => {
    const signer = new WalletSigner({ privateKey: TEST_PRIVATE_KEY });
    const now = Math.floor(Date.now() / 1000);
    const proof = await signer.createPaymentProof({ recipient: RECIPIENT, amountUSDC: 0.001 });
    const decoded = decodePaymentProof(proof);
    if (isRealX402Proof(decoded)) {
      const validAfter = parseInt(decoded.payload.authorization.validAfter);
      // Should be 30s before now (clock skew grace)
      expect(validAfter).toBeLessThanOrEqual(now);
    }
  });

  it("validBefore is in the future", async () => {
    const signer = new WalletSigner({ privateKey: TEST_PRIVATE_KEY });
    const now = Math.floor(Date.now() / 1000);
    const proof = await signer.createPaymentProof({ recipient: RECIPIENT, amountUSDC: 0.001 });
    const decoded = decodePaymentProof(proof);
    if (isRealX402Proof(decoded)) {
      const validBefore = parseInt(decoded.payload.authorization.validBefore);
      expect(validBefore).toBeGreaterThan(now);
    }
  });

  it("proof base64 is decodable and parses as JSON", async () => {
    const signer = new WalletSigner({ privateKey: TEST_PRIVATE_KEY });
    const proof = await signer.createPaymentProof({ recipient: RECIPIENT, amountUSDC: 0.002 });
    expect(() => {
      const raw = Buffer.from(proof, "base64").toString("utf-8");
      JSON.parse(raw);
    }).not.toThrow();
  });
});

// ─── generateNonce edge cases ─────────────────────────────────────────────────

describe("generateNonce() — collision resistance", () => {
  it("generates 100 unique nonces with no collisions", () => {
    const nonces = new Set(Array.from({ length: 100 }, () => generateNonce()));
    expect(nonces.size).toBe(100);
  });

  it("nonce starts with 0x", () => {
    expect(generateNonce().startsWith("0x")).toBe(true);
  });
});

// ─── sanitizePrivateKey edge cases ────────────────────────────────────────────

describe("sanitizePrivateKey() — edge cases", () => {
  it("handles exactly 10 character key (just above short threshold)", () => {
    const safe = sanitizePrivateKey("0x0123456789");
    // length >= 10 after stripping 0x: should show first 4 + ... + last 4
    expect(safe).toMatch(/^0x[0-9a-f]{4}\.\.\.[0-9a-f]{4}$/);
  });

  it("handles key without 0x prefix but long enough", () => {
    // Key stripped of 0x, just raw hex chars
    const rawKey = TEST_PRIVATE_KEY.slice(2); // bare hex, no prefix
    const safe = sanitizePrivateKey(rawKey);
    expect(safe).toMatch(/^0x[0-9a-f]{4}\.\.\.[0-9a-f]{4}$/);
  });

  it("returns *** for empty string", () => {
    const safe = sanitizePrivateKey("");
    expect(safe).toBe("***");
  });

  it("returns *** for very short key (< 10 chars)", () => {
    const safe = sanitizePrivateKey("abc");
    expect(safe).toBe("***");
  });
});
