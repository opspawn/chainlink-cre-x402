/**
 * OpSpawn Agent Client
 *
 * Demonstrates the full x402 payment → CRE workflow execution loop.
 * An autonomous agent uses this client to discover workflows, construct
 * payment proofs, and invoke CRE workflows — all in a single call.
 *
 * E2E Flow:
 *   1. discoverWorkflows()      → GET /workflows, cache pricing + recipient
 *   2. constructPaymentProof()  → Build EIP-3009 proof (mock or real)
 *   3. invoke(workflow, payload) → POST /invoke/:workflow + x-payment header
 *   4. Parse result             → Verified CRE output returned
 *
 * Modes:
 *   simulationMode=true  (default) — mock payment proofs, no wallet needed
 *   simulationMode=false           — real EIP-3009 proofs (private key required)
 *
 * Usage:
 *   const agent = new AgentClient({
 *     gatewayUrl: "http://localhost:3100",
 *     payerAddress: "0xYourWallet",
 *   });
 *
 *   const result = await agent.invoke("price-feed", { pair: "ETH/USD" });
 *   // → { success: true, result: { price: 2847.32, ... } }
 */

import { createMockPaymentProof, createRealX402Proof } from "./x402-verifier.js";
import { WalletSigner } from "./wallet-signer.js";

export interface AgentClientConfig {
  /** Gateway base URL (e.g. "http://localhost:3100") */
  gatewayUrl: string;
  /** Agent's wallet address (payer) */
  payerAddress: string;
  /** Recipient address override (auto-discovered from /workflows if not set) */
  recipientAddress?: string;
  /** Use simulation mode (mock proofs instead of real EIP-3009 signatures) */
  simulationMode?: boolean;
  /** Network for payment proofs */
  network?: "base" | "base-sepolia";
  /**
   * Wallet private key for real EIP-3009 signing (simulationMode=false only).
   * If not provided and simulationMode=false, falls back to createRealX402Proof
   * which creates a structurally valid proof with a mock signature.
   * In production: load from process.env.PAYER_PRIVATE_KEY.
   */
  privateKey?: string;
}

export interface WorkflowInfo {
  name: string;
  description: string;
  priceUSDC: number;
  trigger: string;
  live: boolean;
  payment: {
    recipient: string;
    amount: number;
    currency: string;
    network: string;
    header: string;
  };
}

export interface WorkflowDiscoveryResult {
  workflows: WorkflowInfo[];
  count: number;
  simulationMode: boolean;
}

export interface AgentInvokeResult {
  success: boolean;
  result?: unknown;
  meta?: {
    requestId?: string;
    workflowName?: string;
    executionMs?: number;
    pricePaid?: number;
    paymentTx?: string;
  };
  error?: string;
  /** The base64-encoded payment proof that was sent */
  paymentUsed?: string;
}

export interface AgentTaskResult {
  success: boolean;
  taskId?: string;
  task?: string;
  result?: unknown;
  error?: string;
  paymentUsed?: string;
}

export interface BatchRequest {
  /** Workflow name to invoke */
  workflowName: string;
  /** Input payload for the workflow */
  payload: Record<string, unknown>;
}

export interface BatchItemResult {
  /** Workflow name */
  workflowName: string;
  /** Zero-based index in the original batch request array */
  index: number;
  /** Per-item status */
  status: "success" | "failed";
  /** Full invoke result (present on success) */
  result?: AgentInvokeResult;
  /** Error message (present on failure) */
  error?: string;
}

export interface BatchResult {
  /** Total number of requests submitted */
  totalRequested: number;
  /** Number of successful invocations */
  succeeded: number;
  /** Number of failed invocations */
  failed: number;
  /** Per-item results in the same order as the input batch */
  results: BatchItemResult[];
  /** Wall-clock time for the entire batch (ms) */
  totalExecutionMs: number;
}

export class AgentClient {
  private config: AgentClientConfig;
  private cachedWorkflows: WorkflowInfo[] | null = null;
  private walletSigner: WalletSigner | null = null;

  constructor(config: AgentClientConfig) {
    this.config = {
      simulationMode: true,
      network: "base-sepolia",
      ...config,
    };

    // Wire up real wallet signer for production mode
    if (!this.config.simulationMode) {
      const pk = this.config.privateKey ?? process.env.PAYER_PRIVATE_KEY;
      if (pk) {
        this.walletSigner = new WalletSigner({
          privateKey: pk,
          network: this.config.network,
        });
      }
    }
  }

