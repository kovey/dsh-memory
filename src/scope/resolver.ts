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
     * Resolve the scope owning this call. Falls back to the global scope only
     * when no repository context exists — project scopes never degrade into the
     * global root.
     */
    resolve(input: ResolveInput = {}): MemoryScope {
        if (input.explicit === 'global') return this.globalScope('explicit-global')
        const sessionCwd = sessionCwdOf(input.agent)
        const cwd = input.cwd ?? sessionCwd
        const repo = resolveRepoRoot(cwd) ?? (input.cwd === undefined ? resolveRepoRoot(process.cwd()) : undefined)
        if (repo !== undefined) {
            return {
                kind: 'project',
                repo,
                root: projectMemoryRoot(repo),
                reason: cwd !== undefined && cwd !== '' ? 'session-cwd' : 'process-cwd',
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
