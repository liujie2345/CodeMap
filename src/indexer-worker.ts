import { parentPort, workerData } from 'worker_threads';
import * as fs from 'fs';
import * as path from 'path';
import { CodeMapFile } from './types';
import { extractSymbols, extractTextLines, getLanguageFromPath } from './symbol-extractor';
import { isRelativePathIgnored } from './worker-glob';

type WorkerTask = WorkerIndexTask | WorkerPrewarmTask | WorkerPostFilterTask | WorkerSerializeTask | WorkerSaveTextTask | WorkerLoadIndexTask;

interface WorkerIndexTask {
  type: 'index';
  files: IndexFileTask[];
  maxFileSizeBytes: number;
  textLineLimit: number;
}

interface IndexFileTask {
  absolutePath: string;
  workspaceFolder: string;
  relativePath: string;
}

interface WorkerPrewarmTask {
  type: 'prewarm';
  files: CodeMapFile[];
}

interface WorkerPostFilterTask {
  type: 'postfilter';
  uris: string[];
  workspaceFolder: string;
  excludeGlobs: string[];
}

interface WorkerSerializeTask {
  type: 'serialize';
  files: CodeMapFile[];
  outputPath: string;
}

interface WorkerSaveTextTask {
  type: 'savetext';
  files: CodeMapFile[];
  shardsDir: string;
  shardCount: number;
}

interface WorkerLoadIndexTask {
  type: 'loadindex';
  metaPath: string;
  filesPath: string;
}

interface TextShardEntry {
  workspaceFolder: string;
  relativePath: string;
  line: number;
  text: string;
}

interface WorkerFileResult {
  file: CodeMapFile | undefined;
  error?: string;
}

interface WorkerIndexResult {
  type: 'index';
  results: WorkerFileResult[];
  ms: number;
}

