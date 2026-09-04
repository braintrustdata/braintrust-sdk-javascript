import type { Context } from "@temporalio/activity";
import type {
  ActivityInboundCallsInterceptor,
  ActivityExecuteInput,
  Next,
  ActivityInterceptors,
} from "@temporalio/worker";
import type { WorkflowClientInterceptor } from "@temporalio/client";
import * as braintrust from "braintrust";
import { getWorkflowTraceContext } from "./sinks";
import { deserializeTraceContext, serializeTraceContext } from "./utils";

/**
 * Create a client interceptor that propagates Braintrust span context to workflows.
 * Use this when creating a Temporal Client to enable trace context propagation.
 */
export function createBraintrustClientInterceptor(): WorkflowClientInterceptor {
  return {
    async start(input, next) {
      const span = braintrust.currentSpan();
      if (span) {
        return next({
          ...input,
          headers: {
            ...input.headers,
            ...serializeTraceContext(braintrust.injectTraceContext()),
          },
        });
      }
      return next(input);
    },
    async signal(input, next) {
      return next(input);
    },
    async signalWithStart(input, next) {
      const span = braintrust.currentSpan();
      if (span) {
        return next({
          ...input,
          headers: {
            ...input.headers,
            ...serializeTraceContext(braintrust.injectTraceContext()),
          },
        });
      }
      return next(input);
    },
  };
}

/**
 * Activity interceptor that creates Braintrust spans for activity executions.
 */
class BraintrustActivityInterceptor implements ActivityInboundCallsInterceptor {
  constructor(private ctx: Context) {}

  async execute(
    input: ActivityExecuteInput,
    next: Next<ActivityInboundCallsInterceptor, "execute">,
  ): Promise<unknown> {
    const info = this.ctx.info;
    const runId = info.workflowExecution.runId;

    // Prefer the live workflow span on the same worker, then fall back to the
    // W3C context propagated through Temporal headers.
    let parent: braintrust.PropagationContext | undefined;

    // Check if we have the workflow span export locally (same worker as workflow)
    parent =
      getWorkflowTraceContext(runId) ?? deserializeTraceContext(input.headers);

    const span = braintrust.startSpan({
      name: `temporal.activity.${info.activityType}`,
      spanAttributes: { type: "task" },
      parent,
      event: {
        metadata: {
          "temporal.activity_type": info.activityType,
          "temporal.activity_id": info.activityId,
          "temporal.workflow_id": info.workflowExecution.workflowId,
          "temporal.workflow_run_id": runId,
        },
      },
    });

    try {
      const result = await braintrust.withCurrent(span, () => next(input));
      span.log({ output: result });
      span.end();
      return result;
    } catch (e) {
      span.log({ error: String(e) });
      span.end();
      throw e;
    }
  }
}

/**
 * Create an activity interceptor factory for use with Worker.create().
 * This factory creates BraintrustActivityInterceptor instances for each activity.
 */
export function createBraintrustActivityInterceptor(
  ctx: Context,
): ActivityInterceptors {
  return {
    inbound: new BraintrustActivityInterceptor(ctx),
  };
}
