import * as fs from 'fs/promises';
import * as path from 'path';
import { CodeMapFile, CodeMapIndex, CodeMapIndexMeta, CodeMapIndexSummary, CodeMapSymbol, CodeMapTextLine } from './types';

export const CLI_INDEX_VERSION = 1;
export const CLI_DEFAULT_INCLUDE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.lua', '.java', '.kt', '.kts', '.go', '.rs', '.cs',
  '.cpp', '.cxx', '.cc', '.c', '.h', '.hpp',
  '.php', '.rb', '.swift', '.dart', '.vue', '.svelte',
  '.sh', '.bash', '.zsh', '.ps1'
]);

const DEFAULT_TEXT_LINE_LIMIT = 2000;
const DEFAULT_MAX_FILE_SIZE_BYTES = 1024 * 1024;
const DEFAULT_EXCLUDED_DIRS = new Set([
  '.git', '.codemap', 'node_modules', 'dist', 'build', 'coverage',
  '.next', '.turbo', '.cache', '.venv', 'venv', '__pycache__',
  '.pytest_cache', '.mypy_cache', '.ruff_cache', 'assets', 'resources',
  'static', 'images', 'textures', 'audio', 'video', 'logs', 'tmp',
  'temp', 'vendor', 'generated'
]);

export interface CliIndexOptions {
  root: string;
  maxFileSizeBytes?: number;
}

export interface CliSyncResult {
  index: CodeMapIndex;
  scannedFiles: number;
  addedFiles: number;
  updatedFiles: number;
  removedFiles: number;
}

export async function buildCliIndex(options: CliIndexOptions): Promise<CodeMapIndex> {
  const root = path.resolve(options.root);
  const maxFileSizeBytes = options.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE_BYTES;
  const ignoreRules = await readCodemapIgnore(root);
  const files = await collectCodeFiles(root, ignoreRules);
  const indexedFiles: CodeMapFile[] = [];

  for (const filePath of files) {
    const indexed = await indexCliFile(root, filePath, maxFileSizeBytes);
    if (indexed) {
      indexedFiles.push(indexed);
    }
  }

  const index: CodeMapIndex = {
    version: CLI_INDEX_VERSION,
    createdAt: new Date().toISOString(),
    workspaceFolders: [root],
    files: indexedFiles
  };
  await saveCliIndex(root, index);
  return index;
}

export async function syncCliIndex(options: CliIndexOptions): Promise<CliSyncResult> {
  const root = path.resolve(options.root);
  const current = await loadCliIndex(root);
  if (!current) {
    const index = await buildCliIndex(options);
    return {
      index,
      scannedFiles: index.files.length,
      addedFiles: index.files.length,
      updatedFiles: 0,
      removedFiles: 0
    };
  }

  const maxFileSizeBytes = options.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE_BYTES;
  const ignoreRules = await readCodemapIgnore(root);
  const files = await collectCodeFiles(root, ignoreRules);
  const existingByPath = new Map(current.files.map((file) => [file.relativePath, file]));
  const seen = new Set<string>();
  const nextFiles: CodeMapFile[] = [];
  let addedFiles = 0;
  let updatedFiles = 0;

  for (const filePath of files) {
    const relativePath = toRelativePath(root, filePath);
    seen.add(relativePath);
    const stat = await fs.stat(filePath);
    const existing = existingByPath.get(relativePath);

    if (existing && existing.size === stat.size && existing.mtimeMs === stat.mtimeMs) {
      nextFiles.push(existing);
      continue;
    }

    const indexed = await indexCliFile(root, filePath, maxFileSizeBytes);
    if (!indexed) {
      continue;
    }

    nextFiles.push(indexed);
    if (existing) {
      updatedFiles += 1;
    } else {
      addedFiles += 1;
    }
  }

  const removedFiles = current.files.filter((file) => !seen.has(file.relativePath)).length;
  current.files = nextFiles;
  current.createdAt = new Date().toISOString();
  await saveCliIndex(root, current);

  return {
    index: current,
    scannedFiles: files.length,
    addedFiles,
    updatedFiles,
    removedFiles
  };
}

