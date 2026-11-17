/**
 * Workflow interceptors for Braintrust tracing.
 *
 * IMPORTANT: This module is loaded into the Temporal workflow isolate.
 * It cannot import Node.js modules or access external state directly.
 * Communication with the outside world is done via sinks.
 */
import {
  WorkflowInterceptorsFactory,
  WorkflowInboundCallsInterceptor,
  WorkflowOutboundCallsInterceptor,
  WorkflowExecuteInput,
  Next,
  proxySinks,
  uuid4,
} from "@temporalio/workflow";
import type {
  ActivityInput,
  LocalActivityInput,
  StartChildWorkflowExecutionInput,
} from "@temporalio/workflow";
import type { Payload } from "@temporalio/common";
import type { PropagationContext } from "braintrust";
import type { BraintrustSinks } from "./sinks";
import {
  deserializeTraceContext,
  serializeTraceContext,
  withParentSpanId,
} from "./utils";

const { braintrust } = proxySinks<BraintrustSinks>();

/**
 * Shared state between inbound and outbound interceptors for a single workflow.
 * Created per-workflow by the factory function to avoid global state issues.
 */
interface WorkflowSpanState {
  parentContext: PropagationContext | undefined;
  spanId: string | undefined;
}

class BraintrustWorkflowInboundInterceptor implements WorkflowInboundCallsInterceptor {
  constructor(private state: WorkflowSpanState) {}

  async execute(
    input: WorkflowExecuteInput,
    next: Next<WorkflowInboundCallsInterceptor, "execute">,
  ): Promise<unknown> {
    // Extract parent context from headers
    const parentContext = deserializeTraceContext(input.headers);

    // Store for the outbound interceptor to forward to activities
    this.state.parentContext = parentContext;

    // Generate a deterministic spanId for the workflow span
    this.state.spanId = uuid4().replace(/-/g, "").slice(0, 16);

    // Create workflow span via sink (only called if not replaying)
    // NOTE: WorkflowInfo is injected automatically by the runtime
    braintrust.workflowStarted(parentContext, this.state.spanId);

    try {
      const result = await next(input);
      braintrust.workflowCompleted();
      return result;
    } catch (e) {
      braintrust.workflowCompleted(e instanceof Error ? e.message : String(e));
      throw e;
    }
  }
}

class BraintrustWorkflowOutboundInterceptor implements WorkflowOutboundCallsInterceptor {
  constructor(private state: WorkflowSpanState) {}

  private getHeaders(): Record<string, Payload> {
    const context =
      this.state.parentContext && this.state.spanId
        ? withParentSpanId(this.state.parentContext, this.state.spanId)
        : undefined;
    return context ? serializeTraceContext(context) : {};
  }

  scheduleActivity(
    input: ActivityInput,
    next: Next<WorkflowOutboundCallsInterceptor, "scheduleActivity">,
  ) {
    return next({
      ...input,
      headers: {
        ...input.headers,
        ...this.getHeaders(),
      },
    });
  }

  scheduleLocalActivity(
    input: LocalActivityInput,
    next: Next<WorkflowOutboundCallsInterceptor, "scheduleLocalActivity">,
  ) {
    return next({
      ...input,
      headers: {
        ...input.headers,
        ...this.getHeaders(),
      },
    });
  }

  startChildWorkflowExecution(
    input: StartChildWorkflowExecutionInput,
    next: Next<WorkflowOutboundCallsInterceptor, "startChildWorkflowExecution">,
  ) {
    return next({
      ...input,
      headers: {
        ...input.headers,
        ...this.getHeaders(),
      },
    });
  }
}

export const interceptors: WorkflowInterceptorsFactory = () => {
  // Create shared state for this workflow instance
  const state: WorkflowSpanState = {
    parentContext: undefined,
    spanId: undefined,
  };

  return {
    inbound: [new BraintrustWorkflowInboundInterceptor(state)],
    outbound: [new BraintrustWorkflowOutboundInterceptor(state)],
  };
};
