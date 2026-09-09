import { ChangeSet, EditorSelection, EditorState, Transaction } from "@codemirror/state";
import { history, redo, undo, undoDepth } from "@codemirror/commands";
import { describe, expect, it } from "vitest";
import { buildPasteEdits, pasteCaretPosition, type PastePlan } from "../src/paste";
import { metadataForSource } from "../src/metadata";
import { PASTE_ORIGIN, pasteHistory } from "../src/paste-history";
import type { InsertionSide, Placement } from "../src/paste-destination";
import cases from "./paste-cases.json";
import sequences from "./paste-sequences.json";
import captured from "./fixtures/paste-obsidian-1.13.7.json";
import oldSequences from "./fixtures/sequences-obsidian-1.8.7.json";
import newSequences from "./fixtures/sequences-obsidian-1.13.7.json";

// Obsidian's public Editor.transaction() constructs a ChangeSet against the old
// document, then resolves the supplied selection in the new document. Exercise
// that contract with real CodeMirror state/history, rather than a string-splice mock.
class EditorModel {
  state: EditorState;
  constructor(source: string, start = 0, end = start) {
    this.state = EditorState.create({ doc: source, selection: EditorSelection.single(start, end), extensions: [history(), pasteHistory] });
  }
  apply(plan: PastePlan) {
    if (!plan.changes.length) return;
    const changes = ChangeSet.of(plan.changes.map((change) => ({ from: change.start, to: change.end, insert: change.text })), this.state.doc.length);
    const doc = changes.apply(this.state.doc);
    const caret = pasteCaretPosition(plan);
    const anchor = doc.line(caret.line + 1).from + caret.ch;
    this.state = this.state.update({ changes, selection: EditorSelection.cursor(anchor),
      annotations: Transaction.userEvent.of(PASTE_ORIGIN) }).state;
  }
  undo() { return undo({ state: this.state, dispatch: (transaction) => { this.state = transaction.state; } }); }
  redo() { return redo({ state: this.state, dispatch: (transaction) => { this.state = transaction.state; } }); }
}

describe.each([oldSequences, newSequences])("consecutive Paste and real undo history, Obsidian $version metadata", (fixtureSet) => {
  it.each(sequences)("$name", (item) => {
    const fixture = fixtureSet.fixtures.find((fixture) => fixture.name === item.name)!;
    const editor = new EditorModel(item.source);
    for (let round = 0; round < fixture.steps.length; round++) {
      const step = fixture.steps[round];
      expect(editor.state.doc.toString()).toBe(step.source);
      expect(editor.state.selection.main.head).toBe(step.caret);
      const plan = buildPasteEdits({ source: step.source, clipboard: item.clipboard, cache: step.cache, cacheSource: step.source,
        selectionStart: step.caret, selectionEnd: step.caret });
      expect(plan.status).toBe("footnotes");
      expect(plan.summary).toEqual({ added: round ? 0 : item.firstAdded,
        reused: item.reused - (round ? 0 : item.firstAdded), renamed: item.renamed });
      editor.apply(plan);
      expect(editor.state.doc.toString()).toBe(item.body.repeat(round + 1) + item.suffix);
      expect(editor.state.selection.main.head).toBe(item.body.repeat(round + 1).length);
      expect(undoDepth(editor.state)).toBe(round + 1);
    }
    for (let i = fixture.steps.length - 1; i >= 0; i--) {
      expect(editor.undo()).toBe(true);
      expect(editor.state.doc.toString()).toBe(fixture.steps[i].source);
    }
    for (let i = 0; i < fixture.steps.length; i++) expect(editor.redo()).toBe(true);
    expect(editor.state.doc.toString()).toBe(item.body.repeat(fixture.steps.length) + item.suffix);
  });
});

describe("editor transaction boundaries", () => {
  it.each(cases)("$name restores in one Undo, or makes no edit", (item) => {
    const rawStart = item.target.indexOf("|");
    const raw = item.target.replace("|", "");
    const source = raw.replace(/\r\n?/g, "\n");
    const start = raw.slice(0, rawStart).replace(/\r\n?/g, "\n").length;
    const end = start + (item.selection ?? "").replace(/\r\n?/g, "\n").length;
    const cache = metadataForSource(captured.fixtures.find((fixture) => fixture.name === item.name)!.cache, raw, source);
    const editor = new EditorModel(source, start, end);
    const plan = buildPasteEdits({ source, clipboard: item.clipboard, cache, cacheSource: source, selectionStart: start, selectionEnd: end,
      placement: item.placement as Placement | undefined, insertionSide: item.insertionSide as InsertionSide | undefined });
    editor.apply(plan);
    expect(editor.state.doc.toString()).toBe(item.expected.replace(/\r\n?/g, "\n"));
    if (plan.changes.length) {
      expect(undoDepth(editor.state)).toBe(1);
      expect(editor.undo()).toBe(true);
      expect(editor.state.doc.toString()).toBe(source);
      expect(editor.state.selection.main.from).toBe(start);
      expect(editor.state.selection.main.to).toBe(end);
      expect(editor.redo()).toBe(true);
      expect(editor.state.doc.toString()).toBe(item.expected.replace(/\r\n?/g, "\n"));
    } else {
      expect(undoDepth(editor.state)).toBe(0);
      expect(editor.state.selection.main.from).toBe(start);
      expect(editor.state.selection.main.to).toBe(end);
    }
  });

  it("keeps a paste separate from adjacent typing", () => {
    const editor = new EditorModel("");
    editor.state = editor.state.update({ changes: { from: 0, insert: "Typed " }, selection: { anchor: 6 },
      annotations: Transaction.userEvent.of("input.type") }).state;
    editor.apply(buildPasteEdits({ source: "Typed ", clipboard: "A[^a]\n\n[^a]: A", selectionStart: 6, selectionEnd: 6, cache: {} }));
    const afterPaste = editor.state.doc.toString();
    const caret = editor.state.selection.main.head;
    editor.state = editor.state.update({ changes: { from: caret, insert: "!" }, selection: { anchor: caret + 1 },
      annotations: Transaction.userEvent.of("input.type") }).state;
    expect(editor.undo()).toBe(true);
    expect(editor.state.doc.toString()).toBe(afterPaste);
    expect(editor.undo()).toBe(true);
    expect(editor.state.doc.toString()).toBe("Typed ");
    expect(editor.undo()).toBe(true);
    expect(editor.state.doc.toString()).toBe("");
  });
});
