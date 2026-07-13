/**
 * Appended to OpenAI's api-promise.mjs to make APIPromise.prototype.parseResponse
 * idempotent per-instance. Without this, chat.completions.parse() triggers two
 * instrumented .then() calls (one on the create() APIPromise, one on the
 * _thenUnwrap() APIPromise) that share the same responsePromise, causing both to
 * call defaultParseResponse → response.json() on the same undici Response body.
 * Real HTTP responses can only be read once, so the second read throws
 * "Body is unusable: Body has already been read".
 */
export const OPENAI_API_PROMISE_PATCH = `
;(function __btPatchAPIPromise() {
  if (typeof APIPromise === "undefined" || APIPromise.prototype.__btParsePatched) return;
  APIPromise.prototype.__btParsePatched = true;
  var _origThen = APIPromise.prototype.then;
  APIPromise.prototype.then = function __btThen(onfulfilled, onrejected) {
    if (!this.__btParseWrapped && Object.prototype.hasOwnProperty.call(this, "parseResponse")) {
      this.__btParseWrapped = true;
      var _origParse = this.parseResponse;
      var _cached;
      this.parseResponse = function() {
        if (!_cached) _cached = _origParse.apply(this, arguments);
        return _cached;
      };
    }
    return _origThen.call(this, onfulfilled, onrejected);
  };
})();
`;
