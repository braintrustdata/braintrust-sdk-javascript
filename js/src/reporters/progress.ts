import { sdkConsole } from "../logs/console";
import type { ProgressReporter } from "./types";

export class SimpleProgressReporter implements ProgressReporter {
  public start(name: string, _total: number): void {
    sdkConsole.log(`Running evaluator ${name}`);
  }
  public stop(): void {}
  public increment(_name: string): void {}
  public setTotal(_name: string, _total: number): void {}
}
