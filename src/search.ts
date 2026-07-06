import * as path from 'path';
import { CodeMapFile, CodeMapIndex, CodeMapResultKind, SearchResult } from './types';

const KIND_WEIGHT: Record<CodeMapResultKind, number> = {
  class: 600,
  interface: 560,
  type: 540,
  function: 500,
  file: 420,
  text: 120
};

export type SearchScope = 'all' | 'symbols' | 'classes' | 'functions' | 'files' | 'text';

export interface SearchIndexOptions {
  scope?: SearchScope;
  maxTextMatches?: number;
  limit?: number;
}

export function searchIndex(index: CodeMapIndex, rawQuery: string, maxTextMatchesOrOptions: number | SearchIndexOptions = {}): SearchResult[] {
  const query = normalizeQuery(rawQuery);
  if (!query) {
    return [];
  }

  const options = typeof maxTextMatchesOrOptions === 'number'
    ? { maxTextMatches: maxTextMatchesOrOptions }
    : maxTextMatchesOrOptions;
  const scope = options.scope ?? 'all';
  const maxTextMatches = options.maxTextMatches ?? 80;
  const limit = options.limit ?? 150;
  const includeFiles = scope === 'all' || scope === 'files';
  const includeSymbols = scope === 'all' || scope === 'symbols' || scope === 'classes' || scope === 'functions';
  const includeText = scope === 'all' || scope === 'text';

  const results: SearchResult[] = [];
  let textMatches = 0;

  for (const file of index.files) {
    const fileResult = includeFiles ? matchFile(file, query) : undefined;
    if (fileResult) {
      results.push(fileResult);
    }

    if (includeSymbols) {
      for (const symbol of file.symbols) {
        if (!symbolInScope(symbol.kind, scope)) {
          continue;
        }

        const symbolScore = scoreCandidate(symbol.name, query);
        if (symbolScore <= 0) {
          continue;
        }

        results.push({
          kind: symbol.kind,
          label: symbol.name,
          description: symbol.location.relativePath,
          detail: symbol.signature,
          score: KIND_WEIGHT[symbol.kind] + symbolScore,
          location: symbol.location,
          preview: symbol.signature
        });
      }
    }

    if (includeText && textMatches < maxTextMatches) {
      for (const line of file.textLines) {
        const lineScore = scoreCandidate(line.text, query);
        if (lineScore <= 0) {
          continue;
        }

        results.push({
          kind: 'text',
          label: trimPreview(line.text),
          description: `${file.relativePath}:${line.line + 1}`,
          detail: file.relativePath,
          score: KIND_WEIGHT.text + Math.min(lineScore, 120),
          location: {
            workspaceFolder: file.workspaceFolder,
            relativePath: file.relativePath,
            line: line.line,
            character: Math.max(0, line.text.toLowerCase().indexOf(query.compact))
          },
          preview: line.text
        });
        textMatches += 1;

        if (textMatches >= maxTextMatches) {
          break;
        }
      }
    }
  }

  return dedupeResults(results)
    .sort((left, right) => right.score - left.score || left.label.localeCompare(right.label))
    .slice(0, limit);
}

function symbolInScope(kind: CodeMapResultKind, scope: SearchScope): boolean {
  if (scope === 'classes') {
    return kind === 'class' || kind === 'interface' || kind === 'type';
  }

  if (scope === 'functions') {
    return kind === 'function';
  }

  return kind === 'class' || kind === 'interface' || kind === 'type' || kind === 'function';
}

function matchFile(file: CodeMapFile, query: NormalizedQuery): SearchResult | undefined {
  const baseName = path.basename(file.relativePath);
  const baseScore = scoreCandidate(baseName, query);
  const pathScore = scoreCandidate(file.relativePath, query);
  const score = Math.max(baseScore + 25, pathScore);

  if (score <= 0) {
    return undefined;
  }

  return {
    kind: 'file',
    label: baseName,
    description: file.relativePath,
    score: KIND_WEIGHT.file + score,
    location: {
      workspaceFolder: file.workspaceFolder,
      relativePath: file.relativePath,
      line: 0,
      character: 0
    }
  };
}

