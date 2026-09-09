import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFootnoteFromMarkdown } from "mdast-util-gfm-footnote";
import { gfmFootnote } from "micromark-extension-gfm-footnote";
import type { Nodes } from "mdast";
import { blockIsOpen, opaqueMarkdownRanges } from "./markdown-context";

export interface Span { start: number; end: number }
export interface TextEdit extends Span { text: string }
export interface Reference extends Span { id: string }
export interface Definition extends Span {
  id: string;
  name: string;
  label: Span;
  text: string;
  references: Reference[];
}
export interface ClipboardFootnotes {
  source: string;
  body: string;
  definitions: Definition[];
  references: Reference[];
  bodyReferences: Reference[];
  reservedIds: Set<string>;
}

export class FootnoteError extends Error {}

export function validSpan(source: string, span: Span): boolean {
  return Number.isInteger(span.start) && Number.isInteger(span.end) &&
    span.start >= 0 && span.end > span.start && span.end <= source.length;
}

export function applyEdits(source: string, changes: readonly TextEdit[]): string {
  let end = source.length;
  const parts: string[] = [];
  for (const change of [...changes].sort((a, b) => b.start - a.start)) {
    if (!Number.isInteger(change.start) || !Number.isInteger(change.end) ||
        change.start < 0 || change.end < change.start || change.end > end) {
      throw new FootnoteError("Overlapping text edits");
    }
    parts.push(source.slice(change.end, end), change.text);
    end = change.start;
  }
  parts.push(source.slice(0, end));
  return parts.reverse().join("");
}

// Reservation is conservative: a literal-looking ID must never accidentally acquire
// an incoming definition. These matches do not identify definitions or edit spans.
export function reserveIds(source: string): Set<string> {
  return new Set([...source.matchAll(/\[\^([^\s[\]\\]+)\]/g)].map((match) => match[1].toLowerCase()));
}

export function parseClipboardFootnotes(source: string): ClipboardFootnotes {
  const tree = fromMarkdown(source, {
    extensions: [gfmFootnote()], mdastExtensions: [gfmFootnoteFromMarkdown()],
  });
  const definitions: Definition[] = [];
  const references: Reference[] = [];
  const bodyReferences: Reference[] = [];
  const ids = new Set<string>();
  const stack: { node: Nodes; parent: string; owner?: Definition }[] = [{ node: tree, parent: "" }];
  let unclosedBlock = false;
  // Do not reinterpret Obsidian-only constructs as GFM footnotes. Ordinary
  // comments, wikilinks, math and frontmatter without footnotes remain untouched.
  const literalRanges: Span[] = [];
  const nodes: Nodes[] = [tree];
  while (nodes.length) {
    const node = nodes.pop()!;
    if (["code", "inlineCode", "html"].includes(node.type)) {
      literalRanges.push({ start: node.position!.start.offset!, end: node.position!.end.offset! });
    } else if ("children" in node) for (const child of node.children) nodes.push(child);
  }
  const opaque = opaqueMarkdownRanges(source, literalRanges);
  while (stack.length) {
    const item = stack.pop()!;
    const { node, parent } = item;
    let owner = item.owner;
    if (node.type === "footnoteDefinition" || node.type === "footnoteReference") {
      const start = node.position?.start.offset ?? -1;
      const end = node.position?.end.offset ?? -1;
      if (!validSpan(source, { start, end }) || opaque.ranges.some((span) => start >= span.start && start < span.end)) {
        throw new FootnoteError("Footnotes inside unsupported Markdown syntax");
      }
      const raw = source.slice(start, end);
      const match = /^\[\^([^\s[\]\\]+)\]/.exec(raw);
      if (!match) throw new FootnoteError("Unsupported footnote label");
      const name = match[1];
      const id = name.toLowerCase();
      const label = { start: start + 2, end: start + 2 + name.length };
      if (node.type === "footnoteDefinition") {
        const lineStart = source.lastIndexOf("\n", start - 1) + 1;
        if (parent !== "root" || !/^ {0,3}$/.test(source.slice(lineStart, start)) || raw[match[0].length] !== ":") {
          throw new FootnoteError("Footnote definitions inside lists or quotes");
        }
        if (ids.has(id)) throw new FootnoteError("Duplicate footnote IDs in the clipboard");
        ids.add(id);
        owner = { start: lineStart, end, id, name, label, text: source.slice(lineStart, end), references: [] };
        definitions.push(owner);
      } else {
        if (raw !== match[0]) throw new FootnoteError("Unsupported reference boundary");
        const reference = { ...label, id };
        references.push(reference);
        (owner?.references ?? bodyReferences).push(reference);
      }
    } else if ((node.type === "code" || node.type === "html") && parent === "root") {
      const raw = source.slice(node.position!.start.offset, node.position!.end.offset);
      unclosedBlock ||= blockIsOpen(raw, node.type);
    }
    if ("children" in node) {
      for (let i = node.children.length - 1; i >= 0; i--) stack.push({ node: node.children[i], parent: node.type, owner });
    }
  }
  if (definitions.length && (unclosedBlock || opaque.unclosed)) throw new FootnoteError("Unclosed Markdown block in the clipboard");
  return { source, definitions, references, bodyReferences, reservedIds: reserveIds(source),
    body: extractBody(source, definitions, []) };
}

export function extractBody(source: string, definitions: readonly Span[], replacements: readonly TextEdit[]): string {
  const removals: TextEdit[] = [];
  for (const definition of definitions) {
    const previous = removals[removals.length - 1];
    if (previous && /^\s*$/.test(source.slice(previous.end, definition.start))) previous.end = definition.end;
    else removals.push({ ...definition, text: "" });
  }
  for (const removal of removals) {
    if (/^\s*$/.test(source.slice(removal.end))) {
      // Drop the separator before a trailing definition block, not body text.
      removal.start -= source.slice(0, removal.start).match(/(?:\r?\n[\t ]*)+$/)?.[0].length ?? 0;
      removal.end = source.length;
    } else {
      // Consume complete separator lines, never the next nonempty line's indent.
      removal.end += source.slice(removal.end).match(/^(?:[\t ]*\r?\n)+/)?.[0].length ?? 0;
      const before = source.slice(0, removal.start);
      if (before.trim()) {
        const trailing = before.match(/(?:\r?\n[\t ]*)+$/)?.[0] ?? "";
        const breaks = trailing.match(/\n/g)?.length ?? 0;
        // Removing an interrupting definition must not merge its surrounding
        // body paragraphs into one paragraph.
        removal.text = (source.includes("\r\n") ? "\r\n" : "\n").repeat(Math.max(0, 2 - breaks));
      }
    }
    if (/^\s*$/.test(source.slice(0, removal.start))) removal.start = 0;
  }
  let removalIndex = 0;
  const bodyEdits = [...replacements].sort((a, b) => a.start - b.start).filter((replacement) => {
    while (removalIndex < removals.length && removals[removalIndex].end <= replacement.start) removalIndex++;
    const removal = removals[removalIndex];
    return !removal || replacement.start < removal.start || replacement.end > removal.end;
  });
  return applyEdits(source, [...removals, ...bodyEdits]);
}
