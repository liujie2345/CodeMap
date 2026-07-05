# CodeMap Everywhere Editions

CodeMap Everywhere is distributed as one project with three usage paths.

## 1. VS Code Extension

Use this edition if you want an interactive Search Everywhere experience inside VS Code.

Best for:

- Developers using VS Code directly.
- Large projects and monorepos.
- Quickly jumping to classes, functions, files, and text matches.

Typical workflow:

```text
Install the VSIX or Marketplace extension
Open a workspace
Run CodeMap: Build Index
Run CodeMap: Open Search Panel
```

Release artifact:

```text
codemap-everywhere-<version>.vsix
```

## 2. CLI

Use this edition if you want CodeMap from a terminal, script, CI job, or AI agent.

Best for:

- AI coding agents.
- Terminal workflows.
- Remote development environments.
- Projects where VS Code is not available.

Typical workflow:

```bash
codemap build
codemap sync
codemap info
codemap search UserService --json
codemap search create-kubeconfig --kind symbol --json
```

The CLI reads and writes the same `.codemap/` index used by the VS Code extension.

Current status:

- The CLI preview is included in this repository.
- During development, run it with `node out/cli.js`.
- A standalone npm package or archive can be added later.

## 3. Agent Skill

Use this edition if you want an AI agent to know when and how to use CodeMap.

Best for:

- Codex-style coding agents.
- Agent workflows that need fast code discovery.
- Large repositories where plain grep creates too much noise.

The skill teaches an agent to:

- Check whether a CodeMap index exists.
- Build or sync the index when needed.
- Search symbols before text.
- Read only the most relevant files after CodeMap narrows the search space.

Initial skill location:

```text
skills/codemap-everywhere/SKILL.md
```

## Shared Index

All editions use the same local index format:

```text
.codemap/meta.json
.codemap/files.jsonl
```

This means:

- The VS Code extension can build an index and the CLI can read it.
- The CLI can build an index and the VS Code extension can read it.
- An AI agent can use the CLI without requiring the VS Code extension.

## Repository Layout

Current layout:

```text
src/
  extension.ts       VS Code extension entry
  cli.ts             CLI entry
  cli-indexer.ts     CLI filesystem indexer
  indexer.ts         VS Code indexer
  search.ts          Shared search/ranking logic
  types.ts           Shared data types

docs/
  EDITIONS.md
  AGENT_USAGE.md

skills/
  codemap-everywhere/
    SKILL.md
```

Future layout may split this into packages:

```text
packages/core
packages/vscode
packages/cli
skills/codemap-everywhere
```

That split is useful later, but the current single-repository layout keeps early iteration simple.
