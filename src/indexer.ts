import * as fs from 'fs/promises';
import * as nodeFs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import * as vscode from 'vscode';
import {
  CodeMapFile,
  CodeMapIndex,
  CodeMapIndexMeta,
  CodeMapIndexSummary,
  CodeMapSyncResult,
  CodeMapSymbol,
  CodeMapTextLine,
  SearchResult
} from './types';
import { invalidateSymbolSearchState, prewarmSearchCache, setSearchCacheFromWorkerResult } from './search';
import { extractSymbols, extractTextLines, getLanguageFromPath } from './symbol-extractor';
import { IndexerPool, IndexFileTask } from './indexer-pool';

const INDEX_VERSION = 1;
const DEFAULT_TEXT_LINE_LIMIT = 200;
const DEFAULT_TOTAL_TEXT_LINE_LIMIT = 1000000;
const TEXT_SHARD_COUNT = 64;
const INDEX_BUILD_CONCURRENCY = 64;
const INDEX_SYNC_CONCURRENCY = 64;
const LARGE_PROJECT_FILE_THRESHOLD = 5000;
export const DEFAULT_INCLUDE_GLOB = '**/*.{ts,tsx,js,jsx,mjs,cjs,py,lua,java,kt,kts,go,rs,cs,cpp,cxx,cc,c,h,hpp,php,rb,swift,dart,vue,svelte,sh,bash,zsh,ps1}';

export interface BuildIndexProgress {
  processed: number;
  total: number;
  currentFile?: string;
  stage?: 'indexing' | 'saving-text' | 'saving-index' | 'prewarming';
}

export class CodeMapIndexer {
  private index: CodeMapIndex | undefined;
  private readonly output: vscode.OutputChannel;
  private pool: IndexerPool | undefined;
  private cachedTextQuery = '';
  private cachedTextResults: SearchResult[] = [];
  private cancelled = false;

  constructor(output: vscode.OutputChannel, extensionPath?: string) {
    this.output = output;
    if (extensionPath) {
      this.pool = new IndexerPool(extensionPath, (m) => this.log(m), (c, e) => this.logError(c, e));
    }
  }

  cancel(): void {
    this.cancelled = true;
  }

  private isCancelled(): boolean {
    if (this.cancelled) {
      this.log('Operation cancelled.');
      return true;
    }
    return false;
  }

  private invalidateTextCache(): void {
    this.cachedTextQuery = '';
    this.cachedTextResults = [];
    invalidateSymbolSearchState();
  }

  async getIndex(): Promise<CodeMapIndex | undefined> {
    if (this.index) {
      this.log(`Using cached index with ${this.index.files.length} files.`);
      return this.index;
    }

    this.log('Loading workspace index from disk.');
    this.index = await this.loadIndex();
    this.log(this.index ? `Loaded index with ${this.index.files.length} files.` : 'No index found on disk.');
    if (this.index) {
      const snapshot = this.index;
      void this.prewarmWithWorkers(snapshot);
    }
    return this.index;
  }

  async buildIndex(onProgress?: (progress: BuildIndexProgress) => void): Promise<CodeMapIndex> {
    this.cancelled = false;
    const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
    if (workspaceFolders.length === 0) {
      throw new Error('Open a workspace folder before building a CodeMap index.');
    }

    const config = vscode.workspace.getConfiguration('codemap');
    const includeGlobs = config.get<string[]>('includeGlobs', [DEFAULT_INCLUDE_GLOB]);
    const excludeGlobs = await getEffectiveExcludeGlobs(workspaceFolders);
    const maxFileSizeBytes = config.get<number>('maxFileSizeBytes', 1024 * 1024);
    const indexTextLines = config.get<boolean>('indexTextLines', true);
    const startedAt = Date.now();
    this.log(`Building index for ${workspaceFolders.length} workspace folder(s).`);
    this.log(`Workspace folders: ${workspaceFolders.map((folder) => folder.uri.fsPath).join(' | ')}`);
    this.log(`Include globs: ${includeGlobs.join(' | ')}`);
    this.log(`Exclude globs: ${excludeGlobs.join(' | ') || '(none)'}`);

    const uniqueUris = await collectIndexableUris(includeGlobs, excludeGlobs, this.output, this.pool);
    this.log(`Collected ${uniqueUris.length} unique indexable files.`);

    const maxTextLinesPerFile = indexTextLines ? config.get<number>('maxTextLinesPerFile', DEFAULT_TEXT_LINE_LIMIT) : 0;

    this.log(`Limits: maxFileSizeBytes=${maxFileSizeBytes}, indexTextLines=${indexTextLines}, maxTextLinesPerFile=${maxTextLinesPerFile}`);

    const tasks: IndexFileTask[] = [];
    for (const uri of uniqueUris) {
      const location = getWorkspaceLocation(uri);
      if (location) {
        tasks.push({
          absolutePath: uri.fsPath,
          workspaceFolder: location.workspaceFolder,
          relativePath: location.relativePath
        });
      }
    }

    this.log('Stage: indexing files...');
    const files = await this.indexFilesOnMain(tasks, maxFileSizeBytes, maxTextLinesPerFile, onProgress);

    onProgress?.({
      processed: uniqueUris.length,
      total: uniqueUris.length
    });

    const indexWithText: CodeMapIndex = {
      version: INDEX_VERSION,
      createdAt: new Date().toISOString(),
      workspaceFolders: workspaceFolders.map((folder) => folder.uri.fsPath),
      files: dedupeFiles(files)
    };

    if (indexTextLines) {
      this.log('Stage: saving text shards...');
      onProgress?.({ processed: 0, total: 0, stage: 'saving-text' });
      await this.saveTextIndex(indexWithText.files);
    } else {
      await this.clearTextIndex();
    }

    const index = stripIndexTextLines(indexWithText);
    this.log('Stage: saving index to disk...');
    onProgress?.({ processed: 0, total: 0, stage: 'saving-index' });
    await this.saveIndex(index);
    this.index = index;

    this.log('Stage: prewarming search cache...');
    onProgress?.({ processed: 0, total: 0, stage: 'prewarming' });
    await this.prewarmWithWorkers(index);

    const durationMs = Date.now() - startedAt;
    const symbolCount = index.files.reduce((count, file) => count + file.symbols.length, 0);
    if (indexTextLines) {
      this.invalidateTextCache();
    }
    this.log(`Indexed ${index.files.length} files and ${symbolCount} symbols in ${durationMs}ms.`);
    return index;
  }

