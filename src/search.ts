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

const DEFAULT_RESULT_LIMIT = 150;
const MIN_CANDIDATE_LIMIT = 800;
const CANDIDATE_LIMIT_MULTIPLIER = 8;
const searchCacheByIndex = new WeakMap<CodeMapIndex, SearchCache>();

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

  const cache = getSearchCache(index);
  if (!cache) {
    return [];
  }

  const options = typeof maxTextMatchesOrOptions === 'number'
    ? { maxTextMatches: maxTextMatchesOrOptions }
    : maxTextMatchesOrOptions;
  const scope = options.scope ?? 'all';
  const maxTextMatches = options.maxTextMatches ?? 80;
  const limit = options.limit ?? DEFAULT_RESULT_LIMIT;
  const candidateLimit = Math.max(MIN_CANDIDATE_LIMIT, limit * CANDIDATE_LIMIT_MULTIPLIER);
  const includeFiles = scope === 'all' || scope === 'files';
  const includeSymbols = scope === 'all' || scope === 'symbols' || scope === 'classes' || scope === 'functions';
  const includeText = scope === 'all' || scope === 'text';

  const results = new BoundedSearchResults(candidateLimit);
  let textMatches = 0;

  if (includeFiles) {
    for (const file of cache.files) {
      const fileResult = matchPreparedFile(file, query);
      if (fileResult) {
        results.add(fileResult);
      }
    }
  }

  if (includeSymbols) {
    const symbols = getSymbolsForScope(cache, scope);
    for (const symbol of symbols) {
      const symbolScore = scorePreparedCandidate(symbol.search, query);
      if (symbolScore <= 0) {
        continue;
      }

      results.add({
        kind: symbol.kind,
        label: symbol.label,
        description: symbol.description,
        detail: symbol.detail,
        score: KIND_WEIGHT[symbol.kind] + symbolScore,
        location: symbol.location,
        preview: symbol.preview
      });
    }
  }

  if (includeText && textMatches < maxTextMatches) {
    for (const line of cache.text) {
      const lineScore = scorePreparedCandidate(line.search, query);
      if (lineScore <= 0) {
        continue;
      }

      results.add({
        kind: 'text',
        label: line.label,
        description: line.description,
        detail: line.detail,
        score: KIND_WEIGHT.text + Math.min(lineScore, 120),
        location: {
          ...line.location,
          character: Math.max(0, line.search.normalized.indexOf(query.compact))
        },
        preview: line.preview
      });
      textMatches += 1;

      if (textMatches >= maxTextMatches) {
        break;
      }
    }
  }

  return results.toSorted(limit);
}

// Prefix-extension cache: When typing "User" -> "UserS" -> "UserSe" -> "UserService"
// any result matching the longer query also matched the previous shorter prefix
// (assuming lenient includes() matching). This avoids re-running scorePreparedCandidate
// across millions of symbols on every keystroke.
let symbolSearchState: {
  scope: SearchScope | undefined;
  query: string;
  results: SearchResult[];
} = {
  scope: undefined,
  query: '',
  results: []
};

export function invalidateSymbolSearchState(): void {
  symbolSearchState = { scope: undefined, query: '', results: [] };
}

export function prewarmSearchCache(index: CodeMapIndex): void {
  // Synchronous fallback: build cache on main thread.
  // Used when no worker is available, or by tests/CLI that need the cache immediately.
  const cached = searchCacheByIndex.get(index);
  if (cached && cached.createdAt === index.createdAt && cached.fileCount === index.files.length) {
    return;
  }
  const built = buildSearchCache(index);
  searchCacheByIndex.set(index, built);
}

export interface PrewarmWorkerResult {
  files: PreparedFileCandidate[];
  symbols: PreparedSymbolCandidate[];
  classSymbols: PreparedSymbolCandidate[];
  functionSymbols: PreparedSymbolCandidate[];
  text: PreparedTextCandidate[];
}

export function setSearchCacheFromWorkerResult(index: CodeMapIndex, result: PrewarmWorkerResult): void {
  const built: SearchCache = {
    createdAt: index.createdAt,
    fileCount: index.files.length,
    files: result.files,
    symbols: result.symbols,
    classSymbols: result.classSymbols,
    functionSymbols: result.functionSymbols,
    text: result.text
  };
  searchCacheByIndex.set(index, built);
}

export function isSearchCacheReady(index: CodeMapIndex): boolean {
  const cached = searchCacheByIndex.get(index);
  return !!cached && cached.createdAt === index.createdAt && cached.fileCount === index.files.length;
}

