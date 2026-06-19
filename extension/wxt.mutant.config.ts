// Mutation-testing build. Same extension, a COPY of the source, a different
// output directory.
//
// Mutation testing means building a deliberately broken wallet, and this
// checkout is shared with nine other agents. Editing src/ in place, even for
// the second it takes to build, risks another agent reading or overwriting a
// deliberately broken file. So the mutation is applied to a copy named by
// POCKET_MUT_SRC and the broken build lands in .output-mutant, which nothing
// else reads. Point the suite at it with POCKET_EXT_PATH.
import base from "./wxt.config";
import { defineConfig } from "wxt";

export default defineConfig({
  ...base,
  srcDir: process.env.POCKET_MUT_SRC ?? "src",
  outDir: ".output-mutant",
});
