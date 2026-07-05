export type CodeMapResultKind = 'class' | 'function' | 'interface' | 'type' | 'file' | 'text';

export interface CodeMapLocation {
  workspaceFolder: string;
  relativePath: string;
  line: number;
  character: number;
}

export interface CodeMapSymbol {
  kind: Exclude<CodeMapResultKind, 'file' | 'text'>;
  name: string;
  containerName?: string;
  location: CodeMapLocation;
  signature?: string;
}

export interface CodeMapTextLine {
  text: string;
  line: number;
}

export interface CodeMapFile {
  workspaceFolder: string;
  relativePath: string;
  absolutePath: string;
  language: string;
  size: number;
  mtimeMs: number;
  symbols: CodeMapSymbol[];
  textLines: CodeMapTextLine[];
}

export interface CodeMapIndex {
  version: 1;
  createdAt: string;
  workspaceFolders: string[];
  files: CodeMapFile[];
}

export interface CodeMapIndexMeta {
  version: 1;
  storage: 'jsonl';
  createdAt: string;
  workspaceFolders: string[];
  fileCount: number;
  symbolCount: number;
}

export interface CodeMapIndexSummary {
  createdAt: string;
  workspaceFolders: string[];
  fileCount: number;
  symbolCount: number;
  languageCounts: Record<string, number>;
  storagePath?: string;
}

export interface CodeMapSyncResult {
  index: CodeMapIndex;
  scannedFiles: number;
  addedFiles: number;
  updatedFiles: number;
  removedFiles: number;
}

export interface SearchResult {
  kind: CodeMapResultKind;
  label: string;
  description: string;
  detail?: string;
  score: number;
  location: CodeMapLocation;
  preview?: string;
}
