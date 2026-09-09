import { EditorState } from "@codemirror/state";
import { isolateHistory } from "@codemirror/commands";

export const PASTE_ORIGIN = "input.paste.copy-with-footnotes";

// Use Obsidian's public editor-extension hook and CodeMirror's public annotation.
// The unique user event restricts isolation to this plugin's own transactions.
export const pasteHistory = EditorState.transactionExtender.of((transaction) =>
  transaction.isUserEvent(PASTE_ORIGIN) ? { annotations: isolateHistory.of("full") } : null);
