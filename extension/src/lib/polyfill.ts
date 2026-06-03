// stellar-sdk reaches for the Node `Buffer` global at runtime (rpc/server.js
// among others). MV3 service workers do not have it, and the failure is nasty:
// the import succeeds and the first real call throws "Buffer is not defined".
// Verified in phase 2 by running the sdk with window/document/Buffer deleted.
//
// This supplies a missing platform global. It is not a fallback and it does not
// change any behaviour when Buffer already exists.
import { Buffer } from "buffer";

declare global {
  var Buffer: typeof import("buffer").Buffer;
}

if (typeof globalThis.Buffer === "undefined") {
  globalThis.Buffer = Buffer;
}
