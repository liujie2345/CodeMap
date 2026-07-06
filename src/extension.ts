import * as path from 'path';
import * as vscode from 'vscode';
import { BuildIndexProgress, CodeMapIndexer, DEFAULT_INCLUDE_GLOB } from './indexer';
import { SearchScope, searchIndex } from './search';
import { CodeMapResultKind, SearchResult } from './types';

interface SearchEverywhereItem extends vscode.QuickPickItem {
  result?: SearchResult;
}

const GROUP_LABELS: Record<CodeMapResultKind, string> = {
  class: 'Classes',
  interface: 'Interfaces',
  type: 'Types',
  function: 'Functions',
  file: 'Files',
  text: 'Text'
};

const GROUP_ORDER: CodeMapResultKind[] = ['class', 'interface', 'type', 'function', 'file', 'text'];
let backgroundSyncTimer: NodeJS.Timeout | undefined;
let backgroundSyncRunning = false;

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('CodeMap');
  const indexer = new CodeMapIndexer(output);
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.text = 'CodeMap';
  status.tooltip = 'CodeMap Search Everywhere';
  status.command = 'codemap.searchEverywhere';
  status.show();

  context.subscriptions.push(output, status);

  context.subscriptions.push(
    vscode.commands.registerCommand('codemap.buildIndex', async () => {
      await withProgress('Building CodeMap index', async (progress) => {
        status.text = 'CodeMap: indexing';
        try {
          let lastProcessed = 0;
          const index = await indexer.buildIndex((state) => {
            reportBuildProgress(progress, state, lastProcessed);
            lastProcessed = state.processed;
          });
          setReadyStatus(status, index);
          vscode.window.showInformationMessage(`CodeMap indexed ${index.files.length} files.`);
        } catch (error) {
          status.text = 'CodeMap: error';
          vscode.window.showErrorMessage(getErrorMessage(error));
          output.appendLine(getErrorMessage(error));
        }
      });
    }),
    vscode.commands.registerCommand('codemap.searchEverywhere', async () => {
      await searchEverywhere(indexer, status);
    }),
    vscode.commands.registerCommand('codemap.syncIndex', async () => {
      await syncIndexWithProgress(indexer, status, true);
    }),
    vscode.commands.registerCommand('codemap.openSearchPanel', async () => {
      await openSearchPanel(indexer, status, context);
    }),
    vscode.commands.registerCommand('codemap.showIndexInfo', async () => {
      await showIndexInfo(indexer);
    }),
    vscode.commands.registerCommand('codemap.clearIndex', async () => {
      const answer = await vscode.window.showWarningMessage(
        'Clear the CodeMap index for this workspace?',
        { modal: true },
        'Clear Index'
      );
      if (answer !== 'Clear Index') {
        return;
      }

      await indexer.clearIndex();
      status.text = 'CodeMap: no index';
      vscode.window.showInformationMessage('CodeMap index cleared.');
    })
  );

  const watcher = vscode.workspace.createFileSystemWatcher(DEFAULT_INCLUDE_GLOB);
  const ignoreWatcher = vscode.workspace.createFileSystemWatcher('**/.codemapignore');
  context.subscriptions.push(
    watcher,
    watcher.onDidCreate((uri) => indexer.updateFile(uri)),
    watcher.onDidChange((uri) => indexer.updateFile(uri)),
    watcher.onDidDelete((uri) => indexer.removeFile(uri)),
    ignoreWatcher,
    ignoreWatcher.onDidCreate(() => scheduleBackgroundSync(indexer, status)),
    ignoreWatcher.onDidChange(() => scheduleBackgroundSync(indexer, status)),
    ignoreWatcher.onDidDelete(() => scheduleBackgroundSync(indexer, status))
  );

  void indexer.getIndex().then((index) => {
    if (index) {
      setReadyStatus(status, index);
      const config = vscode.workspace.getConfiguration('codemap');
      if (config.get<boolean>('autoSyncOnStartup', true)) {
        scheduleBackgroundSync(indexer, status);
      }
    } else {
      status.text = 'CodeMap: no index';
    }
  });
}

export function deactivate(): void {
  // Nothing to clean up.
}

