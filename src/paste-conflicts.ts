import type { ClipboardFootnotes, Definition } from "./paste-markdown";
import type { DestinationFootnotes, ExistingDefinition } from "./paste-destination";

export interface ConflictResolution {
  mapping: Map<string, string>;
  reused: Set<string>;
  ordered: Definition[];
}

const normalize = (text: string) => text.replace(/\r\n?/g, "\n");
const numeric = (id: string) => /^\d+$/.test(id);

// Compare the text between actual reference spans. A regex with one capture per
// reference can backtrack exponentially on adjacent references and long text.
// Native metadata already tells us which spans are references in the target.
function segmentsOf(definition: Definition): string[] {
  let cursor = definition.label.end + 2;
  const parts: string[] = [];
  for (const reference of definition.references) {
    parts.push(normalize(definition.text.slice(cursor - definition.start, reference.start - definition.start)));
    cursor = reference.end;
  }
  parts.push(normalize(definition.text.slice(cursor - definition.start)));
  parts[0] = parts[0].trimStart();
  parts[parts.length - 1] = parts[parts.length - 1].trimEnd();
  return parts;
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
  const segments = new Map<Definition, string[]>();
  const getSegments = (definition: Definition) => {
    let parts = segments.get(definition);
    if (!parts) { parts = segmentsOf(definition); segments.set(definition, parts); }
    return parts;
  };
  const unresolved = ordered.filter((definition) => !mapping.has(definition.id));
  const searchNumeric = unresolved.some((definition) => numeric(definition.id));
  const namedIds = new Set(unresolved.filter((definition) => !numeric(definition.id)).map((definition) => definition.id));
  const numericByText = new Map<string, string[]>();
  const namedSuffixes = new Map<string, string[]>();
  const targetKeys = new Map<string, string | null>();
  const targetKey = (id: string): string | null => {
    if (targetKeys.has(id)) return targetKeys.get(id)!;
    const targets = existing.get(id)!;
    const key = JSON.stringify(getSegments(targets[0]));
    const result = targets.every((target) => JSON.stringify(getSegments(target)) === key) ? key : null;
    targetKeys.set(id, result);
    return result;
  };
  // Search only eligible ID families. Numeric IDs can map to any numeric ID,
  // so also group them by the non-reference text they must share to be reused.
  for (const id of existing.keys()) {
    if (numeric(id)) {
      if (!searchNumeric) continue;
      const key = targetKey(id);
      if (key === null) continue;
      const candidates = numericByText.get(key) ?? [];
      candidates.push(id);
      numericByText.set(key, candidates);
    } else if (namedIds.size) {
      const suffix = /^(.*)-([1-9]\d*)$/.exec(id);
      if (!suffix || suffix[2] === "1" || !namedIds.has(suffix[1])) continue;
      const candidates = namedSuffixes.get(suffix[1]) ?? [];
      candidates.push(id);
      namedSuffixes.set(suffix[1], candidates);
    }
  }
  const bindings = (definition: Definition, target: ExistingDefinition): [string, string][] | null => {
    if (definition.references.length !== target.references.length) return null;
    const incomingParts = getSegments(definition);
    const targetParts = getSegments(target);
    if (incomingParts.some((part, index) => part !== targetParts[index])) return null;
    return definition.references.map((reference, index) => [reference.id, target.references[index].id]);
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
    // Check the original ID first, even if its content cannot match; this
    // preserves its priority over previously renamed definitions.
    const key = JSON.stringify(getSegments(definition));
    const candidates = numeric(definition.id) ? numericByText.get(key) ?? [] :
      (namedSuffixes.get(definition.id) ?? []).filter((id) => targetKey(id) === key);
    const prioritized = [definition.id, ...candidates.filter((id) => id !== definition.id)];
    for (const candidate of prioritized) {
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
