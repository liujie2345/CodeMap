# CodeMap Everywhere

Fast structured Search Everywhere for VS Code, built for large codebases and monorepos.

CodeMap Everywhere helps you jump to the right class, function, file, or text match without digging through noisy full-text results. It is designed for projects where VS Code's default search feels too broad and IDEs like PyCharm feel too heavy.

> Demo GIF coming soon.

## Why CodeMap Everywhere

VS Code search is great for text, but large projects often need a more code-aware workflow:

- Search classes, functions, symbols, files, and text from one place.
- Show structured results before generic text matches.
- Keep a local workspace index for faster repeat searches.
- Support large projects, monorepos, legacy codebases, and game/editor projects.
- Stay local-first with no cloud dependency.

If you want a Search Everywhere experience closer to JetBrains IDEs, but inside VS Code, CodeMap Everywhere is the experiment.

## Features

- Dedicated search panel with grouped results.
- QuickPick-based Search Everywhere command.
- Classes, functions, interfaces, types, files, and text search.
- Symbols-first ranking so definitions appear before noisy text matches.
- Separator-aware exact matching, such as `create-kubeconfig` ranking above similar fuzzy matches.
- Local index stored under `.codemap/`.
- Startup auto-sync for existing indexes.
- Manual sync after `git pull`, SVN update, branch switching, or external file changes.
- `.codemapignore` support for excluding resources, generated files, and large folders.
- Index info view with file count, symbol count, language counts, and storage path.

## Supported Languages

CodeMap Everywhere currently provides regex-based symbol extraction for common declarations in:

- TypeScript / JavaScript
- Python
- Lua
- Java
- Kotlin
- Go
- Rust
- C / C++
- C#
- PHP
- Ruby
- Swift
- Dart
- Vue / Svelte
- Shell
- PowerShell

Language support is intentionally lightweight in this prototype. It is built for fast navigation, not compiler-grade static analysis.

## Quick Start

Install the extension, open a workspace, then run:

```text
CodeMap: Build Index
```

Open the search panel:

```text
CodeMap: Open Search Panel
```

Or use the compact command:

```text
CodeMap: Search Everywhere
```

Default shortcuts:

- Search Everywhere: `Ctrl+Shift+Alt+O`
- Search Panel: `Ctrl+Shift+Alt+M`

On macOS:

- Search Everywhere: `Cmd+Shift+Alt+O`
- Search Panel: `Cmd+Shift+Alt+M`

## Commands

- `CodeMap: Build Index`
- `CodeMap: Sync Index`
- `CodeMap: Search Everywhere`
- `CodeMap: Open Search Panel`
- `CodeMap: Show Index Info`
- `CodeMap: Clear Index`

## Index Lifecycle

Run `CodeMap: Build Index` the first time a workspace uses CodeMap Everywhere.

After that, CodeMap Everywhere loads the existing `.codemap/` index when the workspace opens. If `codemap.autoSyncOnStartup` is enabled, it quietly scans for external changes and updates the index in the background.

Use `CodeMap: Sync Index` when you want to reconcile the index with files on disk without forcing a full rebuild.

Use `CodeMap: Clear Index` followed by `CodeMap: Build Index` when changing broad include/exclude rules or when you want a clean rebuild.

## Ignoring Large Folders

CodeMap Everywhere only scans supported code file extensions by default, so assets like PNGs, models, audio, and video files are not read as source files. Still, large resource folders can contain scripts or create unnecessary traversal cost.

Add a `.codemapignore` file at the workspace root:

```gitignore
assets/
resources/
art/
textures/
audio/
video/
models/
generated/
vendor/
dist/
build/
*.snap
```

This is especially useful for game projects, editor projects, and monorepos.

## Tested On

Early testing has used:

- [apache/apisix](https://github.com/apache/apisix): Lua project
- [kubernetes/kubernetes](https://github.com/kubernetes/kubernetes): large Go project

More benchmark data will be added as the indexing backend matures.

## Current Storage

New indexes are stored as:

```text
.codemap/meta.json
.codemap/files.jsonl
```

CodeMap Everywhere can still read the old `.codemap/index.json` prototype format.

The current storage is good enough for early testing, but very large projects may eventually need a stronger backend. Planned directions include SQLite, sharded indexes, worker-based indexing, and more language-aware parsers.

## Roadmap

- SQLite or sharded index backend.
- Better Python class and method hierarchy extraction.
- Better Lua module and method extraction.
- Search result preview and richer context.
- More precise ranking based on current file and recent navigation.
- Marketplace release.
- Performance benchmarks on large real-world repositories.

## Development

Install dependencies:

```bash
npm install
```

Compile:

```bash
npm run compile
```

Run the ranking smoke test:

```bash
npm run smoke
```

Package a local VSIX:

```bash
npm run vsix
```

During extension development, open this folder in VS Code and press `F5` to launch an Extension Development Host.
