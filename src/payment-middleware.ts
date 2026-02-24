/**
 * x402 Payment Gate Middleware
 *
 * Express middleware that enforces x402 payment requirements on routes.
 * Returns HTTP 402 (Payment Required) with full payment instructions when
 * no valid proof is provided. Attaches verified payment context to res.locals
 * for downstream handlers.
 *
 * Usage (per-route):
 *   app.post("/invoke/:workflow",
 *     requireX402Payment({ recipientAddress, requiredAmountUSDC: 0.001 }),
 *     handler
 *   )
 *
 * 402 response format follows the x402 standard:
 *   https://github.com/coinbase/x402
 */

import { Request, Response, NextFunction } from "express";
import { X402Verifier } from "./x402-verifier.js";
import { X402PaymentVerification } from "./types.js";

// USDC contract address on Base Sepolia (for 402 response metadata)
const USDC_BASE_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
// USDC contract address on Base mainnet
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

export interface X402MiddlewareConfig {
  /** Wallet address that receives payments */
  recipientAddress: string;
  /** Required payment amount in USDC (e.g. 0.001 = $0.001) */
  requiredAmountUSDC: number;
  /** Enable simulation mode (skip EIP-712 crypto, validate structure only) */
  simulationMode?: boolean;
  /** Network for payment instructions */
  network?: "base" | "base-sepolia";
  /** Human-readable description of what this payment is for */
  description?: string;
}

/**
 * Payment context attached to res.locals.x402Payment after successful verification.
 */
export interface X402PaymentContext {
  valid: true;
  amount: bigint;
  recipient: string;
  payer: string;
  txHash?: string;
}

/**
 * Create an Express middleware that requires a valid x402 payment proof.
 *
 * On success: attaches X402PaymentContext to res.locals.x402Payment and calls next()
 * On failure: returns HTTP 402 with x402-compliant payment instructions
 */
export function requireX402Payment(config: X402MiddlewareConfig) {
  const network = config.network ?? "base-sepolia";
  const usdcAddress = network === "base" ? USDC_BASE : USDC_BASE_SEPOLIA;

  const verifier = new X402Verifier({
    recipientAddress: config.recipientAddress,
    requiredAmountUSDC: config.requiredAmountUSDC,
    simulationMode: config.simulationMode ?? true,
    network,
  });

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const paymentProof = (req.headers["x-payment"] as string) ?? "";
    const verification: X402PaymentVerification = await verifier.verify(paymentProof);

    if (!verification.valid) {
      const maxAmountRequired = String(Math.round(config.requiredAmountUSDC * 1_000_000));

      res.status(402).json({
        error: "Payment Required",
        message: verification.error ?? "Valid x402 payment proof required",
        x402Version: 1,
        accepts: [
          {
            scheme: "exact",
            network,
            maxAmountRequired,
            resource: req.originalUrl,
            description: config.description ?? "CRE Workflow Execution",
            mimeType: "application/json",
            payTo: config.recipientAddress,
            maxTimeoutSeconds: 300,
            asset: usdcAddress,
            extra: {
              name: "USD Coin",
              version: "2",
            },
          },
        ],
      });
      return;
    }

    // Attach verified payment context for downstream handlers
    res.locals.x402Payment = {
      valid: true,
      amount: verification.amount,
      recipient: verification.recipient,
      payer: verification.payer,
      txHash: verification.txHash,
    } as X402PaymentContext;

    next();
  };
}
