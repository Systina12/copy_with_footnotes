import type { EditorPosition } from "obsidian";
import { applyEdits, extractBody, FootnoteError, parseClipboardFootnotes,
  type ClipboardFootnotes, type TextEdit } from "./paste-markdown";
import { chooseFootnoteBlock, collectDestinationFootnotes,
  type FootnoteMetadata, type InsertionSide, type Placement } from "./paste-destination";
import { resolveFootnoteConflicts, type ConflictResolution } from "./paste-conflicts";
import { validatePasteContext } from "./paste-context";
export { resolveFootnoteConflicts } from "./paste-conflicts";

export interface PasteInput {
  source: string;
  clipboard: string;
  selectionStart: number;
  selectionEnd: number;
  cache: FootnoteMetadata | null;
  cacheSource?: string;
  incoming?: ClipboardFootnotes;
  placement?: Placement;
  insertionSide?: InsertionSide;
}
export interface PastePlan {
  status: "plain" | "footnotes" | "cancelled";
  changes: TextEdit[];
  result: string;
  caretOffset: number;
  reason?: string;
  summary?: { added: number; reused: number; renamed: number };
}
export function rewriteIncomingFootnotes(incoming: ClipboardFootnotes, resolution: ConflictResolution) {
  const replacements = (spans: readonly { start: number; end: number; id: string }[]) => spans.flatMap((span) => {
    const name = resolution.mapping.get(span.id);
    return name && name.toLowerCase() !== span.id ? [{ start: span.start, end: span.end, text: name }] : [];
  });
  const body = extractBody(incoming.source, incoming.definitions, replacements(incoming.bodyReferences));
  const definitions = resolution.ordered.filter((definition) => !resolution.reused.has(definition.id)).map((definition) =>
    applyEdits(definition.text, replacements([{ ...definition.label, id: definition.id }, ...definition.references])
      .map((span) => ({ ...span, start: span.start - definition.start, end: span.end - definition.start }))));
  return { body, definitions };
}

function separatedInsertion(source: string, offset: number, text: string): string {
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const left = source.slice(0, offset);
  const right = source.slice(offset);
  const trailing = left.match(/(?:\r?\n[\t ]*)+$/)?.[0] ?? "";
  const leading = right.match(/^(?:[\t ]*\r?\n)+/)?.[0] ?? "";
  const before = left ? Math.max(2 - (trailing.match(/\n/g)?.length ?? 0), trailing && !trailing.endsWith("\n") ? 1 : 0) : 0;
  const after = right ? Math.max(0, 2 - (leading.match(/\n/g)?.length ?? 0)) : 0;
  return newline.repeat(before) + text + newline.repeat(after);
}

export function plainPastePlan(source: string, clipboard: string, start: number, end: number): PastePlan {
  const changes = clipboard ? [{ start, end, text: clipboard }] : [];
  return { status: "plain", changes, result: applyEdits(source, changes), caretOffset: start + clipboard.length };
}

export function cancelPastePlan(source: string, caretOffset: number, reason: string): PastePlan {
  return { status: "cancelled", changes: [], result: source, caretOffset, reason };
}

export function pasteNotice(plan: PastePlan): string | undefined {
  if (plan.status === "cancelled") return `Paste cancelled: ${plan.reason}. The note was not changed.`;
  if (!plan.summary) return undefined;
  const { added, reused, renamed } = plan.summary;
  return `Footnotes: ${added} added, ${reused} reused${renamed ? `, ${renamed} incoming IDs changed` : ""}.`;
}

