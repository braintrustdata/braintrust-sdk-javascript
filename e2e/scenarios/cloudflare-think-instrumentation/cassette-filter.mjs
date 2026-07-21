// @ts-check
/** @type {import("@braintrust/seinfeld").FilterSpec} */
export const filter = [
  "default",
  {
    ignoreBodyFields: [
      "experimental_generateMessageId",
      "messageId",
      "messages.*.id",
      "messages.*.experimental_messageId",
    ],
  },
];