  private async prewarmWithWorkers(index: CodeMapIndex): Promise<void> {
    if (this.pool) {
      const result = await this.pool.prewarmInWorker(index.files);
      if (result) {
        setSearchCacheFromWorkerResult(index, result as Parameters<typeof setSearchCacheFromWorkerResult>[1]);
        this.log('Search cache prewarmed (worker).');
        return;
      }
    }
    setTimeout(() => {
      try {
        prewarmSearchCache(index);
        this.log('Search cache prewarmed (main thread).');
      } catch (error) {
        this.logError('Failed to prewarm symbol search cache', error);
      }
    }, 0);
  }

  async updateFile(uri: vscode.Uri): Promise<void> {
    try {
      const current = await this.getIndex();
      if (!current || uri.scheme !== 'file') {
        return;
      }

      const config = vscode.workspace.getConfiguration('codemap');
      const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
      const excludeGlobs = await getEffectiveExcludeGlobs(workspaceFolders);
      const maxFileSizeBytes = config.get<number>('maxFileSizeBytes', 1024 * 1024);
      const indexTextLines = config.get<boolean>('indexTextLines', true);
      const textLineLimit = indexTextLines ? config.get<number>('maxTextLinesPerFile', DEFAULT_TEXT_LINE_LIMIT) : 0;
      const location = getWorkspaceLocation(uri);
      if (!location) {
        return;
      }
      const ignored = isRelativePathIgnored(location.relativePath, excludeGlobs);
      if (ignored) {
        const existingInIndex = current.files.some(
          (file) => file.workspaceFolder === location.workspaceFolder && file.relativePath === location.relativePath
        );
        if (!existingInIndex) {
          return;
        }
      }

      const indexedFile = ignored ? undefined : await this.indexFile(uri, maxFileSizeBytes, textLineLimit);

      current.files = current.files.filter((file) => {
        return file.workspaceFolder !== location.workspaceFolder || file.relativePath !== location.relativePath;
      });

      if (indexedFile) {
        current.files.push(stripFileTextLines(indexedFile));
      }

      current.createdAt = new Date().toISOString();
      if (indexTextLines) {
        await this.replaceTextIndexEntries(location.workspaceFolder, location.relativePath, indexedFile);
      } else {
        await this.removeTextIndexEntries(location.workspaceFolder, location.relativePath);
      }
      this.invalidateTextCache();
      await this.saveIndex(current);
      this.log(`Updated index entry for ${location.relativePath}.`);
    } catch (error) {
      this.logError(`Failed to update file ${uri.fsPath}`, error);
    }
  }

