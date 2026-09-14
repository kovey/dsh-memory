/**
 * Session → memory scope resolution (DESIGN §9.3).
 *
 * The scope is resolved **per session**, never from the process working
 * directory: nvim-tui, web and headless sessions can be open in different
 * repositories at the same time, and a project write must land in the
 * repository that actually owns the session.
 */
import path from 'node:path'
import type { MemoryConfig } from '../config.js'
import { dshHome, globalMemoryRoot, projectMemoryRoot, resolveRepoRoot } from '../paths.js'
import type { MemoryScope } from '../store/types.js'

/** Structural view of the bits of a live Agent this plugin needs. */
export interface AgentLike {
    session?: {
        id?: string
        header?: {
            cwd?: string
            origin?: string
            delegationDepth?: number
        }
    }
}

export interface ResolveInput {
    /** Calling agent, when the resolution happens inside a tool call. */
    agent?: AgentLike | undefined
    /** Explicit cwd override (agent hooks pass the payload agent's session). */
    cwd?: string | undefined
    /** Caller-forced scope (`memory_save(layer: 'global')`). */
    explicit?: 'project' | 'global'
}

export class ScopeResolver {
    constructor(private readonly config: MemoryConfig) {}

    /** The dsh home this plugin resolves against (config override wins). */
    home(): string {
        const configured = this.config.memoryHome
        return configured !== undefined && configured !== '' ? path.resolve(configured) : dshHome()
    }

    globalScope(reason: MemoryScope['reason'] = 'explicit-global'): MemoryScope {
        return { kind: 'global', root: globalMemoryRoot(this.home()), reason }
    }

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
    resolve(input: ResolveInput = {}): MemoryScope {
        if (input.explicit === 'global') return this.globalScope('explicit-global')
        const sessionCwd = sessionCwdOf(input.agent)
        const probe = input.cwd ?? sessionCwd
        const fromSession = probe !== undefined && probe !== ''
        const repo = resolveRepoRoot(fromSession ? probe : process.cwd())
        if (repo !== undefined) {
            return {
                kind: 'project',
                repo,
                root: projectMemoryRoot(repo),
                reason: fromSession ? 'session-cwd' : 'process-cwd',
            }
        }
        return this.globalScope('no-project-context')
    }

    /** True when the calling agent is a subagent, which does not author memory. */
    isSubagent(agent: AgentLike | undefined): boolean {
        const header = agent?.session?.header
        if (header === undefined) return false
        return header.origin === 'subagent' || (header.delegationDepth ?? 0) > 0
    }

    /** Whether this caller may write to the resolved scope. */
    mayWrite(agent: AgentLike | undefined): boolean {
        if (this.config.routing.subagentWrite) return true
        return !this.isSubagent(agent)
    }
}

export function sessionCwdOf(agent: AgentLike | undefined): string | undefined {
    const cwd = agent?.session?.header?.cwd
    return typeof cwd === 'string' && cwd !== '' ? cwd : undefined
}

export function sessionIdOf(agent: AgentLike | undefined): string | undefined {
    const id = agent?.session?.id
    return typeof id === 'string' && id !== '' ? id : undefined
}
