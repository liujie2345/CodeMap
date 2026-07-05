---
name: codemap-everywhere
description: Use CodeMap Everywhere CLI to quickly find relevant classes, functions, files, and text in large codebases before reading files directly.
---

# CodeMap Everywhere

Use this skill when working in a repository that has, or can build, a CodeMap Everywhere index.

CodeMap is useful when:

- The repository is large.
- The user asks where code lives.
- You need to find classes, functions, modules, routes, handlers, services, or config keys.
- A plain recursive text search would return too many noisy results.

## Tooling

Preferred command shape:

```bash
codemap search "<query>" --kind symbol --json
```

During local development, if the `codemap` command is not installed, use:

```bash
node out/cli.js search "<query>" --kind symbol --json
```

Run commands from the repository root unless the user provides another workspace path.

If the CLI was downloaded as a release zip and is not on `PATH`, use the full Node command path, for example:

```bash
node C:/tools/codemap-everywhere-cli/out/cli.js search "<query>" --kind symbol --json
```

## Workflow

1. Check for an index:

```bash
codemap info --json
```

If `codemap` is not installed but this repository contains CodeMap source, use:

```bash
node out/cli.js info --json
```

2. If no index exists, build it:

```bash
codemap build
```

3. If the repository may have changed, sync it:

```bash
codemap sync
```

4. Search symbols first:

```bash
codemap search "<query>" --kind symbol --limit 20 --json
```

5. Search files when the user appears to be looking for a file:

```bash
codemap search "<query>" --kind file --limit 20 --json
```

6. Search text for exact strings, errors, constants, or log messages:

```bash
codemap search "<query>" --kind text --limit 20 --json
```

7. Read the top returned files and line numbers directly.

Do not read broad swaths of the repository until CodeMap has narrowed the likely locations.

## Result Handling

Prioritize results by:

1. Exact symbol matches.
2. File matches.
3. High-scoring fuzzy symbol matches.
4. Text matches.

Use `location.relativePath` and `location.line` to open targeted code.

## Fallback

If CodeMap is unavailable or the index cannot be built, fall back to normal repository search tools such as `rg`.

## Installation Note

This skill is designed as a portable Agent Skill draft. Different agent runtimes use different skill installation locations.

Keep the folder structure intact:

```text
codemap-everywhere/
  SKILL.md
```

The CLI and the skill are separate pieces:

- CLI provides the search capability.
- Skill teaches the agent when and how to use it.
