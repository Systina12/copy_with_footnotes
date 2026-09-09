import type { ClipboardFootnotes, Definition } from "./paste-markdown";
import type { DestinationFootnotes, ExistingDefinition } from "./paste-destination";

export interface ConflictResolution {
  mapping: Map<string, string>;
  reused: Set<string>;
  ordered: Definition[];
}

const normalize = (text: string) => text.replace(/\r\n?/g, "\n");
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const numeric = (id: string) => /^\d+$/.test(id);

function contentOf(definition: Definition): string {
  return normalize(definition.text.slice(definition.label.end + 2 - definition.start)).trim();
}

// Only incoming IDs may change. Compare all other content exactly, after newline
// and outer-whitespace normalization. Native reference spans confirm captures.
function templateOf(definition: Definition) {
  let cursor = definition.label.end + 2;
  const parts: string[] = [];
  for (const reference of definition.references) {
    parts.push(normalize(definition.text.slice(cursor - definition.start, reference.start - definition.start)));
    cursor = reference.end;
  }
  parts.push(normalize(definition.text.slice(cursor - definition.start)));
  parts[0] = parts[0].trimStart();
  parts[parts.length - 1] = parts[parts.length - 1].trimEnd();
  return { parts, pattern: new RegExp(`^${parts.map(escape).join("([^\\s\\[\\]\\\\]+)")}$`) };
}

function allowedTarget(id: string, target: string): boolean {
  if (id === target) return true;
  if (numeric(id)) return numeric(target);
  const suffix = target.slice(id.length + 1);
  return target.startsWith(`${id}-`) && /^[1-9]\d*$/.test(suffix) && BigInt(suffix) >= 2n;
}

export function resolveFootnoteConflicts(incoming: ClipboardFootnotes, destination: DestinationFootnotes): ConflictResolution {
  const byId = new Map(incoming.definitions.map((definition) => [definition.id, definition]));
  const pending = [...incoming.bodyReferences.map((reference) => reference.id), ...byId.keys()].reverse();
  const visited = new Set<string>();
  const ordered: Definition[] = [];
  while (pending.length) {
    const id = pending.pop()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const definition = byId.get(id);
    if (!definition) continue;
    ordered.push(definition);
    for (let i = definition.references.length - 1; i >= 0; i--) pending.push(definition.references[i].id);
  }
  const existing = new Map<string, ExistingDefinition[]>();
  for (const definition of destination.definitions) {
    const group = existing.get(definition.id) ?? [];
    group.push(definition);
    existing.set(definition.id, group);
  }
  const mapping = new Map<string, string>();
  const reused = new Set<string>();
  // Preserve all nonconflicting incoming IDs, even when another ID has similar content.
  for (const definition of ordered) {
    if (!destination.reservedIds.has(definition.id)) mapping.set(definition.id, definition.name);
  }
  const templates = new Map<Definition, ReturnType<typeof templateOf>>();
  const referencePositions = new Map<Definition, Map<number, string>>();
  const bindings = (definition: Definition, target: ExistingDefinition): [string, string][] | null => {
    const content = contentOf(target);
    if (contentOf(definition) === content) return definition.references.map((reference) => [reference.id, reference.id]);
    let template = templates.get(definition);
    if (!template) { template = templateOf(definition); templates.set(definition, template); }
    const match = template.pattern.exec(content);
    if (!match) return null;
    let positions = referencePositions.get(target);
    if (!positions) {
      const start = target.label.end + 2 - target.start;
      const raw = normalize(target.text.slice(start));
      const leading = raw.length - raw.trimStart().length;
      positions = new Map(target.references.map((reference) => [
        normalize(target.text.slice(start, reference.start - target.start)).length - leading, reference.id,
      ]));
      referencePositions.set(target, positions);
    }
    let offset = template.parts[0].length;
    const result: [string, string][] = [];
    for (let i = 0; i < definition.references.length; i++) {
      const id = match[i + 1].toLowerCase();
      if (positions.get(offset) !== id) return null;
      result.push([definition.references[i].id, id]);
      offset += match[i + 1].length + template.parts[i + 1].length;
    }
    return result;
  };
  const tryReuse = (id: string, targetId: string): Map<string, string> | null => {
    const proposed = new Map<string, string>();
    const queue: [string, string][] = [[id, targetId]];
    while (queue.length) {
      const [inputId, outputId] = queue.pop()!;
      const fixed = mapping.get(inputId) ?? proposed.get(inputId);
      if (fixed !== undefined) { if (fixed.toLowerCase() !== outputId) return null; else continue; }
      const definition = byId.get(inputId);
      const targets = existing.get(outputId);
      if (!definition || !targets?.length || !allowedTarget(inputId, outputId)) return null;
      proposed.set(inputId, targets[0].name); // Also terminates cyclic comparisons.
      for (const target of targets) {
        const dependencies = bindings(definition, target);
        if (!dependencies) return null;
        for (const dependency of dependencies) {
          if (byId.has(dependency[0])) queue.push(dependency);
          else if (dependency[0] !== dependency[1]) return null;
        }
      }
    }
    return proposed;
  };
  for (const definition of ordered) {
    if (mapping.has(definition.id)) continue;
    const candidates = [...new Set([definition.id, ...existing.keys()])].filter((id) => allowedTarget(definition.id, id));
    for (const candidate of candidates) {
      const proposal = tryReuse(definition.id, candidate);
      if (!proposal) continue;
      for (const [id, name] of proposal) { mapping.set(id, name); reused.add(id); }
      break;
    }
  }
  const occupied = new Set([...destination.reservedIds, ...incoming.reservedIds]);
  let maximum = 0n;
  for (const id of occupied) if (numeric(id) && BigInt(id) > maximum) maximum = BigInt(id);
  for (const definition of ordered) {
    if (mapping.has(definition.id)) continue;
    let name: string;
    if (numeric(definition.id)) name = String(++maximum);
    else {
      let suffix = 2;
      do { name = `${definition.name}-${suffix++}`; } while (occupied.has(name.toLowerCase()));
    }
    occupied.add(name.toLowerCase());
    mapping.set(definition.id, name);
  }
  return { mapping, reused, ordered };
}
