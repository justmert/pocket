// T8's build. Same extension, its own output directory.
//
// Ten agents share this checkout and several of them build deliberately broken
// wallets. A viewport measurement is only meaningful against a KNOWN build, so
// T8 never reads .output/chrome-mv3: it builds here and points the suite at it
// with POCKET_EXT_PATH. POCKET_MUT_SRC swaps in a mutated copy of src/ for the
// red half of a shown-failing pair, exactly as wxt.mutant.config.ts does.
import base from "./wxt.config";
import { defineConfig } from "wxt";

export default defineConfig({
  ...base,
  srcDir: process.env.POCKET_MUT_SRC ?? "src",
  outDir: process.env.POCKET_T8_OUT ?? ".output-t8",
});
