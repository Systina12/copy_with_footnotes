# Copy with Footnotes

Copy selected Markdown together with its referenced footnote definitions.

## Example

Before, in the source note:

```md
Interesting result.[^smith]

...other content...

[^smith]: Smith et al., 2024.
```

Select:

```md
Interesting result.[^smith]
```

After Copy with footnotes, on the clipboard:

```md
Interesting result.[^smith]

[^smith]: Smith et al., 2024.
```

## Usage

- Command Palette -> Copy with footnotes
- Right-click selected text -> Copy with footnotes

Requires Obsidian 1.8.7 or later, in Source mode or Live Preview.

## Local Installation

Run `npm ci`, `npm test`, and `npm run build`. Put `main.js` and
`manifest.json` in `<vault>/.obsidian/plugins/copy-with-footnotes/`, then enable
Copy with Footnotes in Community plugins. No CSS file is needed.



API findings and release checks: [Verification](docs/verification.md).