export function buildPasteEdits(input: PasteInput): PastePlan {
  const { source, clipboard, cache, cacheSource } = input;
  const start = Math.min(input.selectionStart, input.selectionEnd);
  const end = Math.max(input.selectionStart, input.selectionEnd);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > source.length) {
    throw new FootnoteError("Invalid paste location");
  }
  if (!clipboard) return plainPastePlan(source, clipboard, start, end);
  try {
    const incoming = input.incoming ?? parseClipboardFootnotes(clipboard);
    if (incoming.source !== clipboard) throw new FootnoteError("Clipboard text changed during preparation");
    if (!incoming.definitions.length) return plainPastePlan(source, clipboard, start, end);
    if (cacheSource !== undefined && cacheSource !== source) throw new FootnoteError("Destination footnotes are still updating");
    const destination = collectDestinationFootnotes(source, cache, { start, end });
    const resolution = resolveFootnoteConflicts(incoming, destination);
    const rewritten = rewriteIncomingFootnotes(incoming, resolution);
    const summary = { added: rewritten.definitions.length, reused: resolution.reused.size,
      renamed: [...resolution.mapping].filter(([id, name]) => id !== name.toLowerCase()).length };
    if (!rewritten.body && !rewritten.definitions.length) {
      return { status: "footnotes", changes: [], result: source, caretOffset: start, summary };
    }
    if (rewritten.body.startsWith("[^")) {
      const escapes = source.slice(0, start).match(/\\+$/)?.[0].length ?? 0;
      if (escapes % 2) throw new FootnoteError("The paste location would escape a footnote reference");
    }
    if (destination.definitions.some((definition) => start === end ?
      start >= definition.start && start <= definition.end : start < definition.end && end > definition.start)) {
      throw new FootnoteError("The selection overlaps an existing footnote definition");
    }
    if (destination.protectedRanges.some((span) => span.onlyEndpoints ?
      start >= span.start && start <= span.end || end >= span.start && end <= span.end :
      start >= span.start && start <= span.end || start < span.end && end > span.start)) {
      throw new FootnoteError("The paste location is inside protected Markdown syntax");
    }
    const changes: TextEdit[] = [{ start, end, text: rewritten.body }];
    let caretOffset = start + rewritten.body.length;
    if (rewritten.definitions.length) {
      const block = chooseFootnoteBlock(destination.blocks, start, input.placement ?? "nearest");
      const offset = block ? block[input.insertionSide === "before" ? "start" : "end"] : source.length;
      if (destination.protectedRanges.some((span) => offset > span.start && (offset < span.end || span.openEnd && offset === span.end))) {
        throw new FootnoteError("The footnote location is inside protected Markdown syntax");
      }
      const bodySource = applyEdits(source, changes);
      if (offset > start && offset < end) throw new FootnoteError("The selection overlaps the footnote insertion point");
      const afterBody = offset >= end;
      const adjusted = offset < start ? offset : afterBody ? offset + rewritten.body.length - (end - start) : start;
      const newline = source.includes("\r\n") ? "\r\n" : "\n";
      const text = separatedInsertion(bodySource, adjusted, rewritten.definitions.join(newline));
      if (offset >= start && offset <= end) changes[0].text = afterBody ? changes[0].text + text : text + changes[0].text;
      else changes.push({ start: offset, end: offset, text });
      if (offset < start || offset === start && !afterBody) caretOffset += text.length;
    }
    const edits = changes.filter((change) => change.start !== change.end || change.text).sort((a, b) => b.start - a.start);
    const result = applyEdits(source, edits);
    validatePasteContext({ source, result, start, end, body: rewritten.body, caretOffset, changes: edits, cache, destination,
      bodyIds: incoming.bodyReferences.map((reference) => (resolution.mapping.get(reference.id) ?? reference.id).toLowerCase()) });
    return { status: "footnotes", changes: edits, result, caretOffset,
      summary };
  } catch (error) {
    if (!(error instanceof FootnoteError)) throw error;
    return cancelPastePlan(source, start, error.message);
  }
}

export function pasteCaretPosition(plan: PastePlan): EditorPosition {
  // Obsidian normalizes inserted CRLF. Line/column coordinates remain correct
  // for the final document even when its byte offsets no longer match the input.
  const lines = plan.result.slice(0, plan.caretOffset).split(/\r\n|\r|\n/);
  return { line: lines.length - 1, ch: lines[lines.length - 1].length };
}
