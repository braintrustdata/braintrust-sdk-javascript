declare module "@braintrust-test/logger" {
  export interface TestBackgroundLogger {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    drain(): Promise<any[]>;
  }

  export const _exportsForTestingOnly: {
    simulateLoginForTests(): Promise<void>;
    useTestBackgroundLogger(): TestBackgroundLogger;
    clearTestBackgroundLogger(): void;
  };
}
