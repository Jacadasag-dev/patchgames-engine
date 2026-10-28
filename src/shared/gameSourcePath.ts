/** Paths supported by both the content browser and the source store. */
export function sourcePath(path: string): boolean {
  return /^(src\/game\/|tests\/game\/)[A-Za-z0-9_./-]+\.(ts|json)$/.test(path)
    && path.length <= 200 && path.split('/').every(part => part !== '.' && part !== '..' && part !== '')
    && !path.endsWith('.d.ts');
}
