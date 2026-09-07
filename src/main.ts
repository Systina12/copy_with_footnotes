import { MarkdownView, Notice, Plugin, TFile } from "obsidian";
import type { CachedMetadata, Editor, MarkdownFileInfo } from "obsidian";
import { buildClipboardText, getSelectionOffsets } from "./footnotes";

export default class CopyWithFootnotesPlugin extends Plugin {
  private indexedSources = new WeakMap<CachedMetadata, string>();
  private editedFiles = new WeakSet<TFile>();

  onload(): void {
    this.registerEvent(this.app.metadataCache.on("changed", (_file, source, cache) => {
      this.indexedSources.set(cache, source);
    }));
    this.registerEvent(this.app.workspace.on("editor-change", (_editor, info) => {
      if (info.file) this.editedFiles.add(info.file);
    }));
    this.registerEvent(this.app.vault.on("modify", (file) => {
      if (file instanceof TFile) this.editedFiles.add(file);
    }));
    this.registerEvent(this.app.workspace.on("editor-menu", (menu, editor, info) => {
      const { selectionStart, selectionEnd } = getSelectionOffsets(editor);
      if (selectionStart === selectionEnd || !info.file) return;
      menu.addItem((item) => item
        .setTitle("Copy with footnotes")
        .setIcon("copy")
        .onClick(() => this.copySelection(editor, info)));
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
  }

  private async copySelection(editor: Editor, info: MarkdownFileInfo): Promise<void> {
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
      const cache = this.app.metadataCache.getFileCache(file);
      const cacheSource = cache ? this.indexedSources.get(cache) : undefined;
      // A changed buffer must have a matching indexed snapshot before using its cache.
      if (cacheSource !== undefined || !this.editedFiles.has(file)) {
        text = buildClipboardText({ source, ...selection, cache, cacheSource });
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
