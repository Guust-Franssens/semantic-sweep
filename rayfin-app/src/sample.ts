// Embedded demo data: the synthetic brewery seed models (safe to bundle), loaded as raw TMDL text.
import type { InputFile } from "@engine/parser";

const mods = import.meta.glob("./sample/**/*.tmdl", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

export const sampleFiles: InputFile[] = Object.entries(mods).map(([path, text]) => ({
  // strip the leading "./sample/" so paths look like "<workspace>/<model>.SemanticModel/..."
  path: path.replace(/^\.\/sample\//, ""),
  text,
}));
