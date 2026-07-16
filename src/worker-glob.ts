export function isRelativePathIgnored(relativePath: string, globs: string[]): boolean {
  const segments = relativePath.replace(/\\/g, '/').split('/');
  const fileName = segments[segments.length - 1] || '';

  for (const glob of globs) {
    const normalizedGlob = glob.replace(/\\/g, '/');

    const dirMatch = normalizedGlob.match(/^\*\*\/([^/*?]+)\/\*\*$/);
    if (dirMatch) {
      if (segments.includes(dirMatch[1])) {
        return true;
      }
      continue;
    }

    const dirOnlyMatch = normalizedGlob.match(/^\*\*\/([^/*?]+)$/);
    if (dirOnlyMatch) {
      if (segments.includes(dirOnlyMatch[1])) {
        return true;
      }
      continue;
    }

    const extMatch = normalizedGlob.match(/^\*\*\/\*\.(\w[\w.]*)$/);
    if (extMatch) {
      if (fileName.toLowerCase().endsWith('.' + extMatch[1].toLowerCase())) {
        return true;
      }
      continue;
    }

    if (globMatchesRelativePath(normalizedGlob, relativePath)) {
      return true;
    }
  }

  return false;
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
