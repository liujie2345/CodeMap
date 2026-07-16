import * as path from 'path';
import * as vscode from 'vscode';
import { CodeMapIndexer, DEFAULT_INCLUDE_GLOB } from './indexer';

const DEBOUNCE_MS = 800;
const BATCH_SYNC_THRESHOLD = 50;

interface PendingEntry {
  uri: vscode.Uri;
  action: 'up' | 'del';
}

const pending = new Map<string, PendingEntry>();
let timer: ReturnType<typeof setTimeout> | null = null;
let flushing = false;
let paused = false;

let indexer: CodeMapIndexer | undefined;
let output: vscode.OutputChannel | undefined;
let status: vscode.StatusBarItem | undefined;

const EXCLUDE_REGEX = /(^|\/|\\)(node_modules|\.git|\.codemap|dist|build|coverage|\.next|\.turbo|\.cache|\.venv|venv|__pycache__|\.pytest_cache|\.mypy_cache|\.ruff_cache|site-packages|_vendor|\.tox|openpyxl|lxml|numpy|pandas|matplotlib|scipy|requests|pkg_resources|setuptools|pytest|dateutil|luac|unpack|vendor|generated|assets|resources|static|images|textures|audio|video|logs|tmp|temp)(\/|\\|$)/i;

function log(message: string): void {
  output?.appendLine(`[CodeMap ${new Date().toISOString()}] ${message}`);
}

function scheduleFlush(): void {
  if (timer) {
    clearTimeout(timer);
  }
  timer = setTimeout(() => {
    timer = null;
    void flush();
  }, DEBOUNCE_MS);
}

async function flush(): Promise<void> {
  if (paused) {
    return;
  }
  if (flushing) {
    scheduleFlush();
    return;
  }
  if (pending.size === 0) {
    return;
  }

  flushing = true;
  try {
    const batch = new Map(pending);
    pending.clear();

    if (batch.size >= BATCH_SYNC_THRESHOLD) {
      log(`Watcher flush: large batch (${batch.size} files), using syncIndex for stat-based diff.`);
      if (status) {
        status.text = 'CodeMap: syncing';
      }
      paused = true;
      try {
        await indexer?.syncIndex();
      } finally {
        paused = false;
      }
      if (status) {
        const index = await indexer?.getIndex();
        if (index) {
          status.text = `CodeMap: ${index.files.length} files`;
        }
      }
    } else {
      log(`Watcher flush: small batch (${batch.size} files), per-file update.`);
      for (const [, entry] of batch) {
        try {
          if (entry.action === 'del') {
            await indexer?.removeFile(entry.uri);
          } else {
            await indexer?.updateFile(entry.uri);
          }
        } catch {
          // ignore single-file failures
        }
      }
    }
  } finally {
    flushing = false;
    if (pending.size > 0 && !paused) {
      scheduleFlush();
    }
  }
}

function onFs(uri: vscode.Uri, action: 'up' | 'del'): void {
  if (paused) {
    return;
  }
  if (uri.scheme !== 'file') {
    return;
  }

  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (!folder) {
    return;
  }

  const rel = path.relative(folder.uri.fsPath, uri.fsPath).replace(/\\/g, '/');
  if (!rel || rel.startsWith('..')) {
    return;
  }

  if (EXCLUDE_REGEX.test(rel)) {
    return;
  }

  pending.set(uri.fsPath, { uri, action });
  scheduleFlush();
}

export function pauseWatcher(): void {
  paused = true;
  pending.clear();
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

export function resumeWatcher(): void {
  paused = false;
}

export function initIndexWatcher(
  context: vscode.ExtensionContext,
  indexerInstance: CodeMapIndexer,
  statusItem: vscode.StatusBarItem,
  outputChannel: vscode.OutputChannel,
  onIgnoreChange: () => void
): void {
  indexer = indexerInstance;
  output = outputChannel;
  status = statusItem;

  const watcher = vscode.workspace.createFileSystemWatcher(DEFAULT_INCLUDE_GLOB);
  const ignoreWatcher = vscode.workspace.createFileSystemWatcher('**/.codemapignore');

  context.subscriptions.push(
    watcher,
    watcher.onDidCreate((uri) => onFs(uri, 'up')),
    watcher.onDidChange((uri) => onFs(uri, 'up')),
    watcher.onDidDelete((uri) => onFs(uri, 'del')),
    ignoreWatcher,
    ignoreWatcher.onDidCreate(() => onIgnoreChange()),
    ignoreWatcher.onDidChange(() => onIgnoreChange()),
    ignoreWatcher.onDidDelete(() => onIgnoreChange()),
    vscode.workspace.onDidSaveTextDocument((doc) => onFs(doc.uri, 'up')),
    {
      dispose: () => {
        if (timer) {
          clearTimeout(timer);
        }
        pending.clear();
      }
    }
  );

  log('Index watcher initialized (debounce=800ms, batchThreshold=50).');
}
