// T5's build. Same extension, its own output directory.
//
// The auth specs open a REAL web page and ask what it can reach, so they need a
// build whose manifest and content script are known. `.output/chrome-mv3` is
// shared with a dozen agents, several of whom build deliberately broken
// wallets; one of my runs already failed with ENOENT because somebody else's
// build had deleted the directory mid-read. So T5 builds here and points the
// suite at it with POCKET_EXT_PATH.
//
// POCKET_MUT_SRC swaps in a mutated copy of src/, which is how a browser spec
// is shown failing without touching the shared tree.
import base from "./wxt.config";
import { defineConfig } from "wxt";

export default defineConfig({
  ...base,
  srcDir: process.env.POCKET_MUT_SRC ?? "src",
  outDir: process.env.POCKET_T5_OUT ?? ".output-t5",
});