async function searchEverywhere(indexer: CodeMapIndexer, status: vscode.StatusBarItem): Promise<void> {
  let index = await indexer.getIndex();
  if (!index) {
    const answer = await vscode.window.showInformationMessage(
      'CodeMap has no index for this workspace.',
      'Build Index',
      'Cancel'
    );

    if (answer !== 'Build Index') {
      return;
    }

    index = await withProgress('Building CodeMap index', async (progress) => {
      status.text = 'CodeMap: indexing';
      let lastProcessed = 0;
      const built = await indexer.buildIndex((state) => {
        reportBuildProgress(progress, state, lastProcessed);
        lastProcessed = state.processed;
      });
      setReadyStatus(status, built);
      return built;
    });
  }

  const activeIndex = index;
  if (!activeIndex) {
    return;
  }

  const quickPick = vscode.window.createQuickPick<SearchEverywhereItem>();
  quickPick.title = 'CodeMap Search Everywhere';
  quickPick.placeholder = 'Search classes, functions, files, and text';
  quickPick.matchOnDescription = true;
  quickPick.matchOnDetail = true;
  quickPick.items = [
    {
      label: 'Start typing to search the CodeMap index',
      kind: vscode.QuickPickItemKind.Default
    }
  ];

  const updateItems = debounce((query: string) => {
    const config = vscode.workspace.getConfiguration('codemap');
    const maxTextMatches = config.get<number>('maxTextMatches', 80);
    const results = searchIndex(activeIndex, query, { scope: 'all', maxTextMatches });
    quickPick.items = toQuickPickItems(results);
  }, 70);

  quickPick.onDidChangeValue((value) => {
    updateItems(value);
  });

  quickPick.onDidAccept(async () => {
    const selected = quickPick.selectedItems[0];
    if (!selected?.result) {
      return;
    }

    quickPick.hide();
    await openResult(selected.result);
  });

  quickPick.onDidHide(() => quickPick.dispose());
  quickPick.show();
}

async function showIndexInfo(indexer: CodeMapIndexer): Promise<void> {
  const summary = await indexer.getIndexSummary();
  if (!summary) {
    vscode.window.showInformationMessage('CodeMap has no index for this workspace.');
    return;
  }

  const languageSummary = Object.entries(summary.languageCounts)
    .sort((left, right) => right[1] - left[1])
    .map(([language, count]) => `${language}: ${count}`)
    .join('\n');

  const document = await vscode.workspace.openTextDocument({
    language: 'markdown',
    content: [
      '# CodeMap Index Info',
      '',
      `Created: ${summary.createdAt}`,
      `Files: ${summary.fileCount}`,
      `Symbols: ${summary.symbolCount}`,
      `Storage: ${summary.storagePath ?? 'unknown'}`,
      '',
      '## Workspace Folders',
      '',
      ...summary.workspaceFolders.map((folder) => `- ${folder}`),
      '',
      '## Languages',
      '',
      languageSummary || 'No indexed languages.'
    ].join('\n')
  });

  await vscode.window.showTextDocument(document, { preview: true });
}

async function syncIndexWithProgress(
  indexer: CodeMapIndexer,
  status: vscode.StatusBarItem,
  showSummary: boolean
): Promise<void> {
  await withProgress('Syncing CodeMap index', async (progress) => {
    status.text = 'CodeMap: syncing';
    try {
      let lastProcessed = 0;
      const result = await indexer.syncIndex((state) => {
        reportBuildProgress(progress, state, lastProcessed);
        lastProcessed = state.processed;
      });
      setReadyStatus(status, result.index);
      if (showSummary) {
        vscode.window.showInformationMessage(
          `CodeMap synced ${result.scannedFiles} files (+${result.addedFiles}, ~${result.updatedFiles}, -${result.removedFiles}).`
        );
      }
    } catch (error) {
      status.text = 'CodeMap: error';
      vscode.window.showErrorMessage(getErrorMessage(error));
    }
  });
}

function scheduleBackgroundSync(indexer: CodeMapIndexer, status: vscode.StatusBarItem): void {
  if (backgroundSyncTimer) {
    clearTimeout(backgroundSyncTimer);
  }

  status.text = 'CodeMap: stale';
  backgroundSyncTimer = setTimeout(() => {
    if (backgroundSyncRunning) {
      return;
    }

    backgroundSyncRunning = true;
    status.text = 'CodeMap: syncing';
    void indexer.syncIndex()
      .then((result) => {
        setReadyStatus(status, result.index);
      })
      .catch((error) => {
        status.text = 'CodeMap: sync error';
        console.error(error);
      })
      .finally(() => {
        backgroundSyncRunning = false;
      });
  }, 1500);
}

