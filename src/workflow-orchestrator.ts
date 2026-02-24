/**
 * OpSpawn x CRE — Multi-Workflow Orchestrator
 *
 * Chains multiple CRE workflows together in a sequential pipeline.
 * Each step pays via x402 and its output is passed as input to the next step.
 *
 * Architecture:
 *   Agent → orchestrate(['price-feed', 'risk-assessment', 'portfolio-rebalance'])
 *     Step 1: invoke('price-feed', initialPayload)   → price data
 *     Step 2: invoke('risk-assessment', price data)   → risk score
 *     Step 3: invoke('portfolio-rebalance', risk data) → rebalance plan
 *
 * Features:
 *   - Automatic x402 payment per step via AgentClient
 *   - Payload chaining: step N output becomes step N+1 input
 *   - Partial failure handling (continueOnFailure option)
 *   - Full execution audit trail per step
 *   - Parallel batch execution via batchOrchestrate()
 */

import { v4 as uuidv4 } from "uuid";
import type { AgentClient, AgentInvokeResult } from "./agent-client.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface OrchestrationStep {
  /** Name of the CRE workflow to invoke */
  workflowName: string;
  /** Optional fixed payload override for this step (bypasses chaining) */
  payload?: Record<string, unknown>;
}

export type WorkflowChain = (string | OrchestrationStep)[];

export interface OrchestrationConfig {
  /**
   * Continue executing remaining steps even if a step fails.
   * If false (default), the chain stops at the first failure.
   */
  continueOnFailure?: boolean;
  /**
   * Initial payload for the first step.
   * Subsequent steps receive the previous step's result as payload.
   */
  initialPayload?: Record<string, unknown>;
  /**
   * Optional transform function that converts step N's raw result into
   * the payload for step N+1. Defaults to wrapping result in { previousResult }.
   */
  payloadTransformer?: (
    stepResult: unknown,
    nextWorkflow: string,
    stepIndex: number
  ) => Record<string, unknown>;
}

export interface StepResult {
  /** Workflow name for this step */
  workflowName: string;
  /** Zero-based step index */
  stepIndex: number;
  /** Execution status */
  status: "success" | "failed" | "skipped";
  /** Workflow output on success */
  result?: unknown;
  /** Error message on failure */
  error?: string;
  /** The x402 payment proof used */
  paymentProof?: string;
  /** Step execution time in ms */
  executionMs?: number;
  /** USDC spent on this step */
  spentUSDC?: number;
}

export interface OrchestrationResult {
  /** Unique orchestration run ID */
  orchestrationId: string;
  /** Ordered list of workflow names in the chain */
  workflowChain: string[];
  /** Per-step execution results */
  steps: StepResult[];
  /**
   * The result from the final successful step.
   * null if all steps failed.
   */
  finalResult?: unknown;
  /** Total USDC spent across all steps */
  totalSpentUSDC: number;
  /** Number of steps that completed (success or failed, not skipped) */
  stepsCompleted: number;
  /**
   * Overall orchestration status:
   *   completed — all steps succeeded
   *   partial   — some steps failed but others succeeded (continueOnFailure=true)
   *   failed    — all executed steps failed or chain stopped at first failure
   */
  status: "completed" | "partial" | "failed";
  /** ISO timestamp when orchestration started */
  startedAt: string;
  /** ISO timestamp when orchestration completed */
  completedAt: string;
}

// ─── Helper ──────────────────────────────────────────────────────────────────

/**
 * Normalize a WorkflowChain (string[] | OrchestrationStep[]) to OrchestrationStep[].
 */
function normalizeChain(chain: WorkflowChain): OrchestrationStep[] {
  return chain.map((item) =>
    typeof item === "string" ? { workflowName: item } : item
  );
}

/**
 * Default payload transformer: wraps previous step's result in { previousResult, ... }.
 * If the result is an object, its keys are spread directly alongside previousResult.
 */
function defaultTransformer(
  stepResult: unknown,
  _nextWorkflow: string,
  _stepIndex: number
): Record<string, unknown> {
  if (stepResult !== null && typeof stepResult === "object" && !Array.isArray(stepResult)) {
    return {
      ...(stepResult as Record<string, unknown>),
      previousResult: stepResult,
    };
  }
  return { previousResult: stepResult };
}

// ─── WorkflowOrchestrator ────────────────────────────────────────────────────

export class WorkflowOrchestrator {
  private client: AgentClient;

  constructor(client: AgentClient) {
    this.client = client;
  }

