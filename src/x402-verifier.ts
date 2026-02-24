/**
 * x402 Payment Verifier
 *
 * Verifies x402 payment proofs before allowing access to CRE workflows.
 *
 * Supports two proof formats:
 *   1. Simple mock format (testing/CI): base64(JSON({ txHash, amount, recipient, payer, signature }))
 *   2. Real x402 format (production): base64(JSON({ x402Version, scheme, network, payload: { signature, authorization } }))
 *
 * Production verification uses EIP-3009 transferWithAuthorization typed data:
 *   - Recovers signer from EIP-712 signature via viem
 *   - Validates authorization.to matches recipient
 *   - Validates authorization.value meets minimum amount
 *   - Does NOT require on-chain call (signature verification only)
 *
 * Reference: https://github.com/coinbase/x402
 */

import { verifyTypedData, type Address, type Hex } from "viem";
import { X402PaymentVerification } from "./types.js";

// EIP-3009 domain for USDC on Base
const USDC_DOMAIN_BASE = {
  name: "USD Coin",
  version: "2",
  chainId: 8453n, // Base mainnet
} as const;

const USDC_DOMAIN_BASE_SEPOLIA = {
  name: "USD Coin",
  version: "2",
  chainId: 84532n, // Base Sepolia
} as const;

// EIP-3009 TransferWithAuthorization type
const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export interface X402VerifierConfig {
  /** Wallet address that receives payments */
  recipientAddress: string;
  /** Required payment amount in USDC (e.g. 0.001) */
  requiredAmountUSDC: number;
  /** If true, use mock verification (no real blockchain calls) */
  simulationMode?: boolean;
  /** RPC URL for real verification (Base mainnet or testnet) */
  rpcUrl?: string;
  /** Network: 'base' | 'base-sepolia' (default: 'base-sepolia') */
  network?: "base" | "base-sepolia";
}

/**
 * Real x402 authorization payload (EIP-3009 / USDC transferWithAuthorization)
 */
export interface X402Authorization {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
}

/**
 * Real x402 payment proof format (Coinbase/Base standard)
 */
export interface X402RealProof {
  x402Version: number;
  scheme: "exact" | "upto";
  network: string;
  payload: {
    signature: string;
    authorization: X402Authorization;
  };
}

/**
 * Simple mock proof format (for testing/CI, matches Day 1 format)
 */
export interface X402MockProof {
  txHash: string;
  amount: string;
  recipient: string;
  payer: string;
  signature: string;
  timestamp: number;
  network: string;
}

/**
 * Decode and parse x402 payment proof header.
 * Supports both real x402 format and mock format.
 */
export function decodePaymentProof(proof: string): X402RealProof | X402MockProof {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(proof, "base64").toString("utf-8"));
  } catch {
    try {
      decoded = JSON.parse(proof);
    } catch {
      throw new Error(`Invalid x402 payment proof format: ${proof.slice(0, 50)}...`);
    }
  }

  if (!decoded || typeof decoded !== "object") {
    throw new Error("Payment proof is not a JSON object");
  }

  return decoded as X402RealProof | X402MockProof;
}

/**
 * Check if proof is real x402 format (has x402Version field)
 */
export function isRealX402Proof(proof: unknown): proof is X402RealProof {
  return (
    typeof proof === "object" &&
    proof !== null &&
    "x402Version" in proof &&
    "payload" in proof &&
    typeof (proof as X402RealProof).payload === "object"
  );
}

/**
 * Check if proof is simple mock format
 */
export function isMockProof(proof: unknown): proof is X402MockProof {
  return (
    typeof proof === "object" &&
    proof !== null &&
    "recipient" in proof &&
    "amount" in proof &&
    "payer" in proof
  );
}

/**
 * Create a real x402 proof (EIP-3009 format) for testing.
 * In production, this would be created by a wallet (e.g. via x402 client SDK).
 */
export function createRealX402Proof(
  fromAddress: string,
  toAddress: string,
  amountUSDC: number,
  network: "base" | "base-sepolia" = "base-sepolia",
  signature?: string
): string {
  const amount = BigInt(Math.round(amountUSDC * 1_000_000)).toString();
  const now = Math.floor(Date.now() / 1000);
  const nonce = `0x${Math.random().toString(16).slice(2).padEnd(64, "0")}` as Hex;

  const proof: X402RealProof = {
    x402Version: 1,
    scheme: "exact",
    network,
    payload: {
      signature: signature ?? `0x${Math.random().toString(16).slice(2).padEnd(130, "0")}`,
      authorization: {
        from: fromAddress,
        to: toAddress,
        value: amount,
        validAfter: (now - 60).toString(),
        validBefore: (now + 300).toString(),
        nonce,
      },
    },
  };
  return Buffer.from(JSON.stringify(proof)).toString("base64");
}

/**
 * Create a mock x402 payment proof (for Day 1 compat / simple testing)
 */
export function createMockPaymentProof(
  payer: string,
  recipient: string,
  amountUSDC: number
): string {
  const proof: X402MockProof = {
    txHash: `0x${Math.random().toString(16).slice(2).padEnd(64, "0")}`,
    amount: BigInt(Math.round(amountUSDC * 1_000_000)).toString(),
    recipient,
    payer,
    signature: `0x${Math.random().toString(16).slice(2).padEnd(130, "0")}`,
    timestamp: Date.now(),
    network: "base-sepolia",
  };
  return Buffer.from(JSON.stringify(proof)).toString("base64");
}

export class X402Verifier {
  private config: X402VerifierConfig;

  constructor(config: X402VerifierConfig) {
    this.config = config;
  }

