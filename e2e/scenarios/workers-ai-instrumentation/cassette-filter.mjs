// Account IDs are routing details, not part of the model request contract.
const normalizeRequest = (request) => ({
  ...request,
  url: request.url.replace(
    /\/accounts\/[^/]+\//,
    "/accounts/cassette-account/",
  ),
});
export const filter = ["default", { normalizeRequest }];
export const redact = [
  "paranoid",
  { omitRequestHeaders: true, redactRequest: normalizeRequest },
];
