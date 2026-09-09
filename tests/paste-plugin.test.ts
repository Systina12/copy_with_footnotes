import { buildSync } from "esbuild";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CachedMetadata, Command, EditorPosition, EditorTransaction } from "obsidian";
import type { FootnoteSettings, FootnoteSettingTab } from "../src/settings";
import * as cmState from "@codemirror/state";
import * as cmCommands from "@codemirror/commands";
import { PASTE_ORIGIN } from "../src/paste-history";
import cases from "./paste-cases.json";
import captured from "./fixtures/paste-obsidian-1.13.7.json";

const compiled = buildSync({ entryPoints: ["src/main.ts"], bundle: true, write: false,
  platform: "node", format: "cjs", external: ["obsidian", "@codemirror/state", "@codemirror/commands"] }).outputFiles[0].text;
const initialSource = cases[1].target.replace("|", "");
const initialCache: CachedMetadata = captured.fixtures[1].cache;
interface RuntimePlugin {
  onload(): Promise<void>;
  onunload(): void;
  updateSettings(update: Partial<FootnoteSettings>): Promise<void>;
  pasteClipboard(editor: unknown, info: unknown): Promise<void>;
  settings: FootnoteSettings;
}

class SettingControl<Value> {
  value?: Value;
  disabled = false;
  options: Record<string, string> = {};
  change: (value: Value) => unknown = () => undefined;
  setValue(value: Value) { this.value = value; return this; }
  setDisabled(disabled: boolean) { this.disabled = disabled; return this; }
  addOption(value: string, name: string) { this.options[value] = name; return this; }
  onChange(callback: (value: Value) => unknown) { this.change = callback; return this; }
}

interface LegacySettingRow {
  name: string;
  toggle?: SettingControl<boolean>;
  dropdown?: SettingControl<string>;
}

