# Verification

Verified locally: `npm ci` completed with zero reported vulnerabilities;
`npm run typecheck` passed; `npm test` passed 103/103 tests; `npm run build`
produced a 3,668-byte `main.js`. Each official worker passed all 36 cases and
matched its stored fixture data. Core source totals 158 lines; source,
tests, verifier, and build script total approximately 560 lines, excluding
JSON fixtures, documentation, dependencies, and generated output.

## Public API

Checked the official `obsidian` 1.13.1 typings and the current
[sample plugin](https://github.com/obsidianmd/obsidian-sample-plugin).
`CachedMetadata.footnotes` was introduced in 1.6.6 and `footnoteRefs` in 1.8.7.
Both cache items have `id` and `position: Pos`; `Loc.offset` is an absolute
character offset. The plugin uses `Editor.getValue()`, `getCursor("from"/"to")`,
`posToOffset()`, `Workspace.getActiveViewOfType(MarkdownView)`, `getMode()`,
`MetadataCache.getFileCache()`, `Plugin.addCommand()`, `registerEvent()`, and `Notice`.
The `editor-menu` event (since 1.1.0) provides `(Menu, Editor,
MarkdownView | MarkdownFileInfo)`. It adds a selected-text-only menu item with
`Menu.addItem()`, `MenuItem.setTitle()`, `setIcon("copy")`, and `onClick()`.
The command and menu both call `copySelection(editor, info)`, including the same
cache checks and clipboard handling. The menu uses the event's editor/file;
opening a menu does not copy anything or alter the native Copy item.

The [submission requirements](https://docs.obsidian.md/community-directory/submission-requirements-for-plugins)
recommend `navigator.clipboard.writeText()` as a portable alternative to Electron.
There are no runtime dependencies, Node/Electron imports, Markdown parsers,
network requests, or CSS. Clipboard writing happens before the command's first
`await`, preserving the user gesture as far as the host WebView allows.

## Actual Metadata Behavior

Executed the unmodified `worker.js` from official public desktop releases
**1.8.7** and **1.13.7** against the cases in `tests/cases.json`.
The worker executes in a Node VM only during verification; it is not a runtime
dependency and its code is not redistributed. The captured metadata fixtures
are outputs for our own Markdown examples, not fabricated parser mocks.

Both releases return the following offsets for:

```md
A[^x]

[^x]: First
    Second
    Third
```

- Reference: `[1, 5)`.
- Definition: `[7, 39)`, including both continuation lines.
- Definition end is exclusive, before any terminal newline.
- Paragraph breaks, tab indentation, lazy continuation, CRLF, and fenced code
  within definitions are also covered by the native range.
- Code-fence and inline-code references do not enter `footnoteRefs`.
- Undefined references may be absent from `footnoteRefs`; normal copy is safe.
- IDs are lowercased in metadata; original spelling is preserved in the output.
- Inline footnotes appear in `footnotes` with synthetic IDs and content-only
  ranges. A traditional `[^id]:` marker check excludes them.
- A blockquote/list definition starts after the first-line container prefix.
  The plugin includes that line's original prefix so continuation context is
  retained without rewriting Markdown.

No continuation fallback is necessary on either tested release. Future parser
changes are not covered by these results; run the verifier against new releases.

## Cache Freshness

Expected: use the current editor text and never copy an obviously stale definition.

Actual API: `getFileCache()` exposes neither the indexed source/version nor a
public synchronous reparse function. The `changed(file, data, cache)` event does
provide the corresponding source. The plugin keeps that association in a
WeakMap, and observes `editor-change` and vault `modify` through registered events.

Fallback: after an observed edit, metadata is used only with an exact matching
source snapshot. Until indexing catches up, only the original selection is
copied. Range bounds, reference spelling, definition markers, and definition
line endings are additionally checked against the current buffer. Every output
definition is sliced from that buffer. No note-writing API is called.

Remaining risk: caches already present when the plugin is enabled have no
historical source snapshot. They are accepted only after the local position
checks; an unobserved edit before plugin activation that preserves all checked
positions but changes syntax elsewhere cannot be conclusively detected. Once
a `changed` event supplies a snapshot, full source equality is enforced. Exotic
labels whose parser normalization differs from lowercasing degrade to normal
copy. Definitions missing from metadata are not discovered by another parser.

## Tests and Reproduction

```sh
npm ci
npm run typecheck
npm test
npm run build
```

The regular tests are offline and use fixtures from both releases. They cover
basic/multiple/repeated references, complete and partial definitions, missing
and recursive dependencies, cycles, ordering, native code exclusions, inline
footnotes, container prefixes, source preservation, newlines, stale caches,
reversed offsets, and a 12,000-definition dependency chain. Focused command
tests cover no editor, Reading View, empty selection, clipboard failures,
event cleanup registration, and cache recovery. Context-menu tests cover item
visibility, icon, the shared execution method, the event's editor/file, success,
failure, selection changes before clicking, and stale-cache recovery. The
original 95 tests are retained, with command-label and listener-count assertions
updated for the new entry point.

To repeat actual parser verification, extract `worker.js` from the matching
official `obsidian-<version>.asar.gz` release asset and run:

```sh
npm run test:metadata -- /path/to/worker.js 1.8.7
npm run test:metadata -- /path/to/worker.js 1.13.7
```

An optional `--write` regenerates fixtures. Normal `npm test` never downloads
or invokes an Obsidian binary. TypeScript checks include production and test code.
No separate lint tool is configured.

## Metadata Audit

- ID: `copy-with-footnotes`, lowercase and hyphenated, with no `obsidian` prefix.
  The public published-plugin registry was checked on 2026-09-07: none of its
  7,367 entries matched the ID, name, or `Systina12/copy_with_footnotes` repository.
  This is not a reservation; Community Directory determines final availability.
- `manifest.json`, `package.json`, and `versions.json` agree on `0.1.0`.
  The release tag must be exactly `0.1.0`, without a `v` prefix.
- The manifest/package description is "Copy selected Markdown together with
  its referenced footnote definitions." It is 73 characters, ends with a period, and is below
  the 250-character limit.
- `minAppVersion` and `versions.json["0.1.0"]` remain `1.8.7`, the first version
  exposing footnote references and a version verified with the official worker.
- `isDesktopOnly` remains false: no runtime Node or Electron dependency is used.
- `manifest.json.author` is `Systina12`, with `authorUrl` set to
  `https://github.com/Systina12`, as supplied by the owner. No funding URL is set.
- Command ID remains `copy`; Obsidian adds the plugin prefix itself.

## Release Checklist

- Author metadata has been supplied by the owner and filled in `manifest.json`.
- The repository's existing MIT license names Systina12 and was preserved.
- In Desktop Source mode and Live Preview, select text and confirm both
  Command Palette and right-click Copy with footnotes produce the same text.
- Check that empty selections have no added menu item, the native Copy item is
  unchanged, and a right-click in another split copies from that editor.
- Check the system clipboard with multiline and recursive definitions, immediate
  edits, and code-fence examples. The note and selection must remain unchanged.
- Disable/re-enable the plugin and confirm no duplicate menu items. Repeat the
  applicable selection/clipboard checks on Android and iOS; verify a brief Notice
  on clipboard failure when the platform permits reproducing it. Real worker
  execution and API-boundary tests are not full-app or physical-device tests.
- Create a GitHub release tagged `0.1.0` with `main.js` and `manifest.json`.
  `versions.json` belongs in the repository. No `styles.css` is needed.
- Follow the current [official submission guide](https://docs.obsidian.md/plugins/releasing/submit-plugin):
  sign in at [community.obsidian.md](https://community.obsidian.md), link the
  owner's GitHub account, and add the plugin for automated review. The directory
  reads `manifest.json` at the default branch HEAD, so the final metadata must
  be committed and pushed by the owner before submission. The matching GitHub
  release assets are also required.
- The only command is Copy with footnotes, also available from the editor menu.
  Ctrl+C, paste, collision resolution,
  renumbering, citations, wikilinks, embeds, attachments, and other requested
  exclusions remain outside version 0.1.0.
