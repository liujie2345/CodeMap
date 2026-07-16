import * as path from 'path';
import { CodeMapSymbol, CodeMapTextLine } from './types';

export function getLanguageFromPath(filePath: string): string {
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

export function extractTextLines(content: string, limit: number): CodeMapTextLine[] {
  if (limit <= 0) {
    return [];
  }

  return content
    .split(/\r?\n/)
    .slice(0, limit)
    .map((text, index) => ({ text: text.trim(), line: index }))
    .filter((line) => line.text.length > 0 && line.text.length <= 500);
}

export function isLikelyComment(trimmed: string): boolean {
  return trimmed.startsWith('//')
    || trimmed.startsWith('#')
    || trimmed.startsWith('*')
    || trimmed.startsWith('/*')
    || trimmed.startsWith('--')
    || trimmed.startsWith('<!--');
}

export function extractSymbols(
  content: string,
  workspaceFolder: string,
  relativePath: string,
  language: string
): CodeMapSymbol[] {
  if (language === 'python') {
    return extractPythonSymbols(content, workspaceFolder, relativePath);
  }

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

function extractPythonSymbols(content: string, workspaceFolder: string, relativePath: string): CodeMapSymbol[] {
  const symbols: CodeMapSymbol[] = [];
  const lines = content.split(/\r?\n/);
  const classStack: Array<{ name: string; indent: number }> = [];

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    const trimmed = line.trim();
    if (!trimmed || isLikelyComment(trimmed)) {
      continue;
    }

    const indent = line.search(/\S|$/);
    while (classStack.length > 0 && indent <= classStack[classStack.length - 1].indent) {
      classStack.pop();
    }

    const classMatch = trimmed.match(/^class\s+([A-Za-z_][\w]*)\s*(?:\(|:)/);
    if (classMatch) {
      const name = classMatch[1];
      classStack.push({ name, indent });
      symbols.push({
        kind: 'class',
        name,
        location: { workspaceFolder, relativePath, line: lineIndex, character: indent },
        signature: trimmed.slice(0, 240)
      });
      continue;
    }

    const functionMatch = trimmed.match(/^(?:async\s+)?def\s+([A-Za-z_][\w]*)\s*\(/);
    if (functionMatch) {
      const rawName = functionMatch[1];
      const owner = classStack[classStack.length - 1];
      const name = owner && indent > owner.indent ? `${owner.name}.${rawName}` : rawName;
      symbols.push({
        kind: 'function',
        name,
        containerName: owner?.name,
        location: { workspaceFolder, relativePath, line: lineIndex, character: indent },
        signature: trimmed.slice(0, 240)
      });
    }
  }

  return symbols;
}

type SymbolDeclaration = {
  kind: CodeMapSymbol['kind'];
  match: RegExpMatchArray | null;
};

function getSymbolDeclarations(trimmed: string, language: string): SymbolDeclaration[] {
  if (!trimmed) {
    return [];
  }

  if (language === 'lua') {
    const luacatsClass = trimmed.match(/^---+\s*@class\s+([A-Za-z_][\w.]*)/);
    if (luacatsClass) {
      return [{ kind: 'class', match: luacatsClass }];
    }
    const luacatsAlias = trimmed.match(/^---+\s*@alias\s+([A-Za-z_][\w.]*)/);
    if (luacatsAlias) {
      return [{ kind: 'type', match: luacatsAlias }];
    }
    const luacatsEnum = trimmed.match(/^---+\s*@enum\s+([A-Za-z_][\w.]*)/);
    if (luacatsEnum) {
      return [{ kind: 'type', match: luacatsEnum }];
    }
  }

  if (isLikelyComment(trimmed)) {
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
        { kind: 'function', match: trimmed.match(/^[A-Za-z_][\w.]*\[['"]([^'"]+)['"]\]\s*=\s*function\s*\(/) },
        { kind: 'class', match: trimmed.match(/^(?:local\s+)?([A-Za-z_][\w]*)\s*=\s*\{\s*\}/) },
        { kind: 'class', match: trimmed.match(/^local\s+([A-Za-z_][\w]*)\s*=\s*setmetatable\s*\(/) }
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
