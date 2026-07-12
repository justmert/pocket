import { describe, it, expect, vi } from "vitest";
import { IrisClient, IrisError } from "./iris";

const cfg = { baseUrl: "https://iris-api-sandbox.circle.com" };

/** A fetch mock with a controllable status and JSON body. */
const fetchWith = (status: number, body: unknown) =>
  vi.fn(async (_url: string) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })) as unknown as typeof fetch;

describe("IrisClient.attestation", () => {
  it("queries /v2/messages/{domain}?transactionHash= and reports ready when complete", async () => {
    let seen = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        seen = url;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            messages: [{ status: "complete", message: "0xaabb", attestation: "0xccdd" }],
          }),
        };
      }) as unknown as typeof fetch,
    );
    const att = await new IrisClient(cfg).attestation(6, "TXHASH");
    expect(seen).toBe(`${cfg.baseUrl}/v2/messages/6?transactionHash=TXHASH`);
    expect(att).toEqual({
      status: "complete",
      ready: true,
      message: "0xaabb",
      attestation: "0xccdd",
    });
  });

  it("is not ready while the attestation is still the PENDING sentinel", async () => {
    vi.stubGlobal(
      "fetch",
      fetchWith(200, { messages: [{ status: "pending_confirmations", attestation: "PENDING" }] }),
    );
    const att = await new IrisClient(cfg).attestation(6, "TX");
    expect(att.ready).toBe(false);
    expect(att.attestation).toBeUndefined();
    expect(att.status).toBe("pending_confirmations");
  });

  it("treats a 404 (not indexed yet) as pending, not an error", async () => {
    vi.stubGlobal("fetch", fetchWith(404, {}));
    const att = await new IrisClient(cfg).attestation(6, "TX");
    expect(att).toEqual({ status: "pending", ready: false });
  });

  it("treats an empty messages array as pending", async () => {
    vi.stubGlobal("fetch", fetchWith(200, { messages: [] }));
    const att = await new IrisClient(cfg).attestation(6, "TX");
    expect(att.ready).toBe(false);
  });

  it("surfaces a non-404 HTTP error as a typed IrisError with the status", async () => {
    vi.stubGlobal("fetch", fetchWith(500, {}));
    await expect(new IrisClient(cfg).attestation(6, "TX")).rejects.toMatchObject({
      name: "IrisError",
      status: 500,
    });
  });

  it("wraps a network failure in an IrisError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("connection reset");
      }) as unknown as typeof fetch,
    );
    await expect(new IrisClient(cfg).attestation(6, "TX")).rejects.toBeInstanceOf(IrisError);
  });
});
