import type { CachedMetadata, CacheItem, Editor } from "obsidian";

type FootnoteMetadata = Pick<CachedMetadata, "footnotes" | "footnoteRefs">;

interface CopyInput {
  source: string;
  selectionStart: number;
  selectionEnd: number;
  cache?: FootnoteMetadata | null;
  cacheSource?: string;
}

export function getSelectionOffsets(editor: Pick<Editor, "getCursor" | "posToOffset">) {
  const from = editor.posToOffset(editor.getCursor("from"));
  const to = editor.posToOffset(editor.getCursor("to"));
  return { selectionStart: Math.min(from, to), selectionEnd: Math.max(from, to) };
}

export function buildClipboardText({ source, selectionStart, selectionEnd, cache, cacheSource }: CopyInput): string {
  const start = Math.max(0, Math.min(selectionStart, selectionEnd, source.length));
  const end = Math.min(source.length, Math.max(selectionStart, selectionEnd, 0));
  const selection = source.slice(start, end);
  if (!selection || !cache || (cacheSource !== undefined && cacheSource !== source)) {
    return selection;
  }

  const refs = [...(cache.footnoteRefs ?? [])].sort((a, b) => offset(a) - offset(b));
  // Validate metadata locations, never discover references by scanning Markdown.
  if (refs.some((ref) => !validRange(source, ref) ||
      source.slice(offset(ref), offset(ref, true)).toLowerCase() !== `[^${ref.id}]`)) {
    return selection;
  }

  const definitions = new Map<string, { start: number; end: number }>();
  const ambiguous = new Set<string>();
  for (const definition of cache.footnotes ?? []) {
    const from = offset(definition);
    const to = offset(definition, true);
    if (!validRange(source, definition)) continue;
    // Inline footnotes also appear in footnotes; only accept a traditional marker.
    const text = source.slice(from, to);
    if (!text.replace(/^ {0,3}/, "").toLowerCase().startsWith(`[^${definition.id}]:`)) continue;
    if (to !== source.length && source[to] !== "\n" && source[to] !== "\r") return selection;

    // Include an existing blockquote/list prefix so the raw multiline block stays intact.
    const lineStart = source.lastIndexOf("\n", from - 1) + 1;
    const existing = definitions.get(definition.id);
    if (existing && source.slice(existing.start, existing.end).replace(/\r\n?/g, "\n").trim() !==
        source.slice(lineStart, to).replace(/\r\n?/g, "\n").trim()) ambiguous.add(definition.id);
    if (!existing) definitions.set(definition.id, { start: lineStart, end: to });
  }

  const inRange = (from: number, to: number) => {
    let low = 0, high = refs.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (offset(refs[middle]) < from) low = middle + 1; else high = middle;
    }
    const result: typeof refs = [];
    for (let i = low; i < refs.length && offset(refs[i]) < to; i++) {
      if (offset(refs[i], true) <= to) result.push(refs[i]);
    }
    return result;
  };
  const pending = inRange(start, end).map((ref) => ref.id).reverse();
  const visited = new Set<string>();
  const appended: string[] = [];
  while (pending.length > 0) {
    const id = pending.pop()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const definition = definitions.get(id);
    if (!definition || ambiguous.has(id)) continue;
    if (definition.start < start || definition.end > end) {
      appended.push(source.slice(definition.start, definition.end));
    }
    // Iterative preorder traversal also handles very deep chains without a call-stack limit.
    const dependencies = inRange(definition.start, definition.end);
    for (let i = dependencies.length - 1; i >= 0; i--) pending.push(dependencies[i].id);
  }

  if (appended.length === 0) return selection;
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const tail = selection.match(/(?:\r?\n[\t ]*)+$/)?.[0] ?? "";
  const breaks = (tail.match(/\n/g) ?? []).length;
  const finishBlankLine = tail.length > 0 && !tail.endsWith("\n") ? 1 : 0;
  return selection + newline.repeat(Math.max(finishBlankLine, 2 - breaks)) + appended.join(newline);
}

function offset(item: CacheItem, end = false): number {
  return item.position[end ? "end" : "start"].offset;
}

function validRange(source: string, item: CacheItem): boolean {
  const start = offset(item);
  const end = offset(item, true);
  return Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end > start && end <= source.length;
}
