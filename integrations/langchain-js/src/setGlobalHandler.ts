import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import {
  registerConfigureHook,
  setContextVariable,
} from "@langchain/core/context";

const BT_HANDLER = "BT_HANDLER";

/**
 * @deprecated Use automatic LangChain instrumentation from `braintrust` for
 * application-wide coverage. This package will stop being published after the
 * next release.
 */
export const setGlobalHandler = (handler: BaseCallbackHandler) => {
  setContextVariable(BT_HANDLER, handler);

  registerConfigureHook({
    contextVar: BT_HANDLER,
  });
};

export const clearGlobalHandler = () => {
  setContextVariable(BT_HANDLER, undefined);
};
