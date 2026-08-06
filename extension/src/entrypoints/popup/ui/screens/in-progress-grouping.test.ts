// "In progress" has to mean in progress.
//
// The watched-operations section held everything that was not done, which
// included failures with no hash: a rejected submission, an expired envelope, a
// build that never reached the network. Nothing landed and nothing was charged,
// so there is no on-chain transaction for Activity to show and they cannot be
// dropped. What they are not is in progress, and a heading that says so about a
// transaction that has finished failing tells the user to keep waiting for an
// answer that has already arrived.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { stillOpen, neverSent } from "./History";
import type { BgOp } from "../WalletProvider";

const SRC = readFileSync(fileURLToPath(new URL("./History.tsx", import.meta.url)), "utf8");

// The screen's OWN predicates, not a copy: a test that reimplements the rule
// it is checking passes just as happily while the shipped code is wrong.
const inProgressOf = (ops: BgOp[], pocket: string) => ops.filter((o) => stillOpen(o, pocket));
const didNotSendOf = (ops: BgOp[], pocket: string) => ops.filter((o) => neverSent(o, pocket));

const op = (over: Partial<BgOp>): BgOp =>
  ({ id: "1", pocket: "public", verb: "Send", status: "processing", at: 0, ...over }) as BgOp;

describe("which watched operations sit under which heading", () => {
  it("keeps a running one under In progress", () => {
    const ops = [op({ status: "processing" })];
    expect(inProgressOf(ops, "public")).toHaveLength(1);
    expect(didNotSendOf(ops, "public")).toHaveLength(0);
  });

  it("keeps an unresolved one there too, because it may still land", () => {
    const ops = [op({ id: "2", status: "unresolved" })];
    expect(inProgressOf(ops, "public")).toHaveLength(1);
  });

  it("moves a failure that never reached the network out of it", () => {
    const ops = [op({ id: "3", status: "failed" })];
    expect(inProgressOf(ops, "public"), "a finished failure sat under In progress").toHaveLength(0);
    expect(didNotSendOf(ops, "public")).toHaveLength(1);
  });

  it("leaves a failure that DID land to the settled list", () => {
    // It has an on-chain transaction, so it is drawn as a failed history row
    // rather than as a watched card.
    const ops = [op({ id: "4", status: "failed", hash: "h".repeat(64) })];
    expect(inProgressOf(ops, "public")).toHaveLength(0);
    expect(didNotSendOf(ops, "public")).toHaveLength(0);
  });

  it("keeps a done one out of both", () => {
    expect(inProgressOf([op({ id: "5", status: "done" })], "public")).toHaveLength(0);
    expect(didNotSendOf([op({ id: "5", status: "done" })], "public")).toHaveLength(0);
  });

  it("draws the second group under a heading that says what it is", () => {
    expect(SRC, "the two groups share one heading again").toContain("Did not go through");
    expect(SRC).toContain("In progress");
  });
});