async function openSearchPanel(
  indexer: CodeMapIndexer,
  status: vscode.StatusBarItem,
  context: vscode.ExtensionContext
): Promise<void> {
  let index = await indexer.getIndex();
  if (!index) {
    const answer = await vscode.window.showInformationMessage(
      'CodeMap has no index for this workspace.',
      'Build Index',
      'Cancel'
    );

    if (answer !== 'Build Index') {
      return;
    }

    index = await withProgress('Building CodeMap index', async (progress) => {
      status.text = 'CodeMap: indexing';
      let lastProcessed = 0;
      const built = await indexer.buildIndex((state) => {
        reportBuildProgress(progress, state, lastProcessed);
        lastProcessed = state.processed;
      });
      setReadyStatus(status, built);
      return built;
    });
  }

  const activeIndex = index;
  if (!activeIndex) {
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    'codemapSearchPanel',
    'CodeMap',
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [context.extensionUri]
    }
  );

  panel.webview.html = getSearchPanelHtml(panel.webview);

  panel.webview.onDidReceiveMessage(async (message: PanelMessage) => {
    if (message.type === 'search') {
      const config = vscode.workspace.getConfiguration('codemap');
      const maxTextMatches = config.get<number>('maxTextMatches', 80);
      const results = searchIndex(activeIndex, message.query, {
        scope: panelModeToSearchScope(message.mode),
        maxTextMatches,
        limit: 150
      });
      await panel.webview.postMessage({
        type: 'results',
        query: message.query,
        results: groupPanelResults(results)
      });
      return;
    }

    if (message.type === 'open') {
      await openResult(message.result);
    }
  });
}

function toQuickPickItems(results: SearchResult[]): SearchEverywhereItem[] {
  if (results.length === 0) {
    return [
      {
        label: 'No CodeMap results',
        kind: vscode.QuickPickItemKind.Default
      }
    ];
  }

  const items: SearchEverywhereItem[] = [];
  for (const group of GROUP_ORDER) {
    const grouped = results.filter((result) => result.kind === group);
    if (grouped.length === 0) {
      continue;
    }

    items.push({
      label: GROUP_LABELS[group],
      kind: vscode.QuickPickItemKind.Separator
    });

    for (const result of grouped.slice(0, group === 'text' ? 30 : 40)) {
      items.push({
        label: iconForKind(result.kind) + result.label,
        description: result.description,
        detail: result.detail,
        result
      });
    }
  }

  return items;
}

async function openResult(result: SearchResult): Promise<void> {
  const uri = vscode.Uri.file(path.join(result.location.workspaceFolder, result.location.relativePath));
  const document = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(document);
  const position = new vscode.Position(result.location.line, result.location.character);
  editor.selection = new vscode.Selection(position, position);
  editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
}

function iconForKind(kind: CodeMapResultKind): string {
  switch (kind) {
    case 'class':
      return '$(symbol-class) ';
    case 'interface':
      return '$(symbol-interface) ';
    case 'type':
      return '$(symbol-structure) ';
    case 'function':
      return '$(symbol-method) ';
    case 'file':
      return '$(file) ';
    case 'text':
      return '$(search) ';
  }
}

type PanelMode = 'all' | 'symbols' | 'classes' | 'functions' | 'files' | 'text';

type PanelMessage =
  | { type: 'search'; query: string; mode: PanelMode }
  | { type: 'open'; result: SearchResult };

function panelModeToSearchScope(mode: PanelMode): SearchScope {
  switch (mode) {
    case 'symbols':
      return 'symbols';
    case 'classes':
      return 'classes';
    case 'functions':
      return 'functions';
    case 'files':
      return 'files';
    case 'text':
      return 'text';
    case 'all':
      return 'all';
  }
}

function groupPanelResults(results: SearchResult[]): Array<{ title: string; kind: CodeMapResultKind; items: SearchResult[] }> {
  return GROUP_ORDER
    .map((kind) => ({
      title: GROUP_LABELS[kind],
      kind,
      items: results.filter((result) => result.kind === kind).slice(0, kind === 'text' ? 50 : 80)
    }))
    .filter((group) => group.items.length > 0);
}

