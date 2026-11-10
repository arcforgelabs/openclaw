import { expect, it, vi } from "vitest";
import { createNodeSession } from "../../gateway/node-invoke-plugin-policy.test-helpers.js";
import { buildNodeInvokeRequest } from "../../gateway/node-invoke-request.js";
import { sanitizeNodeInvokeParamsForForwarding } from "../../gateway/node-invoke-sanitize.js";
import { NodeRegistry } from "../../gateway/node-registry.js";
import {
  createContext,
  createOperatorClient,
} from "../../gateway/server-plugin-in-process-dispatch.test-support.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
  validateAgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import { coerceNodeInvokePayload } from "../../node-host/invoke-payload.js";
import { withNodeHostPluginInvocation } from "../../node-host/invoke-plugin-context.js";
import { fixture } from "../../plugins/computer-use-registration.test-helpers.js";
import { createOperationalRunInstanceRef } from "../admitted-run-context.js";
import {
  createComputerTool,
  callGatewayToolMock,
  listNodesMock,
  resetComputerToolMocks,
  v2Descriptor,
  TINY_PNG_BASE64,
} from "./computer-tool.test-helpers.js";
import {
  getGatewayToolCallerIdentity,
  wrapToolWithGatewayCallerIdentity,
} from "./gateway-caller-context.js";

const transport = vi.hoisted(() => ({ dispatch: vi.fn() }));
vi.mock("../../gateway/server-plugin-in-process-dispatch.js", async (original) => ({
  ...(await original<typeof import("../../gateway/server-plugin-in-process-dispatch.js")>()),
  dispatchGatewayMethodInProcess: transport.dispatch,
}));

it("transfers actual run-ended disposal through cleanup context without the original runtime owner", async () => {
  resetComputerToolMocks();
  const h = fixture();
  const run = createOperationalRunInstanceRef("paired-run-end");
  const authority = claimAgentRunDelegatedAuthority(run);
  const node = { ...createNodeSession(), nodeId: "paired-cleanup", connId: "connection-one" };
  // The RPC/node wire is an in-process fixture; the tool, close-handler, cleanup
  // snapshot, sanitizer and provider registry below are production owners.
  const context = createContext();
  context.nodeRegistry = new NodeRegistry();
  vi.spyOn(context.nodeRegistry, "get").mockReturnValue(node);
  const cleanupCallers: unknown[] = [];
  const dispatch = async (method: string, params: Record<string, unknown>, cleanup = false) => {
    expect(method).toBe("node.invoke");
    const caller = getGatewayToolCallerIdentity();
    if (cleanup) {
      cleanupCallers.push(caller);
    }
    const client = caller
      ? createOperatorClient({ profileId: "fixture", scopes: ["operator.write"] })
      : null;
    if (caller && client) {
      if (!caller.operationalRunInstance || !caller.approvalAuthority) {
        throw new Error("missing admitted caller");
      }
      client.internal = {
        syntheticClient: true,
        agentRuntimeIdentity: {
          kind: "agentRuntime",
          agentId: caller.agentId,
          sessionKey: caller.sessionKey,
          operationalRunInstance: caller.operationalRunInstance,
          delegatedAuthority: { ...caller.approvalAuthority, kind: "local" },
        },
      };
    }
    const sanitized = await sanitizeNodeInvokeParamsForForwarding({
      nodeId: node.nodeId,
      command: String(params.command),
      rawParams: params.params,
      client,
      declaredCommands: ["computer.execution"],
    });
    if (!sanitized.ok) {
      throw new Error(sanitized.message);
    }
    const frame = coerceNodeInvokePayload(
      buildNodeInvokeRequest({
        id: "wire",
        nodeId: node.nodeId,
        command: String(params.command),
        params: sanitized.params,
        timeoutMs: 1000,
      }),
    );
    if (!frame) {
      throw new Error("invalid wire");
    }
    const command = h.commands.get(frame.command);
    if (!command) {
      throw new Error("missing node command");
    }
    const payload = await withNodeHostPluginInvocation(
      {
        context: { sendNodeEvent: async () => {} },
        computerExecutionV1: frame.computerExecutionV1,
      },
      async (invocation) =>
        JSON.parse(await command.handle(frame.paramsJSON, undefined, invocation)),
    );
    return { payload };
  };
  callGatewayToolMock.mockImplementation(
    async (method, _options, params) => await dispatch(method, params),
  );
  transport.dispatch.mockImplementation(async (method, params, options) => {
    options.sessionMutationCommitGuard?.();
    return await dispatch(method, params, true);
  });
  listNodesMock.mockResolvedValue([
    {
      ...node,
      connected: true,
      commands: ["screen.snapshot", "computer.act", "computer.execution"],
      computerUse: v2Descriptor(["screenshot", "type"], {
        provider: { id: "fixture", label: "Fixture", generation: "generation-one" },
      }),
    },
  ]);
  h.snapshot.mockResolvedValue(
    JSON.stringify({
      format: "png",
      base64: TINY_PNG_BASE64,
      displayFrameId: "native-frame",
      width: 1,
      height: 1,
    }),
  );
  const tool = wrapToolWithGatewayCallerIdentity(
    createComputerTool({ computerExecutionId: run.instanceId }),
    {
      agentId: "main",
      sessionKey: "agent:main:run-ended",
      operationalRunInstance: run,
      approvalAuthority: authority,
      gatewayContextResolver: () => context,
      receiptAuthority: () => validateAgentRunDelegatedAuthority(authority),
    },
  );
  try {
    await tool.execute("observe", { action: "screenshot", target: "node", node: node.nodeId });
    releaseAgentRunDelegatedAuthority(authority);
    await vi.waitFor(() => expect(h.close).toHaveBeenCalledExactlyOnceWith("run-ended"));
    expect(cleanupCallers).toEqual([undefined]);
    await expect(h.invoke("computer.execution", { action: "inspect" })).resolves.toMatchObject({
      state: "free",
    });
  } finally {
    releaseAgentRunDelegatedAuthority(authority);
    vi.restoreAllMocks();
  }
});