  /**
   * Execute a chain of CRE workflows sequentially.
   *
   * Each step pays via x402 using the AgentClient, and passes its output
   * as the payload for the next step.
   *
   * @param workflowChain - Ordered list of workflow names (or OrchestrationStep objects)
   * @param config        - Optional orchestration configuration
   * @returns             OrchestrationResult with per-step audit trail
   *
   * @example
   * const orchestrator = new WorkflowOrchestrator(agentClient);
   * const result = await orchestrator.orchestrate(
   *   ['price-feed', 'risk-assessment', 'portfolio-rebalance'],
   *   { initialPayload: { pair: 'ETH/USD', riskTolerance: 'medium' } }
   * );
   */
  async orchestrate(
    workflowChain: WorkflowChain,
    config: OrchestrationConfig = {}
  ): Promise<OrchestrationResult> {
    const orchestrationId = uuidv4();
    const startedAt = new Date().toISOString();
    const steps = normalizeChain(workflowChain);
    const workflowNames = steps.map((s) => s.workflowName);

    const continueOnFailure = config.continueOnFailure ?? false;
    const transformer = config.payloadTransformer ?? defaultTransformer;

    const stepResults: StepResult[] = [];
    let currentPayload: Record<string, unknown> = config.initialPayload ?? {};
    let totalSpentUSDC = 0;
    let lastSuccessResult: unknown = undefined;
    let hasFailure = false;

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const stepStart = Date.now();

      // If chain stopped due to failure and continueOnFailure=false, mark as skipped
      if (hasFailure && !continueOnFailure) {
        stepResults.push({
          workflowName: step.workflowName,
          stepIndex: i,
          status: "skipped",
        });
        continue;
      }

      // Use step-level payload override if provided, otherwise use chained payload
      const stepPayload = step.payload ?? currentPayload;

      let invokeResult: AgentInvokeResult;
      try {
        invokeResult = await this.client.invoke(step.workflowName, stepPayload);
      } catch (err) {
        // Network-level error
        hasFailure = true;
        stepResults.push({
          workflowName: step.workflowName,
          stepIndex: i,
          status: "failed",
          error: (err as Error).message,
          executionMs: Date.now() - stepStart,
        });
        continue;
      }

      const executionMs = Date.now() - stepStart;

      if (!invokeResult.success) {
        hasFailure = true;
        stepResults.push({
          workflowName: step.workflowName,
          stepIndex: i,
          status: "failed",
          error: invokeResult.error ?? "Workflow invocation failed",
          paymentProof: invokeResult.paymentUsed,
          executionMs,
        });
        continue;
      }

      // Step succeeded — extract USDC spent from meta
      const pricePaid = (invokeResult.meta?.pricePaid as number | undefined) ?? 0;
      totalSpentUSDC += pricePaid;
      lastSuccessResult = invokeResult.result;

      stepResults.push({
        workflowName: step.workflowName,
        stepIndex: i,
        status: "success",
        result: invokeResult.result,
        paymentProof: invokeResult.paymentUsed,
        executionMs,
        spentUSDC: pricePaid,
      });

      // Prepare payload for next step (unless it's the last step)
      if (i < steps.length - 1) {
        try {
          currentPayload = transformer(invokeResult.result, steps[i + 1].workflowName, i);
        } catch (transformErr) {
          // Transformer threw — fail gracefully
          hasFailure = true;
          stepResults[stepResults.length - 1] = {
            ...stepResults[stepResults.length - 1],
            status: "failed",
            error: `Payload transformer error: ${(transformErr as Error).message}`,
          };
        }
      }
    }

    // Compute final status
    const successCount = stepResults.filter((s) => s.status === "success").length;
    const failedCount = stepResults.filter((s) => s.status === "failed").length;

    let status: OrchestrationResult["status"];
    if (failedCount === 0) {
      status = "completed";
    } else if (continueOnFailure && successCount > 0) {
      // "partial" only when we explicitly chose to continue through failures
      // and at least some steps succeeded
      status = "partial";
    } else {
      status = "failed";
    }

    const completedAt = new Date().toISOString();

    return {
      orchestrationId,
      workflowChain: workflowNames,
      steps: stepResults,
      finalResult: lastSuccessResult,
      totalSpentUSDC,
      stepsCompleted: stepResults.filter((s) => s.status !== "skipped").length,
      status,
      startedAt,
      completedAt,
    };
  }

  /**
   * Execute multiple independent orchestration chains in parallel.
   * Each chain runs concurrently — useful for fan-out analysis patterns.
   *
   * @param chains - Array of workflow chains to run in parallel
   * @param config - Shared orchestration config applied to all chains
   * @returns      Array of OrchestrationResult, one per chain
   */
  async batchOrchestrate(
    chains: WorkflowChain[],
    config?: OrchestrationConfig
  ): Promise<OrchestrationResult[]> {
    return Promise.all(chains.map((chain) => this.orchestrate(chain, config)));
  }

  /**
   * Get a summary of an orchestration result: which steps passed/failed.
   */
  static summarize(result: OrchestrationResult): string {
    const { workflowChain, steps, status, totalSpentUSDC } = result;
    const lines = [
      `Orchestration ${result.orchestrationId.slice(0, 8)} — ${status.toUpperCase()}`,
      `Chain: ${workflowChain.join(" → ")}`,
      `Spent: $${totalSpentUSDC.toFixed(4)} USDC`,
      "",
      ...steps.map(
        (s) =>
          `  [${s.stepIndex + 1}] ${s.workflowName}: ${s.status.toUpperCase()}` +
          (s.error ? ` (${s.error})` : "")
      ),
    ];
    return lines.join("\n");
  }
}
