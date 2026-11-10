import { describe, expect, it } from "vitest";
import { runWithComputerExecutionCleanup } from "./computer-execution-cleanup.js";
import { sanitizeNodeInvokeParamsForForwarding } from "./node-invoke-sanitize.js";
import type { GatewayClient } from "./server-methods/types.js";

describe.each(["system.run.prepare", "system.run"])("%s execution context", (command) => {
  const context = { senderId: "sender-1", chatId: "chat-1", subagent: true };
  const invoke = (executionContext: unknown, caps = ["system.run.execution-context.v1"]) =>
    sanitizeNodeInvokeParamsForForwarding({
      nodeId: "node-1",
      command,
      caps,
      client: null,
      rawParams: { command: ["echo", "ok"], executionContext },
    });

  it("preserves supported routing hints without changing argv", async () => {
    expect(await invoke(context)).toMatchObject({
      ok: true,
      params: { command: ["echo", "ok"], executionContext: context },
    });
  });

  it("refuses context when a node reconnects without the capability", async () => {
    expect(await invoke(context, [])).toMatchObject({ ok: false });
    expect(await invoke(undefined, [])).toMatchObject({ ok: true });
  });

  it.each([
    null,
    { senderId: 7 },
    { chatId: "" },
    { subagent: false },
    { env: { PATH: "/tmp" } },
    { sessionKey: "agent:main:main" },
  ])("rejects malformed or authority-bearing context %j", async (executionContext) => {
    expect(await invoke(executionContext)).toMatchObject({ ok: false });
  });
});

it("routing context cannot approve a command", async () => {
  expect(
    await sanitizeNodeInvokeParamsForForwarding({
      nodeId: "node-1",
      command: "system.run",
      caps: ["system.run.execution-context.v1"],
      client: null,
      rawParams: { command: ["echo", "ok"], executionContext: { subagent: true }, approved: true },
    }),
  ).toMatchObject({ ok: false, message: "approval override requires params.runId" });
});

it.each(["screen.snapshot", "computer.act"])(
  "%s never forwards caller-supplied owner or interruption authority",
  async (command) => {
    const result = await sanitizeNodeInvokeParamsForForwarding({
      nodeId: "node-1",
      command,
      declaredCommands: ["computer.execution"],
      client: null,
      rawParams: {
        action: "__recover_execution",
        executionId: "123e4567-e89b-42d3-a456-426614174000",
        computerExecutionCaller: {
          sessionKey: "agent:main:private",
          instanceId: "forged",
          recoveryOperator: true,
        },
        interrupt: true,
      },
    });
    expect(result).toMatchObject({
      ok: true,
      params: { computerExecutionCaller: { recoveryOperator: false } },
    });
    if (!result.ok) {
      throw new Error(result.message);
    }
    expect((result.params as Record<string, unknown>).computerExecutionCaller).toEqual({
      recoveryOperator: false,
    });
  },
);

it("binds acquisition metadata to the admitted run rather than execution IDs or supplied session hints", async () => {
  const operationalRunInstance = { runId: "admitted-run", instanceId: "admitted-instance" };
  const client = {
    connId: "fixture",
    connect: { scopes: ["operator.admin"] },
    internal: {
      syntheticClient: true,
      agentRuntimeIdentity: {
        kind: "agentRuntime",
        agentId: "main",
        sessionKey: "agent:main:admitted",
        operationalRunInstance,
        delegatedAuthority: {
          kind: "local",
          operationalRunInstance,
          lifecycleGeneration: "generation",
          claimId: "claim",
        },
      },
    },
  } as GatewayClient;
  expect(
    await sanitizeNodeInvokeParamsForForwarding({
      nodeId: "agent-seat",
      command: "screen.snapshot",
      declaredCommands: ["computer.execution"],
      client,
      rawParams: {
        executionId: "123e4567-e89b-42d3-a456-426614174000",
        computerExecutionCaller: {
          sessionKey: "agent:main:forged",
          runId: "forged",
          recoveryOperator: true,
        },
      },
    }),
  ).toEqual({
    ok: true,
    params: {
      executionId: "123e4567-e89b-42d3-a456-426614174000",
      computerExecutionCaller: {
        sessionKey: "agent:main:admitted",
        runId: "admitted-run",
        instanceId: "admitted-instance",
        recoveryOperator: false,
      },
    },
  });
});