it("binds cleanup when the acquiring command aborts after the node owns the seat", async () => {
  resetComputerToolMocks();
  const h = fixture();
  const run = createOperationalRunInstanceRef("paired-run-abort");
  const authority = claimAgentRunDelegatedAuthority(run);
  const node = { ...createNodeSession(), nodeId: "paired-abort", connId: "connection-abort" };
  const context = createContext();
  context.nodeRegistry = new NodeRegistry();
  vi.spyOn(context.nodeRegistry, "get").mockReturnValue(node);
  const dispatch = async (method: string, params: Record<string, unknown>) => {
    expect(method).toBe("node.invoke");
    const caller = getGatewayToolCallerIdentity();
    const client = caller
      ? createOperatorClient({ profileId: "fixture", scopes: ["operator.write"] })
      : null;
    if (caller && client && caller.operationalRunInstance && caller.approvalAuthority) {
      client.internal = {
        syntheticClient: true,
        agentRuntimeIdentity: {
          kind: "agentRuntime",
          agentId: caller.agentId,
          sessionKey: caller.sessionKey,
          operationalRunInstance: caller.operationalRunInstance,
          delegatedAuthority: { ...caller.approvalAuthority, kind: "local" },
        },
      };
    }
    const sanitized = await sanitizeNodeInvokeParamsForForwarding({
      nodeId: node.nodeId,
      command: String(params.command),
      rawParams: params.params,
      client,
      declaredCommands: ["computer.execution"],
    });
    if (!sanitized.ok) {
      throw new Error(sanitized.message);
    }
    const frame = coerceNodeInvokePayload(
      buildNodeInvokeRequest({
        id: "wire",
        nodeId: node.nodeId,
        command: String(params.command),
        params: sanitized.params,
        timeoutMs: 1000,
      }),
    );
    if (!frame) {
      throw new Error("invalid wire");
    }
    const command = h.commands.get(frame.command);
    if (!command) {
      throw new Error("missing node command");
    }
    const payload = await withNodeHostPluginInvocation(
      { context: { sendNodeEvent: async () => {} }, computerExecutionV1: frame.computerExecutionV1 },
      async (invocation) => JSON.parse(await command.handle(frame.paramsJSON, undefined, invocation)),
    );
    if (params.command === "screen.snapshot") {
      throw Object.assign(new Error("cancelled after acquire"), { name: "AbortError" });
    }
    return { payload };
  };
  callGatewayToolMock.mockImplementation(
    async (method, _options, params) => await dispatch(method, params),
  );
  transport.dispatch.mockImplementation(async (method, params, options) => {
    options.sessionMutationCommitGuard?.();
    return await dispatch(method, params);
  });
  listNodesMock.mockResolvedValue([
    {
      ...node,
      connected: true,
      commands: ["screen.snapshot", "computer.act", "computer.execution"],
      computerUse: v2Descriptor(["screenshot", "type"], {
        provider: { id: "fixture", label: "Fixture", generation: "generation-one" },
      }),
    },
  ]);
  h.snapshot.mockResolvedValue(
    JSON.stringify({
      format: "png",
      base64: TINY_PNG_BASE64,
      displayFrameId: "native-frame",
      width: 1,
      height: 1,
    }),
  );
  const tool = wrapToolWithGatewayCallerIdentity(
    createComputerTool({ computerExecutionId: run.instanceId }),
    {
      agentId: "main",
      sessionKey: "agent:main:run-aborted",
      operationalRunInstance: run,
      approvalAuthority: authority,
      gatewayContextResolver: () => context,
      receiptAuthority: () => validateAgentRunDelegatedAuthority(authority),
    },
  );
  try {
    await expect(
      tool.execute("observe", { action: "screenshot", target: "node", node: node.nodeId }),
    ).rejects.toThrow("cancelled after acquire");
    releaseAgentRunDelegatedAuthority(authority);
    await vi.waitFor(() => expect(h.close).toHaveBeenCalledExactlyOnceWith("run-ended"));
  } finally {
    releaseAgentRunDelegatedAuthority(authority);
    vi.restoreAllMocks();
  }
});
