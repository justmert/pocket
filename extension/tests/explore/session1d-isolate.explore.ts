// Session 1d — isolating which error the private build path actually throws.
//
// "root cause unknown" is a weak defect report. The user-visible message is the
// generic one, which means describeError fell through both allowlists, which
// means the error's NAME is not in SAFE_ERRORS and its MESSAGE is not in
// SAFE_MESSAGES. PrivatePocketError, AccountNotFoundError and
// ConfidentialReadError are all on the list, so it is none of those.
//
// The worker does not log the raw error anywhere, so this wraps describeError's
// input at the source: patch the worker's own error path from the outside is not
// possible, but the popup CAN ask the worker to do the thing and read what comes
// back, and the service worker's console is reachable through the harness.
import { test } from "../support/fixtures";
import { WAITS } from "../support/wallet";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT = join(process.cwd(), "..", "qa", "exploration", "session1");
const PASSWORD = "correct horse battery staple";
const TO = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";

test("session 1d: which error escapes the allowlist", async ({ wallet, harness }) => {
  test.setTimeout(14 * 60_000);
  const page = wallet.page;
  const worker = await harness.worker();

  // Collect everything the worker says, including anything thrown that it does
  // not catch, before provoking the failure.
  const workerSaid: string[] = [];
  worker.on("console", (m) => workerSaid.push(`${m.type()}: ${m.text().slice(0, 300)}`));

  await wallet.createWallet(PASSWORD);
  await wallet.waitForHome(WAITS.ledgerRead);

  // Ask the worker directly, so nothing about the popup is in the way. This
  // throws with the SANITISED message; the raw one is what we are after, so the
  // worker's own uncaught-rejection reporting is the channel.
  const sanitised = await page.evaluate(
    ([to]) =>
      new Promise<string>((res) => {
        chrome.runtime.sendMessage(
          { type: "buildPrivateOp", op: { kind: "transfer", to, amount: "1" } },
          (r: { ok: boolean; error?: string }) =>
            res(r?.ok ? "(it succeeded)" : (r?.error ?? "(no answer)")),
        );
      }),
    [TO] as const,
  );

  await page.waitForTimeout(2000);

  mkdirSync(OUT, { recursive: true });
  writeFileSync(
    join(OUT, "D-error-isolation.txt"),
    `asked the worker to build a private transfer on an account that does not exist on chain\n` +
      `and has no confidential pocket.\n\n` +
      `WHAT THE USER IS TOLD:\n  ${sanitised}\n\n` +
      `WHAT THE WORKER SAID ON ITS OWN CONSOLE (${workerSaid.length} lines):\n` +
      (workerSaid.length ? workerSaid.map((l) => "  " + l).join("\n") : "  (nothing)") +
      `\n`,
  );
});