async function harness(saved: unknown = { enablePaste: true }) {
  const commands: Command[] = [];
  const notices: string[] = [];
  const listeners = new Map<string, (...args: any[]) => void>();
  const on = (event: string, callback: (...args: any[]) => void) => { listeners.set(event, callback); return { event, callback }; };
  class TFile { path = "Paste test.md"; }
  class MarkdownView {}
  const file = new TFile();
  const state = { source: initialSource, savedSource: initialSource, start: 0, end: 0, mode: "source", active: true, selections: 1 };
  const position = (offset: number): EditorPosition => {
    const lines = state.source.slice(0, offset).split("\n");
    return { line: lines.length - 1, ch: lines[lines.length - 1].length };
  };
  const offset = (pos: EditorPosition) => state.source.split("\n").slice(0, pos.line).reduce((sum, line) => sum + line.length + 1, 0) + pos.ch;
  const transaction = vi.fn((tx: EditorTransaction, _origin?: string) => {
    const changes = (tx.changes ?? []).map((change) => ({ start: offset(change.from), end: offset(change.to ?? change.from), text: change.text }));
    for (const change of changes.sort((a, b) => b.start - a.start)) {
      state.source = state.source.slice(0, change.start) + change.text + state.source.slice(change.end);
    }
    state.source = state.source.replace(/\r\n?/g, "\n");
    if (tx.selection) state.start = state.end = offset(tx.selection.from);
    listeners.get("editor-change")!(editor, { file });
  });
  const editor = { getValue: () => state.source, getCursor: (side: string) => position(side === "from" ? state.start : state.end),
    posToOffset: offset, offsetToPos: position, listSelections: () => Array.from({ length: state.selections }, () => ({ from: position(state.start), to: position(state.end) })), transaction };
  const save = vi.fn().mockResolvedValue(undefined);
  const view = { file, editor, getMode: () => state.mode, save };
  const readText = vi.fn().mockResolvedValue(cases[1].clipboard);
  const writeText = vi.fn().mockResolvedValue(undefined);
  const clipboard = { readText, writeText };
  const getFileCache = vi.fn((): CachedMetadata | null => structuredClone(initialCache));
  const cachedRead = vi.fn(async () => state.savedSource);
  const saveData = vi.fn().mockResolvedValue(undefined);
  const error = vi.fn();
  const addSettingTab = vi.fn<(tab: FootnoteSettingTab) => void>();
  const renderedSettings: LegacySettingRow[] = [];
  // Model the pre-1.13 API: no declarative rendering or refresh methods exist.
  class PluginSettingTab {
    containerEl = { empty: () => { renderedSettings.length = 0; } };
  }
  class Setting {
    row: LegacySettingRow = { name: "" };
    constructor() { renderedSettings.push(this.row); }
    setName(name: string) { this.row.name = name; return this; }
    setHeading() { return this; }
    addToggle(configure: (control: SettingControl<boolean>) => void) {
      this.row.toggle = new SettingControl<boolean>(); configure(this.row.toggle); return this;
    }
    addDropdown(configure: (control: SettingControl<string>) => void) {
      this.row.dropdown = new SettingControl<string>(); configure(this.row.dropdown); return this;
    }
  }
  class Plugin {
    app = { workspace: { on, getActiveViewOfType: () => state.active ? view : null },
      metadataCache: { on, getFileCache }, vault: { on, cachedRead } };
    addCommand(command: Command) { commands.push(command); }
    removeCommand(id: string) { const index = commands.findIndex((command) => command.id === id); if (index >= 0) commands.splice(index, 1); }
    registerEvent() {}
    registerEditorExtension() {}
    loadData = async () => saved;
    saveData = saveData;
    addSettingTab = addSettingTab;
  }
  const module = { exports: {} as { default: new () => RuntimePlugin } };
  runInNewContext(compiled, { module, navigator: { clipboard }, console: { error }, window: { setTimeout, clearTimeout },
    require: (name: string) => name === "@codemirror/state" ? cmState : name === "@codemirror/commands" ? cmCommands : ({ Plugin, TFile, MarkdownView, PluginSettingTab, Setting,
      Notice: class { constructor(message: string) { notices.push(message); } } }) });
  const plugin = new module.exports.default();
  await plugin.onload();
  const pasteClipboard = vi.spyOn(plugin, "pasteClipboard");
  return { plugin, commands, notices, state, readText, clipboard, error, transaction, editor, view, getFileCache, cachedRead, save, saveData, addSettingTab, pasteClipboard,
    settingTab: addSettingTab.mock.calls[0][0], renderedSettings,
    run: async () => { await commands.find((command) => command.id === "paste")!.callback!(); },
    edit: (source = state.source) => { state.source = source; listeners.get("editor-change")!(editor, { file }); },
    index: (source = state.source, cache = structuredClone(initialCache)) => listeners.get("changed")!(file, source, cache),
    menu: () => {
      const items: { title: string; icon: string; callback: () => unknown }[] = [];
      listeners.get("editor-menu")!({ addItem(configure: (item: unknown) => void) {
        const item = { title: "", icon: "", callback: () => undefined as unknown,
          setTitle(title: string) { this.title = title; return this; }, setIcon(icon: string) { this.icon = icon; return this; },
          onClick(callback: () => unknown) { this.callback = callback; return this; } };
        configure(item); items.push(item);
      } }, editor, view);
      return items;
    },
  };
}

afterEach(() => { vi.useRealTimers(); });

