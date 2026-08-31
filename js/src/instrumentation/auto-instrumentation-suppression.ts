import iso, { type IsoAsyncLocalStorage } from "../isomorph";

let autoInstrumentationSuppressionStore:
  | IsoAsyncLocalStorage<boolean>
  | undefined;

function suppressionStore() {
  autoInstrumentationSuppressionStore ??= iso.newAsyncLocalStorage<boolean>();
  return autoInstrumentationSuppressionStore;
}

export function isAutoInstrumentationSuppressed(): boolean {
  return suppressionStore().getStore() === true;
}

export function runWithAutoInstrumentationSuppressed<R>(callback: () => R): R {
  return suppressionStore().run(true, callback);
}

export function runWithAutoInstrumentationAllowed<R>(callback: () => R): R {
  return suppressionStore().run(undefined, callback);
}
