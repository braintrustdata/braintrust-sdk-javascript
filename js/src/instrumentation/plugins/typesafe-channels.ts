import { INSTRUMENTATION_NAMES } from "../../span-origin";
import type {
  TypeSafeAPIPromise,
  TypeSafeSystemOneRequest,
  TypeSafeSystemOneResult,
} from "../../vendor-sdk-types/typesafe";
import { channel, defineChannels } from "../core/channel-definitions";

export const typeSafeChannels = defineChannels(
  "@typesafe-ai/sdk",
  {
    systemOne: channel<
      [TypeSafeSystemOneRequest, options?: unknown],
      TypeSafeSystemOneResult
    >({
      channelName: "systemOne",
      kind: "async",
    }),
  },
  { instrumentationName: INSTRUMENTATION_NAMES.TYPESAFE },
);

export type TypeSafeSystemOnePromise =
  TypeSafeAPIPromise<TypeSafeSystemOneResult>;
