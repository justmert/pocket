// A render throw must not leave a blank rectangle in front of someone's money.
//
// There was no boundary anywhere in the popup, so a throw during render
// unmounted the whole tree: `#root.childElementCount` went to 0 and, because
// the frame is the node Chrome sizes the popup from, the window collapsed with
// it. What the user saw was an empty coloured box, indistinguishable from a
// broken install.
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ErrorBoundary } from "./ErrorBoundary";

/**
 * `renderToStaticMarkup` does not run a boundary: server rendering has no
 * commit phase, so `getDerivedStateFromError` never fires. The boundary's
 * BEHAVIOUR is therefore exercised through its own static method and its
 * failed-state render, which is what the browser reaches.
 */
describe("the popup's error boundary", () => {
  it("switches to a failed state rather than rethrowing", () => {
    expect(ErrorBoundary.getDerivedStateFromError()).toEqual({ failed: true });
  });

  it("draws something, rather than nothing", () => {
    const b = new ErrorBoundary({ children: null });
    b.state = { failed: true };
    const html = renderToStaticMarkup(<>{b.render()}</>);
    expect(html.length, "the failed state renders an empty tree").toBeGreaterThan(200);
    expect(html).toMatch(/Pocket/);
  });

  it("never puts the thrown message on screen", () => {
    // An arbitrary message can carry an RPC URL, a stack fragment or witness
    // material, which is why `dispatch.ts` keeps an allowlist by error NAME.
    // A boundary has no way to tell a safe message from an unsafe one.
    const b = new ErrorBoundary({ children: null });
    b.state = { failed: true };
    b.componentDidCatch(new Error("rpc://internal-host/secret-path"), { componentStack: "" });
    const html = renderToStaticMarkup(<>{b.render()}</>);
    expect(html).not.toMatch(/internal-host|secret-path/);
  });

  it("passes children straight through when nothing has thrown", () => {
    const html = renderToStaticMarkup(
      <ErrorBoundary>
        <p>ordinary</p>
      </ErrorBoundary>,
    );
    expect(html).toContain("ordinary");
  });

  it("is mounted outside the provider, which is as able to throw as anything", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const app = readFileSync(fileURLToPath(new URL("./App.tsx", import.meta.url)), "utf8");
    const boundary = app.indexOf("<ErrorBoundary>");
    const provider = app.indexOf("<WalletProvider");
    expect(boundary, "no boundary in App at all").toBeGreaterThan(-1);
    expect(provider, "no provider in App at all").toBeGreaterThan(-1);
    expect(boundary, "the boundary sits inside the provider it is meant to catch").toBeLessThan(
      provider,
    );
  });
});
