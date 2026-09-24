import { describe, expect, it } from "vitest";
import cases from "./paste-cases.json";
import oldVersion from "./fixtures/paste-obsidian-1.8.7.json";
import currentVersion from "./fixtures/paste-obsidian-1.13.7.json";
import { buildPasteEdits, pasteCaretPosition, resolveFootnoteConflicts, rewriteIncomingFootnotes } from "../src/paste";
import { applyEdits, FootnoteError, parseClipboardFootnotes } from "../src/paste-markdown";
import { chooseFootnoteBlock, collectDestinationFootnotes, type InsertionSide, type Placement } from "../src/paste-destination";

function inputAt(index: number, fixtureSet = currentVersion) {
  const item = cases[index];
  const selectionStart = item.target.indexOf("|");
  const source = item.target.slice(0, selectionStart) + item.target.slice(selectionStart + 1);
  return { source, clipboard: item.clipboard, selectionStart, selectionEnd: selectionStart + (item.selection?.length ?? 0),
    cache: fixtureSet.fixtures.find((fixture) => fixture.name === item.name)!.cache,
    placement: item.placement as Placement | undefined, insertionSide: item.insertionSide as InsertionSide | undefined };
}

describe.each([oldVersion, currentVersion])("Paste using actual Obsidian $version metadata", (fixtureSet) => {
  it.each(cases.map((item, index) => ({ ...item, index })))("$name", (item) => {
    const input = inputAt(item.index, fixtureSet);
    const plan = buildPasteEdits(input);
    expect(plan.result).toBe(item.expected);
    if (item.summary) expect(plan.summary).toEqual(item.summary);
    expect(plan.reason).toBe(item.cancelReason);
    if (item.cancelReason) { expect(plan.status).toBe("cancelled"); expect(plan.changes).toEqual([]); }
    expect(plan.changes.length).toBeLessThanOrEqual(2);
    // There is at most one replacement and one insertion. No extra edits can
    // renumber, reorder or move existing definitions elsewhere in the note.
    expect(plan.changes.filter((change) => change.start !== change.end)).toHaveLength(item.selection && item.clipboard && !item.cancelReason && plan.result !== input.source ? 1 : 0);
    expect(applyEdits(input.source, plan.changes)).toBe(item.expected);
  });
});