export async function loadCliIndex(root: string): Promise<CodeMapIndex | undefined> {
  const paths = getCliIndexPaths(path.resolve(root));
  try {
    const [metaRaw, filesRaw] = await Promise.all([
      fs.readFile(paths.metaPath, 'utf8'),
      fs.readFile(paths.filesPath, 'utf8')
    ]);
    const meta = JSON.parse(metaRaw) as CodeMapIndexMeta;
    if (meta.version !== CLI_INDEX_VERSION || meta.storage !== 'jsonl') {
      return undefined;
    }

    return {
      version: CLI_INDEX_VERSION,
      createdAt: meta.createdAt,
      workspaceFolders: meta.workspaceFolders,
      files: filesRaw
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line) as CodeMapFile)
    };
  } catch {
    return undefined;
  }
}

export function summarizeIndex(root: string, index: CodeMapIndex): CodeMapIndexSummary {
  const languageCounts: Record<string, number> = {};
  for (const file of index.files) {
    languageCounts[file.language] = (languageCounts[file.language] ?? 0) + 1;
  }

  return {
    createdAt: index.createdAt,
    workspaceFolders: index.workspaceFolders,
    fileCount: index.files.length,
    symbolCount: index.files.reduce((count, file) => count + file.symbols.length, 0),
    languageCounts,
    storagePath: getCliIndexPaths(path.resolve(root)).indexDir
  };
}

async function saveCliIndex(root: string, index: CodeMapIndex): Promise<void> {
  const paths = getCliIndexPaths(root);
  const meta: CodeMapIndexMeta = {
    version: CLI_INDEX_VERSION,
    storage: 'jsonl',
    createdAt: index.createdAt,
    workspaceFolders: index.workspaceFolders,
    fileCount: index.files.length,
    symbolCount: index.files.reduce((count, file) => count + file.symbols.length, 0)
  };
  const filesJsonl = index.files.map((file) => JSON.stringify(file)).join('\n');
  await fs.mkdir(paths.indexDir, { recursive: true });
  await Promise.all([
    fs.writeFile(paths.metaPath, JSON.stringify(meta, null, 2), 'utf8'),
    fs.writeFile(paths.filesPath, filesJsonl ? `${filesJsonl}\n` : '', 'utf8')
  ]);
}

async function collectCodeFiles(root: string, ignoreRules: string[]): Promise<string[]> {
  const files: string[] = [];
  await walk(root, root, ignoreRules, files);
  return files;
}

async function walk(root: string, currentDir: string, ignoreRules: string[], files: string[]): Promise<void> {
  const entries = await fs.readdir(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(currentDir, entry.name);
    const relativePath = toRelativePath(root, fullPath);
    if (isIgnored(relativePath, entry, ignoreRules)) {
      continue;
    }

    if (entry.isDirectory()) {
      await walk(root, fullPath, ignoreRules, files);
      continue;
    }

    if (entry.isFile() && CLI_DEFAULT_INCLUDE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      files.push(fullPath);
    }
  }
}

async function indexCliFile(root: string, filePath: string, maxFileSizeBytes: number): Promise<CodeMapFile | undefined> {
  const stat = await fs.stat(filePath);
  if (stat.size > maxFileSizeBytes) {
    return undefined;
  }

  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf8');
  } catch {
    return undefined;
  }

  const relativePath = toRelativePath(root, filePath);
  const language = getLanguageFromPath(filePath);
  return {
    workspaceFolder: root,
    relativePath,
    absolutePath: filePath,
    language,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    symbols: extractCliSymbols(content, root, relativePath, language),
    textLines: extractTextLines(content)
  };
}

function extractTextLines(content: string): CodeMapTextLine[] {
  return content
    .split(/\r?\n/)
    .slice(0, DEFAULT_TEXT_LINE_LIMIT)
    .map((text, index) => ({ text: text.trim(), line: index }))
    .filter((line) => line.text.length > 0 && line.text.length <= 500);
}

function extractCliSymbols(content: string, workspaceFolder: string, relativePath: string, language: string): CodeMapSymbol[] {
  const symbols: CodeMapSymbol[] = [];
  const lines = content.split(/\r?\n/);

  for (let line = 0; line < lines.length; line += 1) {
    const rawLine = lines[line];
    const trimmed = rawLine.trim();
    const character = rawLine.search(/\S|$/);
    const declarations = getDeclarations(trimmed, language);
    for (const declaration of declarations) {
      if (!declaration.match) {
        continue;
      }

      symbols.push({
        kind: declaration.kind,
        name: declaration.match[1],
        location: { workspaceFolder, relativePath, line, character },
        signature: trimmed.slice(0, 240)
      });
      break;
    }
  }

  return symbols;
}

type Declaration = { kind: CodeMapSymbol['kind']; match: RegExpMatchArray | null };

