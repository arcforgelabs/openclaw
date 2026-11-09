import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { ComputerBinding } from "./computer-tool-bindings.js";
import type {
  ComputerToolAction,
  ResolvedComputerTarget,
  ScreenshotCapture,
} from "./computer-tool-shared.js";
import type { GatewayCallOptions } from "./gateway.js";

// Run-local routing policy only. Provider ownership stays in the existing node registry.
export type AgentSeatSelection = {
  candidates: readonly string[];
  locked: boolean;
  failure?: { cause: unknown };
};
type SelectionRequest = {
  action: ComputerToolAction;
  input: Record<string, unknown>;
  gatewayOpts: GatewayCallOptions;
  signal?: AbortSignal;
};

export async function resolveAgentSeatTarget(
  selection: AgentSeatSelection,
  params: SelectionRequest,
  operations: {
    selected(): ComputerBinding | undefined;
    resolve(request: SelectionRequest): Promise<ResolvedComputerTarget>;
    capture(
      target: ResolvedComputerTarget,
      width: number,
      signal?: AbortSignal,
    ): Promise<ScreenshotCapture>;
    forgetBusy(): void;
    referenceWidth: number;
  },
): Promise<ResolvedComputerTarget> {
  if (selection.failure !== undefined) {
    throw selection.failure.cause;
  }
  const selected = operations.selected();
  if (
    params.input.environmentId !== undefined ||
    (params.input.target !== undefined && params.input.target !== "node") ||
    params.gatewayOpts.gatewayUrl !== undefined ||
    params.gatewayOpts.gatewayToken !== undefined ||
    (params.input.node !== undefined &&
      (!selection.locked ||
        selected?.host.host !== "node" ||
        params.input.node !== selected.host.nodeId))
  ) {
    throw new Error(
      "computer: this run is bound to its approved agent seats; target overrides are unavailable",
    );
  }
  if (selection.locked) {
    return await operations.resolve({
      ...params,
      input: { ...params.input, node: undefined, target: undefined },
    });
  }
  if (params.action !== "screenshot") {
    throw new Error(
      "computer: take a screenshot to acquire an eligible agent seat before any input",
    );
  }
  for (const nodeId of selection.candidates) {
    try {
      const resolved = await operations.resolve({
        ...params,
        input: { ...params.input, target: "node", node: nodeId },
      });
      if (resolved.target.host !== "node" || resolved.target.nodeId !== nodeId) {
        throw new Error(
          "computer: approved agent seats must be exact node IDs, not display-name selectors",
        );
      }
      const capture = await operations.capture(resolved, operations.referenceWidth, params.signal);
      selection.locked = true;
      return { ...resolved, initialCapture: capture };
    } catch (error) {
      const details =
        error instanceof Error && error.name === "GatewayClientRequestError"
          ? (error as Error & { details?: unknown }).details
          : undefined;
      const nodeError = isRecord(details) ? details.nodeError : undefined;
      const busy =
        isRecord(nodeError) &&
        (nodeError.code === "COMPUTER_HOST_BUSY" ||
          (nodeError.code === "INVALID_REQUEST" &&
            typeof nodeError.message === "string" &&
            /^(?:Error: )?COMPUTER_HOST_BUSY:/.test(nodeError.message)));
      if (!busy) {
        selection.failure = { cause: error };
        throw error;
      }
      // A definitive refusal acquired nothing. Never retry input or ambiguous failures.
      operations.forgetBusy();
    }
  }
  throw new Error("COMPUTER_HOST_BUSY: all approved agent seats are busy");
}

/** Pin the observed provider identity without changing legacy explicit bindings. */
export function guardAgentSeatBinding(binding: ComputerBinding): ComputerBinding {
  const generation = binding.capabilities?.provider.generation;
  if (binding.host.host !== "node" || !binding.executionOwnership || !generation) {
    throw new Error("computer: approved agent seat does not support guarded execution ownership");
  }
  const invoke = binding.invoke;
  return {
    ...binding,
    invoke: async (request) =>
      await invoke({
        ...request,
        commandParams: { ...request.commandParams, providerGeneration: generation },
      }),
  };
}
