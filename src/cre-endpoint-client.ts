/**
 * CRE Endpoint Client — Agent Discovery via CRE Registry
 *
 * Queries the Chainlink CRE registry to discover deployed workflow agents.
 * In production, this queries the live CRE gateway for registered workflows.
 * In simulation, it returns realistic mock data matching the CRE spec.
 *
 * CRE Registry spec:
 *   - Workflows are registered by DON ID + workflow ID
 *   - Each workflow has an HTTP trigger URL, x402 pricing, and capability flags
 *   - Agents discover available workflows and select by capability + price
 *
 * Reference: https://docs.chain.link/chainlink-automation/concepts/cre
 */

// ─── CRE Registry Types ───────────────────────────────────────────────────────

export interface CREWorkflowCapability {
  /** Capability type (e.g. "data-streams", "http", "compute") */
  type: string;
  /** Whether this capability is available (active on CRE network) */
  active: boolean;
  /** Additional metadata for this capability */
  meta?: Record<string, unknown>;
}

export interface CRERegisteredWorkflow {
  /** Unique workflow ID (DON-scoped) */
  workflowId: string;
  /** Human-readable workflow name */
  name: string;
  /** Workflow description */
  description: string;
  /** Owner address (deployed by this wallet) */
  owner: string;
  /** DON ID this workflow is registered with */
  donId: string;
  /** HTTP trigger URL (for x402-gated invocations) */
  triggerUrl: string;
  /** x402 payment requirements */
  payment: {
    priceUSDC: number;
    recipient: string;
    currency: "USDC";
    network: "base" | "base-sepolia";
  };
  /** Workflow capabilities */
  capabilities: CREWorkflowCapability[];
  /** Whether the workflow is currently active */
  active: boolean;
  /** Registration timestamp (ISO 8601) */
  registeredAt: string;
}

export interface CRERegistryResponse {
  workflows: CRERegisteredWorkflow[];
  donId: string;
  registryVersion: string;
  timestamp: string;
  mode: "live" | "simulation";
}

export interface CREEndpointClientConfig {
  /**
   * CRE registry endpoint URL.
   * Default: https://registry.cre.chain.link (live CRE)
   * Set to a local URL for self-hosted or mock registries.
   */
  registryUrl?: string;
  /** DON ID to query (default: "don-001" on testnet) */
  donId?: string;
  /** If true, returns realistic simulated data without HTTP calls */
  simulationMode?: boolean;
  /** Timeout for registry requests (ms, default: 5000) */
  timeoutMs?: number;
  /** Owner address filter (only show workflows owned by this address) */
  ownerFilter?: string;
}

// ─── Mock CRE Registry Data ───────────────────────────────────────────────────

const MOCK_CRE_REGISTRY_BASE: Pick<CRERegisteredWorkflow, "owner" | "donId" | "payment" | "active" | "registeredAt"> = {
  owner: "0x7483a9F237cf8043704D6b17DA31c12BfFF860DD",
  donId: "don-testnet-001",
  payment: {
    currency: "USDC",
    network: "base-sepolia",
    recipient: "0x7483a9F237cf8043704D6b17DA31c12BfFF860DD",
    priceUSDC: 0,
  },
  active: true,
  registeredAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(), // 2 days ago
};