  /**
   * Discover available workflows and their x402 pricing.
   * Caches results — subsequent calls use cached data unless cleared.
   */
  async discoverWorkflows(): Promise<WorkflowInfo[]> {
    const response = await fetch(`${this.config.gatewayUrl}/workflows`);
    if (!response.ok) {
      throw new Error(
        `Failed to discover workflows: ${response.status} ${response.statusText}`
      );
    }

    const data = (await response.json()) as WorkflowDiscoveryResult;
    this.cachedWorkflows = data.workflows;

    // Auto-set recipient from first workflow if not configured
    if (data.workflows.length > 0 && !this.config.recipientAddress) {
      this.config.recipientAddress = data.workflows[0].payment.recipient;
    }

    return data.workflows;
  }

  /**
   * Clear the cached workflow list (forces re-discovery on next invoke).
   */
  clearCache(): void {
    this.cachedWorkflows = null;
  }

  /**
   * Construct an x402 payment proof for a given recipient and amount.
   *
   * simulationMode=true:  creates a mock proof (structurally valid, no real crypto)
   * simulationMode=false + PAYER_PRIVATE_KEY set: creates a real EIP-3009 proof
   *   with a cryptographic EIP-712 signature (via WalletSigner)
   * simulationMode=false + no key: structurally valid proof with mock signature
   */
  async constructPaymentProofAsync(recipient: string, amountUSDC: number): Promise<string> {
    if (this.config.simulationMode) {
      return createMockPaymentProof(this.config.payerAddress, recipient, amountUSDC);
    }

    // Production: real EIP-3009 signing with wallet private key
    if (this.walletSigner) {
      return this.walletSigner.createPaymentProof({
        recipient,
        amountUSDC,
        network: this.config.network,
      });
    }

    // Fallback: structurally valid proof with mock signature (for demos without a key)
    return createRealX402Proof(
      this.config.payerAddress,
      recipient,
      amountUSDC,
      this.config.network ?? "base-sepolia"
    );
  }

  /**
   * Synchronous version of constructPaymentProof.
   * Always uses mock proof (simulation mode or mock fallback).
   * For real signing, use constructPaymentProofAsync().
   *
   * @deprecated Use constructPaymentProofAsync() for real payment proofs.
   */
  constructPaymentProof(recipient: string, amountUSDC: number): string {
    if (this.config.simulationMode) {
      return createMockPaymentProof(this.config.payerAddress, recipient, amountUSDC);
    }

    // Fallback to mock real proof (no private key available synchronously)
    return createRealX402Proof(
      this.config.payerAddress,
      recipient,
      amountUSDC,
      this.config.network ?? "base-sepolia"
    );
  }

