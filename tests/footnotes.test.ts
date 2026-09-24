import { describe, expect, it, vi } from "vitest";
import type { CachedMetadata, Editor } from "obsidian";
import { buildClipboardText, getSelectionOffsets } from "../src/footnotes";
import cases from "./cases.json";
import captured from "./fixtures/obsidian-1.13.7.json";
import minimumVersion from "./fixtures/obsidian-1.8.7.json";

const basic = cases[0];
const basicCache: CachedMetadata = captured.fixtures[0];
function copy(source = basic.source, cache: CachedMetadata | null = basicCache, cacheSource?: string) {
  return buildClipboardText({ source, selectionStart: 0, selectionEnd: basic.selection.length, cache, cacheSource });
}

describe.each([captured, minimumVersion])("real Obsidian $version metadata", (release) => {
  for (const item of cases) {
    it(item.name, () => {
      const cache = release.fixtures.find((fixture) => fixture.name === item.name)!;
      const selectionStart = item.source.indexOf(item.selection);
      expect(buildClipboardText({ source: item.source, selectionStart,
        selectionEnd: selectionStart + item.selection.length, cache })).toBe(item.expected);
    });
  }

  it("contains actual repeated references and the back edge of a cycle", () => {
    expect(release.fixtures.find((item) => item.name === "repeated reference")!.footnoteRefs).toHaveLength(2);
    expect(release.fixtures.find((item) => item.name === "cycle")!.footnoteRefs).toHaveLength(3);
    expect(release.fixtures.find((item) => item.name === "code fence")!.footnoteRefs.map((ref) => ref.id)).toEqual(["a"]);
  });
});

describe("stale cache and offsets", () => {
  it("normalizes a reverse selection using Editor.posToOffset", () => {
    const editor: Pick<Editor, "getCursor" | "posToOffset"> = {
      getCursor: vi.fn((side) => ({ line: 1, ch: side === "from" ? 20 : 2 })),
      posToOffset: vi.fn((pos) => 30 + pos.ch),
    };
    expect(getSelectionOffsets(editor)).toEqual({ selectionStart: 32, selectionEnd: 50 });
    expect(editor.posToOffset).toHaveBeenCalledTimes(2);
    expect(buildClipboardText({ source: basic.source, selectionStart: basic.selection.length,
      selectionEnd: 0, cache: basicCache })).toBe(basic.expected);
  });

  it("uses current content for an unchanged range", () => {
    expect(copy(basic.source.replace("Source", "Newest"))).toBe(basic.expected.replace("Source", "Newest"));
  });

  it.each(["A much longer source", "S"])("rejects changed definition length: %s", (text) => {
    expect(copy(basic.source.replace("Source", text))).toBe(basic.selection);
  });

  it("rejects a shifted definition marker", () => {
    expect(copy(basic.source.replace("\n\n", "\n\nX"))).toBe(basic.selection);
  });

  it("rejects a stale reference", () => {
    expect(copy(basic.source.replace("[^a]", "[^b]"))).toBe("Alpha[^b]");
  });

  it("rejects changed syntax even when reference offsets still match", () => {
    const before = "---\nA[^a]\n---\n\n[^a]: Source";
    const after = "```\nA[^a]\n```\n\n[^a]: Source";
    expect(buildClipboardText({ source: after, selectionStart: 0, selectionEnd: 9,
      cache: basicCache, cacheSource: before })).toBe(after.slice(0, 9));
  });

  it("rejects any different indexed snapshot including same-length edits", () => {
    expect(copy(basic.source.replace("Source", "Newest"), basicCache, basic.source)).toBe(basic.selection);
  });

  it("copies normally without metadata", () => {
    expect(copy(basic.source, null)).toBe(basic.selection);
  });

  it("does not duplicate a definition partially included in the selection", () => {
    const end = basic.source.indexOf("Source") + 3;
    const selection = basic.source.slice(0, end);
    expect(buildClipboardText({ source: basic.source, selectionStart: 0, selectionEnd: end,
      cache: basicCache })).toBe(selection);
    const cyclic = cases.find((item) => item.name === "self cycle")!;
    const cyclicCache = captured.fixtures.find((item) => item.name === "self cycle")!;
    const start = cyclic.source.indexOf("[^a]:") + 2;
    expect(buildClipboardText({ source: cyclic.source, selectionStart: start,
      selectionEnd: cyclic.source.length, cache: cyclicCache })).toBe(cyclic.source.slice(start));
  });

  it("does not mutate metadata", () => {
    const cache = structuredClone(basicCache);
    const before = structuredClone(cache);
    copy(basic.source, cache);
    expect(cache).toEqual(before);
  });

  it("ignores an invalid definition range", () => {
    const cache = structuredClone(basicCache);
    cache.footnotes![0].position.end.offset = basic.source.length + 1;
    expect(copy(basic.source, cache)).toBe(basic.selection);
  });

  it("does not overflow the call stack on a deep dependency chain", () => {
    const count = 12000;
    const lines = ["Text[^0]", "", ...Array.from({ length: count }, (_, i) =>
      `[^${i}]: ${i + 1 < count ? `[^${i + 1}]` : "End"}`)];
    const source = lines.join("\n");
    const cache: CachedMetadata = { footnotes: [], footnoteRefs: [] };
    let offset = 0;
    const pos = (line: number, col: number, length: number) => ({
      start: { line, col, offset: offset + col }, end: { line, col: col + length, offset: offset + col + length },
    });
    lines.forEach((text, line) => {
      if (line === 0) cache.footnoteRefs!.push({ id: "0", position: pos(line, 4, 4) });
      if (line >= 2) {
        const id = String(line - 2);
        cache.footnotes!.push({ id, position: pos(line, 0, text.length) });
        if (line - 1 < count) {
          const marker = `[^${line - 1}]`;
          cache.footnoteRefs!.push({ id: String(line - 1), position: pos(line, text.indexOf(": ") + 2, marker.length) });
        }
      }
      offset += text.length + 1;
    });
    expect(buildClipboardText({ source, selectionStart: 0, selectionEnd: 8, cache })).toBe(source);
  });
});
