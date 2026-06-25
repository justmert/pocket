import { test, expect } from "@playwright/test";
import { Wallet } from "../support/wallet";
import * as ledger from "../support/testnet";
import { open, installBuild, swappablePath, OLD_BUILD, OLD_VERSION, PASSWORD } from "./harness";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("old build probe", async ({}, info) => {
  test.setTimeout(10 * 60_000);
  const at = swappablePath(info.parallelIndex);
  const dir = mkdtempSync(join(tmpdir(), "oldprobe-"));
  installBuild(OLD_BUILD, at, OLD_VERSION);
  const inst = await open(dir, at);
  const say = async (page: any, what: string) =>
    console.log(`  [${what}] ${(await page.locator("body").innerText()).replace(/\n+/g, " | ").slice(0, 300)}`);
  try {
    const page = await inst.popup();
    const w = new Wallet(page);
    await w.createWallet(PASSWORD);
    const address = await w.revealAddress();
    await ledger.fund(address);
    await w.reopen();
    await w.waitForHome(60_000);
    await say(page, "home");
    await w.openPrivatePocket();
    await say(page, "pocket");
    await expect(page.getByText("Not set up yet")).toBeVisible({ timeout: 60_000 });
    await page.getByRole("button", { name: "Set up the private pocket" }).click();
    for (const s of [10, 30, 60, 120, 240]) {
      await page.waitForTimeout(s === 10 ? 10_000 : 20_000);
      await say(page, `after set-up +${s}s`);
      if ((await page.getByText("What this does").count()) > 0) break;
    }
    if ((await page.getByText("What this does").count()) > 0) {
      await page.getByRole("button", { name: "Approve" }).click();
      for (let i = 0; i < 8; i++) {
        await page.waitForTimeout(20_000);
        await say(page, `after approve #${i}`);
        if ((await page.getByText(/Confirmed on the ledger/).count()) > 0) break;
      }
    }
  } finally {
    await inst.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(at, { recursive: true, force: true });
  }
});
