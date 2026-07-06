#!/usr/bin/env node
import { buildCliIndex, loadCliIndex, summarizeIndex, syncCliIndex } from './cli-indexer';
import { searchIndex } from './search';
import { SearchResult } from './types';

interface CliArgs {
  command?: string;
  query?: string;
  cwd: string;
  json: boolean;
  limit: number;
  kind?: string;
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  switch (args.command) {
    case 'build': {
      const started = Date.now();
      const index = await buildCliIndex({ root: args.cwd });
      const summary = summarizeIndex(args.cwd, index);
      output(args, {
        ...summary,
        durationMs: Date.now() - started
      }, formatSummary(summary, Date.now() - started));
      return;
    }
    case 'sync': {
      const started = Date.now();
      const result = await syncCliIndex({ root: args.cwd });
      const summary = summarizeIndex(args.cwd, result.index);
      output(args, {
        scannedFiles: result.scannedFiles,
        addedFiles: result.addedFiles,
        updatedFiles: result.updatedFiles,
        removedFiles: result.removedFiles,
        summary,
        durationMs: Date.now() - started
      }, `Synced ${result.scannedFiles} files (+${result.addedFiles}, ~${result.updatedFiles}, -${result.removedFiles}) in ${Date.now() - started}ms.`);
      return;
    }
    case 'info': {
      const index = await loadCliIndex(args.cwd);
      if (!index) {
        throw new Error('No CodeMap index found. Run `codemap build` first.');
      }
      const summary = summarizeIndex(args.cwd, index);
      output(args, summary, formatSummary(summary));
      return;
    }
    case 'search': {
      if (!args.query) {
        throw new Error('Usage: codemap search <query> [--json] [--kind symbol|file|text] [--limit 20]');
      }
      const index = await loadCliIndex(args.cwd);
      if (!index) {
        throw new Error('No CodeMap index found. Run `codemap build` first.');
      }
      const results = filterKind(searchIndex(index, args.query, 80), args.kind).slice(0, args.limit);
      output(args, results, formatResults(results));
      return;
    }
    default:
      printHelp();
  }
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    command: argv[0],
    cwd: process.cwd(),
    json: false,
    limit: 20
  };

  const rest = argv.slice(1);
  const queryParts: string[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (value === '--json') {
      args.json = true;
    } else if (value === '--cwd') {
      args.cwd = rest[++index] ?? args.cwd;
    } else if (value === '--limit') {
      args.limit = Number(rest[++index] ?? args.limit);
    } else if (value === '--kind') {
      args.kind = rest[++index];
    } else {
      queryParts.push(value);
    }
  }

  args.query = queryParts.join(' ').trim();
  return args;
}

function filterKind(results: SearchResult[], kind?: string): SearchResult[] {
  if (!kind) {
    return results;
  }

  if (kind === 'symbol' || kind === 'symbols') {
    return results.filter((result) => ['class', 'interface', 'type', 'function'].includes(result.kind));
  }

  return results.filter((result) => result.kind === kind);
}

function output(args: CliArgs, value: unknown, text: string): void {
  if (args.json) {
    console.log(JSON.stringify(value, null, 2));
  } else {
    console.log(text);
  }
}

function formatSummary(summary: ReturnType<typeof summarizeIndex>, durationMs?: number): string {
  const languages = Object.entries(summary.languageCounts)
    .sort((left, right) => right[1] - left[1])
    .map(([language, count]) => `  ${language}: ${count}`)
    .join('\n');

  return [
    `Files: ${summary.fileCount}`,
    `Symbols: ${summary.symbolCount}`,
    `Created: ${summary.createdAt}`,
    `Storage: ${summary.storagePath ?? 'unknown'}`,
    durationMs === undefined ? undefined : `Duration: ${durationMs}ms`,
    'Languages:',
    languages || '  none'
  ].filter(Boolean).join('\n');
}

function formatResults(results: SearchResult[]): string {
  if (results.length === 0) {
    return 'No results.';
  }

  return results.map((result) => {
    const line = result.location.line + 1;
    return `${result.kind.padEnd(9)} ${result.label}  ${result.location.relativePath}:${line}`;
  }).join('\n');
}

function printHelp(): void {
  console.log(`CodeMap Everywhere CLI

Usage:
  codemap build [--cwd path] [--json]
  codemap sync [--cwd path] [--json]
  codemap info [--cwd path] [--json]
  codemap search <query> [--cwd path] [--kind symbol|file|text] [--limit 20] [--json]
`);
}
