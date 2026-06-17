import iso, {
  type IsoAsyncLocalStorage,
  type IsoTracingChannel,
} from "../isomorph";

type AutoInstrumentationSuppressionFrame = {
  id: symbol;
  mode: "allow" | "suppress";
};

type AutoInstrumentationSuppressionState = {
  frames: AutoInstrumentationSuppressionFrame[];
};

let autoInstrumentationSuppressionStore:
  | IsoAsyncLocalStorage<AutoInstrumentationSuppressionState | undefined>
  | undefined;

function suppressionStore() {
  autoInstrumentationSuppressionStore ??= iso.newAsyncLocalStorage<
    AutoInstrumentationSuppressionState | undefined
  >();
  return autoInstrumentationSuppressionStore;
}

function currentFrames(): AutoInstrumentationSuppressionFrame[] {
  return suppressionStore().getStore()?.frames ?? [];
}

export function isAutoInstrumentationSuppressed(): boolean {
  const frames = currentFrames();
  return frames[frames.length - 1]?.mode === "suppress";
}

export function runWithAutoInstrumentationSuppressed<R>(callback: () => R): R {
  const frame = {
    id: Symbol("braintrust.auto-instrumentation-suppress"),
    mode: "suppress" as const,
  };
  return suppressionStore().run(
    { frames: [...currentFrames(), frame] },
    callback,
  );
}

export function bindAutoInstrumentationSuppressionToStart<T>(
  tracingChannel: Pick<IsoTracingChannel<T>, "start">,
): (() => void) | undefined {
  const startChannel = tracingChannel.start;
  if (!startChannel) {
    return undefined;
  }

  const store = suppressionStore();
  startChannel.bindStore(store, () => ({
    frames: [
      ...currentFrames(),
      {
        id: Symbol("braintrust.auto-instrumentation-suppress"),
        mode: "suppress" as const,
      },
    ],
  }));

  return () => {
    startChannel.unbindStore(store);
  };
}

export function enterAutoInstrumentationAllowed(): () => void {
  const frame = {
    id: Symbol("braintrust.auto-instrumentation-allow"),
    mode: "allow" as const,
  };
  suppressionStore().enterWith({
    frames: [...currentFrames(), frame],
  });

  return () => {
    const frames = currentFrames().filter(
      (candidate) => candidate.id !== frame.id,
    );
    suppressionStore().enterWith(frames.length > 0 ? { frames } : undefined);
  };
}
