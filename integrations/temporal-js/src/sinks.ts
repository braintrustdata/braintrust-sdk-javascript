import type { WorkflowInfo, Sinks } from "@temporalio/workflow";
import type { InjectedSinks } from "@temporalio/worker";
import * as braintrust from "braintrust";

// Sink interface (used in workflow code via proxySinks)
// NOTE: WorkflowInfo is NOT included here - it's automatically injected by the runtime
export interface BraintrustSinks extends Sinks {
  braintrust: {
    workflowStarted(
      parentContext?: braintrust.PropagationContext,
      workflowSpanId?: string,
    ): void;
    workflowCompleted(error?: string): void;
  };
}

// Active workflow spans tracked by run ID
const workflowSpans = new Map<string, braintrust.Span>();
const workflowTraceContexts = new Map<string, braintrust.PropagationContext>();

/**
 * Get the exported span context for a workflow by run ID.
 * Activities on the same worker can use this to parent to the workflow span.
 */
export function getWorkflowTraceContext(
  runId: string,
): braintrust.PropagationContext | undefined {
  return workflowTraceContexts.get(runId);
}

/**
 * Create the Braintrust sinks for workflow span management.
 * These sinks are called from the workflow isolate via proxySinks.
 */
export function createBraintrustSinks(): InjectedSinks<BraintrustSinks> {
  return {
    braintrust: {
      workflowStarted: {
        fn: (
          info: WorkflowInfo,
          parentContext?: braintrust.PropagationContext,
          workflowSpanId?: string,
        ) => {
          const span = braintrust.startSpan({
            name: `temporal.workflow.${info.workflowType}`,
            spanAttributes: { type: "task" },
            parent: parentContext,
            spanId: workflowSpanId,
            event: {
              metadata: {
                "temporal.workflow_type": info.workflowType,
                "temporal.workflow_id": info.workflowId,
                "temporal.run_id": info.runId,
              },
            },
          });
          workflowSpans.set(info.runId, span);
          workflowTraceContexts.set(info.runId, span.inject());
        },
        callDuringReplay: false,
      },
      workflowCompleted: {
        fn: (info: WorkflowInfo, error?: string) => {
          const span = workflowSpans.get(info.runId);
          if (span) {
            if (error) {
              span.log({ error });
            }
            span.end();
            workflowSpans.delete(info.runId);
            workflowTraceContexts.delete(info.runId);
          }
        },
        callDuringReplay: false,
      },
    },
  };
}
