import * as path from 'path';
import * as fs from 'fs/promises';
import { Worker } from 'worker_threads';
import * as vscode from 'vscode';
import { CodeMapFile } from './types';
import { extractSymbols, extractTextLines, getLanguageFromPath } from './symbol-extractor';

export interface IndexFileTask {
  absolutePath: string;
  workspaceFolder: string;
  relativePath: string;
}

export interface IndexBatchProgress {
  processed: number;
  total: number;
  currentFile?: string;
}

interface WorkerBatchData {
  files: IndexFileTask[];
  maxFileSizeBytes: number;
  textLineLimit: number;
}

interface WorkerFileResult {
  file: CodeMapFile | undefined;
  error?: string;
}

interface WorkerBatchResult {
  type: 'index';
  results: WorkerFileResult[];
  ms: number;
}

interface WorkerBatchMessage {
  type: 'index-batch';
  results: WorkerFileResult[];
}

export type LogFn = (message: string) => void;
export type LogErrorFn = (context: string, error: unknown) => void;

const MIN_FILES_PER_WORKER = 50;
const MAX_WORKERS = 8;

export interface PrewarmResult {
  files: unknown[];
  symbols: unknown[];
  classSymbols: unknown[];
  functionSymbols: unknown[];
  text: unknown[];
}

export class IndexerPool {
  private workerPath: string;
  private workerCount: number;
  private log: LogFn;
  private logError: LogErrorFn;
  private useWorkers: boolean;

  constructor(extensionPath: string, log: LogFn, logError: LogErrorFn) {
    this.workerPath = path.join(extensionPath, 'out', 'indexer-worker.js');
    this.log = log;
    this.logError = logError;
    const cpuCount = require('os').cpus().length;
    this.workerCount = Math.max(2, Math.min(MAX_WORKERS, cpuCount - 2));
    this.useWorkers = true;
  }

  async indexFiles(
    tasks: IndexFileTask[],
    maxFileSizeBytes: number,
    textLineLimit: number,
    onProgress?: (progress: IndexBatchProgress) => void
  ): Promise<CodeMapFile[]> {
    if (tasks.length === 0) {
      return [];
    }

    if (this.useWorkers && tasks.length >= MIN_FILES_PER_WORKER) {
      try {
        return await this.indexWithWorkers(tasks, maxFileSizeBytes, textLineLimit, onProgress);
      } catch (error) {
        this.logError('Worker pool failed, falling back to main thread', error);
        this.useWorkers = false;
      }
    }

    return this.indexOnMain(tasks, maxFileSizeBytes, textLineLimit, onProgress);
  }

  async prewarmInWorker(files: CodeMapFile[]): Promise<PrewarmResult | undefined> {
    if (!this.useWorkers || files.length === 0) {
      return undefined;
    }
    try {
      const result = await this.runWorkerTask({ type: 'prewarm', files });
      return result as PrewarmResult;
    } catch (error) {
      this.logError('Prewarm worker failed, falling back to main thread', error);
      return undefined;
    }
  }

  async postFilterInWorker(
    uris: string[],
    workspaceFolder: string,
    excludeGlobs: string[]
  ): Promise<string[] | undefined> {
    if (!this.useWorkers || uris.length === 0) {
      return undefined;
    }
    try {
      const result = await this.runWorkerTask({ type: 'postfilter', uris, workspaceFolder, excludeGlobs });
      return (result as { keptUris: string[] }).keptUris;
    } catch (error) {
      this.logError('Post-filter worker failed, falling back to main thread', error);
      return undefined;
    }
  }

  async serializeInWorker(files: CodeMapFile[], outputPath: string): Promise<boolean> {
    if (!this.useWorkers || files.length === 0) {
      return false;
    }
    try {
      await this.runWorkerTask({ type: 'serialize', files, outputPath });
      return true;
    } catch (error) {
      this.logError('Serialize worker failed, falling back to main thread', error);
      return false;
    }
  }