describe("clipboard parsing and rewriting", () => {
  it("returns body, labels and nested reference spans from original source", () => {
    const source = "A[^a] A[^a]\n\n[^a]: See [^b].\n    More\n[^b]: B";
    const parsed = parseClipboardFootnotes(source);
    expect(parsed.body).toBe("A[^a] A[^a]");
    expect(parsed.bodyReferences.map((ref) => source.slice(ref.start, ref.end))).toEqual(["a", "a"]);
    expect(parsed.definitions[0].references.map((ref) => ref.id)).toEqual(["b"]);
    expect(parsed.definitions.map((definition) => source.slice(definition.label.start, definition.label.end))).toEqual(["a", "b"]);
    expect(parsed.definitions[0].text).toBe("[^a]: See [^b].\n    More");
  });

  it("does not discover references in code, escapes or normal links", () => {
    const parsed = parseClipboardFootnotes("`[^a]` \\[^a] [link](https://example.com/[^a]) Real[^a]\n\n[^a]: A");
    expect(parsed.references).toHaveLength(1);
  });

  it("performs mapping replacements once, without a replacement cascade", () => {
    const incoming = parseClipboardFootnotes("A[^1] B[^2]\n\n[^1]: See [^2].\n[^2]: See [^1].");
    const result = rewriteIncomingFootnotes(incoming, {
      mapping: new Map([["1", "2"], ["2", "3"]]), reused: new Set(), ordered: incoming.definitions,
    });
    expect(result).toEqual({ body: "A[^2] B[^3]", definitions: ["[^2]: See [^3].", "[^3]: See [^2]."] });
  });

  it("reserves incoming suffixes before allocating named conflicts", () => {
    const incoming = parseClipboardFootnotes("A[^a] B[^a-2]\n\n[^a]: New\n[^a-2]: Keep");
    const destination = collectDestinationFootnotes("", {});
    destination.reservedIds.add("a");
    const resolved = resolveFootnoteConflicts(incoming, destination);
    expect(resolved.mapping.get("a")).toBe("a-3");
    expect(resolved.mapping.get("a-2")).toBe("a-2");
    expect(resolved.ordered.map((definition) => definition.id)).toEqual(["a", "a-2"]);
  });

  it("keeps internal whitespace significant for deduplication", () => {
    const input = inputAt(cases.findIndex((item) => item.name === "identical definition reused"));
    input.clipboard = input.clipboard.replace("et al.", "et  al.");
    const plan = buildPasteEdits(input);
    expect(plan.result).toContain("Hello.[^smith-2]");
    expect(plan.result).toContain("[^smith-2]: Smith et  al., 2024.");
  });

  it("resolves a conflict with many adjacent references without ambiguous text matching", () => {
    const incoming = parseClipboardFootnotes(`Text[^a]\n\n[^a]: ${"[^b]".repeat(18)}\n[^b]: Child`);
    const target = parseClipboardFootnotes(`[^a]: ${"x".repeat(36)}`).definitions[0];
    const destination = collectDestinationFootnotes("", {});
    destination.definitions.push({ ...target, standalone: true });
    destination.reservedIds.add("a");
    const resolved = resolveFootnoteConflicts(incoming, destination);
    expect(resolved.mapping.get("a")).toBe("a-2");
    expect(resolved.mapping.get("b")).toBe("b");
    expect(resolved.reused.size).toBe(0);
  });

  it("finds a reusable dependency pair among many unrelated destination definitions", () => {
    const incoming = parseClipboardFootnotes("Text[^a]\n\n[^a]: Shared [^b]\n[^b]: Child");
    const unrelated = Array.from({ length: 150 }, (_, index) => `[^other${index}]: Different ${index}`).join("\n");
    const target = parseClipboardFootnotes(`${unrelated}\n[^a]: Shared [^wrong]\n[^wrong]: Wrong\n` +
      "[^b]: Different\n[^a-2]: Shared [^b-2]\n[^b-2]: Child");
    const destination = collectDestinationFootnotes("", {});
    destination.definitions.push(...target.definitions.map((definition) => ({ ...definition, standalone: true })));
    for (const definition of target.definitions) destination.reservedIds.add(definition.id);
    const resolved = resolveFootnoteConflicts(incoming, destination);
    expect(resolved.mapping).toEqual(new Map([["a", "a-2"], ["b", "b-2"]]));
    expect(resolved.reused).toEqual(new Set(["a", "b"]));
  });

  it("appends unreferenced definitions after first-reference traversal", () => {
    const incoming = parseClipboardFootnotes("A[^a]\n\n[^z]: Orphan\n[^a]: See [^b]\n[^b]: B");
    const resolution = resolveFootnoteConflicts(incoming, collectDestinationFootnotes("", {}));
    expect(resolution.ordered.map((definition) => definition.id)).toEqual(["a", "b", "z"]);
  });

  it("rejects an actual footnote inside Obsidian comments without rejecting ordinary comments", () => {
    expect(() => parseClipboardFootnotes("%% Hidden[^a] %%\n\n[^a]: A")).toThrow(FootnoteError);
    expect(parseClipboardFootnotes("%% Fine %% Visible[^a]\n\n[^a]: A").bodyReferences).toHaveLength(1);
  });

  it("uses an iterative closure for a long dependency chain", () => {
    const count = 1200;
    const source = "A[^n0]\n\n" + Array.from({ length: count }, (_, index) =>
      `[^n${index}]: ${index < count - 1 ? `See [^n${index + 1}]` : "End"}`).join("\n");
    const parsed = parseClipboardFootnotes(source);
    const resolution = resolveFootnoteConflicts(parsed, collectDestinationFootnotes("", {}));
    expect(resolution.ordered).toHaveLength(count);
    expect(resolution.ordered[count - 1].id).toBe("n1199");
  });
});

