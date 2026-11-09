import { type Static, Type } from "typebox";
import { lazyCompile } from "./protocol-validator.js";
import { closedObject } from "./schema/closed-object.js";
import { NonEmptyString } from "./schema/primitives.js";

/** Gateway-owned provenance, carried outside model-controlled command parameters. */
export const ComputerExecutionCallerV1Schema = closedObject({
  sessionKey: Type.Optional(NonEmptyString),
  runId: Type.Optional(NonEmptyString),
  instanceId: Type.Optional(NonEmptyString),
  callerId: Type.Optional(NonEmptyString),
  recoveryOperator: Type.Boolean(),
});
export type ComputerExecutionCallerV1 = Static<typeof ComputerExecutionCallerV1Schema>;
export const validateComputerExecutionCallerV1 = lazyCompile(ComputerExecutionCallerV1Schema);