  async saveTextInWorker(files: CodeMapFile[], shardsDir: string, shardCount: number): Promise<number | undefined> {
    if (!this.useWorkers || files.length === 0) {
      return undefined;
    }
    try {
      const result = await this.runWorkerTask({ type: 'savetext', files, shardsDir, shardCount });
      return (result as { textLineCount: number }).textLineCount;
    } catch (error) {
      this.logError('Save-text worker failed, falling back to main thread', error);
      return undefined;
    }
  }

  async loadIndexInWorker(metaPath: string, filesPath: string): Promise<{ version: number; createdAt: string; workspaceFolders: string[]; files: CodeMapFile[] } | undefined> {
    if (!this.useWorkers) {
      return undefined;
    }
    try {
      const result = await this.runWorkerTask({ type: 'loadindex', metaPath, filesPath });
      return (result as { index: unknown }).index as { version: number; createdAt: string; workspaceFolders: string[]; files: CodeMapFile[] } | undefined;
    } catch (error) {
      this.logError('Load-index worker failed, falling back to main thread', error);
      return undefined;
    }
  }

  private runWorkerTask(taskData: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const worker = new Worker(this.workerPath, { workerData: taskData });
      worker.on('message', (msg: unknown) => resolve(msg));
      worker.on('error', (err) => reject(err));
      worker.on('exit', (code) => {
        if (code !== 0) {
          reject(new Error(`Worker exited with code ${code}`));
        }
      });
    });
  }

  private async indexWithWorkers(
    tasks: IndexFileTask[],
    maxFileSizeBytes: number,
    textLineLimit: number,
    onProgress?: (progress: IndexBatchProgress) => void
  ): Promise<CodeMapFile[]> {
    const chunkSize = Math.ceil(tasks.length / this.workerCount);
    const chunks: IndexFileTask[][] = [];
    for (let i = 0; i < tasks.length; i += chunkSize) {
      chunks.push(tasks.slice(i, i + chunkSize));
    }

    this.log(`Indexing with ${chunks.length} workers (${tasks.length} files, ~${chunkSize} each).`);

    const files: CodeMapFile[] = [];
    let processed = 0;
    let lastLoggedProgress = 0;

    const workerPromises = chunks.map(
      (chunk, chunkIndex) =>
        new Promise<void>((resolve, reject) => {
          const batchData: WorkerBatchData = { files: chunk, maxFileSizeBytes, textLineLimit };
          const worker = new Worker(this.workerPath, { workerData: batchData });

          worker.on('message', (msg: WorkerBatchResult | WorkerBatchMessage) => {
            if (msg.type === 'index-batch') {
              for (const result of msg.results) {
                if (result.file) {
                  files.push(result.file);
                } else if (result.error) {
                  this.logError(`Worker indexing error`, new Error(result.error));
                }
              }
              processed += msg.results.length;
              if (processed - lastLoggedProgress >= 1000) {
                this.log(`Worker progress: indexed ${processed}/${tasks.length} candidates, accepted ${files.length} files.`);
                lastLoggedProgress = processed;
              }
              onProgress?.({
                processed,
                total: tasks.length,
                currentFile: chunk[Math.min(processed - 1, chunk.length - 1)]?.relativePath
              });
              return;
            }

            // Final 'index' message (results empty, just signals completion)
            resolve();
          });

          worker.on('error', (err) => reject(err));
          worker.on('exit', (code) => {
            if (code !== 0) {
              reject(new Error(`Worker ${chunkIndex} exited with code ${code}`));
            }
          });
        })
    );

    await Promise.all(workerPromises);

    onProgress?.({ processed: tasks.length, total: tasks.length });
    return files;
  }

  private async indexOnMain(
    tasks: IndexFileTask[],
    maxFileSizeBytes: number,
    textLineLimit: number,
    onProgress?: (progress: IndexBatchProgress) => void
  ): Promise<CodeMapFile[]> {
    const files: CodeMapFile[] = [];
    const batchSize = 64;

    for (let i = 0; i < tasks.length; i += batchSize) {
      const batchEnd = Math.min(i + batchSize, tasks.length);
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
}