  async syncIndex(onProgress?: (progress: BuildIndexProgress) => void, isBackground = false): Promise<CodeMapSyncResult> {
    if (!isBackground) {
      this.cancelled = false;
    }
    const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
    if (workspaceFolders.length === 0) {
      throw new Error('Open a workspace folder before syncing a CodeMap index.');
    }

    const current = await this.getIndex();
    if (!current) {
      throw new Error('No CodeMap index found. Run "CodeMap: Build Index" first.');
    }

    const config = vscode.workspace.getConfiguration('codemap');
    const includeGlobs = config.get<string[]>('includeGlobs', [DEFAULT_INCLUDE_GLOB]);
    const excludeGlobs = await getEffectiveExcludeGlobs(workspaceFolders);
    const maxFileSizeBytes = config.get<number>('maxFileSizeBytes', 1024 * 1024);
    const indexTextLines = config.get<boolean>('indexTextLines', true);
    const maxTextLinesPerFile = indexTextLines ? config.get<number>('maxTextLinesPerFile', DEFAULT_TEXT_LINE_LIMIT) : 0;
    this.log(`Syncing index. Existing files=${current.files.length}.`);
    this.log(`Include globs: ${includeGlobs.join(' | ')}`);
    this.log(`Exclude globs: ${excludeGlobs.join(' | ') || '(none)'}`);
    const uniqueUris = await collectIndexableUris(includeGlobs, excludeGlobs, this.output, this.pool);
    if (this.isCancelled()) {
      return { index: current, scannedFiles: 0, addedFiles: 0, updatedFiles: 0, removedFiles: 0 };
    }
    this.log(`Collected ${uniqueUris.length} unique sync candidates.`);
    const existingByKey = new Map(current.files.map((file) => [fileKey(file.workspaceFolder, file.relativePath), file]));
    const nextFiles: CodeMapFile[] = [];
    const seenKeys = new Set<string>();
    const textReplacements = new Map<string, CodeMapFile | undefined>();
    let addedFiles = 0;
    let updatedFiles = 0;

    interface SyncStatOutcome {
      key: string;
      location: { workspaceFolder: string; relativePath: string };
      absolutePath: string;
      preserved?: CodeMapFile;
      needsIndex?: boolean;
    }

    const statOutcomes: SyncStatOutcome[] = [];
    for (let i = 0; i < uniqueUris.length; i += INDEX_SYNC_CONCURRENCY) {
      const batchEnd = Math.min(i + INDEX_SYNC_CONCURRENCY, uniqueUris.length);
      const batchUris = uniqueUris.slice(i, batchEnd);
      const batchStats = await Promise.all(
        batchUris.map(async (uri): Promise<SyncStatOutcome | undefined> => {
          const location = getWorkspaceLocation(uri);
          if (!location) {
            return undefined;
          }
          const key = fileKey(location.workspaceFolder, location.relativePath);
          seenKeys.add(key);

          let stat;
          try {
            stat = await fs.stat(uri.fsPath);
          } catch (error) {
            this.logError(`Failed to stat file during sync ${location.relativePath}`, error);
            return undefined;
          }

          const existing = existingByKey.get(key);
          if (stat.size > maxFileSizeBytes) {
            return { key, location, absolutePath: uri.fsPath };
          }

          if (existing && existing.size === stat.size && existing.mtimeMs === stat.mtimeMs) {
            return { key, location, absolutePath: uri.fsPath, preserved: existing };
          }

          return { key, location, absolutePath: uri.fsPath, needsIndex: true };
        })
      );

      for (const outcome of batchStats) {
        if (outcome) {
          statOutcomes.push(outcome);
        }
      }

      onProgress?.({
        processed: batchEnd,
        total: uniqueUris.length,
        currentFile: getWorkspaceLocation(batchUris[batchUris.length - 1])?.relativePath
      });
    }

    for (const outcome of statOutcomes) {
      if (outcome.preserved) {
        nextFiles.push({ ...outcome.preserved, textLines: [] });
      }
    }

    const indexTasks: IndexFileTask[] = statOutcomes
      .filter((o) => o.needsIndex)
      .map((o) => ({
        absolutePath: o.absolutePath,
        workspaceFolder: o.location.workspaceFolder,
        relativePath: o.location.relativePath
      }));

    this.log(`Sync: ${statOutcomes.filter((o) => o.preserved).length} preserved, ${indexTasks.length} need indexing.`);

    const indexedFiles = await this.indexFilesOnMain(indexTasks, maxFileSizeBytes, maxTextLinesPerFile);

    for (const indexed of indexedFiles) {
      const key = fileKey(indexed.workspaceFolder, indexed.relativePath);
      const wasExisting = existingByKey.has(key);
      nextFiles.push(stripFileTextLines(indexed));
      if (indexTextLines) {
        textReplacements.set(key, indexed);
      }
      if (wasExisting) {
        updatedFiles += 1;
      } else {
        addedFiles += 1;
      }
    }

    const removedFileEntries = current.files.filter((file) => !seenKeys.has(fileKey(file.workspaceFolder, file.relativePath)));
    for (const removed of removedFileEntries) {
      textReplacements.set(fileKey(removed.workspaceFolder, removed.relativePath), undefined);
    }
    const removedFiles = removedFileEntries.length;
    current.files = dedupeFiles(nextFiles);
    current.createdAt = new Date().toISOString();

    if (this.isCancelled()) {
      return { index: current, scannedFiles: uniqueUris.length, addedFiles, updatedFiles, removedFiles };
    }

    if (indexTextLines) {
      await this.applyTextIndexReplacements(textReplacements);
    } else {
      await this.clearTextIndex();
    }
    if (this.isCancelled()) {
      return { index: current, scannedFiles: uniqueUris.length, addedFiles, updatedFiles, removedFiles };
    }
    await this.saveIndex(current);
    this.index = current;
    await this.prewarmWithWorkers(current);

    onProgress?.({
      processed: uniqueUris.length,
      total: uniqueUris.length
    });

    this.log(`Synced ${uniqueUris.length} files: +${addedFiles}, ~${updatedFiles}, -${removedFiles}.`);
    this.invalidateTextCache();

    return {
      index: current,
      scannedFiles: uniqueUris.length,
      addedFiles,
      updatedFiles,
      removedFiles
    };
  }

  async getIndexSummary(): Promise<CodeMapIndexSummary | undefined> {
    const index = await this.getIndex();
    if (!index) {
      return undefined;
    }

    const paths = getIndexPaths();
    return {
      createdAt: index.createdAt,
      workspaceFolders: index.workspaceFolders,
      fileCount: index.files.length,
      symbolCount: index.files.reduce((count, file) => count + file.symbols.length, 0),
      languageCounts: countLanguages(index.files),
      storagePath: paths?.indexDir
    };
  }

  async searchTextIndex(rawQuery: string, limit: number): Promise<CodeMapTextSearchResult[]> {
    const query = rawQuery.trim();
    if (!query || limit <= 0) {
      return [];
    }

    // Prefix cache: skip 64 shard file re-scan when new query extends previous one.
    if (
      this.cachedTextQuery
      && query.length > this.cachedTextQuery.length
      && query.toLowerCase().startsWith(this.cachedTextQuery.toLowerCase())
      && this.cachedTextResults.length > 0
    ) {
      const filtered = this.filterCachedTextResults(query, limit);
      this.log(`Text cache hit query="${query}" base="${this.cachedTextQuery}" results=${filtered.length}`);
      return filtered;
    }

    const fresh = await this.searchTextIndexRaw(query, limit);
    // Only cache when this query is a refinement of the previous cache, to avoid going backward.
    if (
      !this.cachedTextQuery
      || query.length >= this.cachedTextQuery.length
      || !query.toLowerCase().startsWith(this.cachedTextQuery.toLowerCase())
    ) {
      this.cachedTextQuery = query;
      this.cachedTextResults = fresh;
    }
    return fresh;
  }

