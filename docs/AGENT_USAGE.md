# Agent Usage

CodeMap Everywhere can be used as a code discovery tool for AI coding agents.

The goal is to avoid expensive, noisy full-repository searches when the agent needs to find relevant code.

## Basic Strategy

When investigating a codebase, an agent should:

1. Check whether a CodeMap index exists.
2. Build or sync the index if needed.
3. Search symbols first.
4. Search files second.
5. Search text only when symbol/file search is not enough.
6. Read the top matching files and lines before expanding the search.

## Commands

During development, run the CLI through Node:

```bash
node out/cli.js info --cwd <workspace>
node out/cli.js build --cwd <workspace>
node out/cli.js sync --cwd <workspace>
node out/cli.js search "UserService" --cwd <workspace> --kind symbol --json
```

After a standalone CLI package exists, the intended command shape is:

```bash
codemap info
codemap build
codemap sync
codemap search "UserService" --kind symbol --json
```

## Recommended Agent Flow

### 1. Ensure Index

Try:

```bash
codemap info --json
```

If no index exists, run:

```bash
codemap build
```

If an index exists but the repository may have changed, run:

```bash
codemap sync
```

### 2. Search Symbols

For class, function, type, API, module, or method questions:

```bash
codemap search "<query>" --kind symbol --limit 20 --json
```

Prefer symbol results before text matches.

### 3. Search Files

For file-oriented questions:

```bash
codemap search "<query>" --kind file --limit 20 --json
```

### 4. Search Text

For error messages, constants, strings, logs, or configuration keys:

```bash
codemap search "<query>" --kind text --limit 20 --json
```

### 5. Read Targeted Files

After CodeMap returns paths and line numbers, read the most relevant files directly.

Avoid reading the whole repository unless the CodeMap results are insufficient.

## JSON Result Shape

Example:

```json
[
  {
    "kind": "function",
    "label": "create-kubeconfig",
    "description": "cmd/kubeadm/app/util/kubeconfig/kubeconfig.go",
    "score": 1220,
    "location": {
      "workspaceFolder": "/repo",
      "relativePath": "cmd/kubeadm/app/util/kubeconfig/kubeconfig.go",
      "line": 42,
      "character": 0
    },
    "preview": "func create-kubeconfig(...)"
  }
]
```

Agents should use:

- `kind` to prefer symbols over text.
- `score` to rank confidence.
- `location.relativePath` and `location.line` to read targeted code.
- `preview` for quick triage before opening files.

## Notes

- The index is local to the workspace.
- `.codemapignore` should exclude large resource folders.
- The current parser is regex-based and optimized for fast navigation, not complete static analysis.
- Very large repositories may need future SQLite or sharded index storage.
