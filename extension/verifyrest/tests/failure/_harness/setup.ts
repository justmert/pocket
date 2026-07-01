// The fault harness serves TLS with a throwaway certificate for 127.0.0.1,
// because `rpc.Server` refuses a plain-http URL and the wallet builds it without
// the opt-out. Trusting that certificate is the price of testing the real
// client. Scoped to this suite's own vitest config, so nothing else inherits it.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

// Node prints a warning for the line above on every run. It is correct and it is
// deliberate here, so it is stated once rather than repeated over the output.
const warn = process.emitWarning.bind(process);
process.emitWarning = ((message: unknown, ...rest: unknown[]) => {
  if (typeof message === "string" && message.includes("NODE_TLS_REJECT_UNAUTHORIZED")) return;
  return (warn as (...a: unknown[]) => void)(message, ...rest);
}) as typeof process.emitWarning;