  private filterCachedTextResults(query: string, limit: number): SearchResult[] {
    const queryLower = query.toLowerCase();
    const reScored: SearchResult[] = [];
    for (const cached of this.cachedTextResults) {
      const haystack = (cached.preview ?? cached.label ?? '').toLowerCase();
      const character = haystack.indexOf(queryLower);
      if (character < 0) {
        continue;
      }
      reScored.push({
        ...cached,
        score: 120 + Math.max(0, 120 - character),
        location: { ...cached.location, character }
      });
    }
    reScored.sort((left, right) => right.score - left.score || left.description.localeCompare(right.description));
    return reScored.slice(0, limit);
  }

  private async searchTextIndexRaw(query: string, limit: number): Promise<SearchResult[]> {
    const paths = getIndexPaths();
    if (!paths) {
      return [];
    }

    const queryLower = query.toLowerCase();
    const results: SearchResult[] = [];
    const startedAt = Date.now();

    for (let shard = 0; shard < TEXT_SHARD_COUNT && results.length < limit; shard += 1) {
      const shardPath = getTextShardPath(paths, shard);
      try {
        await fs.access(shardPath);
      } catch {
        continue;
      }

      const reader = readline.createInterface({
        input: nodeFs.createReadStream(shardPath, { encoding: 'utf8' }),
        crlfDelay: Infinity
      });

      for await (const line of reader) {
        if (!line.trim()) {
          continue;
        }

        let entry: TextShardEntry;
        try {
          entry = JSON.parse(line) as TextShardEntry;
        } catch (error) {
          this.logError(`Failed to parse text shard line in ${shardPath}`, error);
          continue;
        }

        const textLower = entry.text.toLowerCase();
        const character = textLower.indexOf(queryLower);
        if (character < 0) {
          continue;
        }

        results.push({
          kind: 'text',
          label: trimPreview(entry.text),
          description: `${entry.relativePath}:${entry.line + 1}`,
          detail: entry.relativePath,
          score: 120 + Math.max(0, 120 - character),
          location: {
            workspaceFolder: entry.workspaceFolder,
            relativePath: entry.relativePath,
            line: entry.line,
            character
          },
          preview: entry.text
        });

        if (results.length >= limit) {
          reader.close();
          break;
        }
      }
    }

    this.log(`Text shard search query="${query}" results=${results.length} durationMs=${Date.now() - startedAt}`);
    return results.sort((left, right) => right.score - left.score || left.description.localeCompare(right.description));
  }

  async clearIndex(): Promise<void> {
    const paths = getIndexPaths();
    this.index = undefined;
    this.invalidateTextCache();
    if (!paths) {
      return;
    }

    this.log(`Clearing index at ${paths.indexDir}.`);
    await fs.rm(paths.indexDir, { recursive: true, force: true });
  }

  async removeFile(uri: vscode.Uri): Promise<void> {
    const current = await this.getIndex();
    const location = getWorkspaceLocation(uri);
    if (!current || !location) {
      return;
    }

    current.files = current.files.filter((file) => {
      return file.workspaceFolder !== location.workspaceFolder || file.relativePath !== location.relativePath;
    });
    current.createdAt = new Date().toISOString();
    await this.removeTextIndexEntries(location.workspaceFolder, location.relativePath);
    this.invalidateTextCache();
    await this.saveIndex(current);
    this.log(`Removed index entry for ${location.relativePath}.`);
  }

  private async indexFile(uri: vscode.Uri, maxFileSizeBytes: number, textLineLimit: number): Promise<CodeMapFile | undefined> {
    if (uri.scheme !== 'file') {
      return undefined;
    }

    const location = getWorkspaceLocation(uri);
    if (!location) {
      return undefined;
    }

    const stat = await fs.stat(uri.fsPath);
    if (stat.size > maxFileSizeBytes) {
      return undefined;
    }

    const content = await fs.readFile(uri.fsPath, 'utf8');
    const language = getLanguageFromPath(uri.fsPath);
    const textLines = extractTextLines(content, textLineLimit);
    const symbols = extractSymbols(content, location.workspaceFolder, location.relativePath, language);

    return {
      workspaceFolder: location.workspaceFolder,
      relativePath: location.relativePath,
      absolutePath: uri.fsPath,
      language,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      symbols,
      textLines
    };
  }

  private async indexFilesOnMain(
    tasks: IndexFileTask[],
    maxFileSizeBytes: number,
    textLineLimit: number,
    onProgress?: (progress: BuildIndexProgress) => void
  ): Promise<CodeMapFile[]> {
    const files: CodeMapFile[] = [];

    for (let i = 0; i < tasks.length; i += INDEX_BUILD_CONCURRENCY) {
      const batchEnd = Math.min(i + INDEX_BUILD_CONCURRENCY, tasks.length);
      const batch = tasks.slice(i, batchEnd);
      const batchResults = await Promise.all(
        batch.map(async (task) => {
          try {
            const stat = await fs.stat(task.absolutePath);
            if (stat.size > maxFileSizeBytes) {
              return undefined;
            }
            const content = await fs.readFile(task.absolutePath, 'utf8');
            const language = getLanguageFromPath(task.absolutePath);
            const textLines = extractTextLines(content, textLineLimit);
            const symbols = extractSymbols(content, task.workspaceFolder, task.relativePath, language);
            return {
              workspaceFolder: task.workspaceFolder,
              relativePath: task.relativePath,
              absolutePath: task.absolutePath,
              language,
              size: stat.size,
              mtimeMs: stat.mtimeMs,
              symbols,
              textLines
            } as CodeMapFile;
          } catch (error) {
            this.logError(`Failed to index file ${task.relativePath}`, error);
            return undefined;
          }
        })
      );

      for (const f of batchResults) {
        if (f) {
          files.push(f);
        }
      }

      onProgress?.({
        processed: batchEnd,
        total: tasks.length,
        currentFile: batch[batch.length - 1]?.relativePath
      });
    }

    return files;
  }

