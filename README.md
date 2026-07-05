# CodeMap

CodeMap is a VS Code extension that adds fast Search Everywhere navigation for large workspaces.

Version `0.2.0` focuses on TypeScript, JavaScript, and Python projects.

## Commands

- `CodeMap: Build Index`
- `CodeMap: Search Everywhere`
- `CodeMap: Open Search Panel`
- `CodeMap: Show Index Info`
- `CodeMap: Clear Index`

Default shortcut:

- Windows/Linux: `Ctrl+Shift+Alt+O`
- macOS: `Cmd+Shift+Alt+O`

Search panel shortcut:

- Windows/Linux: `Ctrl+Shift+Alt+M`
- macOS: `Cmd+Shift+Alt+M`

## v0.1 Scope

- File search
- Class search
- Function search
- Interface and type search
- Python class and function search
- Basic text search
- Grouped QuickPick results
- Dedicated search panel with All, Symbols, Classes, Functions, Files, and Text modes
- Search panel defaults to Symbols so class and function definitions appear before text matches
- Search panel supports up/down selection and Enter to open
- Local index stored in `.codemap/meta.json` and `.codemap/files.jsonl`
- Progress notification while building the index
- `.codemapignore` support
- Index info command
- Clear index command

CodeMap can still read the old `.codemap/index.json` prototype format, but new builds write the split JSONL format.

## Ignore Rules

Add a `.codemapignore` file at the workspace root to exclude folders or files from indexing.

Example:

```gitignore
node_modules/
.venv/
dist/
generated/
*.snap
```

## Packaging

Create a local VSIX package:

```bash
npm install
npm run compile
npm run vsix
```

Then install the generated `.vsix` from VS Code:

```text
Extensions -> ... -> Install from VSIX
```

## Development

```bash
npm install
npm run compile
```

Then open this folder in VS Code and press `F5` to launch the extension host.
