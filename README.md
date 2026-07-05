# CodeMap

CodeMap is a VS Code extension that adds fast Search Everywhere navigation for large workspaces.

Version `0.2.3` focuses on fast, basic symbol navigation across common project languages.

## Commands

- `CodeMap: Build Index`
- `CodeMap: Sync Index`
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
- Basic symbol search for TypeScript, JavaScript, Python, Lua, Java, Kotlin, Go, Rust, C/C++, C#, PHP, Ruby, Swift, Dart, Vue, Svelte, Shell, and PowerShell
- Basic text search
- Grouped QuickPick results
- Dedicated search panel with All, Symbols, Classes, Functions, Files, and Text modes
- Search panel defaults to Symbols so class and function definitions appear before text matches
- Search panel supports up/down selection and Enter to open
- Local index stored in `.codemap/meta.json` and `.codemap/files.jsonl`
- Progress notification while building the index
- `.codemapignore` support
- Startup auto-sync for existing indexes
- Index info command
- Clear index command

CodeMap can still read the old `.codemap/index.json` prototype format, but new builds write the split JSONL format.

Language support in this prototype is regex-based. It is intended for fast navigation and common declarations, not complete compiler-grade parsing.

## Index Lifecycle

Run `CodeMap: Build Index` the first time a workspace uses CodeMap.

After that, CodeMap loads the existing `.codemap/` index when the workspace opens. If `codemap.autoSyncOnStartup` is enabled, it will quietly scan for external changes and update the index in the background. This helps after operations such as `git pull`, SVN update, branch switching, or generated code refreshes.

Use `CodeMap: Sync Index` when you want to manually reconcile the index with files on disk without forcing a full rebuild.

Use `CodeMap: Clear Index` followed by `CodeMap: Build Index` when changing broad include/exclude rules or when you want a clean rebuild.

## Ignore Rules

Add a `.codemapignore` file at the workspace root to exclude folders or files from indexing.

Example:

```gitignore
node_modules/
.venv/
dist/
generated/
resources/
assets/
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