  private async loadIndex(): Promise<CodeMapIndex | undefined> {
    const paths = getIndexPaths();
    if (!paths) {
      this.log('No workspace folder available for index paths.');
      return undefined;
    }

    this.log(`Index paths: meta=${paths.metaPath}, files=${paths.filesPath}, legacy=${paths.legacyIndexPath}`);

    // Try worker-based loading first (keeps main thread free for UI)
    if (this.pool) {
      const startedAt = Date.now();
      const workerResult = await this.pool.loadIndexInWorker(paths.metaPath, paths.filesPath);
      if (workerResult) {
        this.log(`Loaded ${workerResult.files.length} files from JSONL via worker in ${Date.now() - startedAt}ms.`);
        return workerResult as CodeMapIndex;
      }
    }

    // Fallback: main thread streaming load
    const splitIndex = await this.loadSplitIndex(paths);
    if (splitIndex) {
      this.log('Loaded split JSONL index.');
      return splitIndex;
    }

    return this.loadLegacyIndex(paths);
  }

  private async loadSplitIndex(paths: CodeMapIndexPaths): Promise<CodeMapIndex | undefined> {
    let metaRaw: string;
    try {
      metaRaw = await fs.readFile(paths.metaPath, 'utf8');
    } catch (error) {
      this.logError('Failed to load split JSONL index', error);
      return undefined;
    }

    let meta: CodeMapIndexMeta;
    try {
      meta = JSON.parse(metaRaw) as CodeMapIndexMeta;
    } catch (error) {
      this.logError('Failed to parse index meta', error);
      return undefined;
    }
    if (meta.version !== INDEX_VERSION || meta.storage !== 'jsonl') {
      return undefined;
    }

    const files: CodeMapFile[] = [];
    const startedAt = Date.now();
    try {
      const reader = readline.createInterface({
        input: nodeFs.createReadStream(paths.filesPath, { encoding: 'utf8' }),
        crlfDelay: Infinity
      });

      for await (const line of reader) {
        if (!line.trim()) {
          continue;
        }
        try {
          files.push(stripFileTextLines(JSON.parse(line) as CodeMapFile));
        } catch {
          // skip malformed lines
        }
      }
    } catch (error) {
      this.logError('Failed to read split JSONL files', error);
      return undefined;
    }

    this.log(`Loaded ${files.length} files from JSONL in ${Date.now() - startedAt}ms.`);
    return {
      version: INDEX_VERSION,
      createdAt: meta.createdAt,
      workspaceFolders: meta.workspaceFolders,
      files
    };
  }

  private async loadLegacyIndex(paths: CodeMapIndexPaths): Promise<CodeMapIndex | undefined> {
    try {
      const raw = await fs.readFile(paths.legacyIndexPath, 'utf8');
      const parsed = JSON.parse(raw) as CodeMapIndex;
      if (parsed.version !== INDEX_VERSION) {
        return undefined;
      }
      parsed.files = trimLoadedTextLines(parsed.files);
      return parsed;
    } catch (error) {
      this.logError('Failed to load legacy JSON index', error);
      return undefined;
    }
  }

  private async saveIndex(index: CodeMapIndex): Promise<void> {
    const paths = getIndexPaths();
    if (!paths) {
      return;
    }

    const symbolCount = index.files.reduce((count, file) => count + file.symbols.length, 0);
    const meta: CodeMapIndexMeta = {
      version: INDEX_VERSION,
      storage: 'jsonl',
      createdAt: index.createdAt,
      workspaceFolders: index.workspaceFolders,
      fileCount: index.files.length,
      symbolCount
    };
    await fs.mkdir(paths.indexDir, { recursive: true });
    this.log(`Saving index: files=${index.files.length}, symbols=${symbolCount}, path=${paths.indexDir}`);
    await fs.writeFile(paths.metaPath, JSON.stringify(meta, null, 2), 'utf8');

    if (this.pool) {
      const ok = await this.pool.serializeInWorker(index.files, paths.filesPath);
      if (ok) {
        this.log('Index save completed (worker).');
        return;
      }
    }
    await writeFilesJsonl(paths.filesPath, index.files);
    this.log('Index save completed.');
  }

  private async saveTextIndex(files: CodeMapFile[]): Promise<void> {
    const paths = getIndexPaths();
    if (!paths) {
      return;
    }

    if (this.pool) {
      const textLineCount = await this.pool.saveTextInWorker(files, paths.textShardsDir, TEXT_SHARD_COUNT);
      if (textLineCount !== undefined) {
        this.log(`Text shard index saved (worker). files=${files.length}, textLines=${textLineCount}, dir=${paths.textShardsDir}`);
        return;
      }
    }

    // Fallback: main thread
    await fs.rm(paths.textShardsDir, { recursive: true, force: true });
    await fs.mkdir(paths.textShardsDir, { recursive: true });

    const writer = new TextShardWriter(paths);
    let textLineCount = 0;
    try {
      for (const file of files) {
        textLineCount += file.textLines.length;
        await writer.writeFile(file);
      }
    } finally {
      await writer.close();
    }

    this.log(`Text shard index saved. files=${files.length}, textLines=${textLineCount}, dir=${paths.textShardsDir}`);
  }

