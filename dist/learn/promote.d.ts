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
//# sourceMappingURL=promote.d.ts.map