describe("experimental settings and entry points", () => {
  it.each([undefined, null, "invalid", { enablePaste: "true" }])("is off by default for %j", async (saved) => {
    const app = await harness(saved === undefined ? {} : saved);
    expect(app.commands.map((command) => command.id)).toEqual(["copy"]);
    expect(app.menu()).toHaveLength(0);
    expect(app.plugin.settings).toEqual({ enablePaste: false, placement: "nearest", insertionSide: "after" });
    expect(app.addSettingTab).toHaveBeenCalledOnce();
  });

  it("persists toggles and never registers duplicate commands", async () => {
    const app = await harness({});
    await app.plugin.updateSettings({ enablePaste: true });
    await app.plugin.updateSettings({ enablePaste: true, placement: "next", insertionSide: "before" });
    expect(app.commands.map(({ id, name }) => ({ id, name }))).toEqual([
      { id: "copy", name: "Copy selection" }, { id: "paste", name: "Paste clipboard" },
    ]);
    expect(app.menu().map((item) => item.title)).toEqual(["Paste with footnotes"]);
    await app.plugin.updateSettings({ enablePaste: false });
    expect(app.commands).toHaveLength(1);
    expect(app.menu()).toHaveLength(0);
    const reloaded = await harness(app.saveData.mock.calls.at(-1)![0]);
    expect(reloaded.plugin.settings).toEqual({ enablePaste: false, placement: "next", insertionSide: "before" });
  });

  it("palette and menu share one implementation and a single editor transaction", async () => {
    const app = await harness();
    const item = app.menu()[0];
    expect(item.icon).toBe("clipboard-paste");
    await item.callback();
    expect(app.pasteClipboard).toHaveBeenCalledOnce();
    expect(app.transaction).toHaveBeenCalledOnce();
    expect(app.transaction.mock.calls[0][1]).toBe(PASTE_ORIGIN);
    expect(app.state.source).toBe(cases[1].expected);
    expect(app.notices).toEqual(["Footnotes: 1 added, 0 reused."]);
    app.state.source = initialSource; app.state.start = app.state.end = 0; app.index();
    await app.run();
    expect(app.pasteClipboard).toHaveBeenCalledTimes(2);
    expect(app.state.source).toBe(cases[1].expected);
  });

  it("reports settings write errors", async () => {
    const app = await harness();
    app.saveData.mockRejectedValue(new Error("disk"));
    await app.plugin.updateSettings({ placement: "end" });
    expect(app.notices).toEqual(["Could not save settings"]);
  });

  it("declarative controls update commands and persist values across reload", async () => {
    const app = await harness({});
    await app.settingTab.setControlValue("enablePaste", true);
    await app.settingTab.setControlValue("enablePaste", true);
    expect(app.commands.filter((command) => command.id === "paste")).toHaveLength(1);
    await app.settingTab.setControlValue("placement", "end");
    await app.settingTab.setControlValue("insertionSide", "before");
    const reloaded = await harness(app.saveData.mock.calls.at(-1)![0]);
    expect(reloaded.plugin.settings).toEqual({ enablePaste: true, placement: "end", insertionSide: "before" });
    await app.settingTab.setControlValue("enablePaste", false);
    expect(app.commands.map((command) => command.id)).toEqual(["copy"]);
  });

  it("declarative settings reject unknown keys and normalize invalid values", async () => {
    const app = await harness();
    await app.settingTab.setControlValue("__proto__", { enablePaste: false });
    await app.settingTab.setControlValue("unrecognized", true);
    expect(app.saveData).not.toHaveBeenCalled();
    await app.settingTab.setControlValue("enablePaste", "true");
    await app.settingTab.setControlValue("placement", null);
    await app.settingTab.setControlValue("insertionSide", "invalid");
    expect(app.plugin.settings).toEqual({ enablePaste: false, placement: "nearest", insertionSide: "after" });
    expect(app.commands.map((command) => command.id)).toEqual(["copy"]);
  });

  it("legacy settings render and persist changes without any 1.13 APIs", async () => {
    const app = await harness({});
    app.settingTab.display();
    expect(app.renderedSettings.filter((row) => row.dropdown).every((row) => row.dropdown!.disabled)).toBe(true);
    await app.renderedSettings.find((row) => row.toggle)!.toggle!.change(true);
    expect(app.renderedSettings.find((row) => row.toggle)!.toggle!.value).toBe(true);
    const dropdowns = app.renderedSettings.flatMap((row) => row.dropdown ? [row.dropdown] : []);
    expect(dropdowns).toHaveLength(2);
    expect(dropdowns.every((control) => !control.disabled)).toBe(true);
    await dropdowns[0].change("next");
    await dropdowns[1].change("before");
    expect(app.plugin.settings).toEqual({ enablePaste: true, placement: "next", insertionSide: "before" });
    await app.renderedSettings.find((row) => row.toggle)!.toggle!.change(false);
    expect(app.renderedSettings.filter((row) => row.dropdown).every((row) => row.dropdown!.disabled)).toBe(true);
    expect(app.commands.map((command) => command.id)).toEqual(["copy"]);
    const reloaded = await harness(app.saveData.mock.calls.at(-1)![0]);
    expect(reloaded.plugin.settings).toEqual({ enablePaste: false, placement: "next", insertionSide: "before" });
  });
});

