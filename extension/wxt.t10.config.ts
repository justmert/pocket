// T10's build. Same extension, its own output directory.
//
// Ten agents share this checkout and the shared `.output/chrome-mv3` is
// rebuilt by whoever is mid-run, so a spec pointed at it can be measuring
// somebody else's mutation. POCKET_T10_SRC also lets an OLD commit's source
// tree be built here unchanged, which is how the migration specs get a
// previous version's stored data without editing src/.
import base from "./wxt.config";
import { defineConfig } from "wxt";

export default defineConfig({
  ...base,
  srcDir: process.env.POCKET_T10_SRC ?? "src",
  outDir: process.env.POCKET_T10_OUT ?? ".output-t10",
});
