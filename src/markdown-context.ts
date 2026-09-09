import type { Span } from "./paste-markdown";
import { fromMarkdown } from "mdast-util-from-markdown";
import type { Nodes } from "mdast";

// Parse only the metadata section containing a paste endpoint. This guards
// inline syntax; destination footnotes still come exclusively from Obsidian.
export function inlineSyntaxRanges(source: string, span: Span): Span[] {
  const nodes: Nodes[] = [fromMarkdown(source.slice(span.start, span.end))];
  const ranges: Span[] = [];
  while (nodes.length) {
    const node = nodes.pop()!;
    if (node.type === "link" && source[span.start + node.position!.start.offset!] === "[") {
      // A link label can contain real footnote references; its URL/title cannot.
      const start = node.children.at(-1)?.position?.end.offset ?? node.position!.start.offset! + 1;
      ranges.push({ start: span.start + start, end: span.start + node.position!.end.offset! });
      for (const child of node.children) nodes.push(child);
    } else if (["html", "link", "image", "inlineCode", "code"].includes(node.type)) {
      ranges.push({ start: span.start + node.position!.start.offset!, end: span.start + node.position!.end.offset! });
    } else if ("children" in node) for (const child of node.children) nodes.push(child);
  }
  return ranges;
}

function escaped(source: string, offset: number): boolean {
  let count = 0;
  while (offset > 0 && source[--offset] === "\\") count++;
  return count % 2 === 1;
}

export function inlineCodeRanges(source: string, span: Span): Span[] {
  const text = source.slice(span.start, span.end);
  const runs = [...text.matchAll(/`+/g)];
  const next = new Map<number, number>();
  const closing: (number | undefined)[] = [];
  for (let i = runs.length - 1; i >= 0; i--) { closing[i] = next.get(runs[i][0].length); next.set(runs[i][0].length, i); }
  const result: Span[] = [];
  for (let i = 0; i < runs.length; i++) {
    const end = closing[i];
    if (escaped(text, runs[i].index) || end === undefined || /\r?\n[\t ]*\r?\n/.test(text.slice(runs[i].index, runs[end].index))) continue;
    result.push({ start: span.start + runs[i].index, end: span.start + runs[end].index + runs[end][0].length });
    i = end;
  }
  return result;
}

export function opaqueMarkdownRanges(source: string, literalRanges: readonly Span[]) {
  const ranges: (Span & { openEnd?: boolean })[] = [];
  let unclosed = false;
  const frontmatter = /^---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)(?=\r?\n|$)/.exec(source);
  if (frontmatter) ranges.push({ start: 0, end: frontmatter[0].length });
  const tokens = /%%|\[\[|\^\[|\$\$|\$/g;
  if (frontmatter) tokens.lastIndex = frontmatter[0].length;
  let match: RegExpExecArray | null;
  while ((match = tokens.exec(source))) {
    const start = match.index;
    if (escaped(source, start)) continue;
    const literal = literalRanges.find((span) => start >= span.start && start < span.end);
    if (literal) { tokens.lastIndex = literal.end; continue; }
    let end = -1;
    if (match[0] === "^[") {
      let depth = 1;
      for (let i = tokens.lastIndex; i < source.length; i++) {
        const literal = literalRanges.find((span) => i >= span.start && i < span.end);
        if (literal) { i = literal.end - 1; continue; }
        if (escaped(source, i)) continue;
        if (source[i] === "[") depth++;
        if (source[i] === "]" && --depth === 0) { end = i + 1; break; }
      }
    } else if (match[0] === "$") {
      // Obsidian allows inline math across soft line breaks, but not blank
      // paragraphs. Whitespace and a following digit disqualify closing '$'.
      if (!source[tokens.lastIndex] || /\s/.test(source[tokens.lastIndex])) continue;
      let index = source.indexOf("$", tokens.lastIndex);
      while (index >= 0) {
        if (/\r?\n[\t ]*\r?\n/.test(source.slice(start, index))) break;
        if (!escaped(source, index) && !/\s/.test(source[index - 1]) && !/[0-9]/.test(source[index + 1] ?? "")) {
          end = index + 1;
          break;
        }
        index = source.indexOf("$", index + 1);
      }
    } else {
      const close = match[0] === "[[" ? "]]" : match[0];
      let index = source.indexOf(close, tokens.lastIndex);
      while (index >= 0 && escaped(source, index)) index = source.indexOf(close, index + close.length);
      if (index >= 0) end = index + close.length;
    }
    let openEnd = false;
    if (end < 0) {
      if (match[0] !== "%%" && match[0] !== "$$") continue;
      unclosed = true;
      openEnd = true;
      end = source.length;
    }
    ranges.push({ start, end, openEnd });
    tokens.lastIndex = end;
  }
  return { ranges, unclosed };
}

export function blockIsOpen(raw: string, type: string): boolean {
  const text = raw.trim();
  if (type === "code") {
    const fence = /^(`{3,}|~{3,})/.exec(text);
    if (!fence) return false;
    const lines = raw.split(/\r?\n/);
    return lines.length < 2 || !new RegExp(`^ {0,3}${fence[1][0]}{${fence[1].length},}[\\t ]*$`).test(lines[lines.length - 1]);
  }
  if (type === "math") return text.startsWith("$$") && (text.length < 4 || !text.endsWith("$$"));
  if (type === "comment") return text.startsWith("%%") && (text.length < 4 || !text.endsWith("%%"));
  if (text.startsWith("<!--")) return !text.includes("-->");
  if (text.startsWith("<![CDATA[")) return !text.includes("]]>");
  if (text.startsWith("<?")) return !text.includes("?>");
  const html = /^<(script|style|pre|textarea)(?:\s|>)/i.exec(text);
  return !!html && !new RegExp(`</${html[1]}\\s*>`, "i").test(text);
}