describe("clipboard and editor boundary behavior", () => {
  it("plain text bypasses metadata entirely", async () => {
    const app = await harness();
    app.readText.mockResolvedValue("hello");
    app.getFileCache.mockReturnValue(null);
    await app.run();
    expect(app.state.source).toBe("hello" + initialSource);
    expect(app.cachedRead).not.toHaveBeenCalled();
    expect(app.getFileCache).not.toHaveBeenCalled();
    expect(app.notices).toEqual([]);
  });

  it("an empty clipboard leaves the selection intact", async () => {
    const app = await harness();
    app.state.end = 2; app.readText.mockResolvedValue("");
    await app.run();
    expect(app.state.source).toBe(initialSource);
    expect(app.transaction).not.toHaveBeenCalled();
  });

  it.each(["denied", "unavailable"])("handles %s clipboard reads", async (reason) => {
    const app = await harness();
    if (reason === "denied") app.readText.mockRejectedValue(new Error("denied"));
    else Object.defineProperty(app.clipboard, "readText", { value: undefined });
    await app.run();
    expect(app.notices).toEqual(["Could not read text from clipboard"]);
    expect(app.transaction).not.toHaveBeenCalled();
  });

  it.each(["reading", "inactive", "multiple selections"])("does not paste with %s", async (condition) => {
    const app = await harness();
    if (condition === "reading") app.state.mode = "preview";
    if (condition === "inactive") app.state.active = false;
    if (condition === "multiple selections") app.state.selections = 2;
    await app.run();
    expect(app.readText).not.toHaveBeenCalled();
    expect(app.transaction).not.toHaveBeenCalled();
  });

  it.each(["selection", "source", "file", "view", "mode", "disabled", "disabled then enabled"])("cancels when %s changes during clipboard read", async (change) => {
    const app = await harness();
    let complete!: (text: string) => void;
    app.readText.mockReturnValue(new Promise<string>((resolve) => { complete = resolve; }));
    const pending = app.run();
    if (change === "selection") app.state.start = app.state.end = 1;
    if (change === "source") app.edit("Changed");
    if (change === "file") app.view.file = { path: "Other.md" };
    if (change === "view") app.state.active = false;
    if (change === "mode") app.state.mode = "preview";
    if (change.startsWith("disabled")) {
      await app.plugin.updateSettings({ enablePaste: false });
      if (change === "disabled then enabled") await app.plugin.updateSettings({ enablePaste: true });
    }
    complete(cases[1].clipboard); await pending;
    expect(app.transaction).not.toHaveBeenCalled();
  });

  it("does not retry a transaction that may already have applied", async () => {
    const app = await harness();
    app.transaction.mockImplementation(() => { app.state.source = "Already applied"; throw new Error("after edit"); });
    await app.run();
    expect(app.transaction).toHaveBeenCalledOnce();
    expect(app.state.source).toBe("Already applied");
    expect(app.notices).toEqual(["Paste failed. Check the note before retrying."]);
  });

  it("closing an editor during clipboard access never reads its disposed selection", async () => {
    const app = await harness();
    let complete!: (text: string) => void;
    app.readText.mockReturnValue(new Promise<string>((resolve) => { complete = resolve; }));
    const pending = app.run();
    app.state.active = false;
    vi.spyOn(app.editor, "getCursor").mockImplementation(() => { throw new Error("Editor disposed"); });
    complete(cases[1].clipboard);
    await expect(pending).resolves.toBeUndefined();
    expect(app.transaction).not.toHaveBeenCalled();
  });

  it("rejects a concurrent paste while preserving the first paste", async () => {
    const app = await harness();
    let complete!: (text: string) => void;
    app.readText.mockReturnValueOnce(new Promise<string>((resolve) => { complete = resolve; }));
    const first = app.run();
    await app.run();
    expect(app.readText).toHaveBeenCalledOnce();
    expect(app.notices).toEqual(["A paste is already in progress"]);
    complete(cases[1].clipboard); await first;
    expect(app.transaction).toHaveBeenCalledOnce();
    expect(app.state.source).toBe(cases[1].expected);
  });
});

