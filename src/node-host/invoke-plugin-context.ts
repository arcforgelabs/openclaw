import type { ComputerExecutionCallerV1 } from "../../packages/gateway-protocol/src/computer-execution-context.js";
import { warnPluginSdkDeprecation } from "../plugins/sdk-deprecation.js";
import type { OpenClawPluginNodeHostCommandContext } from "../plugins/types.node-host.js";

/** Retain invocation-bound workspace capabilities until command handling settles. */
export async function withNodeHostPluginInvocation<T>(
  {
    context,
    sessionKey,
    signal,
    computerExecutionV1,
  }: {
    context?: OpenClawPluginNodeHostCommandContext;
    sessionKey?: string | null;
    signal?: AbortSignal;
    computerExecutionV1?: ComputerExecutionCallerV1;
  },
  operation: (context: OpenClawPluginNodeHostCommandContext | undefined) => Promise<T>,
): Promise<T> {
  const acquireManagedWorkspace = context?.acquireManagedWorkspace;
  const acquireManagedWorkspaceAsync = context?.acquireManagedWorkspaceAsync;
  let pluginInvocationActive = true;
  const assertCurrent = (requestedSessionKey: string) => {
    if (
      !pluginInvocationActive ||
      signal?.aborted ||
      !sessionKey ||
      requestedSessionKey !== sessionKey
    ) {
      throw new Error("node placement workspace invocation authority is closed");
    }
  };
  const invokeContext =
    context &&
    (sessionKey ||
      signal ||
      computerExecutionV1 ||
      acquireManagedWorkspace ||
      acquireManagedWorkspaceAsync)
      ? {
          ...context,
          ...(sessionKey ? { sessionKey } : {}),
          ...(signal ? { signal } : {}),
          ...(computerExecutionV1
            ? {
                computerExecutionV1: {
                  caller: computerExecutionV1,
                  assertCurrent: () => {
                    signal?.throwIfAborted();
                    if (!pluginInvocationActive) {
                      throw new Error("computer execution invocation authority is closed");
                    }
                  },
                },
              }
            : {}),
          ...(acquireManagedWorkspaceAsync
            ? {
                acquireManagedWorkspaceAsync: async (
                  request: Parameters<typeof acquireManagedWorkspaceAsync>[0],
                ) => {
                  const captured = { ...request };
                  assertCurrent(captured.sessionKey);
                  const workspace = await acquireManagedWorkspaceAsync(captured);
                  try {
                    assertCurrent(captured.sessionKey);
                    return workspace;
                  } catch (error) {
                    workspace.release();
                    throw error;
                  }
                },
              }
            : {}),
          ...(acquireManagedWorkspace
            ? {
                acquireManagedWorkspace: (
                  request: Parameters<typeof acquireManagedWorkspace>[0],
                ) => {
                  warnPluginSdkDeprecation({
                    family: "node-host-sync-workspace",
                    method: "OpenClawPluginNodeHostCommandContext.acquireManagedWorkspace",
                    replacement: "await context.acquireManagedWorkspaceAsync()",
                  });
                  assertCurrent(request.sessionKey);
                  return acquireManagedWorkspace(request);
                },
              }
            : {}),
        }
      : context;
  try {
    return await operation(invokeContext);
  } finally {
    pluginInvocationActive = false;
  }
}
