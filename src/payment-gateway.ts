/**
 * x402 Payment Gateway for CRE Workflows
 *
 * This is the core integration: x402 micropayment verification → CRE workflow execution.
 *
 * Flow:
 *   1. Agent sends WorkflowRequest with x-payment header (x402 proof)
 *   2. Gateway verifies payment against configured recipient + amount
 *   3. On success: dispatches to CRE workflow registry
 *   4. Returns WorkflowResult with execution data
 *
 * In production (when CRE account is registered):
 *   - Replace simulation handlers with actual @chainlink/cre-sdk calls
 *   - cre.handler(http.trigger({...}), async (runtime, payload) => { ... })
 *   - Deploy via: cre workflow deploy ./workflows/my-workflow
 */

import { v4 as uuidv4 } from "uuid";
import { CREWorkflowRegistry } from "./cre-registry.js";
import { X402Verifier } from "./x402-verifier.js";
import {
  WorkflowRequest,
  WorkflowResult,
  AgentTaskRequest,
  AgentOrchestrationResult,
  X402PaymentVerification,
} from "./types.js";

export interface PaymentGatewayConfig {
  /** Wallet address that receives x402 payments */
  recipientAddress: string;
  /** Default price per workflow invocation (USDC) */
  defaultPriceUSDC?: number;
  /** Enable simulation mode (no real blockchain verification) */
  simulationMode?: boolean;
  /** Verbose logging */
  debug?: boolean;
}

export interface GatewayInvokeResult {
  allowed: boolean;
  payment: X402PaymentVerification;
  workflowResult?: WorkflowResult;
  pricePaid?: number;
  error?: string;
}

export class X402CREPaymentGateway {
  private registry: CREWorkflowRegistry;
  private config: PaymentGatewayConfig;
  private log: (msg: string) => void;

  constructor(config: PaymentGatewayConfig, registry?: CREWorkflowRegistry) {
    this.config = {
      defaultPriceUSDC: 0.001,
      simulationMode: true,
      ...config,
    };
    this.registry = registry ?? new CREWorkflowRegistry();
    this.log = config.debug ? (msg) => console.log(`[Gateway] ${msg}`) : () => {};
  }

  /**
   * Primary entry point: verify x402 payment and execute CRE workflow.
   */
  async invoke(
    workflowName: string,
    payload: Record<string, unknown>,
    paymentProof: string
  ): Promise<GatewayInvokeResult> {
    // 1. Get workflow to determine required price
    const workflow = this.registry.getWorkflow(workflowName);
    const requiredPrice = workflow?.priceUSDC ?? this.config.defaultPriceUSDC ?? 0.001;

    this.log(`Invoking ${workflowName} — required: $${requiredPrice} USDC`);

    // 2. Verify x402 payment
    const verifier = new X402Verifier({
      recipientAddress: this.config.recipientAddress,
      requiredAmountUSDC: requiredPrice,
      simulationMode: this.config.simulationMode,
    });

    const payment = await verifier.verify(paymentProof);
    this.log(`Payment verification: ${payment.valid ? "OK" : "FAILED"} — ${payment.error ?? ""}`);

    if (!payment.valid) {
      return {
        allowed: false,
        payment,
        error: payment.error ?? "Payment verification failed",
      };
    }

    // 3. Execute CRE workflow
    const request: WorkflowRequest = {
      requestId: uuidv4(),
      workflowName,
      payload,
      paymentProof,
      createdAt: new Date().toISOString(),
    };

    const workflowResult = await this.registry.execute(request);
    this.log(`Workflow result: ${workflowResult.status} in ${workflowResult.executionMs}ms`);

    return {
      allowed: true,
      payment,
      workflowResult,
      pricePaid: requiredPrice,
    };
  }

  /**
   * Orchestrate an agent task across multiple CRE workflows.
   * Selects the best workflow for the task, verifies payment, executes.
   */
  async orchestrateAgentTask(
    task: AgentTaskRequest,
    paymentProof: string
  ): Promise<AgentOrchestrationResult> {
    const taskId = uuidv4();
    const workflowsInvoked: string[] = [];
    let totalSpentUSDC = 0;
    let finalResult: unknown = null;

    // Simple task routing — in production, this could use semantic matching
    let workflowName = "agent-task-dispatch"; // Default
    if (task.task.toLowerCase().includes("price") || task.task.toLowerCase().includes("token")) {
      workflowName = "price-feed";
    } else if (task.task.toLowerCase().includes("weather")) {
      workflowName = "weather-oracle";
    } else if (task.task.toLowerCase().includes("compute") || task.task.toLowerCase().includes("calculate")) {
      workflowName = "compute-task";
    }

    const result = await this.invoke(workflowName, task.params ?? { task: task.task }, paymentProof);

    if (result.allowed && result.workflowResult) {
      workflowsInvoked.push(workflowName);
      totalSpentUSDC += result.pricePaid ?? 0;
      finalResult = result.workflowResult.result;
    } else {
      throw new Error(result.error ?? "Gateway denied request");
    }

    return {
      taskId,
      task: task.task,
      workflowsInvoked,
      totalSpentUSDC,
      result: finalResult,
      paymentGated: true,
    };
  }

  get workflowRegistry(): CREWorkflowRegistry {
    return this.registry;
  }

  get simulationMode(): boolean {
    return this.config.simulationMode ?? true;
  }
}
