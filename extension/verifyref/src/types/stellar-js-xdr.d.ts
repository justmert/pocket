// `@stellar/js-xdr` ships no types for its readers.
//
// We need `XdrReader` because the archive stores an event's topics as the
// ledger's ScVals concatenated with no envelope, so the only way to know how
// many there are is to decode until the buffer is spent. The SDK's own
// generated `xdr` namespace uses the same reader internally but does not
// re-export it.
//
// Declared narrowly on purpose: only what we call, so a wrong assumption about
// the rest of the package cannot hide behind `any`. Checked against
// @stellar/js-xdr 4.0.0.
declare module "@stellar/js-xdr" {
  export class XdrReader {
    constructor(source: Buffer | Uint8Array);
    /** True once every byte has been consumed. */
    readonly eof: boolean;
  }
  export class XdrWriter {
    constructor(size?: number);
  }
  const jsXdr: { XdrReader: typeof XdrReader; XdrWriter: typeof XdrWriter };
  export default jsXdr;
}
