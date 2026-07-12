// What the worker tells you to do about a private balance it cannot account for.
//
// Five worker-authored sentences asserted "this build has none configured" as a
// flat constant, none of them reading `archiveUrl`. That is the same defect
// D-009 recorded and closed on the UI side, reappearing one layer down: the
// popup learned to gate the Rebuild CONTROL on `canRebuild` and the worker's
// SENTENCES did not. On a build with an archive the wallet says rebuilding is
// impossible immediately above a working button, and the only way to find out
// which is true is to press it.
import { describe, it, expect } from "vitest";
import { rebuildAdvice } from "./controller";
import { canRebuild } from "../entrypoints/popup/ui/copy";
import { NETWORKS } from "./config";

describe("advice about rebuilding", () => {
  it("says an archive is needed and absent when that is true", () => {
    const said = rebuildAdvice(undefined);
    expect(said).toMatch(/none configured/);
    expect(said).not.toMatch(/Settings/);
  });

  it("points at the control that exists when one does", () => {
    const said = rebuildAdvice("https://archive.example");
    expect(said).not.toMatch(/none configured/);
    // The sentence has to name where the button is, or it states a capability
    // and leaves the user to find it.
    expect(said).toMatch(/Settings/);
  });

  it("agrees with the control the popup actually renders", () => {
    // The invariant. `canRebuild` gates the button on `archiveUrl` and this
    // gates the sentence on the same fact, so they cannot contradict each other
    // on any network.
    for (const id of Object.keys(NETWORKS) as (keyof typeof NETWORKS)[]) {
      const url = NETWORKS[id].archiveUrl;
      const offered = canRebuild(id);
      expect(offered, id).toBe(Boolean(url));
      expect(rebuildAdvice(url).includes("none configured"), id).toBe(!offered);
    }
  });
});
