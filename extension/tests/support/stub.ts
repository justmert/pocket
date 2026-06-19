// Network stubs, at the NETWORK boundary only.
//
// Nothing here mocks wallet code. Every helper intercepts HTTP on its way out
// of the browser, which is the only place a dependency can be made to fail
// without changing what is under test. A test that reaches into `core/` to make
// a function throw is testing the mock.
//
// MV3 puts every chain call in the service worker, and Playwright does not
// surface service-worker requests to `context.route` unless
// PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS is set. The suite's config sets
// it; `serviceWorkerRoutingAvailable` below reports whether it took effect, so
// a spec can state the limitation rather than pass vacuously.
import type { BrowserContext, Route } from "@playwright/test";

export const RPC_HOST = "soroban-testnet.stellar.org";
export const HORIZON_HOST = "horizon-testnet.stellar.org";
export const FRIENDBOT_HOST = "friendbot.stellar.org";

export function serviceWorkerRoutingAvailable(): boolean {
  return process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS === "1";
}

/** Every request to a host, refused as if the machine were offline. */
export async function offline(context: BrowserContext, host: string): Promise<void> {
  await context.route(`**://${host}/**`, (route) => route.abort("connectionfailed"));
}

/** Every request to a host answered with a status and body of your choosing. */
export async function respondWith(
  context: BrowserContext,
  host: string,
  reply: { status: number; body?: string; contentType?: string },
): Promise<void> {
  await context.route(`**://${host}/**`, (route) =>
    route.fulfill({
      status: reply.status,
      contentType: reply.contentType ?? "application/json",
      body: reply.body ?? "{}",
    }),
  );
}

/**
 * Hold every request to a host open, never answering.
 *
 * The honest way to test a timeout: an aborted request is a different failure
 * from a server that accepts the connection and goes quiet, and only the second
 * one exercises the request deadline.
 */
export async function hang(context: BrowserContext, host: string): Promise<void> {
  await context.route(`**://${host}/**`, () => {
    /* deliberately never settled */
  });
}

/** Full control, for anything the shapes above do not cover. */
export async function intercept(
  context: BrowserContext,
  host: string,
  handler: (route: Route) => void | Promise<void>,
): Promise<void> {
  await context.route(`**://${host}/**`, handler);
}

/** Remove every stub and let real traffic through again, to test recovery. */
export async function restore(context: BrowserContext, host: string): Promise<void> {
  await context.unroute(`**://${host}/**`);
}