  private async clearTextIndex(): Promise<void> {
    const paths = getIndexPaths();
    if (!paths) {
      return;
    }

    await fs.rm(paths.textShardsDir, { recursive: true, force: true });
    this.log(`Text shard index cleared at ${paths.textShardsDir}.`);
  }

  private async replaceTextIndexEntries(
    workspaceFolder: string,
    relativePath: string,
    file: CodeMapFile | undefined
  ): Promise<void> {
    const replacements = new Map<string, CodeMapFile | undefined>();
    replacements.set(fileKey(workspaceFolder, relativePath), file);
    await this.applyTextIndexReplacements(replacements);
  }

  private async removeTextIndexEntries(workspaceFolder: string, relativePath: string): Promise<void> {
    await this.replaceTextIndexEntries(workspaceFolder, relativePath, undefined);
  }

  private async applyTextIndexReplacements(replacements: Map<string, CodeMapFile | undefined>): Promise<void> {
    const paths = getIndexPaths();
    if (!paths || replacements.size === 0) {
      return;
    }

    await fs.mkdir(paths.textShardsDir, { recursive: true });
    const byShard = new Map<number, Map<string, CodeMapFile | undefined>>();
    for (const [key, file] of replacements) {
      const relativePath = file?.relativePath ?? fileKeyParts(key).relativePath;
      const shard = textShardForRelativePath(relativePath);
      const shardReplacements = byShard.get(shard) ?? new Map<string, CodeMapFile | undefined>();
      shardReplacements.set(key, file);
      byShard.set(shard, shardReplacements);
    }

    for (const [shard, shardReplacements] of byShard) {
      await rewriteTextShard(paths, shard, shardReplacements);
    }

    this.log(`Text shard replacements applied. files=${replacements.size}, shards=${byShard.size}`);
  }

  private log(message: string): void {
    this.output.appendLine(`[CodeMap ${new Date().toISOString()}] ${message}`);
  }

  private logError(context: string, error: unknown): void {
    this.output.appendLine(`[CodeMap ${new Date().toISOString()}] ERROR: ${context}`);
    this.output.appendLine(formatError(error));
  }
}

interface CodeMapIndexPaths {
  indexDir: string;
  metaPath: string;
  filesPath: string;
  textShardsDir: string;
  legacyIndexPath: string;
}

function getIndexPaths(): CodeMapIndexPaths | undefined {
  const firstFolder = vscode.workspace.workspaceFolders?.[0];
  if (!firstFolder) {
    return undefined;
  }

  const indexDir = path.join(firstFolder.uri.fsPath, '.codemap');
  return {
    indexDir,
    metaPath: path.join(indexDir, 'meta.json'),
    filesPath: path.join(indexDir, 'files.jsonl'),
    textShardsDir: path.join(indexDir, 'text-shards'),
    legacyIndexPath: path.join(indexDir, 'index.json')
  };
}

function getWorkspaceLocation(uri: vscode.Uri): { workspaceFolder: string; relativePath: string } | undefined {
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (!folder) {
    return undefined;
  }

  return {
    workspaceFolder: folder.uri.fsPath,
    relativePath: path.relative(folder.uri.fsPath, uri.fsPath).replace(/\\/g, '/')
  };
}

async function getEffectiveExcludeGlobs(workspaceFolders: readonly vscode.WorkspaceFolder[]): Promise<string[]> {
  const config = vscode.workspace.getConfiguration('codemap');
  return [
    ...config.get<string[]>('excludeGlobs', []),
    ...await readCodemapIgnoreGlobs(workspaceFolders)
  ];
}

