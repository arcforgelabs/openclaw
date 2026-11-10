import { AsyncLocalStorage } from "node:async_hooks";
import { isRecord } from "@openclaw/normalization-core/record-coerce";

export type ComputerExecutionCleanup = Readonly<{
  nodeId: string;
  executionId: string;
  providerGeneration: string;
  ownershipId: string;
  assertCurrent(): void;
}>;
const cleanupScope = new AsyncLocalStorage<ComputerExecutionCleanup>();

/** Private host carrier: never accepted from a request body or an operator identity. */
export function runWithComputerExecutionCleanup<T>(
  grant: ComputerExecutionCleanup,
  run: () => T,
): T {
  grant.assertCurrent();
  return cleanupScope.run(grant, run);
}

export function readComputerExecutionCleanup(request: {
  nodeId: string;
  command: string;
  rawParams: unknown;
}) {
  const grant = cleanupScope.getStore();
  if (!grant) {
    return undefined;
  }
  grant.assertCurrent();
  if (
    request.nodeId !== grant.nodeId ||
    request.command !== "computer.act" ||
    !isRecord(request.rawParams) ||
    request.rawParams.action !== "__close_execution" ||
    request.rawParams.executionId !== grant.executionId ||
    request.rawParams.providerGeneration !== grant.providerGeneration
  ) {
    throw new Error("Computer cleanup capability cannot dispatch another operation");
  }
  return {
    executionId: grant.executionId,
    providerGeneration: grant.providerGeneration,
    ownershipId: grant.ownershipId,
  };
}
