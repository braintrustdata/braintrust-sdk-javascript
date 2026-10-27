// SDK brands are shared across copies of @typesafe-ai/sdk.
export interface TypeSafeImage {
  readonly type: "image";
  readonly data: Uint8Array | Blob;
  toString(): string;
}

export interface TypeSafeTextWithAssets {
  readonly text: string;
  readonly assets: readonly TypeSafeImage[];
}

export type TypeSafeSystemOneRequest = {
  state: unknown;
  questions: Record<string, unknown>;
  assets?: Record<string, TypeSafeImage>;
  model?: string;
  [key: string]: unknown;
};

export type TypeSafeUsage = {
  input_tokens?: number;
  output_tokens?: number;
  [key: string]: unknown;
};

export type TypeSafeSystemOneResult = {
  model?: string;
  answers?: Record<string, unknown>;
  usage?: TypeSafeUsage;
  [key: string]: unknown;
};

export type TypeSafeWithResponse<T> = {
  data: T;
  response: Response;
  requestId?: string;
};

export type TypeSafeAPIPromise<T> = Promise<T> & {
  asResponse(): Promise<Response>;
  withResponse(): Promise<TypeSafeWithResponse<T>>;
  map<U>(fn: (data: T) => U): TypeSafeAPIPromise<U>;
  catch<TResult = never>(
    onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null,
  ): Promise<T | TResult>;
  finally(onfinally?: (() => void) | null): Promise<T>;
};

export type TypeSafeClient = {
  defaultModel?: string;
  systemOne(
    request: TypeSafeSystemOneRequest,
    options?: unknown,
  ): TypeSafeAPIPromise<TypeSafeSystemOneResult>;
  [key: string]: unknown;
};
