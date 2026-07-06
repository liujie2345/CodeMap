const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { buildCliIndex } = require('../out/cli-indexer');

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codemap-symbols-'));
  await fs.writeFile(path.join(root, 'service.py'), [
    'class UserService:',
    '    def create_user(self):',
    '        pass',
    '',
    'async def load_user():',
    '    pass'
  ].join('\n'));
  await fs.writeFile(path.join(root, 'module.lua'), [
    'local M = {}',
    'function M:run()',
    'end',
    'M["load-user"] = function()',
    'end'
  ].join('\n'));

  const index = await buildCliIndex({ root });
  const names = index.files.flatMap((file) => file.symbols.map((symbol) => symbol.name)).sort();
  assert.ok(names.includes('UserService'));
  assert.ok(names.includes('UserService.create_user'));
  assert.ok(names.includes('load_user'));
  assert.ok(names.includes('M'));
  assert.ok(names.includes('M:run'));
  assert.ok(names.includes('load-user'));
  console.log(names.join('\n'));
}
