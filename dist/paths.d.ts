/** Expand a leading `~` to the current user's home directory. */
export declare function expandHome(input: string): string;
/** dsh home: `$DSH_HOME` (expanded) or `~/.dsh`. */
export declare function dshHome(): string;
/** The global memory root, overridable for tests via `$DSH_MEMORY_HOME`. */
export declare function globalMemoryRoot(home?: string): string;
/** The project memory root: `<repo>/.dsh/memory`. */
export declare function projectMemoryRoot(repoRoot: string): string;
/** True when `child` is `parent` or nested inside it (after normalization). */
export declare function isInside(parent: string, child: string): boolean;
/** mkdir -p that reports failure instead of throwing (sandbox denials are normal). */
export declare function ensureDir(dir: string): boolean;
/** Drop cached repository lookups (tests, or after a workspace layout change). */
export declare function clearRepoCache(): void;
/**
 * Resolve the repository root owning `cwd`.
 *
 * Uses git's own answer (`--show-toplevel`) for the two layouts where `.git` is a
 * *file* — a linked worktree and a submodule — because the directory that holds
 * the `.git` entry is the working tree in both cases. Only a linked worktree is
 * folded into the main repository, so every worktree of one project shares a
 * single memory root; a submodule keeps its own memory (its common dir is
 * `<super>/.git/modules/<name>`, whose dirname would otherwise place project
 * memory *inside* `.git`, shared by every submodule of the superproject).
 *
 * Returns `undefined` when `cwd` is not inside a repository — callers must then
 * choose the global scope explicitly.
 */
export declare function resolveRepoRoot(cwd: string | undefined): string | undefined;
//# sourceMappingURL=paths.d.ts.map