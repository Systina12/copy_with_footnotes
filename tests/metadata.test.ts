import { describe, expect, it } from "vitest";
import { metadataForSource } from "../src/metadata";
import { buildPasteEdits } from "../src/paste";
import cases from "./paste-cases.json";
import captured from "./fixtures/paste-obsidian-1.13.7.json";

const item = cases.find((item) => item.name === "CRLF source and clipboard")!;
const indexedSource = item.target.replace("|", "");
const source = indexedSource.replace(/\r\n/g, "\n");
const cache = captured.fixtures.find((fixture) => fixture.name === item.name)!.cache;

describe("source-bound metadata", () => {
  it("returns an exact snapshot without cloning it", () => {
    expect(metadataForSource(cache, indexedSource, indexedSource)).toBe(cache);
  });
  it("projects CRLF offsets into an LF editor without changing metadata", () => {
    const original = structuredClone(cache);
    const result = metadataForSource(cache, indexedSource, source)!;
    expect(result.footnotes![0].position.start.offset).toBe(2);
    expect(result.footnotes![0].position.end.offset).toBe(source.length);
    const plan = buildPasteEdits({ source, clipboard: item.clipboard, selectionStart: 0, selectionEnd: 0, cache: result, cacheSource: source });
    expect(plan.status).toBe("footnotes");
    expect(plan.result.replace(/\r\n/g, "\n")).toBe(item.expected.replace(/\r\n/g, "\n"));
    expect(cache).toEqual(original);
  });
  it("can project back into CRLF without losing positions", () => {
    const lf = metadataForSource(cache, indexedSource, source)!;
    expect(metadataForSource(lf, source, indexedSource)).toEqual(cache);
  });
  it("rejects equal-length edits as well as inserted text", () => {
    expect(metadataForSource(cache, indexedSource, source.replace("Old", "New"))).toBeNull();
    expect(metadataForSource(cache, indexedSource, "More " + source)).toBeNull();
  });
  it("rejects impossible cached offsets during projection", () => {
    const invalid = structuredClone(cache);
    invalid.footnotes[0].position.end.offset = indexedSource.length + 1;
    expect(metadataForSource(invalid, indexedSource, source)).toBeNull();
  });
  it("cancels on incomplete destination metadata", () => {
    const plan = buildPasteEdits({ source, clipboard: item.clipboard, selectionStart: 0, selectionEnd: 0, cache: {} });
    expect(plan.status).toBe("cancelled");
    expect(plan.reason).toContain("incomplete");
    expect(plan.result).toBe(source);
  });
  it("does not misclassify a shifted definition as an inline footnote", () => {
    const plan = buildPasteEdits({ source: "X" + indexedSource, clipboard: item.clipboard,
      selectionStart: 0, selectionEnd: 0, cache });
    expect(plan.status).toBe("cancelled");
    expect(plan.reason).toContain("outdated");
  });
});
