import type { CachedMetadata, CacheItem } from "obsidian";

function lineStarts(source: string): number[] {
  const starts = [0];
  for (const match of source.matchAll(/\r\n|\r|\n/g)) starts.push(match.index + match[0].length);
  return starts;
}

// A saved CRLF buffer and the editor's LF buffer have the same text but different
// absolute offsets. Project only this exact newline difference; reject real edits.
export function metadataForSource(cache: CachedMetadata, indexedSource: string, source: string): CachedMetadata | null {
  if (indexedSource === source) return cache;
  if (indexedSource.replace(/\r\n?/g, "\n") !== source.replace(/\r\n?/g, "\n")) return null;
  const oldStarts = lineStarts(indexedSource);
  const newStarts = lineStarts(source);
  const translate = (offset: number) => {
    if (!Number.isInteger(offset) || offset < 0 || offset > indexedSource.length) throw new Error("Invalid metadata offset");
    let low = 0, high = oldStarts.length;
    while (low + 1 < high) {
      const middle = (low + high) >>> 1;
      if (oldStarts[middle] <= offset) low = middle; else high = middle;
    }
    return newStarts[low] + offset - oldStarts[low];
  };
  const project = <T extends CacheItem>(item: T): T => ({ ...item, position: {
    start: { ...item.position.start, offset: translate(item.position.start.offset) },
    end: { ...item.position.end, offset: translate(item.position.end.offset) },
  } });
  try {
    return { footnotes: cache.footnotes?.map(project), footnoteRefs: cache.footnoteRefs?.map(project), sections: cache.sections?.map(project) };
  } catch { return null; }
}
