import { MarkdownView, Notice, Plugin, TFile } from "obsidian";
import type { CachedMetadata, Editor, MarkdownFileInfo } from "obsidian";
import { buildClipboardText, getSelectionOffsets } from "./footnotes";
import { buildPasteEdits, cancelPastePlan, pasteCaretPosition, pasteNotice, type PastePlan } from "./paste";
import { FootnoteError, parseClipboardFootnotes } from "./paste-markdown";
import { DEFAULT_SETTINGS, FootnoteSettingTab, normalizeSettings, type FootnoteSettings } from "./settings";
import { metadataForSource } from "./metadata";
import { PASTE_ORIGIN, pasteHistory } from "./paste-history";

interface IndexedNote { source: string; cache: CachedMetadata }

export default class CopyWithFootnotesPlugin extends Plugin {
  private editedFiles = new WeakSet<TFile>();
  private indexedNotes = new WeakMap<TFile, IndexedNote>();
  private cacheWaiters = new Set<() => void>();
  private stopped = false;
  private pasteGeneration = 0;
  private pasteCommandRegistered = false;
  private settingsWrite = Promise.resolve();
  private pasteInProgress = false;
  settings: FootnoteSettings = { ...DEFAULT_SETTINGS };

  async onload(): Promise<void> {
    this.registerEditorExtension(pasteHistory);
    this.registerEvent(this.app.metadataCache.on("changed", (file, source, cache) => {
      this.indexedNotes.set(file, { source, cache });
      for (const wake of this.cacheWaiters) wake();
    }));
    this.registerEvent(this.app.workspace.on("editor-change", (_editor, info) => {
      if (info.file) this.editedFiles.add(info.file);
    }));
    this.registerEvent(this.app.vault.on("modify", (file) => {
      if (file instanceof TFile) this.editedFiles.add(file);
    }));
    this.registerEvent(this.app.workspace.on("editor-menu", (menu, editor, info) => {
      const { selectionStart, selectionEnd } = getSelectionOffsets(editor);
      if (!info.file) return;
      if (selectionStart !== selectionEnd) {
        menu.addItem((item) => item
          .setTitle("Copy with footnotes")
          .setIcon("copy")
          .onClick(() => this.copySelection(editor, info)));
      }
      if (this.settings.enablePaste && this.isPasteEditor(editor, info)) {
        menu.addItem((item) => item.setTitle("Paste with footnotes").setIcon("clipboard-paste")
          .onClick(() => this.pasteClipboard(editor, info)));
      }
    }));
    this.addCommand({
      id: "copy",
      name: "Copy selection",
      callback: () => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view || view.getMode() !== "source") {
          new Notice("No active Markdown editor");
          return;
        }
        return this.copySelection(view.editor, view);
      },
    });
    try { this.settings = normalizeSettings(await this.loadData()); }
    catch (error) {
      console.error("Copy with Footnotes: settings load failed", error);
      if (!this.stopped) new Notice("Could not load settings; experimental paste is disabled");
    }
    if (this.stopped) return;
    this.addSettingTab(new FootnoteSettingTab(this));
    this.syncPasteCommand();
  }

  onunload(): void {
    this.stopped = true;
    this.pasteGeneration++;
    for (const wake of this.cacheWaiters) wake();
  }

  async updateSettings(update: Partial<FootnoteSettings>): Promise<void> {
    if (this.stopped) return;
    const next = normalizeSettings({ ...this.settings, ...update });
    if (next.enablePaste !== this.settings.enablePaste) this.pasteGeneration++;
    this.settings = next;
    this.syncPasteCommand();
    for (const wake of this.cacheWaiters) wake();
    this.settingsWrite = this.settingsWrite.then(async () => { if (!this.stopped) await this.saveData(next); }).catch((error: unknown) => {
      console.error("Copy with Footnotes: settings save failed", error);
      if (!this.stopped) new Notice("Could not save settings");
    });
    await this.settingsWrite;
  }

  private syncPasteCommand(): void {
    if (this.stopped || this.pasteCommandRegistered === this.settings.enablePaste) return;
    if (this.settings.enablePaste) {
      this.addCommand({ id: "paste", name: "Paste clipboard", callback: () => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view || view.getMode() !== "source") { new Notice("No active Markdown editor"); return; }
        return this.pasteClipboard(view.editor, view);
      } });
    } else this.removeCommand("paste");
    this.pasteCommandRegistered = this.settings.enablePaste;
  }

  private isPasteEditor(editor: Editor, info: MarkdownFileInfo): boolean {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    return !!view && view.getMode() === "source" && view.editor === editor && view.file === info.file;
  }

  private async getPasteMetadata(file: TFile, source: string, view: MarkdownView, isCurrent: () => boolean): Promise<IndexedNote | null> {
    if (!source.trim()) return { source, cache: {} };
    const current = () => {
      const indexed = this.indexedNotes.get(file);
      const cache = indexed && metadataForSource(indexed.cache, indexed.source, source);
      return cache ? { source, cache } : null;
    };
    if (current()) return current();
    // Existing caches predate plugin activation. Check the saved buffer and
    // marker ranges; subsequent changed events provide an exact source/cache pair.
    if (!this.editedFiles.has(file) && !this.indexedNotes.has(file)) {
      try {
        const saved = await this.app.vault.cachedRead(file);
        if (!isCurrent()) return null;
        if (current()) return current();
        const cache = this.app.metadataCache.getFileCache(file);
        const aligned = cache && metadataForSource(cache, saved, source);
        if (aligned && !this.editedFiles.has(file)) return { source, cache: aligned };
      } catch (error) { console.error("Copy with Footnotes: metadata unavailable", error); }
    }
    // requestSave() is debounced by two seconds. Waiting 1.5s without saving
    // first guaranteed premature timeouts during rapid, otherwise valid pastes.
    if (!isCurrent()) return null;
    try { await view.save(); }
    catch { throw new FootnoteError("Could not refresh this note's footnotes"); }
    if (!isCurrent()) return null;
    if (current()) return current();
    return new Promise((resolve) => {
      const finish = (value: IndexedNote | null) => {
        window.clearTimeout(timer);
        this.cacheWaiters.delete(check);
        resolve(value);
      };
      const check = () => {
        const indexed = current();
        if (indexed || !isCurrent()) finish(indexed);
      };
      const timer = window.setTimeout(() => finish(null), 3000);
      this.cacheWaiters.add(check);
      check();
    });
  }

  private async pasteClipboard(editor: Editor, info: MarkdownFileInfo): Promise<void> {
    if (this.stopped || !this.settings.enablePaste) return;
    if (this.pasteInProgress) { new Notice("A paste is already in progress"); return; }
    this.pasteInProgress = true;
    try { await this.performPaste(editor, info); }
    finally { this.pasteInProgress = false; }
  }

  private async performPaste(editor: Editor, info: MarkdownFileInfo): Promise<void> {
    const file = info.file;
    if (!file || !this.isPasteEditor(editor, info)) { new Notice("No active Markdown editor"); return; }
    if (editor.listSelections().length !== 1) { new Notice("Select a single paste location"); return; }
    const source = editor.getValue();
    const selection = getSelectionOffsets(editor);
    const settings = { ...this.settings };
    const generation = this.pasteGeneration;
    const view = this.app.workspace.getActiveViewOfType(MarkdownView)!;
    const stillCurrent = () => {
      if (this.stopped || generation !== this.pasteGeneration || !this.settings.enablePaste ||
          !this.isPasteEditor(editor, info) || info.file !== file) return false;
      const current = getSelectionOffsets(editor);
      return editor.getValue() === source &&
        editor.listSelections().length === 1 && current.selectionStart === selection.selectionStart && current.selectionEnd === selection.selectionEnd;
    };
    let clipboard: string;
    try { clipboard = await navigator.clipboard.readText(); }
    catch (error) {
      console.error("Copy with Footnotes: clipboard read failed", error);
      new Notice("Could not read text from clipboard");
      return;
    }
    if (!clipboard) return;
    if (!stillCurrent()) { if (!this.stopped) new Notice("Paste location changed; try again"); return; }
    let plan: PastePlan;
    try {
      const incoming = parseClipboardFootnotes(clipboard);
      const indexed = incoming.definitions.length ? await this.getPasteMetadata(file, source, view, stillCurrent) : null;
      if (!stillCurrent()) { if (!this.stopped) new Notice("Paste location changed; try again"); return; }
      plan = buildPasteEdits({ source, clipboard, incoming, ...selection, ...settings,
        cache: indexed?.cache ?? null, cacheSource: indexed?.source });
    } catch (error) {
      if (!(error instanceof FootnoteError)) console.error("Copy with Footnotes: paste preparation failed", error);
      plan = cancelPastePlan(source, selection.selectionStart,
        error instanceof FootnoteError ? error.message : "Could not prepare this paste");
    }
    if (!stillCurrent()) return;
    const message = pasteNotice(plan);
    if (plan.status === "cancelled" || !plan.changes.length) {
      if (message) new Notice(message);
      return;
    }
    try {
      editor.transaction({ changes: plan.changes.map((change) => ({
        from: editor.offsetToPos(change.start), to: editor.offsetToPos(change.end), text: change.text,
      })), selection: { from: pasteCaretPosition(plan) } }, PASTE_ORIGIN);
      if (editor.getValue().replace(/\r\n?/g, "\n") !== plan.result.replace(/\r\n?/g, "\n")) {
        new Notice("The note changed during paste. Check the result before retrying.");
        return;
      }
      if (message) new Notice(message);
    } catch (error) {
      console.error("Copy with Footnotes: paste failed", error);
      new Notice("Paste failed. Check the note before retrying.");
    }
  }

  private async copySelection(editor: Editor, info: MarkdownFileInfo): Promise<void> {
    if (this.stopped) return;
    const file = info.file;
    if (!file) {
      new Notice("No active Markdown editor");
      return;
    }

    const source = editor.getValue();
    const selection = getSelectionOffsets(editor);
    if (selection.selectionStart === selection.selectionEnd) {
      new Notice("No text selected");
      return;
    }

    let text = source.slice(selection.selectionStart, selection.selectionEnd);
    try {
      const indexed = this.indexedNotes.get(file);
      if (indexed) {
        const cache = metadataForSource(indexed.cache, indexed.source, source);
        text = buildClipboardText({ source, ...selection, cache, cacheSource: source });
      } else if (!this.editedFiles.has(file)) {
        text = buildClipboardText({ source, ...selection, cache: this.app.metadataCache.getFileCache(file) });
      }
    } catch (error) {
      console.error("Copy with Footnotes: metadata unavailable", error);
    }

    try {
      await navigator.clipboard.writeText(text);
    } catch (error) {
      console.error("Copy with Footnotes: clipboard write failed", error);
      new Notice("Could not copy text to clipboard");
    }
  }
}
