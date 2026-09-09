# Experimental Paste with Footnotes

This optional feature is included in version 0.2.0 and defaults to off.
Versions 0.1.0 and 0.1.1 provide Copy only.

## Use

Open **Settings → Copy with Footnotes → Experimental**, then turn on
**Enable Paste with Footnotes**. It defaults to off. Enabling it adds:

- **Paste clipboard** to the Command Palette.
- **Paste with footnotes** to the active Markdown editor's context menu.

Both entries share the same implementation. Source mode and Live Preview are
supported, with one caret or selection. Ctrl+V and the native Paste action keep
their usual behavior. A shortcut can be assigned to the command.

## Conflicts and placement

The clipboard body replaces the selected text. Definitions go to one separate
insertion point. Existing definitions are never renamed, reordered, or rewritten.

| Situation | Result |
| --- | --- |
| Incoming ID is free | Keep it. |
| ID and definition content match | Reuse the definition. |
| Numeric ID has different content | Allocate above all reserved numeric IDs. |
| Named ID has different content | Try `name-2`, `name-3`, and so on. |
| The same clipboard is pasted after an earlier rename | Reuse the matching numeric ID or named suffix when its dependencies also match. |
| Target has duplicate IDs | Reuse that ID only if all its definitions agree; otherwise resolve the incoming conflict. |

Content comparison normalizes line endings and trims outer whitespace. Internal
whitespace remains significant. Nested references and cycles participate in the
mapping. There is no semantic comparison. Only actual reference and label spans
are rewritten, after the complete mapping has been computed.

Removing definitions from the clipboard preserves separation between body
paragraphs. Currency amounts such as `$5` and `$10` remain ordinary text.

Definitions separated only by whitespace form one footnote block.

| Setting | Behavior |
| --- | --- |
| Nearest footnote block (default) | Use the nearest block; a tie favors the block below the caret. |
| Next footnote block | Use the first block below the caret. |
| End of note | Append to the note. |
| After existing definitions (default) | Insert after the chosen block. |
| Before existing definitions | Insert before the chosen block. |

If no suitable block exists, insertion falls back to the end of the note.
Incoming definitions keep first-reference traversal order. The caret ends after
the pasted body, including when definitions were inserted above it.

## Feedback and cancellation

Successful processing reports added and reused definitions, plus changed incoming
IDs. For example: `Footnotes: 0 added, 1 reused, 1 incoming IDs changed.`

A clipboard without recognized definitions is pasted as ordinary text. An empty
clipboard leaves the note and selection intact. A definitions-only clipboard
whose definitions are all reused cannot delete selected body text.

If recognized footnotes cannot be processed safely, the whole operation is
cancelled and the note stays unchanged. It does not paste the full clipboard
after a processing error. Cancellation covers duplicate clipboard IDs,
unsupported definition containers, missing/stale metadata, overlapping existing
definitions, and unsafe Markdown insertion positions.

The command guards code, math, comments, inline footnotes, Wiki links, link
destinations, HTML syntax, and reference-link definitions. It also guards an
indented blank line that would turn the body into code, or a preceding backslash
that would escape the first reference. Normal list/quote continuations and
footnotes in Markdown link labels remain supported. A complete inline construct
can be selected and replaced.

The completed edit is also checked locally. If joining the clipboard with the
surrounding text would hide existing footnotes or create an extra definition,
the paste is cancelled. Code brackets inside inline footnotes cannot cause
their ordinary text to be renamed as traditional references.

## Editing and compatibility

Each paste uses one transaction isolated from adjacent typing and other pastes.
Undo restores the original text and selection; Redo restores the paste.

An edited note is saved when necessary to refresh metadata. The operation is
cancelled if the file, source, selection, editor, or feature state changes while
asynchronous work is pending. Concurrent invocations are rejected.

Clipboard definitions inside lists or blockquotes, citations, attachments, and
automatic renumbering of existing notes are outside this feature. Android/iOS
physical-device checks remain outstanding. See [Verification](verification.md)
for the tested versions and API limits.
