import type { CachedMetadata } from "obsidian";
import { FootnoteError, reserveIds, validSpan, type Definition, type Reference, type Span } from "./paste-markdown";
import { blockIsOpen, inlineCodeRanges, inlineSyntaxRanges, opaqueMarkdownRanges } from "./markdown-context";

export type Placement = "nearest" | "next" | "end";
export type InsertionSide = "before" | "after";
export type FootnoteMetadata = Pick<CachedMetadata, "footnotes" | "footnoteRefs" | "sections">;
export interface ExistingDefinition extends Definition { standalone: boolean }
export interface FootnoteBlock extends Span { definitions: ExistingDefinition[] }
export interface DestinationFootnotes {
  definitions: ExistingDefinition[];
  blocks: FootnoteBlock[];
  reservedIds: Set<string>;
  protectedRanges: (Span & { openEnd: boolean; onlyEndpoints?: boolean })[];
}

export function collectDestinationFootnotes(source: string, cache: FootnoteMetadata | null, selection?: Span): DestinationFootnotes {
  if (!cache && source.trim()) throw new FootnoteError("Destination footnotes are still updating");
  const definitions: ExistingDefinition[] = [];
  const reservedIds = reserveIds(source);
  for (const item of cache?.footnotes ?? []) {
    const span = { start: item.position.start.offset, end: item.position.end.offset };
    if (!validSpan(source, span)) throw new FootnoteError("Destination footnote positions are outdated");
    if (source.slice(span.start - 2, span.start) === "^[" && source[span.end] === "]") continue;
    const text = source.slice(span.start, span.end);
    const marker = /^ {0,3}\[\^([^\s[\]\\]+)\]:/.exec(text);
    // A content-only inline footnote range must actually be inside ^[...].
    // Otherwise a marker that moved is stale metadata, not an inline footnote.
    if (!marker) {
      throw new FootnoteError("Destination footnote positions are outdated");
    }
    if (marker[1].toLowerCase() !== item.id.toLowerCase() ||
        (span.end < source.length && !/[\r\n]/.test(source[span.end]))) {
      throw new FootnoteError("Destination footnote positions are outdated");
    }
    const lineStart = source.lastIndexOf("\n", span.start - 1) + 1;
    const standalone = /^ {0,3}$/.test(source.slice(lineStart, span.start));
    const start = standalone ? lineStart : span.start;
    const labelStart = span.start + marker[0].indexOf("[^") + 2;
    definitions.push({ start, end: span.end, text: source.slice(start, span.end), id: item.id.toLowerCase(),
      name: marker[1], label: { start: labelStart, end: labelStart + marker[1].length }, references: [], standalone });
    reservedIds.add(item.id.toLowerCase());
  }
  const references: Reference[] = [];
  for (const item of cache?.footnoteRefs ?? []) {
    const span = { start: item.position.start.offset, end: item.position.end.offset };
    if (!validSpan(source, span) || source.slice(span.start, span.end).toLowerCase() !== `[^${item.id.toLowerCase()}]`) {
      throw new FootnoteError("Destination footnote positions are outdated");
    }
    reservedIds.add(item.id.toLowerCase());
    references.push({ start: span.start + 2, end: span.end - 1, id: item.id.toLowerCase() });
  }
  definitions.sort((a, b) => a.start - b.start);
  references.sort((a, b) => a.start - b.start);
  let referenceIndex = 0;
  for (let i = 0; i < definitions.length; i++) {
    const definition = definitions[i];
    if (i > 0 && definition.start < definitions[i - 1].end) throw new FootnoteError("Overlapping destination footnotes");
    while (referenceIndex < references.length && references[referenceIndex].start < definition.start) referenceIndex++;
    while (referenceIndex < references.length && references[referenceIndex].end <= definition.end) {
      definition.references.push(references[referenceIndex++]);
    }
  }
  const blocks = clusterFootnoteBlocks(source, definitions.filter((definition) => definition.standalone));
  const protectedRanges: DestinationFootnotes["protectedRanges"] = (cache?.sections ?? []).filter((section) =>
    ["code", "html", "comment", "math", "yaml", "definition"].includes(section.type)).map((section) => {
    const start = section.position.start.offset;
    const end = section.position.end.offset;
    if (!validSpan(source, { start, end })) throw new FootnoteError("Destination positions are outdated");
    const raw = source.slice(start, end);
    const openEnd = blockIsOpen(raw, section.type);
    return { start, end, openEnd };
  });
  const literals = [...protectedRanges];
  for (const section of cache?.sections ?? []) {
    if (!["paragraph", "heading", "list", "blockquote", "table"].includes(section.type)) continue;
    const span = { start: section.position.start.offset, end: section.position.end.offset };
    if (!validSpan(source, span)) throw new FootnoteError("Destination positions are outdated");
    const codes = inlineCodeRanges(source, span);
    if (selection && [selection.start, selection.end].some((offset) => offset >= span.start && offset <= span.end)) {
      codes.push(...inlineSyntaxRanges(source, span));
    }
    literals.push(...codes.map((span) => ({ ...span, openEnd: false })));
    protectedRanges.push(...codes.map((span) => ({ start: span.start + 1, end: span.end - 1, openEnd: false, onlyEndpoints: true })));
  }
  const opaque = opaqueMarkdownRanges(source, literals);
  protectedRanges.push(...opaque.ranges.map((span) => ({ start: span.start + 1,
    end: span.end - (span.openEnd ? 0 : 1), openEnd: !!span.openEnd, onlyEndpoints: true })));
  if (selection) {
    const lineStart = source.lastIndexOf("\n", selection.start - 1) + 1;
    if (/^[\t ]+$/.test(source.slice(lineStart, selection.start))) {
      // Blank indented lines are absent from metadata until text is inserted.
      // Include the preceding block so valid list continuations stay supported.
      const previous = [...(cache?.sections ?? [])].reverse().find((section) =>
        section.position.end.offset <= selection.start && /^\s*$/.test(source.slice(section.position.end.offset, selection.start)));
      const start = previous?.position.start.offset ?? lineStart;
      const probe = source.slice(start, selection.start) + "x";
      if (inlineSyntaxRanges(probe, { start: 0, end: probe.length }).some((span) =>
        probe.length - 1 >= span.start && probe.length - 1 < span.end)) {
        protectedRanges.push({ start: selection.start, end: selection.start, openEnd: false, onlyEndpoints: true });
      }
    }
  }
  // Detect incomplete/stale caches without using regex matches as definition ranges.
  // Both the matches and the covered ranges are ordered, so a large note with
  // many definitions does not scan every cached definition for every marker.
  const covered = [...definitions, ...literals, ...opaque.ranges].sort((a, b) => a.start - b.start);
  let rangeIndex = 0;
  for (const match of source.matchAll(/^ {0,3}\[\^([^\s[\]\\]+)\]:/gm)) {
    const position = match.index;
    while (rangeIndex < covered.length && covered[rangeIndex].end <= position) rangeIndex++;
    if (rangeIndex < covered.length && covered[rangeIndex].start <= position) continue;
    throw new FootnoteError("Destination footnote information is incomplete");
  }
  return { definitions, blocks, reservedIds, protectedRanges };
}

export function clusterFootnoteBlocks(source: string, definitions: readonly ExistingDefinition[]): FootnoteBlock[] {
  const blocks: FootnoteBlock[] = [];
  for (const definition of definitions) {
    const previous = blocks[blocks.length - 1];
    if (previous && definition.start < previous.end) throw new FootnoteError("Overlapping destination footnotes");
    if (previous && /^\s*$/.test(source.slice(previous.end, definition.start))) {
      previous.end = definition.end;
      previous.definitions.push(definition);
    } else blocks.push({ start: definition.start, end: definition.end, definitions: [definition] });
  }
  return blocks;
}

export function chooseFootnoteBlock(blocks: readonly FootnoteBlock[], offset: number, placement: Placement): FootnoteBlock | undefined {
  if (placement === "end") return undefined;
  if (placement === "next") return blocks.find((block) => block.start >= offset);
  let nearest: FootnoteBlock | undefined;
  let distance = Infinity;
  for (const block of blocks) {
    const nextDistance = Math.max(block.start - offset, offset - block.end, 0);
    if (nextDistance < distance || (nextDistance === distance && block.start >= offset)) {
      nearest = block;
      distance = nextDistance;
    }
  }
  return nearest;
}
