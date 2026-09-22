export const filter = [
  "default",
  {
    ignoreBodyFields: ["stream_options"],
    // Multipart boundaries are chosen randomly by each SDK request. Preserve
    // every field and file byte while removing only that transport delimiter.
    normalizeRequest(request) {
      const contentType =
        request.headers["content-type"] ?? request.body.contentType ?? "";
      const boundary = contentType.match(/boundary="?([^";]+)/)?.[1];
      if (!boundary || request.body.kind !== "base64") return request;
      const { "content-length": _length, ...headers } = request.headers;
      return {
        ...request,
        headers: { ...headers, "content-type": "multipart/form-data" },
        body: {
          kind: "base64",
          contentType: "multipart/form-data",
          value: Buffer.from(
            Buffer.from(request.body.value, "base64")
              .toString("latin1")
              .replaceAll(boundary, "cassette-boundary"),
            "latin1",
          ).toString("base64"),
        },
      };
    },
  },
];
