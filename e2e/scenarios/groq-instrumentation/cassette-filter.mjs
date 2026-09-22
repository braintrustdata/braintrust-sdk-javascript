// Multipart boundaries vary per SDK request. Preserve the audio bytes and all
// form fields in matching while normalizing only the transport delimiter.
export const filter = [
  "default",
  {
    normalizeRequest(request) {
      if (
        request.body.kind !== "base64" ||
        !request.body.contentType?.startsWith("multipart/form-data")
      )
        return request;
      const body = Buffer.from(request.body.value, "base64").toString("latin1");
      const boundary = body.slice(2, body.indexOf("\r\n"));
      return {
        ...request,
        body: {
          kind: "base64",
          contentType: "multipart/form-data; boundary=braintrust-boundary",
          value: Buffer.from(
            body.replaceAll(boundary, "braintrust-boundary"),
            "latin1",
          ).toString("base64"),
        },
      };
    },
  },
];
