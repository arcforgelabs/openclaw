import { vi } from "vitest";
import { buildNodeInvokeRequest } from "../gateway/node-invoke-request.js";
import { coerceNodeInvokePayload } from "../node-host/invoke-payload.js";
import { withNodeHostPluginInvocation } from "../node-host/invoke-plugin-context.js";
import type { ComputerUseCapabilityDescriptor } from "./computer-use-contract.js";
import { registerComputerUseProvider } from "./computer-use-registration.js";
import type { OpenClawPluginNodeHostCommand } from "./types.node-host.js";
export const first = "123e4567-e89b-42d3-a456-426614174000";
export const second = "223e4567-e89b-42d3-a456-426614174000";
export const owner = {
  sessionKey: "agent:main:private-one",
  runId: "run-one",
  instanceId: "instance-one",
};
export const other = {
  sessionKey: "agent:main:private-two",
  runId: "run-two",
  instanceId: "instance-two",
};

export function fixture() {
  let generation = "generation-one";
  const close = vi.fn(async (_reason: string) => {});
  const snapshot = vi.fn(
    async (_params?: string | null, _signal?: AbortSignal) =>
      '{"format":"png","base64":"c2NyZWVu","displayFrameId":"frame-one"}',
  );
  const act = vi.fn(async () => '{"ok":true}');
  const openExecution = vi.fn(async () => ({ close, snapshot, act }));
  const commands = new Map<string, OpenClawPluginNodeHostCommand>();
  registerComputerUseProvider(
    {
      registerNodeHostCommand: (command) => {
        commands.set(command.command, command);
      },
    },
    {
      id: "fixture",
      label: "Fixture",
      isAvailable: () => true,
      capabilities: (): ComputerUseCapabilityDescriptor => ({
        contractVersion: 2,
        provider: { id: "fixture", label: "Fixture", generation },
        actions: ["screenshot", "type"],
        targets: ["screen"],
        deliveryModes: ["foreground"],
        observations: ["image"],
        features: { recording: false, agentCursor: false, multiDisplay: false },
      }),
      openExecution,
    },
  );
  const invoke = async (
    command: string,
    params: Record<string, unknown>,
    caller: object = owner,
    signal?: AbortSignal,
  ) => {
    const registered = commands.get(command);
    if (!registered) {
      throw new Error("Missing registered command");
    }
    const frame = coerceNodeInvokePayload(
      buildNodeInvokeRequest({
        id: "fixture-invoke",
        nodeId: "fixture-node",
        command,
        timeoutMs: 1000,
        params: { ...params, computerExecutionCaller: { recoveryOperator: false, ...caller } },
      }),
    );
    if (!frame) {
      throw new Error("Invalid fixture transport frame");
    }
    return JSON.parse(
      await withNodeHostPluginInvocation(
        {
          context: { sendNodeEvent: async () => {} },
          signal,
          computerExecutionV1: frame.computerExecutionV1,
        },
        async (context) => await registered.handle(frame.paramsJSON, undefined, context),
      ),
    );
  };
  return {
    close,
    snapshot,
    openExecution,
    invoke,
    commands,
    setGeneration: (value: string) => {
      generation = value;
    },
  };
}