export const MOCK_CRE_WORKFLOWS: CRERegisteredWorkflow[] = [
  {
    ...MOCK_CRE_REGISTRY_BASE,
    workflowId: "wf-price-feed-001",
    name: "price-feed",
    description: "Chainlink Data Streams price oracle — real-time verified token prices",
    triggerUrl: "http://localhost:3100/invoke/price-feed",
    payment: { ...MOCK_CRE_REGISTRY_BASE.payment, priceUSDC: 0.001 },
    capabilities: [
      { type: "data-streams", active: true, meta: { feeds: ["ETH/USD", "BTC/USD", "LINK/USD"] } },
      { type: "http-trigger", active: true },
      { type: "x402-payment", active: true },
    ],
  },
  {
    ...MOCK_CRE_REGISTRY_BASE,
    workflowId: "wf-agent-dispatch-001",
    name: "agent-task-dispatch",
    description: "AI agent task orchestration — routes tasks to specialized CRE workflows",
    triggerUrl: "http://localhost:3100/invoke/agent-task-dispatch",
    payment: { ...MOCK_CRE_REGISTRY_BASE.payment, priceUSDC: 0.01 },
    capabilities: [
      { type: "http-trigger", active: true },
      { type: "http-outbound", active: true, meta: { allowedDomains: ["*"] } },
      { type: "x402-payment", active: true },
    ],
  },
  {
    ...MOCK_CRE_REGISTRY_BASE,
    workflowId: "wf-weather-oracle-001",
    name: "weather-oracle",
    description: "Verified weather data for parametric insurance and prediction markets",
    triggerUrl: "http://localhost:3100/invoke/weather-oracle",
    payment: { ...MOCK_CRE_REGISTRY_BASE.payment, priceUSDC: 0.005 },
    capabilities: [
      { type: "http-trigger", active: true },
      { type: "http-outbound", active: true, meta: { allowedDomains: ["api.weather.gov", "api.openweathermap.org"] } },
      { type: "x402-payment", active: true },
    ],
  },
  {
    ...MOCK_CRE_REGISTRY_BASE,
    workflowId: "wf-compute-001",
    name: "compute-task",
    description: "Verifiable off-chain computation — scoring, ranking, ML inference results",
    triggerUrl: "http://localhost:3100/invoke/compute-task",
    payment: { ...MOCK_CRE_REGISTRY_BASE.payment, priceUSDC: 0.002 },
    capabilities: [
      { type: "http-trigger", active: true },
      { type: "compute", active: true, meta: { maxComputeMs: 5000 } },
      { type: "x402-payment", active: true },
    ],
  },
];

// ─── CRE Endpoint Client ──────────────────────────────────────────────────────

export class CREEndpointClient {
  private config: Required<CREEndpointClientConfig>;

  constructor(config: CREEndpointClientConfig = {}) {
    this.config = {
      registryUrl: config.registryUrl ?? "https://registry.cre.chain.link",
      donId: config.donId ?? "don-testnet-001",
      simulationMode: config.simulationMode ?? true,
      timeoutMs: config.timeoutMs ?? 5000,
      ownerFilter: config.ownerFilter ?? "",
    };
  }

  /**
   * Discover available CRE workflows from the registry.
   *
   * simulationMode=true: returns realistic mock workflows (no network call)
   * simulationMode=false: queries the live CRE registry endpoint
   *
   * Returns workflows filtered by ownerFilter if configured.
   */
  async discoverWorkflows(): Promise<CRERegistryResponse> {
    if (this.config.simulationMode) {
      return this.simulatedDiscovery();
    }

    return this.liveDiscovery();
  }

  /**
   * Find a specific workflow by name in the registry.
   */
  async findWorkflow(name: string): Promise<CRERegisteredWorkflow | null> {
    const registry = await this.discoverWorkflows();
    return registry.workflows.find((wf) => wf.name === name) ?? null;
  }

  /**
   * Find all workflows with a given capability.
   */
  async findByCapability(capabilityType: string): Promise<CRERegisteredWorkflow[]> {
    const registry = await this.discoverWorkflows();
    return registry.workflows.filter((wf) =>
      wf.capabilities.some((cap) => cap.type === capabilityType && cap.active)
    );
  }

  /**
   * Check if a specific workflow is registered and active.
   */
  async isWorkflowActive(name: string): Promise<boolean> {
    const workflow = await this.findWorkflow(name);
    return workflow?.active ?? false;
  }

  private simulatedDiscovery(): CRERegistryResponse {
    let workflows = [...MOCK_CRE_WORKFLOWS];

    if (this.config.ownerFilter) {
      workflows = workflows.filter(
        (wf) => wf.owner.toLowerCase() === this.config.ownerFilter.toLowerCase()
      );
    }

    return {
      workflows,
      donId: this.config.donId,
      registryVersion: "1.2.0",
      timestamp: new Date().toISOString(),
      mode: "simulation",
    };
  }

  private async liveDiscovery(): Promise<CRERegistryResponse> {
    const url = `${this.config.registryUrl}/v1/workflows?donId=${encodeURIComponent(this.config.donId)}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { "Accept": "application/json" },
      });

      if (!response.ok) {
        throw new Error(`CRE registry returned ${response.status}: ${response.statusText}`);
      }

      const data = await response.json() as CRERegistryResponse;
      return data;
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        throw new Error(`CRE registry request timed out after ${this.config.timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  get registryUrl(): string {
    return this.config.registryUrl;
  }

  get donId(): string {
    return this.config.donId;
  }

  get simulationMode(): boolean {
    return this.config.simulationMode;
  }
}
