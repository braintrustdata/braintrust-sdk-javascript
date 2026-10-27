// Multipart image bodies exceed the sidecar threshold. Keep the bytes available
// to normalize their random boundaries and image references during matching.
export const inlineRequestBodies = true;

export const filter = [
  "default",
  {
    // Normalize transport boundaries and SDK-generated references, preserving
    // every input field and image byte for cassette matching.
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
              .replaceAll(boundary, "cassette-boundary")
              .replace(/<image:[a-f0-9]{32}>/g, "<image:reference>"),
            "latin1",
          ).toString("base64"),
        },
      };
    },
  },
];
