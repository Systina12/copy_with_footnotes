Copy with Footnotes 0.2.2 is a patch release for Obsidian 1.8.7 and later.
Experimental Paste remains disabled by default.

- Copying a selection that contains only part of a referenced definition now
  keeps the selection intact, without adding a duplicate definition marker.
- Copying with multiple editor selections now gives a clear notice instead of
  silently copying just the primary selection.
- Paste reuses definitions by comparing actual reference spans and indexes
  compatible candidates by ID family and content. This avoids regular-expression
  backtracking and repeated scans of unrelated definitions.
- Markdown context checks use indexed protected ranges, improving performance
  in notes with many code or comment spans.

Validation: 535 automated tests passed, including stored Obsidian 1.8.7 and
1.13.7 metadata fixtures. Lint, type checking, production build, and CI passed.
The native metadata workers and an installed Obsidian application were not
rerun for this patch release. See the [review](https://github.com/Systina12/copy_with_footnotes/blob/main/docs/review-2026-09-23.md) for
the detailed changes and limits.

Download `main.js` and `manifest.json` below to install manually. No CSS file
is required.
