/**
 * Wallet Signer — Real EIP-3009 Payment Proof Generation
 *
 * Creates cryptographically signed x402 payment proofs using a wallet private key.
 * Uses viem's `privateKeyToAccount` + `signTypedData` to produce EIP-712 signatures
 * compatible with USDC's `transferWithAuthorization` on Base / Base Sepolia.
 *
 * Usage:
 *   const signer = new WalletSigner({ privateKey: process.env.PAYER_PRIVATE_KEY! });
 *   const proof = await signer.createPaymentProof({
 *     recipient: "0xRecipient...",
 *     amountUSDC: 0.001,
 *     network: "base-sepolia",
 *   });
 *
 * Proof format (x402 standard):
 *   base64(JSON({
 *     x402Version: 1,
 *     scheme: "exact",
 *     network: "base-sepolia",
 *     payload: {
 *       signature: "0x...",  // EIP-712 signature
 *       authorization: {
 *         from: "0xPayer...",
 *         to: "0xRecipient...",
 *         value: "1000",           // USDC micro-units (6 decimals)
 *         validAfter: "...",       // Unix timestamp (seconds)
 *         validBefore: "...",      // Unix timestamp (seconds)
 *         nonce: "0x...",          // Random 32-byte nonce (prevents replay)
 *       }
 *     }
 *   }))
 *
 * Reference: https://github.com/coinbase/x402
 * EIP-3009: https://eips.ethereum.org/EIPS/eip-3009
 */

import { privateKeyToAccount, type Account } from "viem/accounts";
import { signTypedData } from "viem/actions";
import { createWalletClient, http, type Hex, type Address } from "viem";
import { base, baseSepolia } from "viem/chains";
import type { X402RealProof } from "./x402-verifier.js";

// ─── USDC Contract Addresses ──────────────────────────────────────────────────

export const USDC_ADDRESS = {
  base: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address,
  "base-sepolia": "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as Address,
} as const;

// ─── EIP-712 Domain for USDC ─────────────────────────────────────────────────

const USDC_EIP712_DOMAIN = {
  base: {
    name: "USD Coin",
    version: "2",
    chainId: 8453n,
    verifyingContract: USDC_ADDRESS.base,
  },
  "base-sepolia": {
    name: "USD Coin",
    version: "2",
    chainId: 84532n,
    verifyingContract: USDC_ADDRESS["base-sepolia"],
  },
} as const;

// ─── EIP-3009 TransferWithAuthorization types ─────────────────────────────────

const TRANSFER_WITH_AUTH_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

// ─── Config ───────────────────────────────────────────────────────────────────

export interface WalletSignerConfig {
  /**
   * Ethereum private key (hex, 0x-prefixed or bare).
   * For testnet use only — never expose in production logs.
   * Loaded from PAYER_PRIVATE_KEY env var in production.
   */
  privateKey: string;
  /** Network to sign for (default: "base-sepolia") */
  network?: "base" | "base-sepolia";
}

export interface CreateProofOptions {
  /** Recipient wallet address (e.g. OpSpawn gateway wallet) */
  recipient: string;
  /** Amount in USDC (e.g. 0.001 = $0.001) */
  amountUSDC: number;
  /** Override network for this specific proof */
  network?: "base" | "base-sepolia";
  /** Override validity window (default: 5 minutes) */
  validForSeconds?: number;
}

// ─── WalletSigner ─────────────────────────────────────────────────────────────

export class WalletSigner {
  private account: Account;
  private network: "base" | "base-sepolia";

  constructor(config: WalletSignerConfig) {
    const pk = config.privateKey.startsWith("0x")
      ? (config.privateKey as Hex)
      : (`0x${config.privateKey}` as Hex);
    this.account = privateKeyToAccount(pk);
    this.network = config.network ?? "base-sepolia";
  }

  /** Signer's wallet address (derived from private key) */
  get address(): string {
    return this.account.address;
  }

  /**
   * Create a real x402 payment proof using EIP-3009 transferWithAuthorization.
   *
   * Signs an EIP-712 typed data message using the wallet's private key.
   * The resulting proof can be verified by any x402-compatible gateway
   * without making an on-chain call.
   */
  async createPaymentProof(options: CreateProofOptions): Promise<string> {
    const network = options.network ?? this.network;
    const validForSeconds = options.validForSeconds ?? 300; // 5 minutes default
    const now = Math.floor(Date.now() / 1000);

    // Convert USDC amount to micro-units (6 decimals)
    const valueInMicroUnits = BigInt(Math.round(options.amountUSDC * 1_000_000));

    // Random 32-byte nonce (prevents replay attacks)
    const nonce = generateNonce();

    const authorization = {
      from: this.account.address as Address,
      to: options.recipient as Address,
      value: valueInMicroUnits,
      validAfter: BigInt(now - 30), // 30s grace for clock skew
      validBefore: BigInt(now + validForSeconds),
      nonce,
    };

    const domain = USDC_EIP712_DOMAIN[network];
    const chain = network === "base" ? base : baseSepolia;

    // Create wallet client for signing
    const walletClient = createWalletClient({
      account: this.account,
      chain,
      transport: http(),
    });

    // Sign EIP-712 typed data
    const signature = await signTypedData(walletClient, {
      account: this.account,
      domain,
      types: TRANSFER_WITH_AUTH_TYPES,
      primaryType: "TransferWithAuthorization",
      message: authorization,
    });

    const proof: X402RealProof = {
      x402Version: 1,
      scheme: "exact",
      network,
      payload: {
        signature,
        authorization: {
          from: authorization.from,
          to: authorization.to,
          value: authorization.value.toString(),
          validAfter: authorization.validAfter.toString(),
          validBefore: authorization.validBefore.toString(),
          nonce,
        },
      },
    };

    return Buffer.from(JSON.stringify(proof)).toString("base64");
  }

  /**
   * Load wallet signer from environment variable.
   * Returns null if PAYER_PRIVATE_KEY is not set.
   *
   * Safe to call without a private key — returns null gracefully.
   */
  static fromEnv(network?: "base" | "base-sepolia"): WalletSigner | null {
    const privateKey = process.env.PAYER_PRIVATE_KEY;
    if (!privateKey) return null;
    return new WalletSigner({ privateKey, network });
  }
}

// ─── Utility ─────────────────────────────────────────────────────────────────

/**
 * Generate a random 32-byte hex nonce for EIP-3009 (0x-prefixed).
 * Used as the `nonce` field in TransferWithAuthorization.
 */
export function generateNonce(): Hex {
  const bytes = new Uint8Array(32);
  // Use crypto.getRandomValues for true randomness in Node.js 22+
  globalThis.crypto.getRandomValues(bytes);
  return `0x${Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")}` as Hex;
}

/**
 * Sanitize a private key for display (shows only first/last 4 chars).
 * Use in logs to confirm a key is loaded without exposing it.
 */
export function sanitizePrivateKey(privateKey: string): string {
  const pk = privateKey.replace(/^0x/, "");
  if (pk.length < 10) return "***";
  return `0x${pk.slice(0, 4)}...${pk.slice(-4)}`;
}