describe("metadata freshness without permanent fallback", () => {
  it("saves an edited note before waiting for its matching metadata", async () => {
    const app = await harness();
    app.edit();
    app.save.mockImplementation(async () => { app.index(); });
    await app.run();
    expect(app.save).toHaveBeenCalledOnce();
    expect(app.state.source).toBe(cases[1].expected);
  });

  it("a save failure cancels the paste without inserting clipboard definitions", async () => {
    const app = await harness();
    app.edit();
    app.save.mockRejectedValue(new Error("Disk unavailable"));
    await app.run();
    expect(app.transaction).not.toHaveBeenCalled();
    expect(app.state.source).toBe(initialSource);
    expect(app.notices[0]).toContain("Could not refresh this note's footnotes");
  });

  it("uses a matching file snapshot even if getFileCache returns another object", async () => {
    const app = await harness();
    app.edit(); app.index(); app.getFileCache.mockReturnValue(null);
    await app.run();
    expect(app.state.source).toBe(cases[1].expected);
    expect(app.notices).toEqual(["Footnotes: 1 added, 0 reused."]);
  });

  it("waits for indexing after an edit, then performs the structured paste", async () => {
    const app = await harness();
    app.edit(); app.index("outdated source");
    const pending = app.run();
    await Promise.resolve(); await Promise.resolve();
    expect(app.transaction).not.toHaveBeenCalled();
    app.index(); await pending;
    expect(app.state.source).toBe(cases[1].expected);
    expect(app.notices).toEqual(["Footnotes: 1 added, 0 reused."]);
  });

  it("times out safely and recovers on the next indexed paste", async () => {
    vi.useFakeTimers();
    const app = await harness(); app.edit();
    const pending = app.run();
    await vi.advanceTimersByTimeAsync(3000); await pending;
    expect(app.notices[0]).toContain("still updating");
    expect(app.state.source).toBe(initialSource);
    expect(app.transaction).not.toHaveBeenCalled();
    app.state.source = initialSource; app.state.start = app.state.end = 0; app.index();
    await app.run();
    expect(app.state.source).toBe(cases[1].expected);
    expect(app.notices).toHaveLength(2);
  });

  it("unloading cancels an indexing wait and clears its timeout", async () => {
    vi.useFakeTimers();
    const app = await harness(); app.edit();
    const pending = app.run(); await vi.advanceTimersByTimeAsync(0);
    app.plugin.onunload(); await pending;
    expect(app.transaction).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("disabling Paste from declarative settings cancels an indexing wait", async () => {
    vi.useFakeTimers();
    const app = await harness(); app.edit();
    const pending = app.run(); await vi.advanceTimersByTimeAsync(0);
    await app.settingTab.setControlValue("enablePaste", false);
    await pending;
    expect(app.transaction).not.toHaveBeenCalled();
    expect(app.state.source).toBe(initialSource);
    expect(vi.getTimerCount()).toBe(0);
    expect(app.commands.map((command) => command.id)).toEqual(["copy"]);
  });
});
