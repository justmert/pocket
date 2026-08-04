// Every sheet is a dialog with a name.
//
// `Sheet` renders `role="dialog" aria-modal="true"`. A dialog with no
// accessible name is announced as "dialog" and nothing else, which tells a
// screen-reader user that something has taken over the screen and not what.
//
// Four sheets pass `title=" "` deliberately, because their own body carries the
// heading and a second one above it would be noise to a sighted reader. That is
// a legitimate choice and it makes `ariaLabel` mandatory, which is the thing a
// new sheet can quietly not do.
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("./", import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return sources(p);
    return f.endsWith(".tsx") && !f.includes(".test.") ? [p] : [];
  });
}

/**
 * Every `<Sheet ...>` OPENING TAG in the tree, with its file.
 *
 * Scanned with a brace counter rather than matched with `[\s\S]*?>`, because a
 * prop can legitimately contain a `>`: `onClose={busy ? () => undefined :
 * close}` ends the lazy match four props early, and the tag then looks
 * nameless when its `title` is simply further down.
 */
function sheetTags(): { file: string; tag: string }[] {
  const out: { file: string; tag: string }[] = [];
  for (const file of sources(ROOT)) {
    const src = readFileSync(file, "utf8");
    // The definition itself is not a call site.
    if (file.endsWith("primitives.tsx")) continue;
    for (const m of src.matchAll(/<Sheet\b/g)) {
      let depth = 0;
      let end = m.index!;
      for (let i = m.index!; i < src.length; i++) {
        const c = src[i]!;
        if (c === "{") depth++;
        else if (c === "}") depth--;
        else if (c === ">" && depth === 0 && src[i - 1] !== "=") {
          end = i + 1;
          break;
        }
      }
      out.push({ file, tag: src.slice(m.index!, end) });
    }
  }
  return out;
}

describe("a sheet", () => {
  it("is drawn somewhere, or this file is checking nothing", () => {
    expect(sheetTags().length).toBeGreaterThan(3);
  });

  it("always has an accessible name", () => {
    const nameless: string[] = [];
    for (const { file, tag } of sheetTags()) {
      if (/ariaLabel=/.test(tag)) continue;
      const title = /title=(?:"([^"]*)"|\{([^}]*)\})/.exec(tag);
      // A title with real text names the dialog. A blank one, or none at all,
      // does not, and then `ariaLabel` is the only thing that can.
      const named = title ? (title[1] !== undefined ? title[1].trim() !== "" : true) : false;
      if (!named) nameless.push(`${file.split("/ui/")[1]}: ${tag.split("\n")[0]}`);
    }
    expect(nameless, `a dialog announced as just "dialog":\n${nameless.join("\n")}`).toEqual([]);
  });
});
