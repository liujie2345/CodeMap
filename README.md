# CodeMap Everywhere

Fast structured Search Everywhere for VS Code, built for large codebases and monorepos.

CodeMap Everywhere helps you jump to the right class, function, file, or text match without digging through noisy full-text results. It is designed for projects where VS Code's default search feels too broad and IDEs like PyCharm feel too heavy.

> Demo
> <img width="1372" height="671" alt="POPO_RECORDER_20260706002446" src="https://github.com/user-attachments/assets/b1c8d9fd-210d-4a60-a480-ac7d09d49309" />


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
- Mode-aware search so Symbols, Files, and Text tabs avoid unnecessary scans.
- Separator-aware exact matching, such as `create-kubeconfig` ranking above similar fuzzy matches.
- Improved Python class method and Lua module function extraction.
- Local index stored under `.codemap/`.
- Startup auto-sync for existing indexes.
- Manual sync after `git pull`, SVN update, branch switching, or external file changes.
- `.codemapignore` support for excluding resources, generated files, and large folders.
- Text indexing caps for very large workspaces.
- Index info view with file count, symbol count, language counts, and storage path.

## Editions

CodeMap Everywhere is one repository with three usage paths:

- **VS Code Extension**: interactive Search Everywhere panel for developers.
- **CLI**: terminal and script interface for code search.
- **AI Enhanced Edition**: CLI plus Agent Skill instructions for AI coding agents.

See [docs/EDITIONS.md](docs/EDITIONS.md), [docs/AI_ENHANCED_EDITION.md](docs/AI_ENHANCED_EDITION.md), and [docs/AGENT_USAGE.md](docs/AGENT_USAGE.md).

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

## VS Code Commands

- `CodeMap: Build Index`
- `CodeMap: Sync Index`
- `CodeMap: Search Everywhere`
- `CodeMap: Open Search Panel`
- `CodeMap: Show Index Info`
- `CodeMap: Clear Index`

## CLI Preview

CodeMap Everywhere also includes an early CLI for agents, scripts, and terminal workflows:

```bash
codemap build
codemap sync
codemap info
codemap search UserService
codemap search create-kubeconfig --kind symbol --json
```

The CLI reads and writes the same `.codemap/` index format used by the VS Code extension.

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

## Large Workspace Notes

For very large workspaces, CodeMap keeps symbol indexing complete and disables stored text lines by default:

- `codemap.maxTextLinesPerFile`: `200`
- `codemap.maxTotalTextLines`: `0`
- `codemap.indexTextLines`: `false`

If you want text search, enable it explicitly:

```json
"codemap.indexTextLines": true,
"codemap.maxTotalTextLines": 200000
```

The default keeps the index much smaller while preserving symbol and file search.

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

Package the CLI preview zip:

```bash
npm run package:cli
```

Run the CLI locally after compiling:

```bash
node out/cli.js build --cwd path/to/project
node out/cli.js search UserService --cwd path/to/project
node out/cli.js search UserService --cwd path/to/project --json
```

During extension development, open this folder in VS Code and press `F5` to launch an Extension Development Host.
