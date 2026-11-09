import type { OpenClawPluginNodeInvokePolicyContext } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it, vi } from "vitest";
import { createCuaComputerNodeInvokePolicy } from "./node-invoke-policy.js";

const resourceHandle = "openclaw:computer-resource:v1:123e4567-e89b-42d3-a456-426614174000";

describe("cua-computer node invoke policy", () => {
  const classifyRisk = (params: unknown) => {
    const classify = createCuaComputerNodeInvokePolicy().classifyRisk;
    if (!classify) {
      throw new Error("missing CUA Computer risk classifier");
    }
    return classify({ command: "computer.act", params });
  };

  it.each([
    [{ action: "kill_app", app: "app-ref" }, "process_termination"],
    [
      { action: "browser_navigate", browserRef: "browser", pageRef: "page", url: "about:blank" },
      "browser_navigation",
    ],
    [
      {
        action: "browser_download",
        browserRef: "browser",
        pageRef: "page",
        observationId: "observation",
        elementRef: "element",
      },
      "browser_download",
    ],
    [
      {
        action: "browser_set_input_files",
        browserRef: "browser",
        pageRef: "page",
        observationId: "observation",
        elementRef: "element",
        resourceHandles: [resourceHandle],
      },
      "browser_file_input",
    ],
    [{ action: "start_recording" }, "recording_start"],
    [{ action: "replay_trajectory", resourceHandle }, "recording_replay"],
    [{ action: "escalate_scope", reason: "other" }, "desktop_scope_escalation"],
  ])("classifies $family as high risk", (params, family) => {
    expect(classifyRisk(params)).toEqual({ level: "high", family });
  });

  it("distinguishes ordinary observation, input, and lifecycle arguments", () => {
    expect(classifyRisk({ action: "list_windows" })).toEqual({
      level: "ordinary",
      family: "observation",
    });
    expect(
      classifyRisk({
        action: "zoom",
        windowRef: "window",
        observationId: "observation",
        x1: 0,
        y1: 0,
        x2: 100,
        y2: 100,
      }),
    ).toEqual({ level: "ordinary", family: "observation" });
    expect(classifyRisk({ action: "type", text: "hello", windowRef: "window" })).toEqual({
      level: "ordinary",
      family: "input",
    });
    expect(
      classifyRisk({
        action: "__close_execution",
        executionId: "123e4567-e89b-42d3-a456-426614174000",
        reason: "completion",
      }),
    ).toEqual({ level: "ordinary", family: "execution_lifecycle" });
  });

  it("rejects raw provider calls and native process controls before dispatch", async () => {
    const policy = createCuaComputerNodeInvokePolicy();
    for (const params of [
      { providerTool: "click", arguments: { x: 1, y: 2 } },
      { action: "left_click", binaryPath: "/tmp/cua-driver" },
      { action: "left_click", socketPath: "/tmp/cua.sock" },
      { action: "left_click", session: "native-session" },
      { action: "left_click", driverArgs: ["--dangerously-bypass-approvals"] },
    ]) {
      expect(() => policy.classifyRisk?.({ command: "computer.act", params })).toThrow(
        "COMPUTER_INVALID_REQUEST",
      );
    }

    const invokeNode = vi.fn(async () => ({ ok: true as const }));
    await expect(
      policy.handle({ invokeNode } as unknown as OpenClawPluginNodeInvokePolicyContext),
    ).resolves.toMatchObject({ ok: false, code: "COMPUTER_RISK_UNCLASSIFIED" });
    expect(invokeNode).not.toHaveBeenCalled();
  });
});

describe("computer execution interruption", () => {
  const target = {
    action: "recover",
    executionId: "123e4567-e89b-42d3-a456-426614174000",
    providerGeneration: "generation-one",
    ownershipId: "ownership-one",
    interrupt: true,
  };
  const policy = createCuaComputerNodeInvokePolicy();
  const risk = policy.classifyRisk!({ command: "computer.execution", params: target });
  const invokeNode = vi.fn<OpenClawPluginNodeInvokePolicyContext["invokeNode"]>(async () => ({
    ok: true as const,
  }));
  const context = {
    nodeId: "agent-seat",
    command: "computer.execution",
    params: target,
    config: {},
    risk,
    invokeNode,
  };

  it.each([undefined, "deny", "allow-always"] as const)(
    "does not automatically recover Unknown work on %s",
    async (decision) => {
      invokeNode.mockClear();
      const request = vi.fn<
        NonNullable<OpenClawPluginNodeInvokePolicyContext["approvals"]>["request"]
      >(async () => ({ decision }));
      expect(await policy.handle({ ...context, approvals: { request } })).toMatchObject({
        ok: false,
        code: "COMPUTER_INTERRUPTION_REQUIRED",
      });
      expect(invokeNode).not.toHaveBeenCalled();
      expect(request.mock.calls[0]?.[0]).toMatchObject({
        title: "Interrupt agent-seat",
        description:
          "Work may be lost. execution=123e4567-e89b-42d3-a456-426614174000 generation=generation-one ownership=ownership-one",
        allowedDecisions: ["allow-once", "deny"],
        severity: "critical",
      });
    },
  );

  it("dispatches only after an explicit one-time decision for the exact target", async () => {
    invokeNode.mockClear();
    let decide: (value: { decision: "allow-once" }) => void = () => {
      throw new Error("approval was not requested");
    };
    const request = vi.fn(
      () =>
        new Promise<{ decision: "allow-once" }>((resolve) => {
          decide = resolve;
        }),
    );
    const pending = policy.handle({ ...context, approvals: { request } });
    expect(invokeNode).not.toHaveBeenCalled();
    decide({ decision: "allow-once" });
    expect(await pending).toMatchObject({ ok: true });
    expect(invokeNode).toHaveBeenCalledOnce();
  });

  it("dispatches only the target named by the human decision even if request arguments change while waiting", async () => {
    invokeNode.mockClear();
    const params = { ...target };
    let decide: (value: { decision: "allow-once" }) => void = () => {
      throw new Error("approval was not requested");
    };
    const request = vi.fn(
      () =>
        new Promise<{ decision: "allow-once" }>((resolve) => {
          decide = resolve;
        }),
    );
    const pending = policy.handle({ ...context, params, approvals: { request } });
    params.executionId = "223e4567-e89b-42d3-a456-426614174000";
    decide({ decision: "allow-once" });
    await pending;
    expect(invokeNode).toHaveBeenCalledExactlyOnceWith({
      params: {
        action: "recover",
        executionId: "123e4567-e89b-42d3-a456-426614174000",
        providerGeneration: "generation-one",
        ownershipId: "ownership-one",
        computerExecutionCaller: undefined,
      },
    });
  });
});