function getSearchPanelHtml(webview: vscode.Webview): string {
  const nonce = getNonce();

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <title>CodeMap</title>
  <style>
    :root {
      color-scheme: dark light;
      --border: var(--vscode-panel-border);
      --muted: var(--vscode-descriptionForeground);
      --bg: var(--vscode-editor-background);
      --fg: var(--vscode-editor-foreground);
      --row: var(--vscode-list-hoverBackground);
      --panel: var(--vscode-sideBar-background);
      --input: var(--vscode-input-background);
      --input-fg: var(--vscode-input-foreground);
      --active: var(--vscode-button-background);
      --active-fg: var(--vscode-button-foreground);
      --focus: var(--vscode-focusBorder);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 0;
      background: var(--bg);
      color: var(--fg);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      line-height: 1.45;
    }
    .shell {
      display: grid;
      grid-template-rows: auto auto 1fr;
      height: 100vh;
    }
    .search {
      padding: 14px 16px 10px;
      background: var(--panel);
      border-bottom: 1px solid var(--border);
    }
    input {
      width: 100%;
      height: 40px;
      padding: 0 13px;
      border: 1px solid var(--vscode-input-border);
      border-radius: 4px;
      outline: none;
      background: var(--input);
      color: var(--input-fg);
      font-family: var(--vscode-font-family);
      font-size: 14px;
    }
    input:focus {
      border-color: var(--focus);
      box-shadow: 0 0 0 1px var(--focus);
    }
    .tabs {
      display: flex;
      gap: 4px;
      padding: 9px 16px;
      background: var(--panel);
      border-bottom: 1px solid var(--border);
      overflow-x: auto;
    }
    button {
      height: 30px;
      padding: 0 12px;
      border: 1px solid var(--vscode-button-border, transparent);
      border-radius: 4px;
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      font-family: var(--vscode-font-family);
      font-size: 12px;
      cursor: pointer;
    }
    button:hover { background: var(--row); }
    button.active {
      background: var(--active);
      color: var(--active-fg);
    }
    .results {
      overflow: auto;
      padding: 8px 0 24px;
    }
    .empty {
      padding: 32px 18px;
      color: var(--muted);
      font-size: 13px;
    }
    .group-title {
      position: sticky;
      top: 0;
      padding: 10px 16px 6px;
      background: var(--bg);
      color: var(--muted);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0;
      border-bottom: 1px solid var(--border);
    }
    .result {
      display: grid;
      grid-template-columns: 32px minmax(0, 1fr) auto;
      gap: 10px;
      align-items: center;
      min-height: 48px;
      padding: 7px 16px;
      cursor: pointer;
    }
    .result:hover { background: var(--row); }
    .result.selected {
      background: var(--vscode-list-activeSelectionBackground);
      color: var(--vscode-list-activeSelectionForeground);
    }
    .result.selected .path,
    .result.selected .detail {
      color: var(--vscode-list-activeSelectionForeground);
      opacity: 0.84;
    }
    .name {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 14px;
      font-weight: 500;
    }
    .path {
      color: var(--muted);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      max-width: 42vw;
      font-size: 12px;
    }
    .detail {
      grid-column: 2 / 4;
      color: var(--muted);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 12px;
      opacity: 0.92;
    }
    .hint {
      margin-top: 8px;
      color: var(--muted);
      font-size: 12px;
    }
    .kind {
      display: inline-grid;
      place-items: center;
      width: 24px;
      height: 24px;
      border: 1px solid var(--border);
      border-radius: 4px;
      color: var(--muted);
      background: var(--panel);
      font-size: 11px;
      font-weight: 600;
    }
  </style>
</head>
<body>
  <div class="shell">
    <div class="search">
      <input id="query" placeholder="Search classes, functions, interfaces, and types" autofocus />
      <div class="hint">Up/down to select, Enter to open. Switch tabs for files or text.</div>
    </div>
    <div class="tabs">
      <button data-mode="all">All</button>
      <button class="active" data-mode="symbols">Symbols</button>
      <button data-mode="classes">Classes</button>
      <button data-mode="functions">Functions</button>
      <button data-mode="files">Files</button>
      <button data-mode="text">Text</button>
    </div>
    <div id="results" class="results">
      <div class="empty">Start typing to search the CodeMap index.</div>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const query = document.getElementById('query');
    const results = document.getElementById('results');
    const tabs = Array.from(document.querySelectorAll('button[data-mode]'));
    let mode = 'symbols';
    let latestGroups = [];
    let latestFlat = [];
    let selectedIndex = 0;
    let timer;

    query.focus();

    function search() {
      clearTimeout(timer);
      timer = setTimeout(() => {
        vscode.postMessage({ type: 'search', query: query.value, mode });
      }, 80);
    }

    tabs.forEach((tab) => {
      tab.addEventListener('click', () => {
        mode = tab.dataset.mode;
        tabs.forEach((item) => item.classList.toggle('active', item === tab));
        selectedIndex = 0;
        search();
      });
    });

    query.addEventListener('input', search);
    query.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        openSelected();
        return;
      }

      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setSelected(selectedIndex + 1);
        return;
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setSelected(selectedIndex - 1);
      }
    });

    window.addEventListener('message', (event) => {
      if (event.data.type !== 'results') {
        return;
      }

      latestGroups = event.data.results || [];
      latestFlat = latestGroups.flatMap((group) => group.items);
      selectedIndex = latestFlat.length > 0 ? 0 : -1;
      render();
    });

    function render() {
      if (!query.value.trim()) {
        latestFlat = [];
        selectedIndex = -1;
        results.innerHTML = '<div class="empty">Start typing to search symbols. Use Files or Text when you need a wider search.</div>';
        return;
      }

      if (latestGroups.length === 0) {
        latestFlat = [];
        selectedIndex = -1;
        results.innerHTML = '<div class="empty">No CodeMap results.</div>';
        return;
      }

      results.innerHTML = '';
      let flatIndex = 0;
      for (const group of latestGroups) {
        const title = document.createElement('div');
        title.className = 'group-title';
        title.textContent = group.title;
        results.appendChild(title);

        for (const item of group.items) {
          const row = document.createElement('div');
          row.className = 'result';
          row.dataset.resultIndex = String(flatIndex);
          row.innerHTML = '<div class="kind">' + icon(group.kind) + '</div>' +
            '<div class="name"></div>' +
            '<div class="path"></div>' +
            '<div class="detail"></div>';
          row.querySelector('.name').textContent = item.label;
          row.querySelector('.path').textContent = item.description || '';
          row.querySelector('.detail').textContent = item.detail || item.preview || '';
          row.addEventListener('click', () => vscode.postMessage({ type: 'open', result: item }));
          row.addEventListener('mouseenter', () => setSelected(Number(row.dataset.resultIndex)));
          results.appendChild(row);
          flatIndex += 1;
        }
      }
      applySelection();
    }

    function setSelected(nextIndex) {
      if (latestFlat.length === 0) {
        selectedIndex = -1;
        return;
      }

      if (nextIndex < 0) {
        selectedIndex = latestFlat.length - 1;
      } else if (nextIndex >= latestFlat.length) {
        selectedIndex = 0;
      } else {
        selectedIndex = nextIndex;
      }

      applySelection();
    }

    function applySelection() {
      const rows = Array.from(results.querySelectorAll('[data-result-index]'));
      for (const row of rows) {
        const isSelected = Number(row.dataset.resultIndex) === selectedIndex;
        row.classList.toggle('selected', isSelected);
        if (isSelected) {
          row.scrollIntoView({ block: 'nearest' });
        }
      }
    }

    function openSelected() {
      if (selectedIndex < 0 || selectedIndex >= latestFlat.length) {
        return;
      }

      vscode.postMessage({ type: 'open', result: latestFlat[selectedIndex] });
    }

    function icon(kind) {
      if (kind === 'class') return 'C';
      if (kind === 'interface') return 'I';
      if (kind === 'type') return 'T';
      if (kind === 'function') return 'Fn';
      if (kind === 'file') return 'F';
      return 'Tx';
    }
  </script>
