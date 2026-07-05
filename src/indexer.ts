import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  CodeMapFile,
  CodeMapIndex,
  CodeMapIndexMeta,
  CodeMapIndexSummary,
  CodeMapSymbol,
  CodeMapTextLine
} from './types';

const INDEX_VERSION = 1;
const DEFAULT_TEXT_LINE_LIMIT = 2000;

export interface BuildIndexProgress {
  processed: number;
  total: number;
  currentFile?: string;
}

export class CodeMapIndexer {
  private index: CodeMapIndex | undefined;
  private readonly output: vscode.OutputChannel;

  constructor(output: vscode.OutputChannel) {
    this.output = output;
  }

  async getIndex(): Promise<CodeMapIndex | undefined> {
    if (this.index) {
      return this.index;
    }

    this.index = await this.loadIndex();
    return this.index;
  }

  async buildIndex(onProgress?: (progress: BuildIndexProgress) => void): Promise<CodeMapIndex> {
    const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
    if (workspaceFolders.length === 0) {
      throw new Error('Open a workspace folder before building a CodeMap index.');
    }

    const config = vscode.workspace.getConfiguration('codemap');
    const includeGlobs = config.get<string[]>('includeGlobs', ['**/*.{ts,tsx,js,jsx,mjs,cjs,py}']);
    const excludeGlobs = [
      ...config.get<string[]>('excludeGlobs', []),
      ...await readCodemapIgnoreGlobs(workspaceFolders)
    ];
    const maxFileSizeBytes = config.get<number>('maxFileSizeBytes', 1024 * 1024);

    const startedAt = Date.now();
    this.output.appendLine(`[CodeMap] Building index for ${workspaceFolders.length} workspace folder(s).`);

    const uris: vscode.Uri[] = [];
    const excludePattern = excludeGlobs.length > 0 ? `{${excludeGlobs.join(',')}}` : undefined;
    for (const includeGlob of includeGlobs) {
      const found = await vscode.workspace.findFiles(includeGlob, excludePattern);
      uris.push(...found);
    }

    const uniqueUris = dedupeUris(uris);
    const files: CodeMapFile[] = [];
    for (let index = 0; index < uniqueUris.length; index += 1) {
      const uri = uniqueUris[index];
      onProgress?.({
        processed: index,
        total: uniqueUris.length,
        currentFile: getWorkspaceLocation(uri)?.relativePath
      });

      const indexedFile = await this.indexFile(uri, maxFileSizeBytes);
      if (indexedFile) {
        files.push(indexedFile);
      }
    }

    onProgress?.({
      processed: uniqueUris.length,
      total: uniqueUris.length
    });

    const index: CodeMapIndex = {
      version: INDEX_VERSION,
      createdAt: new Date().toISOString(),
      workspaceFolders: workspaceFolders.map((folder) => folder.uri.fsPath),
      files: dedupeFiles(files)
    };

    await this.saveIndex(index);
    this.index = index;

    const durationMs = Date.now() - startedAt;
    const symbolCount = index.files.reduce((count, file) => count + file.symbols.length, 0);
    this.output.appendLine(`[CodeMap] Indexed ${index.files.length} files and ${symbolCount} symbols in ${durationMs}ms.`);
    return index;
  }

  async updateFile(uri: vscode.Uri): Promise<void> {
    const current = await this.getIndex();
    if (!current || uri.scheme !== 'file') {
      return;
    }

    const config = vscode.workspace.getConfiguration('codemap');
    const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
    const excludeGlobs = [
      ...config.get<string[]>('excludeGlobs', []),
      ...await readCodemapIgnoreGlobs(workspaceFolders)
    ];
    const maxFileSizeBytes = config.get<number>('maxFileSizeBytes', 1024 * 1024);
    const location = getWorkspaceLocation(uri);
    if (!location) {
      return;
    }
    const indexedFile = isRelativePathIgnored(location.relativePath, excludeGlobs)
      ? undefined
      : await this.indexFile(uri, maxFileSizeBytes);

    current.files = current.files.filter((file) => {
      return file.workspaceFolder !== location.workspaceFolder || file.relativePath !== location.relativePath;
    });

    if (indexedFile) {
      current.files.push(indexedFile);
    }

    current.createdAt = new Date().toISOString();
    await this.saveIndex(current);
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

  async clearIndex(): Promise<void> {
    const paths = getIndexPaths();
    this.index = undefined;
    if (!paths) {
      return;
    }

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
    await this.saveIndex(current);
  }

  private async indexFile(uri: vscode.Uri, maxFileSizeBytes: number): Promise<CodeMapFile | undefined> {
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
    const textLines = extractTextLines(content);
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

  private async loadIndex(): Promise<CodeMapIndex | undefined> {
    const paths = getIndexPaths();
    if (!paths) {
      return undefined;
    }

    const splitIndex = await this.loadSplitIndex(paths);
    if (splitIndex) {
      return splitIndex;
    }

    return this.loadLegacyIndex(paths);
  }

  private async loadSplitIndex(paths: CodeMapIndexPaths): Promise<CodeMapIndex | undefined> {
    try {
      const [metaRaw, filesRaw] = await Promise.all([
        fs.readFile(paths.metaPath, 'utf8'),
        fs.readFile(paths.filesPath, 'utf8')
      ]);
      const meta = JSON.parse(metaRaw) as CodeMapIndexMeta;
      if (meta.version !== INDEX_VERSION || meta.storage !== 'jsonl') {
        return undefined;
      }

      const files = filesRaw
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line) as CodeMapFile);

      return {
        version: INDEX_VERSION,
        createdAt: meta.createdAt,
        workspaceFolders: meta.workspaceFolders,
        files
      };
    } catch {
      return undefined;
    }
  }

