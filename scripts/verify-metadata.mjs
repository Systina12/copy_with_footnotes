import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createContext, runInContext } from "node:vm";
import { resolve } from "node:path";
import { build } from "esbuild";

// Supply the worker from an official Obsidian release; it is never shipped with the plugin.
const [workerPath, version, mode] = process.argv.slice(2);
if (!workerPath || !version) throw new Error("Usage: npm run test:metadata -- <worker.js> <version> [--write]");
const cases = JSON.parse(await readFile(new URL("../tests/cases.json", import.meta.url), "utf8"));
let metadata;
const self = { postMessage: (message) => { metadata = message; } };
const context = createContext({ self, console, TextEncoder, TextDecoder, performance, setTimeout, clearTimeout });
runInContext(await readFile(workerPath, "utf8"), context, { timeout: 10000 });
const compiled = await build({ entryPoints: ["src/footnotes.ts"], bundle: true, write: false, format: "esm" });
const { buildClipboardText } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].contents).toString("base64")}`);
const fixtures = [];
for (const item of cases) {
  metadata = undefined;
  self.onmessage({ data: { metadataCache: new TextEncoder().encode(item.source).buffer } });
  assert.ok(metadata, `${item.name}: worker did not return metadata`);
  const cache = { footnotes: metadata.footnotes ?? [], footnoteRefs: metadata.footnoteRefs ?? [] };
  const start = item.source.indexOf(item.selection);
  const output = buildClipboardText({ source: item.source, selectionStart: start, selectionEnd: start + item.selection.length, cache });
  assert.equal(output, item.expected, `${version}: ${item.name}`);
  fixtures.push({ name: item.name, ...cache });
}
const outputPath = resolve(`tests/fixtures/obsidian-${version}.json`);
if (mode === "--write") {
  await mkdir(resolve("tests/fixtures"), { recursive: true });
  await writeFile(outputPath, JSON.stringify({ version, fixtures }, null, 2) + "\n");
} else {
  assert.deepEqual(JSON.parse(JSON.stringify({ version, fixtures })), JSON.parse(await readFile(outputPath, "utf8")));
}
console.log(`Obsidian ${version}: ${cases.length} real metadata/clipboard cases passed; positions match fixtures.`);
