import { PluginSettingTab, Setting } from "obsidian";
import type CopyWithFootnotesPlugin from "./main";
import type { InsertionSide, Placement } from "./paste-destination";

export interface FootnoteSettings { enablePaste: boolean; placement: Placement; insertionSide: InsertionSide }
export const DEFAULT_SETTINGS: FootnoteSettings = { enablePaste: false, placement: "nearest", insertionSide: "after" };

export function normalizeSettings(value: unknown): FootnoteSettings {
  const data = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    enablePaste: data.enablePaste === true,
    placement: data.placement === "next" || data.placement === "end" ? data.placement : "nearest",
    insertionSide: data.insertionSide === "before" ? "before" : "after",
  };
}

export class FootnoteSettingTab extends PluginSettingTab {
  constructor(private plugin: CopyWithFootnotesPlugin) { super(plugin.app, plugin); }

  display(): void {
    this.containerEl.empty();
    new Setting(this.containerEl).setName("Experimental").setHeading();
    new Setting(this.containerEl).setName("Enable Paste with Footnotes").addToggle((toggle) => toggle
      .setValue(this.plugin.settings.enablePaste).onChange(async (enablePaste) => {
        await this.plugin.updateSettings({ enablePaste });
        this.display();
      }));
    new Setting(this.containerEl).setName("Footnote placement").addDropdown((dropdown) => dropdown
      .addOption("nearest", "Nearest footnote block").addOption("next", "Next footnote block").addOption("end", "End of note")
      .setValue(this.plugin.settings.placement).setDisabled(!this.plugin.settings.enablePaste)
      .onChange(async (placement) => { await this.plugin.updateSettings({ placement: placement as Placement }); }));
    new Setting(this.containerEl).setName("Insert definitions").addDropdown((dropdown) => dropdown
      .addOption("after", "After existing definitions").addOption("before", "Before existing definitions")
      .setValue(this.plugin.settings.insertionSide).setDisabled(!this.plugin.settings.enablePaste)
      .onChange(async (insertionSide) => { await this.plugin.updateSettings({ insertionSide: insertionSide as InsertionSide }); }));
  }
}