</body>
</html>`;
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let index = 0; index < 32; index += 1) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}

function debounce<T extends (...args: never[]) => void>(callback: T, delayMs: number): T {
  let handle: NodeJS.Timeout | undefined;
  return ((...args: Parameters<T>) => {
    if (handle) {
      clearTimeout(handle);
    }

    handle = setTimeout(() => callback(...args), delayMs);
  }) as T;
}

async function withProgress<T>(
  title: string,
  task: (progress: vscode.Progress<{ message?: string; increment?: number }>) => Promise<T>
): Promise<T> {
  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      cancellable: false,
      title
    },
    task
  );
}

function reportBuildProgress(
  progress: vscode.Progress<{ message?: string; increment?: number }>,
  state: BuildIndexProgress,
  lastProcessed: number
): void {
  const increment = state.total > 0 ? ((state.processed - lastProcessed) / state.total) * 100 : 0;
  const processed = Math.min(state.processed + 1, state.total);
  const message = state.total > 0
    ? `${processed}/${state.total}${state.currentFile ? ` ${state.currentFile}` : ''}`
    : 'Scanning workspace';

  progress.report({
    increment: Math.max(0, increment),
    message
  });
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function setReadyStatus(status: vscode.StatusBarItem, index: { files: unknown[] }): void {
  status.text = `CodeMap: ${index.files.length} files`;
  status.tooltip = 'CodeMap index ready';
}
