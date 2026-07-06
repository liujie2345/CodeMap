import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  CodeMapFile,
  CodeMapIndex,
  CodeMapIndexMeta,
  CodeMapIndexSummary,
  CodeMapSyncResult,
  CodeMapSymbol,
  CodeMapTextLine
} from './types';

const INDEX_VERSION = 1;
const DEFAULT_TEXT_LINE_LIMIT = 200;
const DEFAULT_TOTAL_TEXT_LINE_LIMIT = 200000;
export const DEFAULT_INCLUDE_GLOB = '**/*.{ts,tsx,js,jsx,mjs,cjs,py,lua,java,kt,kts,go,rs,cs,cpp,cxx,cc,c,h,hpp,php,rb,swift,dart,vue,svelte,sh,bash,zsh,ps1}';

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
    const includeGlobs = config.get<string[]>('includeGlobs', [DEFAULT_INCLUDE_GLOB]);
    const excludeGlobs = await getEffectiveExcludeGlobs(workspaceFolders);
    const maxFileSizeBytes = config.get<number>('maxFileSizeBytes', 1024 * 1024);
    const indexTextLines = config.get<boolean>('indexTextLines', true);
    const maxTextLinesPerFile = indexTextLines ? config.get<number>('maxTextLinesPerFile', DEFAULT_TEXT_LINE_LIMIT) : 0;
    let remainingTextLines = indexTextLines ? config.get<number>('maxTotalTextLines', DEFAULT_TOTAL_TEXT_LINE_LIMIT) : 0;

    const startedAt = Date.now();
    this.output.appendLine(`[CodeMap] Building index for ${workspaceFolders.length} workspace folder(s).`);

    const uniqueUris = await collectIndexableUris(includeGlobs, excludeGlobs);
    const files: CodeMapFile[] = [];
    for (let index = 0; index < uniqueUris.length; index += 1) {
      const uri = uniqueUris[index];
      onProgress?.({
        processed: index,
        total: uniqueUris.length,
        currentFile: getWorkspaceLocation(uri)?.relativePath
      });

      const textLineLimit = Math.min(maxTextLinesPerFile, remainingTextLines);
      const indexedFile = await this.indexFile(uri, maxFileSizeBytes, textLineLimit);
      if (indexedFile) {
        files.push(indexedFile);
        remainingTextLines = Math.max(0, remainingTextLines - indexedFile.textLines.length);
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
    const excludeGlobs = await getEffectiveExcludeGlobs(workspaceFolders);
    const maxFileSizeBytes = config.get<number>('maxFileSizeBytes', 1024 * 1024);
    const indexTextLines = config.get<boolean>('indexTextLines', true);
    const textLineLimit = indexTextLines ? config.get<number>('maxTextLinesPerFile', DEFAULT_TEXT_LINE_LIMIT) : 0;
    const location = getWorkspaceLocation(uri);
    if (!location) {
      return;
    }
    const indexedFile = isRelativePathIgnored(location.relativePath, excludeGlobs)
      ? undefined
      : await this.indexFile(uri, maxFileSizeBytes, textLineLimit);

    current.files = current.files.filter((file) => {
      return file.workspaceFolder !== location.workspaceFolder || file.relativePath !== location.relativePath;
    });

    if (indexedFile) {
      current.files.push(indexedFile);
    }

    current.createdAt = new Date().toISOString();
    await this.saveIndex(current);
  }

  async syncIndex(onProgress?: (progress: BuildIndexProgress) => void): Promise<CodeMapSyncResult> {
    const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
    if (workspaceFolders.length === 0) {
      throw new Error('Open a workspace folder before syncing a CodeMap index.');
    }

    const current = await this.getIndex();
    if (!current) {
      const index = await this.buildIndex(onProgress);
      return {
        index,
        scannedFiles: index.files.length,
        addedFiles: index.files.length,
        updatedFiles: 0,
        removedFiles: 0
      };
    }

    const config = vscode.workspace.getConfiguration('codemap');
    const includeGlobs = config.get<string[]>('includeGlobs', [DEFAULT_INCLUDE_GLOB]);
    const excludeGlobs = await getEffectiveExcludeGlobs(workspaceFolders);
    const maxFileSizeBytes = config.get<number>('maxFileSizeBytes', 1024 * 1024);
    const indexTextLines = config.get<boolean>('indexTextLines', true);
    const maxTextLinesPerFile = indexTextLines ? config.get<number>('maxTextLinesPerFile', DEFAULT_TEXT_LINE_LIMIT) : 0;
    let remainingTextLines = indexTextLines ? config.get<number>('maxTotalTextLines', DEFAULT_TOTAL_TEXT_LINE_LIMIT) : 0;
    const uniqueUris = await collectIndexableUris(includeGlobs, excludeGlobs);
    const existingByKey = new Map(current.files.map((file) => [fileKey(file.workspaceFolder, file.relativePath), file]));
    const nextFiles: CodeMapFile[] = [];
    const seenKeys = new Set<string>();
    let addedFiles = 0;
    let updatedFiles = 0;

    for (let index = 0; index < uniqueUris.length; index += 1) {
      const uri = uniqueUris[index];
      const location = getWorkspaceLocation(uri);
      if (!location) {
        continue;
      }

      onProgress?.({
        processed: index,
        total: uniqueUris.length,
        currentFile: location.relativePath
      });

      const key = fileKey(location.workspaceFolder, location.relativePath);
      seenKeys.add(key);
      const existing = existingByKey.get(key);
      const stat = await fs.stat(uri.fsPath);
      if (stat.size > maxFileSizeBytes) {
        continue;
      }

      if (existing && existing.size === stat.size && existing.mtimeMs === stat.mtimeMs) {
        const preserved = {
          ...existing,
          textLines: existing.textLines.slice(0, Math.min(maxTextLinesPerFile, remainingTextLines))
        };
        nextFiles.push(preserved);
        remainingTextLines = Math.max(0, remainingTextLines - preserved.textLines.length);
        continue;
      }

      const textLineLimit = Math.min(maxTextLinesPerFile, remainingTextLines);
      const indexedFile = await this.indexFile(uri, maxFileSizeBytes, textLineLimit);
      if (!indexedFile) {
        continue;
      }

      nextFiles.push(indexedFile);
      remainingTextLines = Math.max(0, remainingTextLines - indexedFile.textLines.length);
      if (existing) {
        updatedFiles += 1;
      } else {
        addedFiles += 1;
      }
    }

    const removedFiles = current.files.filter((file) => !seenKeys.has(fileKey(file.workspaceFolder, file.relativePath))).length;
    current.files = dedupeFiles(nextFiles);
    current.createdAt = new Date().toISOString();
    await this.saveIndex(current);
    this.index = current;

    onProgress?.({
      processed: uniqueUris.length,
      total: uniqueUris.length
    });

    this.output.appendLine(
      `[CodeMap] Synced ${uniqueUris.length} files: +${addedFiles}, ~${updatedFiles}, -${removedFiles}.`
    );

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

async function getEffectiveExcludeGlobs(workspaceFolders: readonly vscode.WorkspaceFolder[]): Promise<string[]> {
  const config = vscode.workspace.getConfiguration('codemap');
  return [
    ...config.get<string[]>('excludeGlobs', []),
    ...await readCodemapIgnoreGlobs(workspaceFolders)
  ];
}

async function collectIndexableUris(includeGlobs: string[], excludeGlobs: string[]): Promise<vscode.Uri[]> {
  const uris: vscode.Uri[] = [];
  const excludePattern = excludeGlobs.length > 0 ? `{${excludeGlobs.join(',')}}` : undefined;
  for (const includeGlob of includeGlobs) {
    const found = await vscode.workspace.findFiles(includeGlob, excludePattern);
    uris.push(...found);
  }

  return dedupeUris(uris);
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
    case '.lua':
      return 'lua';
    case '.java':
      return 'java';
    case '.kt':
    case '.kts':
      return 'kotlin';
    case '.go':
      return 'go';
    case '.rs':
      return 'rust';
    case '.cs':
      return 'csharp';
    case '.cpp':
    case '.cxx':
    case '.cc':
    case '.c':
    case '.hpp':
    case '.h':
      return 'cpp';
    case '.php':
      return 'php';
    case '.rb':
      return 'ruby';
    case '.swift':
      return 'swift';
    case '.dart':
      return 'dart';
    case '.vue':
      return 'vue';
    case '.svelte':
      return 'svelte';
    case '.sh':
    case '.bash':
    case '.zsh':
      return 'shell';
    case '.ps1':
      return 'powershell';
    default:
      return 'plaintext';
  }
}

function extractTextLines(content: string, limit: number): CodeMapTextLine[] {
  if (limit <= 0) {
    return [];
  }

  return content
    .split(/\r?\n/)
    .slice(0, limit)
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

    const declarations = getSymbolDeclarations(trimmed, language);

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

type SymbolDeclaration = {
  kind: CodeMapSymbol['kind'];
  match: RegExpMatchArray | null;
};

function getSymbolDeclarations(trimmed: string, language: string): SymbolDeclaration[] {
  if (!trimmed || isLikelyComment(trimmed)) {
    return [];
  }

  switch (language) {
    case 'python':
      return [
        { kind: 'class', match: trimmed.match(/^class\s+([A-Za-z_][\w]*)\s*(?:\(|:)/) },
        { kind: 'function', match: trimmed.match(/^(?:async\s+)?def\s+([A-Za-z_][\w]*)\s*\(/) }
      ];
    case 'lua':
      return [
        { kind: 'function', match: trimmed.match(/^(?:local\s+)?function\s+([A-Za-z_][\w.:-]*)\s*\(/) },
        { kind: 'function', match: trimmed.match(/^([A-Za-z_][\w.:-]*)\s*=\s*function\s*\(/) },
        { kind: 'class', match: trimmed.match(/^local\s+([A-Za-z_][\w]*)\s*=\s*\{\s*\}/) }
      ];
    case 'java':
      return [
        { kind: 'class', match: trimmed.match(/^(?:public\s+|private\s+|protected\s+|abstract\s+|final\s+|static\s+)*class\s+([A-Za-z_$][\w$]*)/) },
        { kind: 'interface', match: trimmed.match(/^(?:public\s+|private\s+|protected\s+|abstract\s+|static\s+)*interface\s+([A-Za-z_$][\w$]*)/) },
        { kind: 'type', match: trimmed.match(/^(?:public\s+|private\s+|protected\s+|static\s+)*enum\s+([A-Za-z_$][\w$]*)/) },
        { kind: 'function', match: trimmed.match(/^(?:public\s+|private\s+|protected\s+|static\s+|final\s+|synchronized\s+|abstract\s+|native\s+)*[\w<>\[\], ?]+\s+([A-Za-z_$][\w$]*)\s*\([^;]*\)\s*(?:\{|throws\s+)/) }
      ];
    case 'kotlin':
      return [
        { kind: 'class', match: trimmed.match(/^(?:data\s+|sealed\s+|open\s+|abstract\s+|private\s+|public\s+|internal\s+)*class\s+([A-Za-z_][\w]*)/) },
        { kind: 'interface', match: trimmed.match(/^(?:private\s+|public\s+|internal\s+)*interface\s+([A-Za-z_][\w]*)/) },
        { kind: 'type', match: trimmed.match(/^(?:enum\s+class|object)\s+([A-Za-z_][\w]*)/) },
        { kind: 'function', match: trimmed.match(/^(?:private\s+|public\s+|internal\s+|suspend\s+|inline\s+|override\s+|open\s+)*fun\s+(?:[A-Za-z_][\w]*\.)?([A-Za-z_][\w]*)\s*\(/) }
      ];
    case 'go':
      return [
        { kind: 'class', match: trimmed.match(/^type\s+([A-Za-z_][\w]*)\s+struct\b/) },
        { kind: 'interface', match: trimmed.match(/^type\s+([A-Za-z_][\w]*)\s+interface\b/) },
        { kind: 'type', match: trimmed.match(/^type\s+([A-Za-z_][\w]*)\s+/) },
        { kind: 'function', match: trimmed.match(/^func\s+(?:\([^)]*\)\s*)?([A-Za-z_][\w]*)\s*\(/) }
      ];
    case 'rust':
      return [
        { kind: 'class', match: trimmed.match(/^(?:pub\s+)?struct\s+([A-Za-z_][\w]*)/) },
        { kind: 'interface', match: trimmed.match(/^(?:pub\s+)?trait\s+([A-Za-z_][\w]*)/) },
        { kind: 'type', match: trimmed.match(/^(?:pub\s+)?(?:enum|type)\s+([A-Za-z_][\w]*)/) },
        { kind: 'function', match: trimmed.match(/^(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_][\w]*)\s*(?:<[^>]+>)?\s*\(/) }
      ];
    case 'csharp':
      return [
        { kind: 'class', match: trimmed.match(/^(?:public\s+|private\s+|protected\s+|internal\s+|abstract\s+|sealed\s+|static\s+|partial\s+)*class\s+([A-Za-z_][\w]*)/) },
        { kind: 'interface', match: trimmed.match(/^(?:public\s+|private\s+|protected\s+|internal\s+|partial\s+)*interface\s+([A-Za-z_][\w]*)/) },
        { kind: 'type', match: trimmed.match(/^(?:public\s+|private\s+|protected\s+|internal\s+|readonly\s+|partial\s+)*(?:struct|enum|record)\s+([A-Za-z_][\w]*)/) },
        { kind: 'function', match: trimmed.match(/^(?:public\s+|private\s+|protected\s+|internal\s+|static\s+|virtual\s+|override\s+|async\s+|sealed\s+|partial\s+)*[\w<>\[\], ?]+\s+([A-Za-z_][\w]*)\s*\([^;]*\)\s*(?:\{|=>)/) }
      ];
    case 'cpp':
      return [
        { kind: 'class', match: trimmed.match(/^(?:template\s*<[^>]+>\s*)?(?:class|struct)\s+([A-Za-z_][\w]*)/) },
        { kind: 'type', match: trimmed.match(/^(?:typedef\s+.*\s+|using\s+)([A-Za-z_][\w]*)\s*(?:=|;)/) },
        { kind: 'function', match: trimmed.match(/^(?:template\s*<[^>]+>\s*)?(?:[\w:*&<>\[\],~]+\s+)+([A-Za-z_~][\w:~]*)\s*\([^;]*\)\s*(?:const\s*)?(?:\{|$)/) }
      ];
    case 'php':
      return [
        { kind: 'class', match: trimmed.match(/^(?:abstract\s+|final\s+)?class\s+([A-Za-z_][\w]*)/) },
        { kind: 'interface', match: trimmed.match(/^interface\s+([A-Za-z_][\w]*)/) },
        { kind: 'type', match: trimmed.match(/^trait\s+([A-Za-z_][\w]*)/) },
        { kind: 'function', match: trimmed.match(/^(?:public\s+|private\s+|protected\s+|static\s+|abstract\s+|final\s+)*function\s+([A-Za-z_][\w]*)\s*\(/) }
      ];
    case 'ruby':
      return [
        { kind: 'class', match: trimmed.match(/^class\s+([A-Za-z_][\w:]*)/) },
        { kind: 'type', match: trimmed.match(/^module\s+([A-Za-z_][\w:]*)/) },
        { kind: 'function', match: trimmed.match(/^def\s+(?:self\.)?([A-Za-z_][\w!?=]*)/) }
      ];
    case 'swift':
      return [
        { kind: 'class', match: trimmed.match(/^(?:public\s+|private\s+|internal\s+|open\s+|final\s+)*class\s+([A-Za-z_][\w]*)/) },
        { kind: 'interface', match: trimmed.match(/^(?:public\s+|private\s+|internal\s+|open\s+)*protocol\s+([A-Za-z_][\w]*)/) },
        { kind: 'type', match: trimmed.match(/^(?:public\s+|private\s+|internal\s+)*(?:struct|enum|typealias)\s+([A-Za-z_][\w]*)/) },
        { kind: 'function', match: trimmed.match(/^(?:public\s+|private\s+|internal\s+|open\s+|static\s+|class\s+|override\s+)*func\s+([A-Za-z_][\w]*)\s*\(/) }
      ];
    case 'dart':
      return [
        { kind: 'class', match: trimmed.match(/^(?:abstract\s+|base\s+|final\s+|sealed\s+)?class\s+([A-Za-z_][\w]*)/) },
        { kind: 'type', match: trimmed.match(/^(?:enum|mixin|typedef)\s+([A-Za-z_][\w]*)/) },
        { kind: 'function', match: trimmed.match(/^(?:static\s+)?(?:Future<[^>]+>|[\w<>?]+)?\s*([A-Za-z_][\w]*)\s*\([^;]*\)\s*(?:async\s*)?\{?/) }
      ];
    case 'shell':
      return [
        { kind: 'function', match: trimmed.match(/^(?:function\s+)?([A-Za-z_][\w-]*)\s*\(\)\s*\{?/) },
        { kind: 'function', match: trimmed.match(/^function\s+([A-Za-z_][\w-]*)\b/) }
      ];
    case 'powershell':
      return [
        { kind: 'function', match: trimmed.match(/^function\s+([A-Za-z_][\w-]*)\b/i) },
        { kind: 'class', match: trimmed.match(/^class\s+([A-Za-z_][\w]*)\b/i) }
      ];
    case 'vue':
    case 'svelte':
    case 'typescript':
    case 'typescriptreact':
    case 'javascript':
    case 'javascriptreact':
    default:
      return [
        { kind: 'class', match: trimmed.match(/^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/) },
        { kind: 'interface', match: trimmed.match(/^(?:export\s+)?(?:default\s+)?interface\s+([A-Za-z_$][\w$]*)/) },
        { kind: 'type', match: trimmed.match(/^(?:export\s+)?type\s+([A-Za-z_$][\w$]*)/) },
        { kind: 'function', match: trimmed.match(/^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/) },
        { kind: 'function', match: trimmed.match(/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/) }
      ];
  }
}

function isLikelyComment(trimmed: string): boolean {
  return trimmed.startsWith('//')
    || trimmed.startsWith('#')
    || trimmed.startsWith('*')
    || trimmed.startsWith('/*')
    || trimmed.startsWith('--')
    || trimmed.startsWith('<!--');
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
  return `${workspaceFolder}:${relativePath}`;
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