  /**
   * Invoke a CRE workflow with automatic x402 payment.
   *
   * Automatically:
   *   1. Discovers workflows (if not cached) to get pricing
   *   2. Constructs the payment proof for the workflow's price
   *   3. Sends POST /invoke/:workflow with x-payment header
   *   4. Returns parsed result
   */
  async invoke(workflowName: string, payload: Record<string, unknown>): Promise<AgentInvokeResult> {
    if (!this.cachedWorkflows) {
      await this.discoverWorkflows();
    }

    const workflow = this.cachedWorkflows?.find((w) => w.name === workflowName);
    const priceUSDC = workflow?.priceUSDC ?? 0.001;
    const recipient =
      workflow?.payment.recipient ??
      this.config.recipientAddress ??
      "";

    if (!recipient) {
      throw new Error(
        "No recipient address available. Call discoverWorkflows() first or set recipientAddress in config."
      );
    }

    const paymentProof = await this.constructPaymentProofAsync(recipient, priceUSDC);

    const response = await fetch(`${this.config.gatewayUrl}/invoke/${workflowName}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-payment": paymentProof,
      },
      body: JSON.stringify(payload),
    });

    const data = (await response.json()) as Record<string, unknown>;

    if (!response.ok) {
      return {
        success: false,
        error: String(
          (data as Record<string, unknown>).message ??
          (data as Record<string, unknown>).error ??
          `HTTP ${response.status}`
        ),
        paymentUsed: paymentProof,
      };
    }

    return {
      success: true,
      result: data.result,
      meta: data.meta as AgentInvokeResult["meta"],
      paymentUsed: paymentProof,
    };
  }

  /**
   * Submit a high-level agent task to the orchestration endpoint.
   * The gateway auto-routes the task to the appropriate CRE workflow.
   *
   * Uses the "agent-task-dispatch" workflow pricing if available.
   */
  async submitTask(
    task: string,
    params?: Record<string, unknown>
  ): Promise<AgentTaskResult> {
    if (!this.cachedWorkflows) {
      await this.discoverWorkflows();
    }

    const dispatchWorkflow = this.cachedWorkflows?.find(
      (w) => w.name === "agent-task-dispatch"
    );
    const priceUSDC = dispatchWorkflow?.priceUSDC ?? 0.01;
    const recipient =
      dispatchWorkflow?.payment.recipient ??
      this.config.recipientAddress ??
      "";

    if (!recipient) {
      throw new Error("No recipient address available.");
    }

    const paymentProof = await this.constructPaymentProofAsync(recipient, priceUSDC);

    const response = await fetch(`${this.config.gatewayUrl}/agent/task`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-payment": paymentProof,
      },
      body: JSON.stringify({ task, params }),
    });

    const data = (await response.json()) as Record<string, unknown>;

    if (!response.ok) {
      return {
        success: false,
        error: String(
          data.message ?? data.error ?? `HTTP ${response.status}`
        ),
        paymentUsed: paymentProof,
      };
    }

    return {
      success: true,
      taskId: data.taskId as string | undefined,
      task: data.task as string | undefined,
      result: data.result,
      paymentUsed: paymentProof,
    };
  }

  /** Agent's wallet address */
  get payerAddress(): string {
    return this.config.payerAddress;
  }

  /** Whether this client is in simulation mode */
  get isSimulationMode(): boolean {
    return this.config.simulationMode ?? true;
  }

  /** Configured network */
  get network(): string {
    return this.config.network ?? "base-sepolia";
  }

  /** Cached workflow list (null if not yet discovered) */
  get workflows(): WorkflowInfo[] | null {
    return this.cachedWorkflows;
  }

  /** Whether this client has a real wallet signer (can create true EIP-712 proofs) */
  get hasRealSigner(): boolean {
    return this.walletSigner !== null;
  }

  /**
   * The wallet signer address (if real signing is enabled).
   * Falls back to payerAddress if no signer is configured.
   */
  get signerAddress(): string {
    return this.walletSigner?.address ?? this.config.payerAddress;
  }

  /**
   * Send parallel workflow invocations with individual x402 proofs.
   * All requests are dispatched concurrently; results are collected in order.
   *
   * @param batch - Array of { workflowName, payload } requests
   * @returns     BatchResult with per-item status and aggregate counts
   *
   * @example
   * const batch = await agent.batchInvoke([
   *   { workflowName: 'price-feed', payload: { pair: 'ETH/USD' } },
   *   { workflowName: 'price-feed', payload: { pair: 'BTC/USD' } },
   *   { workflowName: 'weather-oracle', payload: { location: 'Denver, CO' } },
   * ]);
   * // batch.succeeded === 3, batch.results[0].status === 'success'
   */
  async batchInvoke(batch: BatchRequest[]): Promise<BatchResult> {
    const batchStart = Date.now();

    const settled = await Promise.allSettled(
      batch.map(({ workflowName, payload }) => this.invoke(workflowName, payload))
    );

    const results: BatchItemResult[] = settled.map((outcome, index) => {
      const workflowName = batch[index].workflowName;

      if (outcome.status === "fulfilled") {
        const invokeResult = outcome.value;
        if (invokeResult.success) {
          return {
            workflowName,
            index,
            status: "success" as const,
            result: invokeResult,
          };
        }
        return {
          workflowName,
          index,
          status: "failed" as const,
          result: invokeResult,
          error: invokeResult.error ?? "Workflow returned failure",
        };
      }

      // Promise rejected (network error, etc.)
      return {
        workflowName,
        index,
        status: "failed" as const,
        error: (outcome.reason as Error)?.message ?? "Unknown error",
      };
    });

    const succeeded = results.filter((r) => r.status === "success").length;

    return {
      totalRequested: batch.length,
      succeeded,
      failed: batch.length - succeeded,
      results,
      totalExecutionMs: Date.now() - batchStart,
    };
  }
}
