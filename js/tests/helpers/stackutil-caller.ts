import { configureNode } from "../../src/node/config";
import { getCallerLocation } from "../../src/stackutil";

configureNode();

export const callerFromModuleInit = getCallerLocation();

export function callerFromNamedFunction() {
  return getCallerLocation();
}

export function callerFromAnonymousFunction() {
  return (() => getCallerLocation())();
}
