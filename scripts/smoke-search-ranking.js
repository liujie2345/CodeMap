const assert = require('node:assert/strict');
const { searchIndex } = require('../out/search');

const workspaceFolder = 'E:/tmp/ranking';
const index = {
  version: 1,
  createdAt: new Date().toISOString(),
  workspaceFolders: [workspaceFolder],
  files: [
    file('cmd/create-kubeconfig.go', [
      symbol('function', 'create-kubeconfig', 'cmd/create-kubeconfig.go', 4),
      symbol('function', 'createkubeproxyconfig', 'cmd/create-kubeconfig.go', 12),
      symbol('function', 'createkubeapiserverconfig', 'cmd/create-kubeconfig.go', 20)
    ]),
    file('cmd/createkubeproxyconfig.go', [
      symbol('function', 'createkubeproxyconfig', 'cmd/createkubeproxyconfig.go', 4)
    ])
  ]
};

const results = searchIndex(index, 'create-kubeconfig', 10);
assert.equal(results[0].label, 'create-kubeconfig');
assert.ok(results[0].score > results[1].score);
console.log(results.slice(0, 5).map((result) => `${result.kind}:${result.label}:${result.score}`).join('\n'));

function file(relativePath, symbols) {
  return {
    workspaceFolder,
    relativePath,
    absolutePath: `${workspaceFolder}/${relativePath}`,
    language: 'go',
    size: 1,
    mtimeMs: 1,
    symbols,
    textLines: []
  };
}

function symbol(kind, name, relativePath, line) {
  return {
    kind,
    name,
    location: {
      workspaceFolder,
      relativePath,
      line,
      character: 0
    },
    signature: `func ${name}()`
  };
}
