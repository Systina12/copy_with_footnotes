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

After copying, on the clipboard:

```md
Interesting result.[^smith]

[^smith]: Smith et al., 2024.
```

## Usage

- Command Palette -> Copy selection
- Right-click selected text -> Copy with footnotes

Requires Obsidian 1.8.7 or later, in Source mode or Live Preview.

## Experimental Paste

In the plugin settings, turn on **Enable Paste with Footnotes**. Use
**Paste clipboard** in the Command Palette or **Paste with footnotes** in the
editor menu. Choose the nearest block, the next block, or the end of the note,
and insert definitions before or after that block. Existing definitions are
reused or incoming IDs are renamed when needed. [Details](docs/experimental-paste.md).

## Local Installation

Use a supported LTS Node.js release. Run `npm ci`, `npm test`, and
`npm run build`. Put `main.js` and
`manifest.json` in `<vault>/.obsidian/plugins/copy-with-footnotes/`, then enable
Copy with Footnotes in Community plugins. No CSS file is needed.

API findings and release checks: [Verification](docs/verification.md).