  /**
   * Verify an x402 payment proof.
   *
   * Modes:
   *   - simulationMode=true: Validates proof structure + amount (no crypto calls)
   *   - simulationMode=false, mock proof: Validates structure + amount
   *   - simulationMode=false, real x402 proof: Verifies EIP-712 signature via viem,
   *     checks signer == authorization.from, validates recipient + amount
   */
  async verify(paymentProof: string): Promise<X402PaymentVerification> {
    if (!paymentProof) {
      return {
        valid: false,
        amount: 0n,
        recipient: "",
        payer: "",
        error: "Missing x402 payment proof (x-payment header required)",
      };
    }

    let decoded: X402RealProof | X402MockProof;
    try {
      decoded = decodePaymentProof(paymentProof);
    } catch (err) {
      return {
        valid: false,
        amount: 0n,
        recipient: "",
        payer: "",
        error: `Failed to decode payment proof: ${(err as Error).message}`,
      };
    }

    if (isRealX402Proof(decoded)) {
      return this.verifyRealX402Proof(decoded);
    } else if (isMockProof(decoded)) {
      return this.verifyMockProof(decoded);
    } else {
      return {
        valid: false,
        amount: 0n,
        recipient: "",
        payer: "",
        error: "Unrecognized payment proof format",
      };
    }
  }

  /**
   * Verify a real x402 proof (EIP-3009 / EIP-712 typed data signature).
   *
   * In simulation mode: skips signature crypto, validates structure only.
   * In production mode: recovers signer from EIP-712 signature using viem,
   *   verifies signer == authorization.from, and checks recipient + amount.
   */
  private async verifyRealX402Proof(proof: X402RealProof): Promise<X402PaymentVerification> {
    const auth = proof.payload.authorization;
    const amount = BigInt(auth.value ?? "0");
    const recipient = auth.to ?? "";
    const payer = auth.from ?? "";

    // Validate recipient
    if (recipient.toLowerCase() !== this.config.recipientAddress.toLowerCase()) {
      return {
        valid: false,
        amount,
        recipient,
        payer,
        error: `Payment recipient mismatch: expected ${this.config.recipientAddress}, got ${recipient}`,
      };
    }

    // Validate amount
    const requiredAmount = BigInt(Math.round(this.config.requiredAmountUSDC * 1_000_000));
    if (amount < requiredAmount) {
      return {
        valid: false,
        amount,
        recipient,
        payer,
        error: `Insufficient payment: required ${this.config.requiredAmountUSDC} USDC, got ${Number(amount) / 1_000_000} USDC`,
      };
    }

    // Validate validity window
    const now = Math.floor(Date.now() / 1000);
    const validAfter = parseInt(auth.validAfter ?? "0");
    const validBefore = parseInt(auth.validBefore ?? "0");
    if (now < validAfter) {
      return {
        valid: false,
        amount,
        recipient,
        payer,
        error: `Payment not yet valid (validAfter: ${new Date(validAfter * 1000).toISOString()})`,
      };
    }
    if (now >= validBefore) {
      return {
        valid: false,
        amount,
        recipient,
        payer,
        error: `Payment expired (validBefore: ${new Date(validBefore * 1000).toISOString()})`,
      };
    }

    // In simulation mode, skip EIP-712 signature verification
    if (this.config.simulationMode) {
      return { valid: true, amount, recipient, payer };
    }

    // Production: verify EIP-712 signature using viem
    try {
      const domain =
        proof.network === "base"
          ? USDC_DOMAIN_BASE
          : USDC_DOMAIN_BASE_SEPOLIA;

      const message = {
        from: auth.from as Address,
        to: auth.to as Address,
        value: BigInt(auth.value),
        validAfter: BigInt(auth.validAfter),
        validBefore: BigInt(auth.validBefore),
        nonce: auth.nonce as Hex,
      };

      const isValid = await verifyTypedData({
        address: payer as Address,
        domain,
        types: TRANSFER_WITH_AUTHORIZATION_TYPES,
        primaryType: "TransferWithAuthorization",
        message,
        signature: proof.payload.signature as Hex,
      });

      if (!isValid) {
        return {
          valid: false,
          amount,
          recipient,
          payer,
          error: "EIP-712 signature verification failed: signer does not match authorization.from",
        };
      }

      return { valid: true, amount, recipient, payer };
    } catch (err) {
      return {
        valid: false,
        amount,
        recipient,
        payer,
        error: `EIP-712 verification error: ${(err as Error).message}`,
      };
    }
  }

  /**
   * Verify a mock proof (Day 1 simple format: { txHash, amount, recipient, payer })
   */
  private async verifyMockProof(proof: X402MockProof): Promise<X402PaymentVerification> {
    const amount = BigInt(String(proof.amount ?? "0"));
    const recipient = String(proof.recipient ?? "");
    const payer = String(proof.payer ?? "");
    const txHash = proof.txHash ? String(proof.txHash) : undefined;

    if (recipient.toLowerCase() !== this.config.recipientAddress.toLowerCase()) {
      return {
        valid: false,
        amount,
        recipient,
        payer,
        txHash,
        error: `Payment recipient mismatch: expected ${this.config.recipientAddress}, got ${recipient}`,
      };
    }

    const requiredAmount = BigInt(Math.round(this.config.requiredAmountUSDC * 1_000_000));
    if (amount < requiredAmount) {
      return {
        valid: false,
        amount,
        recipient,
        payer,
        txHash,
        error: `Insufficient payment: required ${this.config.requiredAmountUSDC} USDC, got ${Number(amount) / 1_000_000} USDC`,
      };
    }

    return { valid: true, amount, recipient, payer, txHash };
  }

  get requiredAmountUSDC(): number {
    return this.config.requiredAmountUSDC;
  }

  get recipientAddress(): string {
    return this.config.recipientAddress;
  }
}