describe("blocks, fallback and editor coordinates", () => {
  const blocks = [{ start: 0, end: 10, definitions: [] }, { start: 30, end: 40, definitions: [] }];
  it.each([
    [12, "nearest", 0], [28, "nearest", 30], [20, "nearest", 30], [5, "nearest", 0],
    [12, "next", 30], [40, "next", undefined], [12, "end", undefined],
  ] as const)("offset %i, %s selects %s", (offset, placement, expected) => {
    expect(chooseFootnoteBlock(blocks, offset, placement)?.start).toBe(expected);
  });
  it("falls back to EOF when there are no blocks", () => {
    expect(chooseFootnoteBlock([], 5, "nearest")).toBeUndefined();
  });
  it("clusters whitespace-separated definitions without merging separate sections", () => {
    const input = inputAt(cases.findIndex((item) => item.name === "nearest block above moves final caret"));
    const target = collectDestinationFootnotes(input.source, input.cache);
    expect(target.blocks).toHaveLength(2);
    const duplicates = inputAt(cases.findIndex((item) => item.name === "identical duplicate destination IDs remain usable"));
    expect(collectDestinationFootnotes(duplicates.source, duplicates.cache).blocks).toHaveLength(1);
  });
  it("does not use metadata from a different source snapshot", () => {
    const input = inputAt(1);
    const plan = buildPasteEdits({ ...input, cacheSource: "old buffer" });
    expect(plan.reason).toContain("still updating");
    expect(plan.result).toBe(input.source);
    expect(plan.changes).toEqual([]);
  });
  it("rejects stale ranges even at startup without a source snapshot", () => {
    const input = inputAt(1);
    const cache = structuredClone(input.cache);
    cache.footnotes[0].position.end.offset -= 2;
    expect(buildPasteEdits({ ...input, cache }).reason).toContain("outdated");
  });
  it("plain clipboard content never waits for valid footnote metadata", () => {
    const input = inputAt(1);
    expect(buildPasteEdits({ ...input, clipboard: "plain", cache: null, cacheSource: "stale" }).reason).toBeUndefined();
  });
  it("normalizes reversed selections", () => {
    const index = cases.findIndex((item) => item.name === "replace nonempty selection");
    const input = inputAt(index);
    expect(buildPasteEdits({ ...input, selectionStart: input.selectionEnd, selectionEnd: input.selectionStart }).result).toBe(cases[index].expected);
  });
  it("keeps the caret at the end of the body after inserting definitions above it", () => {
    const input = inputAt(cases.findIndex((item) => item.name === "nearest block above moves final caret"));
    const plan = buildPasteEdits(input);
    expect(plan.result.slice(0, plan.caretOffset)).toBe("[^up]: Up\n\n[^n]: N\n\nNew[^n]");
    expect(pasteCaretPosition(plan)).toEqual({ line: 4, ch: 7 });
  });
  it("keeps line/column correct after the editor normalizes CRLF", () => {
    const plan = buildPasteEdits(inputAt(cases.findIndex((item) => item.name === "CRLF source and clipboard")));
    expect(pasteCaretPosition(plan)).toEqual({ line: 1, ch: 1 });
  });
  it("coalesces replacement and definition insertion at either boundary", () => {
    for (const name of ["replacement and definition insertion meet at EOF", "definition insertion at the start of a replacement"]) {
      const plan = buildPasteEdits(inputAt(cases.findIndex((item) => item.name === name)));
      expect(plan.changes).toHaveLength(1);
      expect(plan.result.slice(0, plan.caretOffset)).toMatch(/(?:Hello\[\^1\]|Body\[\^n\])$/);
    }
  });
});
