import { buildSync } from "esbuild";
import { runInNewContext } from "node:vm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Command } from "obsidian";
import cases from "./cases.json";
import captured from "./fixtures/obsidian-1.13.7.json";

const compiled = buildSync({ entryPoints: ["src/main.ts"], bundle: true, write: false,
  format: "cjs", external: ["obsidian"] }).outputFiles[0].text;

// Only public API boundaries are stubbed; no Obsidian App mock is needed.
function harness() {
  const commands: Command[] = [];
  const notices: string[] = [];
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const on = (event: string, callback: (...args: unknown[]) => void) => {
    listeners.set(event, callback);
    return { event, callback };
  };
  const writeText = vi.fn().mockResolvedValue(undefined);
  const error = vi.fn();
  const registerEvent = vi.fn();
  class TFile {}
  class MarkdownView {}
  class MenuItem {
    title = "";
    icon = "";
    callback: () => unknown = () => undefined;
    setTitle(title: string) { this.title = title; return this; }
    setIcon(icon: string) { this.icon = icon; return this; }
    onClick(callback: () => unknown) { this.callback = callback; return this; }
  }
  const file = new TFile();
  let source = cases[0].source;
  let end = cases[0].selection.length;
  let mode = "source";
  let active = true;
  const cache = structuredClone(captured.fixtures[0]);
  const getFileCache = vi.fn(() => cache);
  const view = {
    file, getMode: () => mode,
    editor: { getValue: () => source, getCursor: (side: string) => ({ line: 0, ch: side === "from" ? 0 : end }),
      posToOffset: (pos: { ch: number }) => pos.ch },
  };
  class Plugin {
    app = { workspace: { on, getActiveViewOfType: () => active ? view : null },
      metadataCache: { on, getFileCache }, vault: { on } };
    addCommand(command: Command) { commands.push(command); }
    registerEvent = registerEvent;
  }
  const exports = { exports: {} as { default: new () => {
    onload: () => void;
    copySelection: (...args: unknown[]) => Promise<void>;
  } } };
  const clipboard = { writeText };
  runInNewContext(compiled, { module: exports, require: () => ({ Plugin, MarkdownView, TFile,
    Notice: class { constructor(text: string) { notices.push(text); } } }),
    navigator: { clipboard }, console: { error } });
  const plugin = new exports.exports.default();
  plugin.onload();
  const copySelection = vi.spyOn(plugin, "copySelection");
  return {
    commands, notices, writeText, registerEvent, clipboard, error, copySelection, getFileCache,
    run: () => commands[0].callback!(),
    openMenu: (editor = view.editor, info = { file }) => {
      const items: MenuItem[] = [];
      const menu = { addItem: (configure: (item: MenuItem) => void) => {
        const item = new MenuItem();
        configure(item);
        items.push(item);
      } };
      listeners.get("editor-menu")!(menu, editor, info);
      return items;
    },
    setSelection: (value: number) => { end = value; },
    setMode: (value: string) => { mode = value; },
    deactivate: () => { active = false; },
    edit: (value: string) => { source = value; listeners.get("editor-change")!(view.editor, { file }); },
    modify: () => listeners.get("modify")!(file),
    indexed: (value = source) => listeners.get("changed")!(file, value, cache),
    getSource: () => source,
  };
}