  private async loadLegacyIndex(paths: CodeMapIndexPaths): Promise<CodeMapIndex | undefined> {
    try {
      const raw = await fs.readFile(paths.legacyIndexPath, 'utf8');
      const parsed = JSON.parse(raw) as CodeMapIndex;
      if (parsed.version !== INDEX_VERSION) {
        return undefined;
      }
      return parsed;
    } catch {
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
    const filesJsonl = index.files.map((file) => JSON.stringify(file)).join('\n');

    await fs.mkdir(paths.indexDir, { recursive: true });
    await Promise.all([
      fs.writeFile(paths.metaPath, JSON.stringify(meta, null, 2), 'utf8'),
      fs.writeFile(paths.filesPath, filesJsonl.length > 0 ? `${filesJsonl}\n` : '', 'utf8')
    ]);
  }
}

interface CodeMapIndexPaths {
  indexDir: string;
  metaPath: string;
  filesPath: string;
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

function getLanguageFromPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.ts':
      return 'typescript';
    case '.tsx':
      return 'typescriptreact';
    case '.js':
    case '.mjs':
    case '.cjs':
      return 'javascript';
    case '.jsx':
      return 'javascriptreact';
    case '.py':
      return 'python';
    default:
      return 'plaintext';
  }
}

function extractTextLines(content: string): CodeMapTextLine[] {
  return content
    .split(/\r?\n/)
    .slice(0, DEFAULT_TEXT_LINE_LIMIT)
    .map((text, index) => ({ text: text.trim(), line: index }))
    .filter((line) => line.text.length > 0 && line.text.length <= 500);
}

function extractSymbols(
  content: string,
  workspaceFolder: string,
  relativePath: string,
  language: string
): CodeMapSymbol[] {
  const symbols: CodeMapSymbol[] = [];
  const lines = content.split(/\r?\n/);

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    const trimmed = line.trim();
    const character = line.search(/\S|$/);

    const declarations = language === 'python' ? [
      {
        kind: 'class' as const,
        match: trimmed.match(/^class\s+([A-Za-z_][\w]*)\s*(?:\(|:)/)
      },
      {
        kind: 'function' as const,
        match: trimmed.match(/^(?:async\s+)?def\s+([A-Za-z_][\w]*)\s*\(/)
      }
    ] : [
      {
        kind: 'class' as const,
        match: trimmed.match(/^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/)
      },
      {
        kind: 'interface' as const,
        match: trimmed.match(/^(?:export\s+)?(?:default\s+)?interface\s+([A-Za-z_$][\w$]*)/)
      },
      {
        kind: 'type' as const,
        match: trimmed.match(/^(?:export\s+)?type\s+([A-Za-z_$][\w$]*)/)
      },
      {
        kind: 'function' as const,
        match: trimmed.match(/^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/)
      },
      {
        kind: 'function' as const,
        match: trimmed.match(/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/)
      }
    ];

    for (const declaration of declarations) {
      if (!declaration.match) {
        continue;
      }

      symbols.push({
        kind: declaration.kind,
        name: declaration.match[1],
        location: {
          workspaceFolder,
          relativePath,
          line: lineIndex,
          character
        },
        signature: trimmed.slice(0, 240)
      });
      break;
    }
  }

  return symbols;
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
  return globs.some((glob) => globMatchesRelativePath(glob, relativePath));
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

function countLanguages(files: CodeMapFile[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const file of files) {
    counts[file.language] = (counts[file.language] ?? 0) + 1;
  }
  return counts;
}
