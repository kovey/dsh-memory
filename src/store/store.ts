/**
 * Store registry: one open database per memory root, shared by every session
 * that resolves to the same scope (DESIGN §5.2).
 *
 * Sessions are the scope source, so on a host with nvim-tui, web and headless
 * surfaces running at once several roots can be open simultaneously; each root
 * keeps exactly one connection and one writer queue.
 */
import type { DatabaseSync } from 'node:sqlite'
import type { MemoryConfig } from '../config.js'
import { log } from '../log.js'
import { ensureDir, globalMemoryRoot, projectMemoryRoot } from '../paths.js'
import { exportAll, exportIndex } from './export.js'
import { bootstrapImport, importLessons } from './import.js'
import { importMetrics } from './metrics.js'
import { openDatabase, probeSqlite, rebuildFts } from './sqlite/db.js'
import type { SqliteProbe } from './sqlite/db.js'
import { countRecords } from './sqlite/records.js'
import type { RecordCounts } from './sqlite/records.js'
import type { MemoryScope } from './types.js'

type SqliteModule = typeof import('node:sqlite')

export interface ScopeStore {
    scope: MemoryScope
    db: DatabaseSync
    fts5: boolean
    openedAt: string
}

export interface OpenReport {
    probe: SqliteProbe
    opened: number
    errors: string[]
}

export class StoreRegistry {
    private readonly stores = new Map<string, ScopeStore>()
    private probe: SqliteProbe = { available: false, reason: 'not probed', fts5: false }
    private module: SqliteModule | undefined

    constructor(private readonly config: MemoryConfig) {}

    /** Load the driver and probe capabilities once; safe to call repeatedly. */
    async initialize(loadModule: () => Promise<SqliteModule | undefined>): Promise<OpenReport> {
        const report: OpenReport = { probe: this.probe, opened: 0, errors: [] }
        this.module = await loadModule()
        if (this.module === undefined) {
            this.probe = { available: false, reason: 'node:sqlite could not be imported', fts5: false }
            report.probe = this.probe
            return report
        }
        this.probe = probeSqlite(this.module)
        report.probe = this.probe
        if (!this.probe.available) {
            return report
        }
        if (!this.probe.fts5) {
            log('warn', 'memory: SQLite build lacks FTS5 — ranked search degrades to LIKE matching')
        }
        return report
    }

    get available(): boolean {
        return this.module !== undefined && this.probe.available
    }

    get capabilities(): SqliteProbe {
        return this.probe
    }

    /** Open (or reuse) the database for `scope`. Returns undefined when unavailable. */
    open(scope: MemoryScope): ScopeStore | undefined {
        const existing = this.stores.get(scope.root)
        if (existing !== undefined) return existing
        if (this.module === undefined || !this.probe.available) return undefined
        if (!ensureDir(scope.root)) {
            log('warn', `memory: cannot create memory root ${scope.root} (sandbox denial?)`)
            return undefined
        }
        try {
            const db = openDatabase(this.module, {
                file: `${scope.root}/memory.db`,
                journalMode: this.config.sqlite.journalMode,
                busyTimeoutMs: this.config.sqlite.busyTimeoutMs,
                fts5: this.probe.fts5,
            })
            const store: ScopeStore = { scope, db, fts5: this.probe.fts5, openedAt: new Date().toISOString() }
            this.stores.set(scope.root, store)
            this.bootstrap(store)
            return store
        } catch (error) {
            log('error', `memory: cannot open ${scope.root}/memory.db:`, error)
            return undefined
        }
    }

    /** First-open bootstrap: import the text view, then load the metric ledger. */
    private bootstrap(store: ScopeStore): void {
        try {
            const imported = bootstrapImport(store.db, store.scope)
            if (imported !== undefined && imported.imported > 0) {
                log('info', `memory: bootstrapped ${imported.imported} records for ${store.scope.root}`)
            }
            const metrics = importMetrics(store.db, store.scope)
            if (metrics > 0) log('info', `memory: imported ${metrics} task metrics for ${store.scope.root}`)
        } catch (error) {
            log('warn', 'memory: bootstrap import failed:', error)
        }
    }

    /** Re-import the text view into an already-open store. */
    reimport(scope: MemoryScope): number {
        const store = this.open(scope)
        if (store === undefined) return 0
        const result = importLessons(store.db, store.scope)
        rebuildFts(store.db, store.fts5)
        return result.imported
    }

    /** Export the store's records back to the git-tracked text view. */
    exportScope(scope: MemoryScope): boolean {
        const store = this.stores.get(scope.root)
        if (store === undefined) return false
        try {
            const result = exportAll(store.db, store.scope)
            if (result.errors.length > 0) log('warn', 'memory: export reported errors:', result.errors)
            return result.errors.length === 0
        } catch (error) {
            log('error', 'memory: export failed:', error)
            return false
        }
    }

    exportIndexOnly(scope: MemoryScope): boolean {
        const store = this.stores.get(scope.root)
        if (store === undefined) return false
        try {
            exportIndex(store.db, store.scope)
            return true
        } catch (error) {
            log('warn', 'memory: index export failed:', error)
            return false
        }
    }

    counts(scope: MemoryScope): RecordCounts | undefined {
        const store = this.stores.get(scope.root)
        return store === undefined ? undefined : countRecords(store.db)
    }

    listOpen(): ScopeStore[] {
        return [...this.stores.values()]
    }

    /** Close one root (used when a scope's work is finished). */
    close(root: string): void {
        const store = this.stores.get(root)
        if (store === undefined) return
        try {
            store.db.close()
        } catch (error) {
            log('warn', `memory: closing ${root} failed:`, error)
        }
        this.stores.delete(root)
    }

    closeAll(): void {
        for (const root of [...this.stores.keys()]) this.close(root)
    }
}

/** Resolve the root directory a scope owns (used by path guards and tests). */
export function scopeRootOf(scope: MemoryScope, dshHome: string): string {
    if (scope.kind === 'project') {
        if (scope.repo === undefined) throw new Error('project scope without a repository root')
        return projectMemoryRoot(scope.repo)
    }
    return globalMemoryRoot(dshHome)
}

/** Counts for every open root — the raw material of `memory_stats`. */
export function openRootCounts(registry: StoreRegistry): { scope: MemoryScope; counts: RecordCounts }[] {
    return registry.listOpen().flatMap((store) => {
        const counts = countRecords(store.db)
        return [{ scope: store.scope, counts }]
    })
}