export function searchWithCachedSymbols(
  index: CodeMapIndex,
  query: string,
  scope: SearchScope,
  maxTextMatches: number,
  limit: number,
  textFetcher: (query: string, limit: number) => Promise<SearchResult[]>
): Promise<SearchResult[]> {
  if (!query.trim()) {
    return Promise.resolve([]);
  }

  if (scope === 'text') {
    return textFetcher(query, Math.min(maxTextMatches, limit));
  }

  const queryLower = query.toLowerCase();
  const cacheScope = symbolSearchState.scope;
  const cacheQuery = symbolSearchState.query;
  const cacheHit = cacheScope === scope
    && cacheQuery !== ''
    && queryLower.startsWith(cacheQuery.toLowerCase())
    && queryLower.length > cacheQuery.length
    && symbolSearchState.results.length > 0;

  let symbolResults: SearchResult[];
  if (cacheHit) {
    symbolResults = symbolSearchState.results.filter((result) => result.label.toLowerCase().includes(queryLower));
    // Keep refining forward: cache the new query so further keystrokes stay cache-hot.
    symbolSearchState.query = query;
    symbolSearchState.results = symbolResults;
  } else {
    symbolResults = searchIndex(index, query, { scope, maxTextMatches: 0, limit });
    symbolSearchState.scope = scope;
    symbolSearchState.query = query;
    symbolSearchState.results = symbolResults;
  }

  if (scope !== 'all' || maxTextMatches <= 0) {
    return Promise.resolve(symbolResults);
  }

  return textFetcher(query, maxTextMatches).then((textResults) => {
    return [...symbolResults, ...textResults].sort(compareResults).slice(0, limit);
  });
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

function matchPreparedFile(file: PreparedFileCandidate, query: NormalizedQuery): SearchResult | undefined {
  const baseScore = scorePreparedCandidate(file.baseSearch, query);
  const pathScore = scorePreparedCandidate(file.pathSearch, query);
  const score = Math.max(baseScore + 25, pathScore);

  if (score <= 0) {
    return undefined;
  }

  return {
    kind: 'file',
    label: file.label,
    description: file.description,
    score: KIND_WEIGHT.file + score,
    location: file.location
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
  return scorePreparedCandidate(prepareSearchText(candidate, normalized), query);
}

function scorePreparedCandidate(candidate: PreparedSearchText, query: NormalizedQuery): number {
  if (
    candidate.normalized === query.rawLower
    || candidate.baseName === query.rawLower
    || candidate.baseNameWithoutExtension === query.rawLower
  ) {
    return 720;
  }

  if (
    candidate.separated === query.separated
    || candidate.separatedBaseName === query.separated
    || candidate.separatedBaseNameWithoutExtension === query.separated
  ) {
    return 680;
  }

  if (candidate.compact === query.compact) {
    return 560 - lengthPenalty(candidate.compact, query.compact, 120);
  }

  if (candidate.separated.startsWith(query.separated) || candidate.separatedBaseName.startsWith(query.separated)) {
    return 470 - lengthPenalty(candidate.separated, query.separated, 120);
  }

  if (candidate.compact.startsWith(query.compact)) {
    return 390 - lengthPenalty(candidate.compact, query.compact, 120);
  }

  if (candidate.separated.includes(query.separated) || candidate.separatedBaseName.includes(query.separated)) {
    return 330 - Math.min(firstPositiveIndex([
      candidate.separated.indexOf(query.separated),
      candidate.separatedBaseName.indexOf(query.separated)
    ]), 80);
  }

  if (candidate.compact.includes(query.compact)) {
    return 240 - Math.min(candidate.compact.indexOf(query.compact), 80);
  }

  if (query.tokens.length > 1 && query.tokens.every((token) => candidate.normalized.includes(token))) {
    return 210;
  }

  const fuzzy = fuzzyScore(candidate.compact, query.compact);
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

class BoundedSearchResults {
  private readonly best = new Map<string, SearchResult>();

  public constructor(private readonly candidateLimit: number) {}

  public add(result: SearchResult): void {
    const key = resultKey(result);

    const existing = this.best.get(key);
    if (!existing || result.score > existing.score) {
      this.best.set(key, result);
    }

    if (this.best.size > this.candidateLimit * 2) {
      this.prune();
    }
  }

  public toSorted(limit: number): SearchResult[] {
    return Array.from(this.best.values())
      .sort(compareResults)
      .slice(0, limit);
  }

  private prune(): void {
    const kept = this.toSorted(this.candidateLimit);
    this.best.clear();
    for (const result of kept) {
      this.best.set(resultKey(result), result);
    }
  }
}

function compareResults(left: SearchResult, right: SearchResult): number {
  return right.score - left.score || left.label.localeCompare(right.label);
}

function resultKey(result: SearchResult): string {
  return [
    result.kind,
    result.location.workspaceFolder,
    result.location.relativePath,
    result.location.line,
    result.label
  ].join(':');
}

interface PreparedSearchText {
  normalized: string;
  separated: string;
  compact: string;
  baseName: string;
  baseNameWithoutExtension: string;
  separatedBaseName: string;
  separatedBaseNameWithoutExtension: string;
}

interface PreparedFileCandidate {
  label: string;
  description: string;
  location: SearchResult['location'];
  baseSearch: PreparedSearchText;
  pathSearch: PreparedSearchText;
}

interface PreparedSymbolCandidate {
  kind: Exclude<CodeMapResultKind, 'file' | 'text'>;
  label: string;
  description: string;
  detail?: string;
  preview?: string;
  location: SearchResult['location'];
  search: PreparedSearchText;
}

interface PreparedTextCandidate {
  label: string;
  description: string;
  detail: string;
  preview: string;
  location: SearchResult['location'];
  search: PreparedSearchText;
}

interface SearchCache {
  createdAt: string;
  fileCount: number;
  files: PreparedFileCandidate[];
  symbols: PreparedSymbolCandidate[];
  classSymbols: PreparedSymbolCandidate[];
  functionSymbols: PreparedSymbolCandidate[];
  text: PreparedTextCandidate[];
}

function getSearchCache(index: CodeMapIndex): SearchCache | undefined {
  const cached = searchCacheByIndex.get(index);
  if (cached && cached.createdAt === index.createdAt && cached.fileCount === index.files.length) {
    return cached;
  }
  // Cache not ready (prewarm still running in worker). Return undefined so callers
  // can show "index loading" instead of blocking the main thread with a sync build.
  return undefined;
}

function buildSearchCache(index: CodeMapIndex): SearchCache {
  const files: PreparedFileCandidate[] = [];
  const symbols: PreparedSymbolCandidate[] = [];
  const classSymbols: PreparedSymbolCandidate[] = [];
  const functionSymbols: PreparedSymbolCandidate[] = [];
  const text: PreparedTextCandidate[] = [];

  for (const file of index.files) {
    const baseName = path.basename(file.relativePath);
    files.push({
      label: baseName,
      description: file.relativePath,
      location: {
        workspaceFolder: file.workspaceFolder,
        relativePath: file.relativePath,
        line: 0,
        character: 0
      },
      baseSearch: prepareSearchText(baseName),
      pathSearch: prepareSearchText(file.relativePath)
    });

    for (const symbol of file.symbols) {
      const candidate: PreparedSymbolCandidate = {
        kind: symbol.kind,
        label: symbol.name,
        description: symbol.location.relativePath,
        detail: symbol.signature,
        preview: symbol.signature,
        location: symbol.location,
        search: prepareSearchText(symbol.name)
      };
      symbols.push(candidate);
      if (symbol.kind === 'class' || symbol.kind === 'interface' || symbol.kind === 'type') {
        classSymbols.push(candidate);
      }
      if (symbol.kind === 'function') {
        functionSymbols.push(candidate);
      }
    }

    for (const line of file.textLines) {
      text.push({
        label: trimPreview(line.text),
        description: `${file.relativePath}:${line.line + 1}`,
        detail: file.relativePath,
        preview: line.text,
        location: {
          workspaceFolder: file.workspaceFolder,
          relativePath: file.relativePath,
          line: line.line,
          character: 0
        },
        search: prepareSearchText(line.text)
      });
    }
  }

  return {
    createdAt: index.createdAt,
    fileCount: index.files.length,
    files,
    symbols,
    classSymbols,
    functionSymbols,
    text
  };
}

function getSymbolsForScope(cache: SearchCache, scope: SearchScope): PreparedSymbolCandidate[] {
  if (scope === 'classes') {
    return cache.classSymbols;
  }

  if (scope === 'functions') {
    return cache.functionSymbols;
  }

  return cache.symbols;
}

function prepareSearchText(value: string, normalized = value.toLowerCase()): PreparedSearchText {
  const baseName = path.basename(normalized);
  const separatedBaseName = normalizeSeparators(baseName);
  return {
    normalized,
    separated: normalizeSeparators(normalized),
    compact: normalized.replace(/[\s._/-]+/g, ''),
    baseName,
    baseNameWithoutExtension: stripExtension(baseName),
    separatedBaseName,
    separatedBaseNameWithoutExtension: stripExtension(separatedBaseName)
  };
}