function getDeclarations(trimmed: string, language: string): Declaration[] {
  if (!trimmed || isLikelyComment(trimmed)) {
    return [];
  }

  if (language === 'python') {
    return [
      { kind: 'class', match: trimmed.match(/^class\s+([A-Za-z_][\w]*)\s*(?:\(|:)/) },
      { kind: 'function', match: trimmed.match(/^(?:async\s+)?def\s+([A-Za-z_][\w]*)\s*\(/) }
    ];
  }

  if (language === 'lua') {
    return [
      { kind: 'function', match: trimmed.match(/^(?:local\s+)?function\s+([A-Za-z_][\w.:-]*)\s*\(/) },
      { kind: 'function', match: trimmed.match(/^([A-Za-z_][\w.:-]*)\s*=\s*function\s*\(/) },
      { kind: 'class', match: trimmed.match(/^local\s+([A-Za-z_][\w]*)\s*=\s*\{\s*\}/) }
    ];
  }

  if (language === 'go') {
    return [
      { kind: 'class', match: trimmed.match(/^type\s+([A-Za-z_][\w]*)\s+struct\b/) },
      { kind: 'interface', match: trimmed.match(/^type\s+([A-Za-z_][\w]*)\s+interface\b/) },
      { kind: 'type', match: trimmed.match(/^type\s+([A-Za-z_][\w]*)\s+/) },
      { kind: 'function', match: trimmed.match(/^func\s+(?:\([^)]*\)\s*)?([A-Za-z_][\w]*)\s*\(/) }
    ];
  }

  return [
    { kind: 'class', match: trimmed.match(/^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/) },
    { kind: 'interface', match: trimmed.match(/^(?:export\s+)?(?:default\s+)?interface\s+([A-Za-z_$][\w$]*)/) },
    { kind: 'type', match: trimmed.match(/^(?:export\s+)?type\s+([A-Za-z_$][\w$]*)/) },
    { kind: 'function', match: trimmed.match(/^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/) },
    { kind: 'function', match: trimmed.match(/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/) }
  ];
}

function getLanguageFromPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (['.ts', '.tsx'].includes(ext)) return 'typescript';
  if (['.js', '.jsx', '.mjs', '.cjs'].includes(ext)) return 'javascript';
  if (ext === '.py') return 'python';
  if (ext === '.lua') return 'lua';
  if (ext === '.go') return 'go';
  if (ext === '.rs') return 'rust';
  if (['.c', '.cc', '.cpp', '.cxx', '.h', '.hpp'].includes(ext)) return 'cpp';
  return ext.replace('.', '') || 'plaintext';
}

async function readCodemapIgnore(root: string): Promise<string[]> {
  try {
    const raw = await fs.readFile(path.join(root, '.codemapignore'), 'utf8');
    return raw
      .split(/\r?\n/)
      .map((line) => line.split('#')[0]?.trim())
      .filter((line): line is string => Boolean(line) && !line.startsWith('!'));
  } catch {
    return [];
  }
}

function isIgnored(relativePath: string, entry: { name: string; isDirectory(): boolean }, ignoreRules: string[]): boolean {
  if (entry.isDirectory() && DEFAULT_EXCLUDED_DIRS.has(entry.name)) {
    return true;
  }

  const normalized = relativePath.replace(/\\/g, '/');
  return ignoreRules.some((rule) => {
    const pattern = rule.replace(/\\/g, '/').replace(/^\/+/, '');
    if (!pattern) return false;
    if (pattern.endsWith('/')) {
      return normalized === pattern.slice(0, -1) || normalized.startsWith(pattern);
    }
    return normalized === pattern || normalized.startsWith(`${pattern}/`) || path.basename(normalized) === pattern;
  });
}

function isLikelyComment(trimmed: string): boolean {
  return trimmed.startsWith('//')
    || trimmed.startsWith('#')
    || trimmed.startsWith('*')
    || trimmed.startsWith('/*')
    || trimmed.startsWith('--')
    || trimmed.startsWith('<!--');
}

function getCliIndexPaths(root: string): { indexDir: string; metaPath: string; filesPath: string } {
  const indexDir = path.join(root, '.codemap');
  return {
    indexDir,
    metaPath: path.join(indexDir, 'meta.json'),
    filesPath: path.join(indexDir, 'files.jsonl')
  };
}

function toRelativePath(root: string, fullPath: string): string {
  return path.relative(root, fullPath).replace(/\\/g, '/');
}
