// Network stubs, at the NETWORK boundary only.
//
// Nothing here mocks wallet code. Every helper intercepts HTTP on its way out
// of the browser, which is the only place a dependency can be made to fail
// without changing what is under test. A test that reaches into `core/` to make
// a function throw is testing the mock.
//
// MV3 puts EVERY chain call in the service worker, so a stub that only reaches
// page traffic would silently do nothing and every failure-injection test would
// pass while injecting no failure. Playwright does not surface service-worker
// requests to `context.route` unless PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS
// is set; the suite's config sets it, and `service-worker-routing.spec.ts`
// proves it takes effect rather than assuming it.
import type { BrowserContext, Route } from "@playwright/test";

export const RPC_HOST = "soroban-testnet.stellar.org";
export const HORIZON_HOST = "horizon-testnet.stellar.org";
export const FRIENDBOT_HOST = "friendbot.stellar.org";

export function serviceWorkerRoutingAvailable(): boolean {
  return process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS === "1";
}

/**
 * Match by parsed host, not by glob.
 *
 * A glob has to guess how the URL is spelled, and the RPC endpoint is posted to
 * with an empty path, which is exactly the case a trailing `/**` is least
 * reliable about. Parsing the URL cannot be wrong about which host a request is
 * going to.
 */
const MATCHERS = new Map<string, (url: URL) => boolean>();

function toHost(host: string): (url: URL) => boolean {
  // Memoised, and that is load-bearing rather than an optimisation.
  //
  // `context.unroute(matcher)` identifies the route to remove by the matcher
  // itself, and a fresh closure is never equal to the one that was registered.
  // Building a new function per call made `restore()` a silent no-op: the stub
  // stayed installed, the dependency never "came back", and every
  // recovers-when-the-dependency-returns test would have failed -- or, written
  // more loosely, passed while proving nothing. Caught by a real red in
  // `ui-states/async-states.spec.ts`.
  let m = MATCHERS.get(host);
  if (!m) {
    m = (url: URL) => url.host === host;
    MATCHERS.set(host, m);
  }
  return m;
}

/** Every request to a host, refused as if the machine were offline. */
export async function offline(context: BrowserContext, host: string): Promise<void> {
  await context.route(toHost(host), (route) => route.abort("connectionfailed"));
}

/** Every request to a host answered with a status and body of your choosing. */
export async function respondWith(
  context: BrowserContext,
  host: string,
  reply: { status: number; body?: string; contentType?: string },
): Promise<void> {
  await context.route(toHost(host), (route) =>
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
  await context.route(toHost(host), () => {
    /* deliberately never settled */
  });
}

/** Full control, for anything the shapes above do not cover. */
export async function intercept(
  context: BrowserContext,
  host: string,
  handler: (route: Route) => void | Promise<void>,
): Promise<void> {
  await context.route(toHost(host), handler);
}

/** Remove every stub for a host and let real traffic through again. */
export async function restore(context: BrowserContext, host: string): Promise<void> {
  await context.unroute(toHost(host));
}

/** What `watch` saw. A stub that was never hit did not stub anything. */
export interface Traffic {
  /** Every request to the host that the route handler actually saw. */
  urls: string[];
  /** How many of those were made by a service worker rather than a page. */
  fromServiceWorker: number;
  get total(): number;
}

/**
 * Count traffic to a host without changing it.
 *
 * The point of `fromServiceWorker`: asserting only that a stub "was hit" proves
 * nothing about MV3, because the popup page makes requests too. An assertion
 * that a stub reached the SERVICE WORKER is what distinguishes a real failure
 * injection from one that silently passed through.
 */
export async function watch(context: BrowserContext, host: string): Promise<Traffic> {
  const traffic: Traffic = {
    urls: [],
    fromServiceWorker: 0,
    get total() {
      return this.urls.length;
    },
  };
  await context.route(toHost(host), (route) => {
    const request = route.request();
    traffic.urls.push(request.url());
    if (request.serviceWorker()) traffic.fromServiceWorker++;
    void route.continue();
  });
  return traffic;
}
