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
const pasteCompiled = await build({ entryPoints: ["src/paste.ts"], bundle: true, write: false, format: "esm", platform: "node" });
const { buildPasteEdits, pasteCaretPosition } = await import(`data:text/javascript;base64,${Buffer.from(pasteCompiled.outputFiles[0].contents).toString("base64")}`);
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

const pasteCases = JSON.parse(await readFile(new URL("../tests/paste-cases.json", import.meta.url), "utf8"));
const pasteFixtures = [];
const traditionalDefinitions = (source, cache) => (cache.footnotes ?? []).flatMap((definition) => {
  const text = source.slice(definition.position.start.offset, definition.position.end.offset);
  const marker = /^ {0,3}\[\^([^\s\[\]\\]+)\]:/.exec(text);
  return marker?.[1].toLowerCase() === definition.id.toLowerCase()
    ? [`${definition.id.toLowerCase()}\0${text.replace(/\r\n?/g, "\n")}`] : [];
});
for (const item of pasteCases) {
  const start = item.target.indexOf("|");
  assert.ok(start >= 0, `${item.name}: missing paste marker`);
  const source = item.target.slice(0, start) + item.target.slice(start + 1);
  assert.equal(source.slice(start, start + (item.selection?.length ?? 0)), item.selection ?? "");
  metadata = undefined;
  self.onmessage({ data: { metadataCache: new TextEncoder().encode(source).buffer } });
  assert.ok(metadata, `${item.name}: worker did not return destination metadata`);
  const cache = { footnotes: metadata.footnotes ?? [], footnoteRefs: metadata.footnoteRefs ?? [], sections: metadata.sections ?? [] };
  const plan = buildPasteEdits({ source, clipboard: item.clipboard, selectionStart: start,
    selectionEnd: start + (item.selection?.length ?? 0), cache, cacheSource: source,
    placement: item.placement, insertionSide: item.insertionSide });
  assert.equal(plan.reason, item.cancelReason, `${version}: ${item.name}: unexpected cancellation`);
  if (item.cancelReason) { assert.equal(plan.status, "cancelled"); assert.deepEqual(plan.changes, []); }
  assert.equal(plan.result, item.expected, `${version}: ${item.name}: paste result`);
  if (item.summary) assert.deepEqual(plan.summary, item.summary, `${version}: ${item.name}: result notification counts`);
  if (plan.status === "footnotes" || item.expectedIds || item.expectedRefs) {
    self.onmessage({ data: { metadataCache: new TextEncoder().encode(plan.result).buffer } });
    if (plan.status === "footnotes") {
      const before = traditionalDefinitions(source, cache);
      const after = traditionalDefinitions(plan.result, metadata);
      assert.equal(after.length - before.length, plan.summary.added, `${version}: ${item.name}: native added-definition count`);
      const remaining = [...after];
      for (const definition of before) {
        const index = remaining.indexOf(definition);
        assert.ok(index >= 0, `${version}: ${item.name}: existing definition changed or disappeared`);
        remaining.splice(index, 1);
      }
    }
    if (item.expectedIds) assert.deepEqual(Array.from(metadata.footnotes ?? [], (definition) => definition.id), item.expectedIds,
      `${version}: ${item.name}: actual resulting definition IDs`);
    if (item.expectedRefs) assert.deepEqual(Array.from(metadata.footnoteRefs ?? [], (reference) => reference.id), item.expectedRefs,
      `${version}: ${item.name}: actual resulting reference IDs`);
  }
  pasteFixtures.push({ name: item.name, cache });
}
const pasteOutputPath = resolve(`tests/fixtures/paste-obsidian-${version}.json`);
const pasteOutput = JSON.parse(JSON.stringify({ version, fixtures: pasteFixtures }));
if (mode === "--write") await writeFile(pasteOutputPath, JSON.stringify(pasteOutput, null, 2) + "\n");
else assert.deepEqual(pasteOutput, JSON.parse(await readFile(pasteOutputPath, "utf8")));
console.log(`Obsidian ${version}: ${pasteCases.length} real Paste cases passed, including duplicate destination IDs.`);

const sequences = JSON.parse(await readFile(new URL("../tests/paste-sequences.json", import.meta.url), "utf8"));
const sequenceFixtures = [];
for (const item of sequences) {
  let source = item.source;
  let caret = 0;
  const steps = [];
  for (let round = 0; round < 5; round++) {
    self.onmessage({ data: { metadataCache: new TextEncoder().encode(source).buffer } });
    const cache = { footnotes: metadata.footnotes ?? [], footnoteRefs: metadata.footnoteRefs ?? [], sections: metadata.sections ?? [] };
    steps.push({ source, caret, cache });
    const plan = buildPasteEdits({ source, clipboard: item.clipboard, selectionStart: caret, selectionEnd: caret, cache, cacheSource: source });
    assert.equal(plan.status, "footnotes", `${version}: ${item.name}: round ${round + 1}`);
    assert.deepEqual(plan.summary, { added: round ? 0 : item.firstAdded,
      reused: item.reused - (round ? 0 : item.firstAdded), renamed: item.renamed });
    source = plan.result.replace(/\r\n?/g, "\n"); // The real editor normalizes inserted newlines.
    assert.equal(source, item.body.repeat(round + 1) + item.suffix, `${version}: ${item.name}: round ${round + 1} result`);
    const position = pasteCaretPosition(plan);
    caret = source.split("\n").slice(0, position.line).reduce((sum, line) => sum + line.length + 1, 0) + position.ch;
    assert.equal(caret, item.body.repeat(round + 1).length);
    self.onmessage({ data: { metadataCache: new TextEncoder().encode(source).buffer } });
    assert.deepEqual(Array.from(metadata.footnotes ?? [], (definition) => definition.id), item.ids);
  }
  sequenceFixtures.push({ name: item.name, steps });
}
const sequencePath = resolve(`tests/fixtures/sequences-obsidian-${version}.json`);
const sequenceOutput = JSON.parse(JSON.stringify({ version, fixtures: sequenceFixtures }));
if (mode === "--write") await writeFile(sequencePath, JSON.stringify(sequenceOutput, null, 2) + "\n");
else assert.deepEqual(sequenceOutput, JSON.parse(await readFile(sequencePath, "utf8")));
console.log(`Obsidian ${version}: ${sequences.length} sequences / ${sequences.length * 5} consecutive pastes passed; IDs and caret remained stable.`);
