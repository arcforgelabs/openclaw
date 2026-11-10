import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { runWithComputerExecutionCleanup } from "../../gateway/computer-execution-cleanup.js";
import type { ComputerBinding } from "./computer-tool-bindings.js";
import {
  captureGatewayToolCallerAssertion,
  getGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
  withoutGatewayToolCallerIdentity,
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
  let boundOwnershipId: string | undefined;
  const acquiring = (request: { command: string; commandParams: Record<string, unknown> }) =>
    (request.command === "screen.snapshot" || request.command === "computer.act") &&
    request.commandParams.action !== "__close_execution";
  const bindInspectedAcquisition = async (liveCaller: boolean) => {
    const readOwnership = async () => {
      if (liveCaller) {
        assertCaller();
      }
      return await invoke({
        command: "computer.execution",
        commandParams: { action: "inspect", providerGeneration: generation },
      });
    };
    const ownership = liveCaller
      ? await readOwnership()
      : await withoutGatewayToolCallerIdentity(() =>
          withGatewayToolCallerIdentity(
            {
              ...caller,
              approvalSignals: (caller.approvalSignals ?? []).filter((signal) => !signal.aborted),
            },
            readOwnership,
          ),
        );
    const owner = typeof ownership === "string" ? JSON.parse(ownership) : ownership;
    if (liveCaller) {
      assertCaller();
    }
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
    bindGrant(owner.ownershipId);
    return true;
  };
  const bindGrant = (ownershipId: string) => {
    const grant = {
      nodeId,
      executionId,
      providerGeneration: generation,
      ownershipId,
      assertCurrent: assertCustody,
    };
    const requestClose = runWithGatewayToolCleanupContext(
      () =>
        runWithComputerExecutionCleanup(grant, () =>
          bindAgentToolGatewayRequest({ resolveGatewayContext: resolver }),
        ),
      resolver,
    );
    boundOwnershipId = ownershipId;
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
          idempotencyKey: `computer.close:${executionId}:${ownershipId}`,
        },
      });
      return response.payload;
    };
  };
  const ownershipStamp = (result: unknown) => {
    let parsed: unknown;
    try {
      parsed = typeof result === "string" ? (JSON.parse(result) as unknown) : result;
    } catch {
      return undefined;
    }
    const stamp = isRecord(parsed) ? parsed.computerExecutionOwnership : undefined;
    if (
      !isRecord(stamp) ||
      stamp.executionId !== executionId ||
      stamp.providerGeneration !== generation ||
      typeof stamp.ownershipId !== "string"
    ) {
      return undefined;
    }
    return stamp.ownershipId;
  };
  const withoutOwnershipStamp = (result: unknown) => {
    let parsed: unknown;
    let encoded = false;
    try {
      parsed = typeof result === "string" ? (JSON.parse(result) as unknown) : result;
      encoded = typeof result === "string";
    } catch {
      return result;
    }
    if (!isRecord(parsed) || !Object.hasOwn(parsed, "computerExecutionOwnership")) {
      return result;
    }
    const { computerExecutionOwnership: _stamp, ...payload } = parsed;
    return encoded ? JSON.stringify(payload) : payload;
  };
  return {
    ...binding,
    pairedConnection: node,
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
        if (acquiring(request)) {
          const stamped = ownershipStamp(result);
          if (stamped && stamped !== boundOwnershipId) {
            bindGrant(stamped);
          } else if (!stamped) {
            try {
              const bound = await bindInspectedAcquisition(true).catch(async (error: unknown) => {
                if (!(await bindInspectedAcquisition(false))) {
                  throw error;
                }
                return true;
              });
              if (!bound) {
                throw new Error("Computer cleanup could not bind its exact acquisition");
              }
            } catch (error) {
              const message = error instanceof Error ? error.message : "";
              const details = isRecord(error) && isRecord(error.details) ? error.details : undefined;
              const code = typeof details?.code === "string" ? details.code : "";
              if (
                code !== "PLUGIN_POLICY_MISSING" &&
                code !== "COMPUTER_OWNERSHIP_UNAVAILABLE" &&
                !message.includes("PLUGIN_POLICY_MISSING") &&
                !message.includes("COMPUTER_OWNERSHIP_UNAVAILABLE")
              ) {
                throw error;
              }
            }
          }
        }
        return withoutOwnershipStamp(result);
      } catch (error) {
        if (!close && acquiring(request)) {
          try {
            await bindInspectedAcquisition(true);
          } catch {
            try {
              await bindInspectedAcquisition(false);
            } catch {
              // A failed first command releases the seat in the node handler.
            }
          }
        }
        throw error;
      }
    },
  };
}
