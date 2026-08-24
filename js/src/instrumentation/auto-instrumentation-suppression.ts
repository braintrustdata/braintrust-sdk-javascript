import iso, {
  type IsoAsyncLocalStorage,
  type IsoTracingChannel,
} from "../isomorph";

type AutoInstrumentationSuppressionFrame = {
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
        mode: "suppress" as const,
      },
    ],
  }));

  return () => {
    startChannel.unbindStore(store);
  };
}

export function runWithAutoInstrumentationAllowed<R>(callback: () => R): R {
  const frame = {
    mode: "allow" as const,
  };
  return suppressionStore().run(
    { frames: [...currentFrames(), frame] },
    callback,
  );
}
