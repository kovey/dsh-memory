import type { MemoryConfig } from '../config.js';
import type { MemoryScope } from '../store/types.js';
/** Structural view of the bits of a live Agent this plugin needs. */
export interface AgentLike {
    /** Provider route + model the session runs on (source of truth for distillation). */
    options?: {
        provider?: string;
        model?: string;
    };
    session?: {
        id?: string;
        header?: {
            cwd?: string;
            origin?: string;
            delegationDepth?: number;
        };
    };
}
export interface ResolveInput {
    /** Calling agent, when the resolution happens inside a tool call. */
    agent?: AgentLike | undefined;
    /** Explicit cwd override (agent hooks pass the payload agent's session). */
    cwd?: string | undefined;
    /** Caller-forced scope (`memory_save(layer: 'global')`). */
    explicit?: 'project' | 'global';
}
export declare class ScopeResolver {
    private readonly config;
    constructor(config: MemoryConfig);
    /** The dsh home this plugin resolves against (config override wins). */
    home(): string;
    globalScope(reason?: MemoryScope['reason']): MemoryScope;
    /**
     * Resolve the scope owning this call.
     *
     * The session's own working directory is authoritative: when it exists and
     * is not inside a repository the result is the *global* scope. Falling back
     * to the host process's cwd in that situation would attribute an unrelated
     * session to whichever repository the host happened to be launched from —
     * exactly the cross-project contamination invariant 3 forbids. The process
     * cwd is consulted only when the session carries no cwd at all.
     */
    resolve(input?: ResolveInput): MemoryScope;
    /** True when the calling agent is a subagent, which does not author memory. */
    isSubagent(agent: AgentLike | undefined): boolean;
    /** Whether this caller may write to the resolved scope. */
    mayWrite(agent: AgentLike | undefined): boolean;
}
export declare function sessionCwdOf(agent: AgentLike | undefined): string | undefined;
export declare function sessionIdOf(agent: AgentLike | undefined): string | undefined;
//# sourceMappingURL=resolver.d.ts.map