interface NormalizedQuery {
  raw: string;
  rawLower: string;
  separated: string;
  compact: string;
  tokens: string[];
}

function normalizeQuery(rawQuery: string): NormalizedQuery | undefined {
  const raw = rawQuery.trim();
  if (!raw) {
    return undefined;
  }

  const rawLower = raw.toLowerCase();
  const separated = normalizeSeparators(rawLower);
  const compact = rawLower.replace(/[\s._/-]+/g, '');
  const tokens = raw
    .toLowerCase()
    .split(/[\s._/-]+/)
    .map((token) => token.trim())
    .filter(Boolean);

  return { raw, rawLower, separated, compact, tokens };
}

function scoreCandidate(candidate: string, query: NormalizedQuery): number {
  const normalized = candidate.toLowerCase();
  const separated = normalizeSeparators(normalized);
  const compact = normalized.replace(/[\s._/-]+/g, '');
  const baseName = path.basename(normalized);
  const baseNameWithoutExtension = stripExtension(baseName);
  const separatedBaseName = normalizeSeparators(baseName);
  const separatedBaseNameWithoutExtension = stripExtension(separatedBaseName);

  if (normalized === query.rawLower || baseName === query.rawLower || baseNameWithoutExtension === query.rawLower) {
    return 720;
  }

  if (
    separated === query.separated
    || separatedBaseName === query.separated
    || separatedBaseNameWithoutExtension === query.separated
  ) {
    return 680;
  }

  if (compact === query.compact) {
    return 560 - lengthPenalty(compact, query.compact, 120);
  }

  if (separated.startsWith(query.separated) || separatedBaseName.startsWith(query.separated)) {
    return 470 - lengthPenalty(separated, query.separated, 120);
  }

  if (compact.startsWith(query.compact)) {
    return 390 - lengthPenalty(compact, query.compact, 120);
  }

  if (separated.includes(query.separated) || separatedBaseName.includes(query.separated)) {
    return 330 - Math.min(firstPositiveIndex([separated.indexOf(query.separated), separatedBaseName.indexOf(query.separated)]), 80);
  }

  if (compact.includes(query.compact)) {
    return 240 - Math.min(compact.indexOf(query.compact), 80);
  }

  if (query.tokens.length > 1 && query.tokens.every((token) => normalized.includes(token))) {
    return 210;
  }

  const fuzzy = fuzzyScore(compact, query.compact);
  if (fuzzy > 0) {
    return fuzzy;
  }

  return 0;
}

function normalizeSeparators(value: string): string {
  return value.toLowerCase().replace(/[\s._/-]+/g, '-').replace(/^-+|-+$/g, '');
}

function stripExtension(value: string): string {
  const parsed = path.parse(value);
  return parsed.name;
}

function lengthPenalty(candidate: string, query: string, maxPenalty: number): number {
  return Math.min(Math.max(candidate.length - query.length, 0), maxPenalty);
}

function firstPositiveIndex(indexes: number[]): number {
  const positive = indexes.filter((index) => index >= 0);
  return positive.length > 0 ? Math.min(...positive) : 0;
}

function fuzzyScore(candidate: string, query: string): number {
  let candidateIndex = 0;
  let score = 0;
  let streak = 0;

  for (const char of query) {
    const foundIndex = candidate.indexOf(char, candidateIndex);
    if (foundIndex === -1) {
      return 0;
    }

    if (foundIndex === candidateIndex) {
      streak += 1;
      score += 18 + streak * 3;
    } else {
      streak = 0;
      score += 8;
    }

    candidateIndex = foundIndex + 1;
  }

  return Math.max(35, score - Math.min(candidate.length - query.length, 60));
}

function trimPreview(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 96) {
    return trimmed;
  }

  return `${trimmed.slice(0, 93)}...`;
}

function dedupeResults(results: SearchResult[]): SearchResult[] {
  const best = new Map<string, SearchResult>();

  for (const result of results) {
    const key = [
      result.kind,
      result.location.workspaceFolder,
      result.location.relativePath,
      result.location.line,
      result.label
    ].join(':');

    const existing = best.get(key);
    if (!existing || result.score > existing.score) {
      best.set(key, result);
    }
  }

  return [...best.values()];
}
