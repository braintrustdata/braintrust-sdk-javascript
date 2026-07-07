export type OnlyAType = { a: number };
export interface AlsoAType {
  b: string;
}

export const alpha: number = 1,
  beta: string = "two";

export function gamma(n: number): number {
  return n + alpha;
}

export class Delta {
  value: number = 3;
}
