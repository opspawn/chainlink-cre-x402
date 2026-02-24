/**
 * OpSpawn x CRE — Type Definitions
 *
 * This module defines the core types for the x402 payment-gated CRE workflow system.
 * Architecture:
 *   Agent → x402 Payment Gate → CRE Workflow Dispatch → Result
 */

export interface X402PaymentHeader {
  /** x402 payment proof (USDC on Base/Ethereum) */
  "x-payment": string;
  /** Amount in USDC micro-units (e.g. "1000" = $0.001) */
  "x-payment-amount"?: string;
  /** Recipient address (agent or service wallet) */
  "x-payment-recipient"?: string;
}

export interface WorkflowRequest {
  /** Unique request ID */
  requestId: string;
  /** CRE workflow name to invoke */
  workflowName: string;
  /** Input payload for the workflow */
  payload: Record<string, unknown>;
  /** x402 payment proof attached to the request */
  paymentProof?: string;
  /** Timestamp of request creation */
  createdAt: string;
}

export interface WorkflowResult {
  requestId: string;
  workflowName: string;
  status: "success" | "failed" | "pending";
  result?: unknown;
  error?: string;
  /** Execution time in ms */
  executionMs?: number;
  /** Block number of the payment settlement (if applicable) */
  paymentBlock?: number;
}

export interface X402PaymentVerification {
  valid: boolean;
  amount: bigint;
  recipient: string;
  payer: string;
  txHash?: string;
  error?: string;
}

export interface CREWorkflowDefinition {
  name: string;
  description: string;
  /** Price per invocation in USDC (e.g. 0.001 = $0.001) */
  priceUSDC: number;
  /** CRE trigger type */
  trigger: "http" | "cron" | "evm-log";
  /** Whether this workflow is live (deployed to CRE mainnet) */
  live: boolean;
  /** If not live, handler is called directly (simulation mode) */
  handler: (payload: Record<string, unknown>) => Promise<unknown>;
}

export interface AgentTaskRequest {
  /** Task description */
  task: string;
  /** Parameters for the task */
  params?: Record<string, unknown>;
  /** Maximum USDC to spend on this task */
  maxBudgetUSDC?: number;
}

export interface AgentOrchestrationResult {
  taskId: string;
  task: string;
  /** Workflows invoked to complete the task */
  workflowsInvoked: string[];
  /** Total USDC spent */
  totalSpentUSDC: number;
  /** Final result combining all workflow outputs */
  result: unknown;
  /** Was the x402 payment gate used? */
  paymentGated: boolean;
}
