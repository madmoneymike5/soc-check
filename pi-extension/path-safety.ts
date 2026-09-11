import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

function canonicalPath(path: string): string | undefined {
  const absolute = resolve(path);
  try {
    lstatSync(absolute);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    const parent = dirname(absolute);
    if (parent === absolute) return undefined;
    const canonicalParent = canonicalPath(parent);
    return canonicalParent ? resolve(canonicalParent, basename(absolute)) : undefined;
  }
  try {
    return realpathSync(absolute);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    return undefined;
  }
}

export function isCanonicalPathWithin(root: string, path: string): boolean {
  const canonicalRoot = canonicalPath(root);
  const canonicalTarget = canonicalPath(path);
  if (!canonicalRoot || !canonicalTarget) return false;
  const relativePath = relative(canonicalRoot, canonicalTarget);
  return relativePath === ""
    || (relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath));
}
