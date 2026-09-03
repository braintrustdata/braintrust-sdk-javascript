import {
  configureContextManager,
  ContextManager,
  type ContextParentSpanIds,
  type CurrentSpanStore,
  type Span,
} from "braintrust";
import { AsyncLocalStorage as BrowserAsyncLocalStorage } from "als-browser";

class BrowserContextManager extends ContextManager {
  private readonly currentSpan = new BrowserAsyncLocalStorage<Span>();

  getParentSpanIds(): ContextParentSpanIds | undefined {
    const span = this.currentSpan.getStore();
    return span
      ? { rootSpanId: span.rootSpanId, spanParents: [span.spanId] }
      : undefined;
  }

  runInContext<R>(span: Span, callback: () => R): R {
    return this.currentSpan.run(span, callback);
  }

  getCurrentSpan(): Span | undefined {
    return this.currentSpan.getStore();
  }

  getCurrentSpanStore(): CurrentSpanStore {
    return this.currentSpan;
  }
}

export function configureBrowser(): void {
  configureContextManager(BrowserContextManager);
}