it("preserves legacy native payloads without the ownership command declaration", async () => {
  const params = { executionId: "123e4567-e89b-42d3-a456-426614174000", screenIndex: 0 };
  expect(
    await sanitizeNodeInvokeParamsForForwarding({
      nodeId: "native-node",
      command: "screen.snapshot",
      client: null,
      rawParams: params,
    }),
  ).toEqual({ ok: true, params });
});

it.each([
  [
    { connId: "operator-one", connect: { scopes: ["operator.admin"] } },
    "connection:operator-one",
    true,
  ],
  [
    { internal: { syntheticClient: true, pluginRuntimeOwnerId: "fixture-plugin" } },
    "plugin:fixture-plugin",
    false,
  ],
] as const)(
  "retains a sessionless caller without fabricating session or run metadata",
  async (client, callerId, recoveryOperator) => {
    const result = await sanitizeNodeInvokeParamsForForwarding({
      nodeId: "agent-seat",
      command: "computer.execution",
      client: client as GatewayClient,
      rawParams: { action: "inspect" },
    });
    expect(result).toEqual({
      ok: true,
      params: { action: "inspect", computerExecutionCaller: { callerId, recoveryOperator } },
    });
  },
);

it("retains authenticated device ownership across fresh operator CLI connections without conflating devices", async () => {
  const inspect = async (connId: string, id: string) =>
    await sanitizeNodeInvokeParamsForForwarding({
      nodeId: "seat",
      command: "computer.execution",
      rawParams: { action: "inspect" },
      client: { connId, connect: { device: { id }, scopes: ["operator.admin"] } } as GatewayClient,
    });
  const first = await inspect("cli-one", "verified-device-one");
  const second = await inspect("cli-two", "verified-device-one");
  const other = await inspect("cli-three", "verified-device-two");
  expect(first).toMatchObject({
    ok: true,
    params: { computerExecutionCaller: { callerId: "device:verified-device-one" } },
  });
  expect(second).toEqual(first);
  expect(other).toMatchObject({
    ok: true,
    params: { computerExecutionCaller: { callerId: "device:verified-device-two" } },
  });
});

it("mints cleanup provenance only from exact live host custody, never model params", async () => {
  let current = true;
  const target = {
    nodeId: "node-cleanup",
    executionId: "execution-cleanup",
    providerGeneration: "generation",
    ownershipId: "acquisition",
  };
  const grant = {
    ...target,
    assertCurrent: () => {
      if (!current) {
        throw new Error("custody closed");
      }
    },
  };
  const request = {
    nodeId: target.nodeId,
    command: "computer.act",
    declaredCommands: ["computer.execution"],
    client: null,
    rawParams: {
      action: "__close_execution",
      executionId: target.executionId,
      providerGeneration: target.providerGeneration,
      computerExecutionCaller: { cleanup: target, recoveryOperator: true },
    },
  };
  const ordinary = await sanitizeNodeInvokeParamsForForwarding(request);
  expect(ordinary).not.toHaveProperty("params.computerExecutionCaller.cleanup");
  const cleanup = await runWithComputerExecutionCleanup(grant, () =>
    sanitizeNodeInvokeParamsForForwarding(request),
  );
  expect(cleanup).toMatchObject({
    ok: true,
    params: {
      computerExecutionCaller: {
        recoveryOperator: false,
        cleanup: {
          executionId: target.executionId,
          providerGeneration: target.providerGeneration,
          ownershipId: target.ownershipId,
        },
      },
    },
  });
  await expect(
    runWithComputerExecutionCleanup(grant, () =>
      sanitizeNodeInvokeParamsForForwarding({
        ...request,
        rawParams: { action: "type", text: "not allowed" },
      }),
    ),
  ).rejects.toThrow("cannot dispatch another operation");
  await expect(
    runWithComputerExecutionCleanup(grant, () =>
      sanitizeNodeInvokeParamsForForwarding({ ...request, nodeId: "other-node" }),
    ),
  ).rejects.toThrow("cannot dispatch another operation");
  await expect(
    runWithComputerExecutionCleanup(grant, async () => {
      current = false;
      return await sanitizeNodeInvokeParamsForForwarding(request);
    }),
  ).rejects.toThrow("custody closed");
});
