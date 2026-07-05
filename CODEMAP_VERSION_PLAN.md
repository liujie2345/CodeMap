# CodeMap Version Plan

## 1. Product Positioning

CodeMap is a VS Code extension focused on fast, structured code search for large projects and monorepos.

The first product goal is to provide a Search Everywhere experience similar to JetBrains IDEs, with better prioritization for code entities such as classes, functions, files, and symbols.

CodeMap should solve this core problem:

> In large projects, developers need to quickly jump to the right class, function, file, or symbol without scanning noisy full-text search results.

## 2. Core Principles

- Fast local search before AI-assisted search.
- Structured code navigation before broad code analysis.
- Local index first, optional semantic or AI features later.
- Prioritize developer intent over raw text matching.
- Class, function, type, and file matches should rank above generic text matches.
- Large project support must be part of the architecture from the beginning.

## 3. Target User Experience

The main interaction should be a single command:

```text
CodeMap: Search Everywhere
```

When the user types a query such as:

```text
UserService
```

CodeMap should return results in a useful order:

```text
Classes
  UserService              src/services/UserService.ts
  UserServiceImpl          src/services/UserServiceImpl.ts

Files
  UserService.ts           src/services/UserService.ts

References
  new UserService()        src/app/bootstrap.ts:42

Text
  "UserService failed"     src/logging/errors.ts:18
```

The expected behavior is not just faster full-text search. CodeMap should understand that a class definition is more important than an import statement, log message, or comment.

## 4. Version Roadmap

## v0.1 - Search Everywhere MVP

### Goal

Prove that CodeMap can provide a better search and navigation experience than VS Code's default sidebar search for common class, function, file, and text queries.

### Features

- Add VS Code command: `CodeMap: Search Everywhere`.
- Add VS Code command: `CodeMap: Build Index`.
- Provide a QuickPick-based search UI.
- Support searching:
  - Files
  - Classes
  - Functions
  - Interfaces
  - Types
  - Text
- Group search results by type:
  - Classes
  - Functions
  - Types
  - Files
  - Text
- Prioritize structured code results above generic text results.
- Support fuzzy search:
  - `usrsvc` should match `UserService`.
  - `authctl` should match `AuthController`.
- Open selected result directly at the target file and line.
- Store the local index under `.codemap/`.
- Ignore common heavy directories by default:
  - `node_modules`
  - `.git`
  - `dist`
  - `build`
  - `coverage`
  - `.next`
  - `.turbo`
  - `.cache`

### Initial Language Scope

- TypeScript
- JavaScript

### Technical Notes

- Use the VS Code extension API for commands, QuickPick UI, workspace file access, and navigation.
- Use a lightweight local index.
- Consider one of the following indexing approaches:
  - SQLite with FTS5
  - FlexSearch
  - MiniSearch
  - A custom in-memory index with persisted snapshots
- Use simple AST or symbol extraction for TS/JS first.
- Keep the first implementation intentionally small and measurable.

### Acceptance Criteria

- Searching for a class name returns class definitions before generic text matches.
- Searching for a file name is faster and cleaner than sidebar search.
- Search results can be opened directly from the QuickPick UI.
- Index build works on a medium TypeScript or JavaScript project.
- The extension remains responsive while indexing.

## v0.2 - Incremental Indexing and Multi-Language Base

### Goal

Make CodeMap usable in daily development without requiring frequent manual reindexing.

### Features

- Automatically update the index when files are created, changed, deleted, or renamed.
- Add status bar indicator:
  - `indexing`
  - `ready`
  - `stale`
  - `error`
- Add `.codemapignore` support.
- Add settings for include and exclude patterns.
- Add basic support for more languages:
  - Python
  - Java
  - Go
  - Rust
- Index additional symbol types:
  - Methods
  - Variables
  - Enums
  - Modules

### Ranking Improvements

- Boost exact matches.
- Boost class, function, and type definitions.
- Boost recently opened files.
- Boost files close to the currently active file.
- Downrank tests, generated files, snapshots, and dependency folders.

### Acceptance Criteria

- Modifying a file updates search results without a full rebuild.
- Renamed or deleted files no longer appear as stale results.
- Multi-language projects have basic structured search support.
- Default ranking feels useful for common navigation queries.

## v0.3 - Search Experience Polish

### Goal

Bring the interaction closer to JetBrains Search Everywhere while staying native to VS Code.

### Features

- Add search modes:
  - All
  - Classes
  - Files
  - Symbols
  - Text
- Add query prefixes:
  - `c UserService` for classes
  - `f user.service` for files
  - `t timeout error` for text
  - `# bootstrap` for symbols
- Support path-aware queries:
  - `service user`
  - `api auth controller`
  - `order status handler`
- Add recent searches.
- Add pinned or favorite results.
- Show preview context for text results.
- Support open behavior:
  - Open in current editor
  - Open beside
  - Open in new tab

### Acceptance Criteria

- Search Everywhere becomes useful enough to replace several built-in VS Code search and navigation commands.
- Users can narrow search scope without opening separate UI panels.
- Result ranking feels stable and predictable.

