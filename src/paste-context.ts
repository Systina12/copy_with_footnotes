import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFootnoteFromMarkdown } from "mdast-util-gfm-footnote";
import { gfmFootnote } from "micromark-extension-gfm-footnote";
import type { Nodes } from "mdast";
import { blockIsOpen, opaqueMarkdownRanges } from "./markdown-context";
import { FootnoteError, validSpan, type Span, type TextEdit } from "./paste-markdown";
import type { DestinationFootnotes, FootnoteMetadata } from "./paste-destination";

interface PasteContextInput {
  source: string;
  result: string;
  start: number;
  end: number;
  body: string;
  caretOffset: number;
  changes: readonly TextEdit[];
  bodyIds: readonly string[];
  cache: FootnoteMetadata | null;
  destination: DestinationFootnotes;
}

function syntax(source: string, ids: ReadonlySet<string>) {
  // Stubs resolve references whose actual definitions are outside this local
  // context. Their spans are excluded from all checks below.
  const text = source + "\n\n" + [...ids].map((id) => `[^${id}]: .`).join("\n");
  const tree = fromMarkdown(text, { extensions: [gfmFootnote()], mdastExtensions: [gfmFootnoteFromMarkdown()] });
  const references: (Span & { id: string })[] = [];
  const definitions: (Span & { label: number; parent: string; interruptsParagraph: boolean })[] = [];
  const literals: Span[] = [];
  const open: Span[] = [];
  const stack: { node: Nodes; parent: string; previous?: Nodes }[] = [{ node: tree, parent: "" }];
  while (stack.length) {
    const { node, parent, previous } = stack.pop()!;
    const start = node.position?.start.offset ?? source.length;
    if (node.type !== "root" && start >= source.length) continue;
    const end = Math.min(node.position?.end.offset ?? 0, source.length);
    const raw = source.slice(start, end);
    if (["code", "inlineCode", "html"].includes(node.type)) {
      literals.push({ start, end });
      if (parent === "root" && blockIsOpen(raw, node.type)) open.push({ start, end });
    }
    if (node.type === "footnoteReference") {
      references.push({ start, end, id: raw.slice(2, -1).toLowerCase() });
    } else if (node.type === "footnoteDefinition") {
      definitions.push({ start, end, label: start + raw.indexOf("[^") + 2, parent,
        interruptsParagraph: parent === "root" && previous?.type === "paragraph" &&
          !/\r?\n[\t ]*\r?\n/.test(source.slice(previous.position!.end.offset!, start)) });
    }
    if ("children" in node) {
      for (let i = node.children.length - 1; i >= 0; i--) {
        stack.push({ node: node.children[i], parent: node.type, previous: node.children[i - 1] });
      }
    }
  }
  const opaque = opaqueMarkdownRanges(source, literals);
  open.push(...opaque.ranges.filter((range) => range.openEnd));
  return { definitions, open, references: references.filter((reference) =>
    !opaque.ranges.some((range) => reference.start >= range.start && reference.start < range.end)) };
}

export function validatePasteContext(input: PasteContextInput): void {
  const { source, result, start, end, body, caretOffset, changes, bodyIds, cache, destination } = input;
  let left = start === 0 ? 0 : source.lastIndexOf("\n", start - 1) + 1;
  let right = source.indexOf("\n", end);
  if (right < 0) right = source.length;
  const sections = (cache?.sections ?? []).map((section) => ({
    start: section.position.start.offset, end: section.position.end.offset,
  })).filter((span) => validSpan(source, span)).sort((a, b) => a.start - b.start);
  for (const section of sections) {
    if (section.start <= start && section.end >= start) left = Math.min(left, section.start);
    if (section.start <= end && section.end >= end) right = Math.max(right, section.end);
  }
  const previous = [...sections].reverse().find((section) => section.end <= start);
  const next = sections.find((section) => section.start >= end);
  if (previous && /^\s*$/.test(source.slice(previous.end, start))) left = Math.min(left, previous.start);
  if (next && /^\s*$/.test(source.slice(end, next.start))) right = Math.max(right, next.end);

  // Only offsets outside the replaced selection are projected. Affinity keeps
  // an existing token on its original side of an insertion at the same offset.
  const project = (offset: number, affinity: -1 | 1) => offset + changes.reduce((delta, change) =>
    change.end < offset || change.end === offset && (change.start < change.end || affinity > 0)
      ? delta + change.text.length - (change.end - change.start) : delta, 0);
  const contextStart = project(left, -1);
  const context = result.slice(contextStart, project(right, 1));
  const bodyStart = caretOffset - body.length - contextStart;
  const bodyEnd = caretOffset - contextStart;
  const outside = (span: Span) => span.start >= left && span.end <= right && (span.end <= start || span.start >= end);
  const oldReferences = (cache?.footnoteRefs ?? []).map((reference) => ({
    start: reference.position.start.offset, end: reference.position.end.offset, id: reference.id,
  })).filter(outside);
  const ids = new Set([...bodyIds, ...oldReferences.map((reference) => reference.id)]);
  const standalone = syntax(body, new Set(bodyIds));
  const actual = syntax(context, ids);
  const fail = () => { throw new FootnoteError("The paste would change footnote or Markdown boundaries"); };
  if (standalone.references.length !== bodyIds.length || standalone.references.some((reference, i) => reference.id !== bodyIds[i])) fail();
  const expected = [
    ...standalone.references.map((reference) => ({ start: bodyStart + reference.start, end: bodyStart + reference.end })),
    ...oldReferences.map((reference) => ({ start: project(reference.start, 1) - contextStart,
      end: project(reference.end, -1) - contextStart })),
  ];
  const referenceSpans = new Set(actual.references.map((reference) => `${reference.start}:${reference.end}`));
  if (expected.some((reference) => !referenceSpans.has(`${reference.start}:${reference.end}`))) fail();
  const crossesBody = (span: Span) => span.start < bodyEnd && span.end > bodyStart;
  if (actual.open.some(crossesBody) || actual.definitions.some(crossesBody)) fail();
  const definitionEnds = new Map(actual.definitions.map((definition) => [definition.label, definition]));
  for (const definition of destination.definitions.filter(outside)) {
    const parsed = definitionEnds.get(project(definition.label.start, 1) - contextStart);
    if (!parsed || parsed.end !== project(definition.end, -1) - contextStart || definition.standalone && parsed.parent !== "root") fail();
  }
  // GFM allows definitions to interrupt paragraphs; Obsidian does not. A body
  // replacement must retain separation before an unchanged following definition.
  if (actual.definitions.some((definition) => definition.interruptsParagraph && definition.start >= bodyEnd &&
    /^\s*$/.test(context.slice(bodyEnd, definition.start)))) fail();
}
