export const SEG_SPLIT = /-(?=(?:g[a-z]|fh\d+|fs|fp|ph\d+|ps):)/;

const FEDERAL = /^(?:fh\d+|fs|fp):/;

const PDF_POSITIONAL = /^(?:ph\d+|ps|pp):/;

export function segmentsOf(path: string): string[] {
  return path.split(SEG_SPLIT);
}

export function depthOf(path: string): number {
  return segmentsOf(path).length;
}

export function truncatePath(path: string, d: number): string {
  return segmentsOf(path).slice(0, d).join("-");
}

export function isFederalPath(path: string): boolean {
  return FEDERAL.test(path);
}

export function isPdfPath(path: string): boolean {
  return PDF_POSITIONAL.test(path);
}

export function subtreeClause(col: string): string {
  return `(${col} = ? OR (${col} >= ? || '-' AND ${col} < ? || '.'))`;
}

export function subtreeBinds(path: string): [string, string, string] {
  return [path, path, path];
}
