# AI Enhanced Edition

CodeMap Everywhere AI Enhanced Edition is the CLI plus Agent Skill workflow.

It lets an AI coding agent use CodeMap as a fast local code discovery layer before reading files directly.

## What Is Included

The AI Enhanced Edition is made of:

```text
codemap-everywhere-cli-<version>.zip
skills/codemap-everywhere/SKILL.md
docs/AGENT_USAGE.md
```

The CLI provides the executable capability:

```bash
codemap build
codemap sync
codemap search "UserService" --kind symbol --json
```

The skill teaches an agent when and how to use that capability.

## Why This Helps Agents

Large repositories are hard for agents because plain text search often returns too much noise.

CodeMap gives agents a better first step:

- Search symbols before text.
- Prefer definitions over incidental mentions.
- Return structured JSON with path and line numbers.
- Reuse a local `.codemap/` index across runs.
- Avoid reading unrelated files until the search space is narrowed.

## Install CLI Preview

Download:

```text
codemap-everywhere-cli-<version>.zip
```

Unzip it somewhere stable, for example:

```text
C:\tools\codemap-everywhere-cli
```

During the preview phase, run it with Node:

```powershell
node C:\tools\codemap-everywhere-cli\out\cli.js info --cwd C:\path\to\project
```

For agent prompts, use the full path if `codemap` is not on `PATH`.

## Agent Prompt

Use this prompt with Codex, Claude Code, OpenCode, or another coding agent:

```text
Use CodeMap Everywhere before broad repository searches.

If the codemap CLI is available, run:

codemap info --json

If there is no index, run:

codemap build

If the repository may have changed, run:

codemap sync

For code structure questions, search symbols first:

codemap search "<query>" --kind symbol --limit 20 --json

For file lookup, use:

codemap search "<query>" --kind file --limit 20 --json

For exact strings, errors, constants, or log messages, use:

codemap search "<query>" --kind text --limit 20 --json

Read only the top returned files and line numbers before expanding the search.
Avoid broad grep-style repository searches unless CodeMap results are insufficient.
```

If the CLI is not installed globally, replace `codemap` with:

```text
node C:\tools\codemap-everywhere-cli\out\cli.js
```

## Codex

CodeMap ships a Codex-compatible skill draft at:

```text
skills/codemap-everywhere/SKILL.md
```

For local testing, install or copy this folder into your Codex skills location, then ask Codex to use the `codemap-everywhere` skill.

Suggested prompt:

```text
Use the codemap-everywhere skill for code discovery in this repository. Build or sync the index if needed, then search symbols before reading files.
```

## Claude Code

Claude Code also supports skill-style folders with a `SKILL.md` file. Use the same folder:

```text
skills/codemap-everywhere/SKILL.md
```

If your Claude Code setup uses a different custom skills directory, copy the folder there.

Suggested prompt:

```text
Use the CodeMap Everywhere skill in this repository. If the CLI is available, use it to build or sync the index and search symbols before reading files.
```

## OpenCode

OpenCode supports Agent Skills through `SKILL.md` definitions. Keep or copy:

```text
skills/codemap-everywhere/SKILL.md
```

Suggested prompt:

```text
Load the CodeMap Everywhere skill and use it for repository search. Prefer codemap symbol search before broad text search.
```

## Current Limitations

- The CLI preview currently runs through Node.
- The skill is a draft, not a packaged marketplace install.
- Different agents may use different skill install directories.
- The current index backend is JSONL, not SQLite.
- Symbol extraction is regex-based and optimized for fast navigation.

## Planned Packaging

Future releases may provide:

```text
codemap-everywhere-agent-<version>.zip
```

That package can bundle:

```text
cli/
skills/
docs/
install scripts
```

For now, use the CLI zip plus `skills/codemap-everywhere/SKILL.md`.
