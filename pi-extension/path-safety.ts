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

export function canonicalPathWithin(root: string, path: string): string | undefined {
  const canonicalRoot = canonicalPath(root);
  const canonicalTarget = canonicalPath(path);
  if (!canonicalRoot || !canonicalTarget) return undefined;
  const relativePath = relative(canonicalRoot, canonicalTarget);
  const withinRoot = relativePath === ""
    || (relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath));
  return withinRoot ? canonicalTarget : undefined;
}
