// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyFn = (this: any, ...args: any[]) => any;

export type TypedApplyProxyHandler<TTarget extends AnyFn> = Omit<
  ProxyHandler<TTarget>,
  "apply"
> & {
  apply: (
    target: TTarget,
    thisArg: ThisParameterType<TTarget>,
    argArray: Parameters<TTarget>,
  ) => ReturnType<TTarget>;
};

/**
 * Literally `Proxy` that has a typed `apply` based on the `target`.
 */
export const TypedApplyProxy: new <TTarget extends AnyFn>(
  target: TTarget,
  handler: TypedApplyProxyHandler<TTarget>,
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
) => TTarget = Proxy as unknown as new <TTarget extends AnyFn>(
  target: TTarget,
  handler: TypedApplyProxyHandler<TTarget>,
) => TTarget;
