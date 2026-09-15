/**
 * Core memory data model (docs/DESIGN.md §3, §5).
 *
 * A record's *layer* answers "what kind of memory is this"; its *scope* answers
 * "which memory root owns it". Project-scoped records live only under
 * `<repo>/.dsh/memory` and are never written to the global root (invariant 2/3).
 */
/** Ranking weights per layer (DESIGN §6). */
export const LAYER_WEIGHT = {
    project: 1,
    profile: 0.95,
    global: 0.85,
    episodic: 0.7,
};
//# sourceMappingURL=types.js.map