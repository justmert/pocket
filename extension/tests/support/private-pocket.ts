// A private pocket that is open, for tests that need to reach a private screen.
//
// Why this exists. Reaching the private compose form used to need nothing at
// all: switch pocket, press the send control, and the form appeared regardless
// of whether a private pocket existed. Several specs relied on that, so they
// were driving a screen through a path a real user should never have. Defect
// D-002 closed the path — the send sheet now answers with the pocket's state
// instead of offering a form it cannot fulfil — and those specs need to arrange
// the state their subject actually lives in.
//
// This is a shortcut, and it is the honest kind: opening a real confidential
// account takes two on-chain transactions and a proof, which is not something a
// styling test should be paying for. The wire shape is exactly what the worker
// answers, so what the popup renders is what it would render for real.
import type { Page } from "@playwright/test";

/** the fields `PrivatePocket` carries when the pocket is open and spendable. */
export const READY_POCKET = {
  state: "ready",
  spendable: "12.5000000",
  mergeAvailable: false,
  auditorId: 1,
} as const;

/**
 * answer `privatePocket` with an open pocket, and force `privateAvailable`.
 *
 * must be called BEFORE the page that will read it loads, and the caller
 * reloads afterwards if the page is already up — `addInitScript` does not reach
 * a document that has already run.
 */
export async function stubReadyPrivatePocket(
  page: Page,
  pocket: Record<string, unknown> = READY_POCKET,
): Promise<void> {
  await page.addInitScript((p) => {
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (chrome.runtime as any).sendMessage = async (msg: { type?: string }) => {
      if (msg?.type === "privatePocket") return { ok: true, data: p };
      if (msg?.type === "status") {
        const real = await send(msg);
        if (real?.ok) return { ok: true, data: { ...real.data, privateAvailable: true } };
        return real;
      }
      return send(msg);
    };
  }, pocket);
}
