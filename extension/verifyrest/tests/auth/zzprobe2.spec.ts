import { test } from "@playwright/test";
import { launchWallet } from "../support/extension";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

test("frame probe", async () => {
  const h = await launchWallet();
  const server = createServer((_q, r) => { r.writeHead(200, {"content-type":"text/html"}); r.end("<!doctype html><body><h1>hi</h1></body>"); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const page = await h.context.newPage();
  await page.goto(`http://127.0.0.1:${port}/`);
  const out = await page.evaluate(async () => {
    const seen: string[] = [];
    window.addEventListener("message", (e: MessageEvent) => {
      const d = e.data as { channel?: string; id?: string };
      if (d?.channel?.startsWith("pocket:sep43")) {
        seen.push(`${d.channel} id=${d.id} sourceIsWindow=${e.source === window}`);
      }
    });
    const iframe = document.createElement("iframe");
    iframe.src = "about:blank";
    document.body.appendChild(iframe);
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    const win = iframe.contentWindow!;
    const bodyExists = !!win.document.body;
    const s = win.document.createElement("script");
    s.textContent = 'window.parent.postMessage({channel:"pocket:sep43",id:"frame-1",method:"getAddress",params:[]}, "*")';
    (win.document.body ?? win.document.documentElement).appendChild(s);
    await new Promise((r) => setTimeout(r, 2500));
    return { bodyExists, hasProvider: "pocket" in win, seen };
  });
  console.log("[probe]", JSON.stringify(out, null, 1));
  await new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); });
  await h.close();
});
