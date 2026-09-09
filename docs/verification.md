# Verification

This document covers Copy with Footnotes 0.2.0, including optional experimental
Paste. Versions 0.1.0 and 0.1.1 contain Copy only; their tags and release assets
remain unchanged.

## Results

Latest validation ran on 2026-09-09 after fixing the four follow-up review findings.

| Check | Result |
| --- | --- |
| `npm ci` and dependency audit | Clean install succeeded; zero known vulnerabilities. |
| `npm test` | 527/527 tests in six files passed. |
| `npm run build` | TypeScript check and production build passed. |
| Production `main.js` | 119,890 bytes, including bundled dependency licenses. |
| Official Obsidian 1.8.7 worker | 38 Copy, 114 Paste, 8 sequences / 40 consecutive pastes passed. |
| Official Obsidian 1.13.7 worker | Same cases and sequences passed. |
| Installed Obsidian 1.13.7 | 320 native scenario checks passed across Source and Live Preview. |

Each native editor mode passed 114 Paste scenarios, eight five-paste sequences,
and 38 Copy scenarios. The native harness invoked registered commands through
Obsidian's official CLI and used the actual editor, clipboard, metadata,
notices, and Undo/Redo. It verified cancellation or one-step restoration of
text and selection, stable carets, and success feedback during repeated pastes.
Fixture setup waited for indexing and rendering before placing and checking the
caret/selection; repeated pastes did not add a wait between rounds. Clipboard
readback was allowed up to 250 ms without re-running Copy.
See the [review report](review-2026-09-09.md) for findings and evidence.

## Reproduce

```sh
npm ci
npm test
npm run build
npm run test:metadata -- /path/to/worker-1.8.7.js 1.8.7
npm run test:metadata -- /path/to/worker-1.13.7.js 1.13.7
```

The workers must come from the corresponding official Obsidian release. They
are not shipped with the plugin. Fixtures are native metadata for this
project's own Markdown examples. The verifier checks resulting native
reference/definition IDs in boundary cases. Every accepted structured Paste
also checks the actual added-definition count and preserves the original
definition content, including existing duplicates.

Use `--write` after the version only to intentionally regenerate fixtures.
Normal tests are offline and do not download or execute Obsidian binaries.
TypeScript checks include production and test code. No separate lint tool is
configured. Temporary verification files belong in the ignored `.verification/`
directory.

Release preparation upgraded the development test runner to Vitest 4.1.11,
which fixes GHSA-82fw-gwwq-j7x9. Use a supported LTS Node.js release for the
development tools. Vitest is not included in the plugin bundle.

For application checks, install the built `main.js` and `manifest.json` into a
separate test vault. Enable experimental Paste and repeat the cases in
`tests/paste-cases.json` and `tests/paste-sequences.json` in Source mode and Live
Preview. Check notices, selection and caret restoration, Undo/Redo, settings
toggling, and the shared command/menu behavior. Repeat Copy with
`tests/cases.json`. Existing notes must be kept separate from test fixtures.

## Public APIs and runtime

The minimum version remains 1.8.7: `CachedMetadata.footnotes` arrived in 1.6.6
and `footnoteRefs` in 1.8.7. The implementation uses:

- Editor text, selection, cursor, and offset APIs, plus `Editor.transaction()`.
- `MarkdownView`, its source/preview mode, and `save()` for metadata refresh.
- `MetadataCache.getFileCache()` and `changed(file, source, cache)`.
- Registered `editor-change`, `editor-menu`, and vault `modify` events.
- Command registration/removal, settings persistence, `PluginSettingTab`,
  `registerEditorExtension()`, and `Notice`.
- `navigator.clipboard.readText()` and `writeText()`.
- CodeMirror's public transaction extension and `isolateHistory` annotation.

Obsidian and CodeMirror are external host modules. Clipboard parsing uses
bundled `mdast-util-from-markdown`, `mdast-util-gfm-footnote`, and
`micromark-extension-gfm-footnote`. The build includes licenses for every bundled
package. There are no runtime Node/Electron imports, network requests,
telemetry, or CSS assets.

Destination footnote positions come from Obsidian metadata. Affected sections
and their adjoining blocks are checked again after the planned edits, without
reparsing the entire note. Existing definition ranges and unaffected references
must remain valid, and inserted references must still be references. This
rejects new code fences, inline code/math, or duplicate definitions formed at
the paste boundary. Metadata remains authoritative for collecting destination
definitions. Short probes distinguish indented code from list continuations.

## Cache and source fidelity

The current editor text supplies all copied or rewritten content. The plugin
keeps the source/cache pair from `changed` in a WeakMap keyed by file.

- A cached pair must match the current buffer. LF/CRLF differences alone are
  projected into current offsets without modifying the cached object.
- Bounds, reference text, definition markers, IDs, and line endings are checked.
  A visible traditional definition missing from destination metadata cancels Paste.
- Paste calls `MarkdownView.save()` when a matching snapshot is unavailable,
  then waits up to three seconds for metadata. The former 1.5-second wait could
  expire before Obsidian's two-second automatic-save debounce.
- The file, active editor, source, selection, lifecycle, and enabled state are
  rechecked after asynchronous work. A disposed editor is not queried.
- Copy returns the original selection while an observed edit lacks matching
  metadata. It does not guess among conflicting duplicate definitions.

Obsidian has no public synchronous reparse API or historical source version for
caches created before plugin activation. Startup caches also rely on local
position checks. An unobserved earlier syntax change that preserves all checked
positions cannot be ruled out completely; this remains an API limitation.

## Parsing, placement, and history

Native ranges include complete multiline definitions, paragraph breaks,
indentation, lazy continuation, CRLF, and code fences within definitions.
Inline footnotes are excluded from traditional definitions. Copy preserves raw
Markdown and traverses dependencies iteratively, in first-reference order,
with cycle protection.

Paste covers numeric/named conflicts, existing duplicate IDs, reuse after
renaming, dependency graphs and cycles, all placement settings, multiple
blocks and tie breaking, replacement ranges, definitions-only clipboards,
line endings, and unsafe insertion contexts. A cancelled plan has no edits.
An accepted plan contains at most one body replacement and one definition
insertion. CodeMirror tests check history isolation from adjacent typing as
well as consecutive pastes.

Integration tests cover default-off behavior, shared commands and menus,
settings persistence errors and toggles, unavailable clipboard APIs,
concurrent invocations, save/index waits, timeout recovery, closing an editor,
disabling the feature, and unloading during an operation.

## Release and platform checks

The manifest ID is `copy-with-footnotes`; author is `Systina12`. Copy retains
command ID `copy`, command name **Copy selection**, and menu label **Copy with
footnotes**. Paste uses ID `paste`, command name **Paste clipboard**, and menu
label **Paste with footnotes**.

Before a new release, choose its version and update the manifest, package
metadata, and `versions.json`. Preserve the 0.1.0 and 0.1.1 records and tags.
Release assets are `main.js` and `manifest.json`; no empty `styles.css` is needed.
Follow the current [submission guide](https://docs.obsidian.md/plugins/releasing/submit-plugin)
for Community Directory review.

Android/iOS physical-device checks remain outstanding. Worker and desktop
application results do not establish every mobile clipboard or host behavior.
See [Experimental Paste](experimental-paste.md) for user-facing behavior.
