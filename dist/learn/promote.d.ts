import type { MemoryRecord, MemoryScope } from '../store/types.js';
/** Directory holding promotion drafts, relative to a memory root. */
export declare function proposalsDir(scope: MemoryScope): string;
/** File a draft lives in, or `undefined` when the scope is unusable. */
export declare function skillDraftPath(scope: MemoryScope, record: MemoryRecord): string | undefined;
/** Skill name for a promoted lesson: stable, filesystem-safe, prefixed. */
export declare function skillDraftName(record: MemoryRecord): string;
/**
 * The draft itself: host-compatible frontmatter plus the lesson, with its
 * provenance so a reviewer can judge it.
 */
export declare function renderSkillDraft(record: MemoryRecord, now?: Date): string;
/** Write (or refresh) the draft for one promotion candidate. */
export declare function writeSkillDraft(scope: MemoryScope, record: MemoryRecord, now?: Date): string | undefined;
/** Remove drafts whose proposal no longer exists (a rejected promotion). */
export declare function pruneSkillDrafts(scope: MemoryScope, keepIds: readonly string[]): number;
/**
 * A host skill name is a single path segment of `[a-z0-9-]`.
 *
 * The name comes out of a rendered draft rather than from a constant, so it is
 * validated *before* any path is built from it: a `..`, a `/`, an uppercase
 * letter or a space must never become a directory under `~/.dsh/skills`.
 */
export declare function isSafeSkillName(name: string): boolean;
/**
 * The `name:` frontmatter field of a rendered draft — the name the host loads it
 * under.
 *
 * YAML, not "the rest of the line": a value may be quoted (`name: "mem-x"`) and a
 * trailing ` # …` is a comment, not part of the scalar. Taking the raw text made
 * the first form install nothing (quotes are not a valid skill name) and the
 * second form invent a name with the comment glued on.
 */
export declare function skillNameOf(draft: string): string | undefined;
export interface SkillInstall {
    action: 'installed' | 'unchanged' | 'conflict' | 'invalid-name' | 'failed';
    /** Absolute target path, present once a usable name came out of the draft. */
    file?: string;
    name?: string;
    message: string;
}
/**
 * Install a reviewed promotion draft as a host skill:
 * `<dshHome>/skills/<name>/SKILL.md`.
 *
 * Only an explicit `acceptProposal` reaches this function, so the human
 * decision stays where DESIGN §3 put it — but the step after it is a copy, not
 * an authoring exercise. Three rules keep the install safe:
 *
 *   - the existing file is never clobbered silently: different content is a
 *     conflict unless the caller passed `overwrite`, because a promoted skill
 *     may be a file somebody wrote by hand;
 *   - a failure (bad name, unwritable directory) is returned as a message, so
 *     the caller can leave the proposal open instead of reporting a promotion
 *     that did not happen;
 *   - the target must resolve *inside* the skills root. `isInside` is purely
 *     lexical, so `<home>/skills/<name>` as a symlink used to send the write
 *     wherever the link pointed. The containment check is therefore redone on
 *     `realpath` for any part that already exists; a symlinked *root* that stays
 *     inside (macOS `/tmp` → `/private/tmp`) is still legitimate, which is why
 *     this resolves instead of refusing every symlink outright.
 */
export declare function installSkillDraft(home: string, draft: string, options?: {
    overwrite?: boolean;
}): SkillInstall;
//# sourceMappingURL=promote.d.ts.map