## v0.4 - Code Map and Relationship View

### Goal

Start turning CodeMap from a search extension into a project navigation map.

### Features

- Index file dependencies:
  - Imports
  - Exports
  - References
- Show related files for the current file:
  - Files imported by current file
  - Files importing current file
  - Related tests
  - Related type definitions
  - Related configuration files
- Add command: `CodeMap: Show Related Files`.
- Add command: `CodeMap: Show Module Map`.
- Provide a lightweight dependency graph view.

### Acceptance Criteria

- From an open file, users can quickly discover related implementation, type, and test files.
- Users can understand where a file sits inside the project without manually following imports.
- The map view remains useful and fast on medium projects.

## v0.5 - Large Project and Monorepo Optimization

### Goal

Make CodeMap reliable for very large repositories.

### Features

- Add index sharding.
- Move indexing into background workers.
- Add an indexing priority queue.
- Add large-file skip rules.
- Add monorepo package detection.
- Add multi-root workspace support.
- Add workspace-level and package-level index controls.
- Add index performance diagnostics.
- Add manual commands:
  - Rebuild full index
  - Rebuild current package index
  - Clear CodeMap cache

### Performance Goals

- First search should be available before the full index is complete.
- Search should remain responsive while background indexing continues.
- Common searches should return within tens to hundreds of milliseconds.
- The extension should not noticeably slow down VS Code startup.

### Acceptance Criteria

- CodeMap remains usable on monorepos.
- Users can control which directories and packages are indexed.
- Indexing failures are visible and recoverable.

## v1.0 - Stable Release

### Goal

Release a stable VS Code extension focused on fast structured search and navigation.

### Features

- Stable Search Everywhere.
- Stable local indexing.
- Incremental updates.
- Multi-language symbol support.
- Good default ignore rules.
- Configurable include and exclude rules.
- Index rebuild and cache clear commands.
- Marketplace-ready extension metadata.
- User documentation.
- Example screenshots or demo project.
- Basic automated tests.

### Non-Goals for v1.0

- AI code search as a required feature.
- Remote cloud indexing.
- Full static analysis engine.
- Full IDE replacement.

### Acceptance Criteria

- CodeMap can be used as a daily navigation tool in VS Code.
- It improves class, function, symbol, and file search for large projects.
- It is stable enough for public installation from the VS Code Marketplace.

## 5. Post-v1.0 Directions

After the core local indexing and structured search experience is stable, CodeMap can explore AI-assisted features.

Possible future features:

- Natural language code search:
  - "Where is user login handled?"
  - "Where does order status change?"
  - "Which module sends email?"
- Semantic search.
- Module summaries.
- Architecture overview generation.
- Similar code discovery.
- Code ownership hints.
- Onboarding map for new developers.

AI features should be built on top of the local CodeMap index, not replace it.

## 6. Suggested Implementation Order

1. Scaffold the VS Code extension.
2. Add `CodeMap: Search Everywhere` command.
3. Add QuickPick UI.
4. Add file name indexing.
5. Add TS/JS class and function extraction.
6. Add result ranking.
7. Add local index persistence under `.codemap/`.
8. Add manual rebuild command.
9. Add incremental file watching.
10. Expand language support.
11. Add relationship mapping.
12. Optimize for large monorepos.

## 7. Early Technical Architecture

### VS Code Extension Layer

Responsible for:

- Commands
- Keybindings
- QuickPick UI
- Status bar
- Settings
- Navigation to files and locations

### Indexing Layer

Responsible for:

- Workspace scanning
- File filtering
- Symbol extraction
- Text indexing
- Incremental updates
- Persisting index data

### Search Layer

Responsible for:

- Query parsing
- Fuzzy matching
- Exact matching
- Type filtering
- Ranking
- Result grouping

### Storage Layer

Responsible for:

- Local cache under `.codemap/`
- Index metadata
- File hash or mtime tracking
- Searchable symbol and text data

## 8. Key Risks

### Indexing Performance

Large projects can contain hundreds of thousands of files. CodeMap must avoid scanning dependency folders, generated files, and oversized files by default.

### Symbol Accuracy

Different languages require different parsing strategies. The MVP should focus on TypeScript and JavaScript first to avoid spreading the implementation too thin.

### Ranking Quality

Fast search is not enough. If results are noisy, the tool will still feel bad. Ranking should be treated as a core product feature.

### Extension Responsiveness

Indexing must not block the VS Code extension host. Heavy work should move to background workers as early as needed.

### Cache Staleness

The index must stay in sync with file changes. Stale search results would quickly damage trust in the tool.

## 9. MVP Definition

The first meaningful MVP is:

> A VS Code extension that lets users press one shortcut, type a class, function, or file name, and jump to the right result faster and more cleanly than VS Code sidebar search.

MVP includes:

- TS/JS support.
- File search.
- Class search.
- Function search.
- Basic text search.
- Grouped QuickPick results.
- Local index.
- Manual rebuild.

MVP does not include:

- AI search.
- Full dependency graph.
- All programming languages.
- Marketplace polish.
- Cloud sync.