async function collectIndexableUris(
  includeGlobs: string[],
  excludeGlobs: string[],
  output?: vscode.OutputChannel,
  pool?: IndexerPool
): Promise<vscode.Uri[]> {
  const uris: vscode.Uri[] = [];
  const excludePattern = excludeGlobs.length > 0 ? `{${excludeGlobs.join(',')}}` : undefined;
  for (const includeGlob of includeGlobs) {
    output?.appendLine(`[CodeMap ${new Date().toISOString()}] Finding files for glob: ${includeGlob}`);
    const found = await vscode.workspace.findFiles(includeGlob, excludePattern);
    output?.appendLine(`[CodeMap ${new Date().toISOString()}] Glob matched ${found.length} files: ${includeGlob}`);
    for (const uri of found) {
      uris.push(uri);
    }
  }

  const deduped = dedupeUris(uris);
  output?.appendLine(`[CodeMap ${new Date().toISOString()}] Deduped ${uris.length} matched files to ${deduped.length}.`);

  if (excludeGlobs.length === 0) {
    return deduped;
  }

  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
  if (pool && workspaceFolder) {
    const uriStrings = deduped.map((u) => u.fsPath);
    const keptStrings = await pool.postFilterInWorker(uriStrings, workspaceFolder, excludeGlobs);
    if (keptStrings) {
      const keptSet = new Set(keptStrings);
      const filtered = deduped.filter((u) => keptSet.has(u.fsPath));
      output?.appendLine(`[CodeMap ${new Date().toISOString()}] Post-filter (worker) ${deduped.length} -> ${filtered.length}.`);
      return filtered;
    }
  }

  // Fallback: main-thread post-filter (async chunked)
  let noLocationCount = 0;
  let matchedCount = 0;
  const sampleMatched: string[] = [];
  const samplePaths: string[] = [];
  const filtered: vscode.Uri[] = [];
  const FILTER_CHUNK = 5000;
  for (let i = 0; i < deduped.length; i += FILTER_CHUNK) {
    const end = Math.min(i + FILTER_CHUNK, deduped.length);
    for (let j = i; j < end; j += 1) {
      const uri = deduped[j];
      const location = getWorkspaceLocation(uri);
      if (!location) {
        noLocationCount += 1;
        filtered.push(uri);
        continue;
      }
      if (samplePaths.length < 3) {
        samplePaths.push(location.relativePath);
      }
      const ignored = isRelativePathIgnored(location.relativePath, excludeGlobs);
      if (ignored) {
        matchedCount += 1;
        if (sampleMatched.length < 5) {
          sampleMatched.push(location.relativePath);
        }
      } else {
        filtered.push(uri);
      }
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  output?.appendLine(`[CodeMap ${new Date().toISOString()}] Post-filter ${deduped.length} -> ${filtered.length} after applying exclude rules. (noLocation=${noLocationCount}, matched=${matchedCount})`);
  if (samplePaths.length > 0) {
    output?.appendLine(`[CodeMap ${new Date().toISOString()}] Sample relative paths: ${samplePaths.join(' | ')}`);
  }
  if (sampleMatched.length > 0) {
    output?.appendLine(`[CodeMap ${new Date().toISOString()}] Sample excluded paths: ${sampleMatched.join(', ')}`);
  }
  return filtered;
}

async function writeFilesJsonl(filePath: string, files: CodeMapFile[]): Promise<void> {
  const handle = await fs.open(filePath, 'w');
  try {
    const BATCH = 500;
    for (let i = 0; i < files.length; i += BATCH) {
      const end = Math.min(i + BATCH, files.length);
      const chunk: string[] = [];
      for (let j = i; j < end; j += 1) {
        chunk.push(JSON.stringify(files[j]));
      }
      await handle.writeFile(chunk.join('\n') + '\n', 'utf8');
    }
  } finally {
    await handle.close();
  }
}

type CodeMapTextSearchResult = SearchResult;

interface TextShardEntry {
  workspaceFolder: string;
  relativePath: string;
  line: number;
  text: string;
}

class TextShardWriter {
  private readonly handles = new Map<number, fs.FileHandle>();

  public constructor(private readonly paths: CodeMapIndexPaths) {}

  public async writeFile(file: CodeMapFile): Promise<void> {
    if (file.textLines.length === 0) {
      return;
    }

    const shard = textShardForRelativePath(file.relativePath);
    const handle = await this.getHandle(shard);
    const lines = file.textLines
      .map((line) => JSON.stringify({
        workspaceFolder: file.workspaceFolder,
        relativePath: file.relativePath,
        line: line.line,
        text: line.text
      } satisfies TextShardEntry))
      .join('\n');
    await handle.writeFile(`${lines}\n`, 'utf8');
  }

  public async close(): Promise<void> {
    const handles = Array.from(this.handles.values());
    this.handles.clear();
    await Promise.all(handles.map((handle) => handle.close()));
  }

  private async getHandle(shard: number): Promise<fs.FileHandle> {
    const existing = this.handles.get(shard);
    if (existing) {
      return existing;
    }

    const handle = await fs.open(getTextShardPath(this.paths, shard), 'a');
    this.handles.set(shard, handle);
    return handle;
  }
}

async function rewriteTextShard(
  paths: CodeMapIndexPaths,
  shard: number,
  replacements: Map<string, CodeMapFile | undefined>
): Promise<void> {
  const shardPath = getTextShardPath(paths, shard);
  const tmpPath = `${shardPath}.tmp`;
  const writer = await fs.open(tmpPath, 'w');

  try {
    try {
      await fs.access(shardPath);
      const reader = readline.createInterface({
        input: nodeFs.createReadStream(shardPath, { encoding: 'utf8' }),
        crlfDelay: Infinity
      });

      for await (const line of reader) {
        if (!line.trim()) {
          continue;
        }

        let entry: TextShardEntry;
        try {
          entry = JSON.parse(line) as TextShardEntry;
        } catch {
          continue;
        }

        if (replacements.has(fileKey(entry.workspaceFolder, entry.relativePath))) {
          continue;
        }

        await writer.writeFile(`${line}\n`, 'utf8');
      }
    } catch {
      // Missing shards are normal for new indexes.
    }

    for (const file of replacements.values()) {
      if (!file || file.textLines.length === 0) {
        continue;
      }

      for (const line of file.textLines) {
        const entry: TextShardEntry = {
          workspaceFolder: file.workspaceFolder,
          relativePath: file.relativePath,
          line: line.line,
          text: line.text
        };
        await writer.writeFile(`${JSON.stringify(entry)}\n`, 'utf8');
      }
    }
  } finally {
    await writer.close();
  }

  await fs.rename(tmpPath, shardPath);
}

function getTextShardPath(paths: CodeMapIndexPaths, shard: number): string {
  return path.join(paths.textShardsDir, `${String(shard).padStart(2, '0')}.jsonl`);
}

function textShardForRelativePath(relativePath: string): number {
  return Math.abs(hashString(relativePath)) % TEXT_SHARD_COUNT;
}

function hashString(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  }
  return hash;
}

function stripIndexTextLines(index: CodeMapIndex): CodeMapIndex {
  return {
    ...index,
    files: index.files.map(stripFileTextLines)
  };
}

function stripFileTextLines(file: CodeMapFile): CodeMapFile {
  return {
    ...file,
    textLines: []
  };
}

function dedupeFiles(files: CodeMapFile[]): CodeMapFile[] {
  const seen = new Set<string>();
  const deduped: CodeMapFile[] = [];

  for (const file of files) {
    const key = `${file.workspaceFolder}:${file.relativePath}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(file);
  }

  return deduped;
}

function fileKey(workspaceFolder: string, relativePath: string): string {
  return `${workspaceFolder}\u0000${relativePath}`;
}

function fileKeyParts(key: string): { workspaceFolder: string; relativePath: string } {
  const separatorIndex = key.indexOf('\u0000');
  if (separatorIndex < 0) {
    return { workspaceFolder: '', relativePath: key };
  }

  return {
    workspaceFolder: key.slice(0, separatorIndex),
    relativePath: key.slice(separatorIndex + 1)
  };
}

function dedupeUris(uris: vscode.Uri[]): vscode.Uri[] {
  const seen = new Set<string>();
  const deduped: vscode.Uri[] = [];

  for (const uri of uris) {
    if (seen.has(uri.fsPath)) {
      continue;
    }

    seen.add(uri.fsPath);
    deduped.push(uri);
  }

  return deduped;
}

async function readCodemapIgnoreGlobs(workspaceFolders: readonly vscode.WorkspaceFolder[]): Promise<string[]> {
  const globs: string[] = [];

  for (const folder of workspaceFolders) {
    const ignorePath = path.join(folder.uri.fsPath, '.codemapignore');
    try {
      const raw = await fs.readFile(ignorePath, 'utf8');
      for (const line of raw.split(/\r?\n/)) {
        const parsed = normalizeIgnoreLine(line);
        if (parsed) {
          globs.push(parsed);
        }
      }
    } catch {
      // Workspaces do not need a .codemapignore file.
    }
  }

  return globs;
}

function normalizeIgnoreLine(line: string): string | undefined {
  const withoutComment = line.split('#')[0]?.trim();
  if (!withoutComment || withoutComment.startsWith('!')) {
    return undefined;
  }

  const pattern = withoutComment.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!pattern) {
    return undefined;
  }

  const hasSlash = pattern.includes('/');
  const hasGlob = /[*?[\]{}]/.test(pattern);
  if (pattern.endsWith('/')) {
    return `**/${pattern.replace(/\/+$/, '')}/**`;
  }

  if (!hasSlash && !hasGlob) {
    return `**/${pattern}/**`;
  }

  if (!hasSlash && hasGlob) {
    return `**/${pattern}`;
  }

  return pattern;
}

function isRelativePathIgnored(relativePath: string, globs: string[]): boolean {
  const segments = relativePath.replace(/\\/g, '/').split('/');
  const fileName = segments[segments.length - 1] || '';

  for (const glob of globs) {
    const normalizedGlob = glob.replace(/\\/g, '/');

    // Pattern: **/dirname/** → directory segment match (fast path)
    const dirMatch = normalizedGlob.match(/^\*\*\/([^/*?]+)\/\*\*$/);
    if (dirMatch) {
      if (segments.includes(dirMatch[1])) {
        return true;
      }
      continue;
    }

    // Pattern: **/dirname → directory segment match (fast path)
    const dirOnlyMatch = normalizedGlob.match(/^\*\*\/([^/*?]+)$/);
    if (dirOnlyMatch) {
      if (segments.includes(dirOnlyMatch[1])) {
        return true;
      }
      continue;
    }

    // Pattern: **/*.ext → file extension match (fast path)
    const extMatch = normalizedGlob.match(/^\*\*\/\*\.(\w[\w.]*)$/);
    if (extMatch) {
      if (fileName.toLowerCase().endsWith('.' + extMatch[1].toLowerCase())) {
        return true;
      }
      continue;
    }

    // Fallback: full regex match for complex globs
    if (globMatchesRelativePath(normalizedGlob, relativePath)) {
      return true;
    }
  }

  return false;
}

function globMatchesRelativePath(glob: string, relativePath: string): boolean {
  const normalizedGlob = glob.replace(/\\/g, '/');
  const normalizedPath = relativePath.replace(/\\/g, '/');
  const regex = new RegExp(`^${globToRegExpSource(normalizedGlob)}$`);
  return regex.test(normalizedPath);
}

function globToRegExpSource(glob: string): string {
  let source = '';

  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    const next = glob[index + 1];
    const afterNext = glob[index + 2];

    if (char === '*' && next === '*' && afterNext === '/') {
      source += '(?:.*/)?';
      index += 2;
      continue;
    }

    if (char === '*' && next === '*') {
      source += '.*';
      index += 1;
      continue;
    }

    if (char === '*') {
      source += '[^/]*';
      continue;
    }

    if (char === '?') {
      source += '[^/]';
      continue;
    }

    source += escapeRegExp(char);
  }

  return source;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

function trimPreview(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 96) {
    return trimmed;
  }

  return `${trimmed.slice(0, 93)}...`;
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return [
      `${error.name}: ${error.message}`,
      error.stack ? `Stack:\n${error.stack}` : undefined
    ].filter(Boolean).join('\n');
  }

  try {
    return JSON.stringify(error, null, 2);
  } catch {
    return String(error);
  }
}

function countLanguages(files: CodeMapFile[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const file of files) {
    counts[file.language] = (counts[file.language] ?? 0) + 1;
  }
  return counts;
}

function trimLoadedTextLines(files: CodeMapFile[]): CodeMapFile[] {
  return files.map(stripFileTextLines);
}
