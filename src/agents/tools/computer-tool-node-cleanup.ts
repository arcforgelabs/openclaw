import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { runWithComputerExecutionCleanup } from "../../gateway/computer-execution-cleanup.js";
import type { ComputerBinding } from "./computer-tool-bindings.js";
import {
  captureGatewayToolCallerAssertion,
  getGatewayToolCallerIdentity,
} from "./gateway-caller-context.js";
import { shouldUseInProcessGatewayTool } from "./gateway.js";
import {
  bindAgentToolGatewayRequest,
  getInProcessGatewayToolContext,
  runWithGatewayToolCleanupContext,
} from "./in-process-gateway.js";

/** Transfer only this acquired close to live Gateway custody, not the finished run identity. */
export function bindPairedComputerCleanup(
  binding: ComputerBinding,
  executionId: string,
): ComputerBinding {
  const caller = getGatewayToolCallerIdentity();
  const assertCaller = captureGatewayToolCallerAssertion();
  const context = getInProcessGatewayToolContext(caller?.gatewayContextResolver);
  if (
    !binding.executionOwnership ||
    binding.host.host !== "node" ||
    !caller?.operationalRunInstance ||
    !assertCaller ||
    !context ||
    !shouldUseInProcessGatewayTool(binding.gatewayOpts)
  ) {
    return binding;
  }
  const nodeId = binding.host.nodeId;
  const generation = binding.capabilities?.provider.generation;
  const node = context.nodeRegistry.get(nodeId);
  if (!node || !generation) {
    throw new Error("Computer cleanup requires a current paired provider");
  }
  const resolver = caller.gatewayContextResolver;
  const assertCustody = () => {
    if (
      getInProcessGatewayToolContext(resolver) !== context ||
      context.nodeRegistry.get(nodeId) !== node
    ) {
      throw new Error("Computer cleanup Gateway or paired connection changed");
    }
  };
  const invoke = binding.invoke;
  let close: ((reason: string) => Promise<unknown>) | undefined;
  const acquiring = (request: { command: string; commandParams: Record<string, unknown> }) =>
    (request.command === "screen.snapshot" || request.command === "computer.act") &&
    request.commandParams.action !== "__close_execution";
  const bindInspectedAcquisition = async () => {
    assertCaller();
    const inspected = await invoke({
      command: "computer.execution",
      commandParams: { action: "inspect", providerGeneration: generation },
    });
    const owner = typeof inspected === "string" ? JSON.parse(inspected) : inspected;
    assertCaller();
    assertCustody();
    const acquiredOwner = isRecord(owner) && isRecord(owner.owner) ? owner.owner : undefined;
    if (
      !isRecord(owner) ||
      owner.state !== "owned" ||
      owner.executionId !== executionId ||
      owner.providerGeneration !== generation ||
      typeof owner.ownershipId !== "string" ||
      acquiredOwner?.instanceId !== caller.operationalRunInstance?.instanceId ||
      acquiredOwner?.runId !== caller.operationalRunInstance?.runId ||
      acquiredOwner?.sessionKey !== caller.sessionKey
    ) {
      return false;
    }
    const grant = {
      nodeId,
      executionId,
      providerGeneration: generation,
      ownershipId: owner.ownershipId,
      assertCurrent: assertCustody,
    };
    // Bind inside the cleanup-only scope: the request helper snapshots its ALS custody.
    const requestClose = runWithGatewayToolCleanupContext(
      () =>
        runWithComputerExecutionCleanup(grant, () =>
          bindAgentToolGatewayRequest({ resolveGatewayContext: resolver }),
        ),
      resolver,
    );
    close = async (reason) => {
      assertCustody();
      const response = await requestClose<{ payload: unknown }>({
        method: "node.invoke",
        assertDispatchCurrent: assertCustody,
        params: {
          nodeId,
          command: "computer.act",
          params: {
            action: "__close_execution",
            executionId,
            providerGeneration: generation,
            reason,
          },
          idempotencyKey: `computer.close:${executionId}:${owner.ownershipId}`,
        },
      });
      return response.payload;
    };
    return true;
  };
  return {
    ...binding,
    invoke: async (request) => {
      if (
        request.command === "computer.act" &&
        request.commandParams.action === "__close_execution" &&
        close
      ) {
        return await close(
          typeof request.commandParams.reason === "string"
            ? request.commandParams.reason
            : "completion",
        );
      }
      try {
        const result = await invoke(request);
        if (!close && acquiring(request) && !(await bindInspectedAcquisition())) {
          throw new Error("Computer cleanup could not bind its exact acquisition");
        }
        return result;
      } catch (error) {
        const aborted =
          request.signal?.aborted === true ||
          (error instanceof Error && error.name === "AbortError");
        if (!close && aborted && acquiring(request)) {
          await bindInspectedAcquisition();
        }
        throw error;
      }
    },
  };
}
