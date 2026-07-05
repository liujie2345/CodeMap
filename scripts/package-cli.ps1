param(
  [string]$Version = ""
)

$ErrorActionPreference = "Stop"

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$packageJsonPath = Join-Path $root "package.json"
$packageJson = Get-Content $packageJsonPath -Raw | ConvertFrom-Json

if ([string]::IsNullOrWhiteSpace($Version)) {
  $Version = $packageJson.version
}

$distDir = Join-Path $root "dist"
$stageDir = Join-Path $distDir "codemap-everywhere-cli-$Version"
$zipPath = Join-Path $distDir "codemap-everywhere-cli-$Version.zip"

if (Test-Path $stageDir) {
  Remove-Item $stageDir -Recurse -Force
}

if (Test-Path $zipPath) {
  Remove-Item $zipPath -Force
}

New-Item -ItemType Directory -Force -Path $stageDir | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $stageDir "out") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $stageDir "docs") | Out-Null

$requiredOutFiles = @(
  "cli.js",
  "cli.js.map",
  "cli-indexer.js",
  "cli-indexer.js.map",
  "search.js",
  "search.js.map",
  "types.js",
  "types.js.map"
)

foreach ($file in $requiredOutFiles) {
  $source = Join-Path $root "out\$file"
  if (!(Test-Path $source)) {
    throw "Missing compiled file: $source. Run npm run compile first."
  }
  Copy-Item $source (Join-Path $stageDir "out\$file")
}

Copy-Item (Join-Path $root "README.md") (Join-Path $stageDir "README.md")
Copy-Item (Join-Path $root "LICENSE") (Join-Path $stageDir "LICENSE") -ErrorAction SilentlyContinue
Copy-Item (Join-Path $root "LICENSE.txt") (Join-Path $stageDir "LICENSE.txt") -ErrorAction SilentlyContinue
Copy-Item (Join-Path $root "docs\AGENT_USAGE.md") (Join-Path $stageDir "docs\AGENT_USAGE.md")
Copy-Item (Join-Path $root "docs\EDITIONS.md") (Join-Path $stageDir "docs\EDITIONS.md")

$cliPackage = [ordered]@{
  name = "codemap-everywhere-cli"
  version = $Version
  private = $true
  description = "CodeMap Everywhere CLI preview for terminal, scripts, and AI agents."
  bin = @{
    codemap = "./out/cli.js"
  }
  scripts = @{
    codemap = "node ./out/cli.js"
  }
}

($cliPackage | ConvertTo-Json -Depth 5) | Set-Content (Join-Path $stageDir "package.json") -Encoding UTF8

$usage = @"
# CodeMap Everywhere CLI

This is the CLI preview package for CodeMap Everywhere.

## Usage

Run from this folder:

```bash
node out/cli.js build --cwd /path/to/project
node out/cli.js sync --cwd /path/to/project
node out/cli.js info --cwd /path/to/project
node out/cli.js search "UserService" --cwd /path/to/project --json
```

Or on Windows:

```powershell
node .\out\cli.js build --cwd C:\path\to\project
node .\out\cli.js search "UserService" --cwd C:\path\to\project --json
```

The CLI reads and writes the same `.codemap/` index used by the VS Code extension.
"@

$usage | Set-Content (Join-Path $stageDir "CLI_USAGE.md") -Encoding UTF8

Compress-Archive -Path (Join-Path $stageDir "*") -DestinationPath $zipPath -Force

Write-Host "Created $zipPath"