interface WorkerIndexBatchMessage {
  type: 'index-batch';
  results: WorkerFileResult[];
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

interface PreparedSymbolCandidate {
  kind: string;
  label: string;
  description: string;
  detail?: string;
  preview?: string;
  location: { workspaceFolder: string; relativePath: string; line: number; character: number };
  search: PreparedSearchText;
}

interface PreparedFileCandidate {
  label: string;
  description: string;
  location: { workspaceFolder: string; relativePath: string; line: number; character: number };
  baseSearch: PreparedSearchText;
  pathSearch: PreparedSearchText;
}

interface PreparedTextCandidate {
  label: string;
  description: string;
  detail: string;
  preview: string;
  location: { workspaceFolder: string; relativePath: string; line: number; character: number };
  search: PreparedSearchText;
}

interface WorkerPrewarmResult {
  type: 'prewarm';
  files: PreparedFileCandidate[];
  symbols: PreparedSymbolCandidate[];
  classSymbols: PreparedSymbolCandidate[];
  functionSymbols: PreparedSymbolCandidate[];
  text: PreparedTextCandidate[];
  ms: number;
}

interface WorkerPostFilterResult {
  type: 'postfilter';
  keptUris: string[];
  ms: number;
}

interface WorkerSerializeResult {
  type: 'serialize';
  bytesWritten: number;
  ms: number;
}

interface WorkerSaveTextResult {
  type: 'savetext';
  textLineCount: number;
  ms: number;
}

interface WorkerLoadIndexResult {
  type: 'loadindex';
  index: { version: number; createdAt: string; workspaceFolders: string[]; files: CodeMapFile[] } | undefined;
  ms: number;
}

const task = workerData as WorkerTask;
const t0 = Date.now();

if (task.type === 'index') {
  const BATCH_SEND = 500;
  let batch: WorkerFileResult[] = [];
  for (const file of task.files) {
    try {
      const stat = fs.statSync(file.absolutePath);
      if (stat.size > task.maxFileSizeBytes) {
        batch.push({ file: undefined });
        continue;
      }

      const content = fs.readFileSync(file.absolutePath, 'utf8');
      const language = getLanguageFromPath(file.absolutePath);
      const textLines = extractTextLines(content, task.textLineLimit);
      const symbols = extractSymbols(content, file.workspaceFolder, file.relativePath, language);

      batch.push({
        file: {
          workspaceFolder: file.workspaceFolder,
          relativePath: file.relativePath,
          absolutePath: file.absolutePath,
          language,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          symbols,
          textLines
        }
      });
    } catch (error) {
      batch.push({
        file: undefined,
        error: error instanceof Error ? error.message : String(error)
      });
    }

    if (batch.length >= BATCH_SEND) {
      parentPort?.postMessage({ type: 'index-batch', results: batch } as WorkerIndexBatchMessage);
      batch = [];
    }
  }
  if (batch.length > 0) {
    parentPort?.postMessage({ type: 'index-batch', results: batch } as WorkerIndexBatchMessage);
  }

  const result: WorkerIndexResult = { type: 'index', results: [], ms: Date.now() - t0 };
  parentPort?.postMessage(result);
} else if (task.type === 'prewarm') {
  const files: PreparedFileCandidate[] = [];
  const symbols: PreparedSymbolCandidate[] = [];
  const classSymbols: PreparedSymbolCandidate[] = [];
  const functionSymbols: PreparedSymbolCandidate[] = [];
  const text: PreparedTextCandidate[] = [];

  for (const file of task.files) {
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

  const result: WorkerPrewarmResult = {
    type: 'prewarm',
    files,
    symbols,
    classSymbols,
    functionSymbols,
    text,
    ms: Date.now() - t0
  };
  parentPort?.postMessage(result);
} else if (task.type === 'postfilter') {
  const keptUris: string[] = [];
  for (const uri of task.uris) {
    const relativePath = path.relative(task.workspaceFolder, uri).replace(/\\/g, '/');
    if (!relativePath || relativePath.startsWith('..')) {
      continue;
    }
    if (isRelativePathIgnored(relativePath, task.excludeGlobs)) {
      continue;
    }
    keptUris.push(uri);
  }

  const result: WorkerPostFilterResult = { type: 'postfilter', keptUris, ms: Date.now() - t0 };
  parentPort?.postMessage(result);
} else if (task.type === 'serialize') {
  const handle = fs.openSync(task.outputPath, 'w');
  let bytesWritten = 0;
  try {
    const BATCH = 500;
    for (let i = 0; i < task.files.length; i += BATCH) {
      const end = Math.min(i + BATCH, task.files.length);
      const chunk: string[] = [];
      for (let j = i; j < end; j += 1) {
        chunk.push(JSON.stringify(task.files[j]));
      }
      const data = chunk.join('\n') + '\n';
      const buf = Buffer.from(data, 'utf8');
      fs.writeSync(handle, buf, 0, buf.length);
      bytesWritten += buf.length;
    }
  } finally {
    fs.closeSync(handle);
  }

  const result: WorkerSerializeResult = { type: 'serialize', bytesWritten, ms: Date.now() - t0 };
  parentPort?.postMessage(result);
} else if (task.type === 'savetext') {
  // Clean shards dir
  try { fs.rmSync(task.shardsDir, { recursive: true, force: true }); } catch { /* ignore */ }
  fs.mkdirSync(task.shardsDir, { recursive: true });

  const handles = new Map<number, number>();
  let textLineCount = 0;

  try {
    for (const file of task.files) {
      if (file.textLines.length === 0) {
        continue;
      }
      const shard = Math.abs(hashString(file.relativePath)) % task.shardCount;
      let fd = handles.get(shard);
      if (fd === undefined) {
        const shardPath = path.join(task.shardsDir, `${String(shard).padStart(2, '0')}.jsonl`);
        fd = fs.openSync(shardPath, 'a');
        handles.set(shard, fd);
      }
      const lines = file.textLines
        .map((line) => JSON.stringify({
          workspaceFolder: file.workspaceFolder,
          relativePath: file.relativePath,
          line: line.line,
          text: line.text
        } satisfies TextShardEntry))
        .join('\n');
      const buf = Buffer.from(lines + '\n', 'utf8');
      fs.writeSync(fd, buf, 0, buf.length);
      textLineCount += file.textLines.length;
    }
  } finally {
    for (const fd of handles.values()) {
      fs.closeSync(fd);
    }
  }

  const result: WorkerSaveTextResult = { type: 'savetext', textLineCount, ms: Date.now() - t0 };
  parentPort?.postMessage(result);
} else if (task.type === 'loadindex') {
  const loadResult = loadIndexTask(task.metaPath, task.filesPath);
  const result: WorkerLoadIndexResult = { type: 'loadindex', index: loadResult, ms: Date.now() - t0 };
  parentPort?.postMessage(result);
}

function loadIndexTask(metaPath: string, filesPath: string): { version: number; createdAt: string; workspaceFolders: string[]; files: CodeMapFile[] } | undefined {
  let metaRaw: string;
  try {
    metaRaw = fs.readFileSync(metaPath, 'utf8');
  } catch {
    return undefined;
  }

  const meta = JSON.parse(metaRaw);
  if (meta.version !== 1 || meta.storage !== 'jsonl') {
    return undefined;
  }

  const files: CodeMapFile[] = [];
  const content = fs.readFileSync(filesPath, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as CodeMapFile;
      files.push({ ...parsed, textLines: [] });
    } catch { /* skip */ }
  }

  return {
    version: 1,
    createdAt: meta.createdAt,
    workspaceFolders: meta.workspaceFolders,
    files
  };
}

function hashString(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  }
  return hash;
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

function normalizeSeparators(value: string): string {
  return value.toLowerCase().replace(/[\s._/-]+/g, '-').replace(/^-+|-+$/g, '');
}

function stripExtension(value: string): string {
  const parsed = path.parse(value);
  return parsed.name;
}

function trimPreview(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 96) {
    return trimmed;
  }
  return `${trimmed.slice(0, 93)}...`;
}