describe("command integration", () => {
  let app: ReturnType<typeof harness>;
  beforeEach(() => { app = harness(); });

  it("registers exactly one command and cleanup-managed listeners", () => {
    expect(app.commands.map(({ id, name }) => ({ id, name }))).toEqual([{ id: "copy", name: "Copy with footnotes" }]);
    expect(app.registerEvent).toHaveBeenCalledTimes(4);
    expect(app.registerEvent.mock.calls.map(([ref]) => ref.event)).toContain("editor-menu");
  });

  it("writes to the clipboard without modifying the editor or showing success", async () => {
    await app.run();
    expect(app.writeText).toHaveBeenCalledWith(cases[0].expected);
    expect(app.getSource()).toBe(cases[0].source);
    expect(app.notices).toEqual([]);
  });

  it("leaves the clipboard alone for an empty selection", async () => {
    app.setSelection(0);
    await app.run();
    expect(app.writeText).not.toHaveBeenCalled();
    expect(app.notices).toEqual(["No text selected"]);
  });

  it.each(["reading", "no editor"])("safely handles %s", async (state) => {
    if (state === "reading") app.setMode("preview"); else app.deactivate();
    await app.run();
    expect(app.writeText).not.toHaveBeenCalled();
    expect(app.notices).toEqual(["No active Markdown editor"]);
  });

  it("degrades until the edited source is indexed, then recovers", async () => {
    const current = cases[0].source.replace("Source", "Newest");
    app.edit(current);
    await app.run();
    expect(app.writeText).toHaveBeenLastCalledWith(cases[0].selection);
    app.indexed(cases[0].source);
    await app.run();
    expect(app.writeText).toHaveBeenLastCalledWith(cases[0].selection);
    app.indexed();
    await app.run();
    expect(app.writeText).toHaveBeenLastCalledWith(current);
  });

  it("handles external modifications while metadata is pending", async () => {
    app.modify();
    await app.run();
    expect(app.writeText).toHaveBeenCalledWith(cases[0].selection);
  });

  it("catches clipboard rejection and preserves the note", async () => {
    app.writeText.mockRejectedValue(new Error("denied"));
    await app.run();
    expect(app.notices).toEqual(["Could not copy text to clipboard"]);
    expect(app.getSource()).toBe(cases[0].source);
    expect(app.error).toHaveBeenCalledOnce();
  });

  it("handles an unavailable Clipboard API", async () => {
    Object.defineProperty(app.clipboard, "writeText", { value: undefined });
    await app.run();
    expect(app.notices).toEqual(["Could not copy text to clipboard"]);
  });
});

describe("editor context menu", () => {
  let app: ReturnType<typeof harness>;
  beforeEach(() => { app = harness(); });

  it("adds Copy with footnotes with the built-in copy icon for selected text", () => {
    const items = app.openMenu();
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe("Copy with footnotes");
    expect(items[0].icon).toBe("copy");
    expect(app.writeText).not.toHaveBeenCalled();
  });

  it("does not add an item for an empty selection", () => {
    app.setSelection(0);
    expect(app.openMenu()).toHaveLength(0);
    expect(app.notices).toEqual([]);
  });

  it("invokes the same copy method as the palette command", async () => {
    await app.run();
    await app.openMenu()[0].callback();
    expect(app.copySelection).toHaveBeenCalledTimes(2);
    expect(app.copySelection.mock.calls[0][0]).toBe(app.copySelection.mock.calls[1][0]);
    expect(app.writeText.mock.calls).toEqual([[cases[0].expected], [cases[0].expected]]);
  });

  it("uses the event's editor and file even when no Markdown view is active", async () => {
    app.deactivate();
    const source = cases[0].source.replace("Alpha", "Other");
    const editor = { getValue: () => source,
      getCursor: (side: string) => ({ line: 0, ch: side === "from" ? 0 : cases[0].selection.length }),
      posToOffset: (pos: { ch: number }) => pos.ch };
    const file = {};
    await app.openMenu(editor, { file })[0].callback();
    expect(app.getFileCache).toHaveBeenCalledWith(file);
    expect(app.writeText).toHaveBeenCalledWith(source);
  });

  it("copies successfully without notices or note changes", async () => {
    await app.openMenu()[0].callback();
    expect(app.writeText).toHaveBeenCalledWith(cases[0].expected);
    expect(app.getSource()).toBe(cases[0].source);
    expect(app.notices).toEqual([]);
  });

  it("handles clipboard failure without modifying the note", async () => {
    app.writeText.mockRejectedValue(new Error("denied"));
    await app.openMenu()[0].callback();
    expect(app.notices).toEqual(["Could not copy text to clipboard"]);
    expect(app.error).toHaveBeenCalledOnce();
    expect(app.getSource()).toBe(cases[0].source);
  });

  it("rechecks the selection when the item is clicked", async () => {
    const item = app.openMenu()[0];
    app.setSelection(0);
    await item.callback();
    expect(app.writeText).not.toHaveBeenCalled();
    expect(app.notices).toEqual(["No text selected"]);
  });

  it("uses the same stale-cache fallback and recovery", async () => {
    const current = cases[0].source.replace("Source", "Newest");
    app.edit(current);
    await app.openMenu()[0].callback();
    expect(app.writeText).toHaveBeenLastCalledWith(cases[0].selection);
    app.indexed();
    await app.openMenu()[0].callback();
    expect(app.writeText).toHaveBeenLastCalledWith(current);
  });
});
