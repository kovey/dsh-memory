/**
 * L5 — identity and preference memory (DESIGN §3, §6).
 *
 * The layer is plain markdown under `<memory root>/profile/`: permanent, written
 * by a human (or by an explicit, user-confirmed save) and rendered into the
 * resident prompt section, so a preference stays in effect without being
 * recalled. It was declared in the config, the layer enum and the store types
 * from the start, but nothing ever read or wrote it.
 *
 * The reading side is deliberately tiny and total: a missing directory is a
 * normal state, every file is size-capped, and one unreadable file never breaks
 * prompt assembly.
 */
import fs from 'node:fs';
import path from 'node:path';
import { log } from '../log.js';
import { assertInsideScope } from '../store/guard.js';
import { writeAtomic } from '../store/export.js';
/** Files that make up the layer, in render order. */
export const PROFILE_FILES = ['preferences.md', 'conventions.md'];
/**
 * A profile file *name* (without `.md`): lowercase letters, digits and dashes.
 *
 * This is a security boundary, not cosmetics: `memory_save` takes the name from
 * a model, and `../../lessons/x` or `/etc/passwd` must never resolve to a path.
 * `profileFilePath` still re-checks with `assertInsideScope`, so a traversal bug
 * here is caught there as well.
 */
export const PROFILE_NAME_RE = /^[a-z0-9-]{1,64}$/;
/** True when `name` may be used as `<memory root>/profile/<name>.md`. */
export function isProfileName(name) {
    return PROFILE_NAME_RE.test(name);
}
/** Heading used when a profile file is created (existing files are kept as-is). */
function headingFor(name) {
    return name === 'preferences' ? '# 偏好' : `# ${name}`;
}
/** Per-file cap: a preference is a line or two, not an essay. */
const MAX_FILE_BYTES = 4_000;
export function profileDir(scope) {
    return path.join(scope.root, 'profile');
}
/**
 * Path of one profile file, with the *name* rule enforced here rather than at
 * the call sites.
 *
 * `isProfileName` used to be checked only on the `memory_save` tool surface and
 * in `appendProfileLine`, so every other writer (`writeProfile`, a test, a future
 * caller) could create `profile/UPPER.md`, `profile/a.b.md` or `profile/x/y.md`:
 * names that stay inside the root but are not part of the documented layer. The
 * rule belongs where the path is built — one door, one check.
 *
 * Returns `undefined` (and logs) for a name that is not a bare `[a-z0-9-]` slug
 * or that would resolve outside the scope.
 */
export function profileFilePath(scope, name) {
    // `preferences.md` and `preferences` are the same file.
    const base = name.endsWith('.md') ? name.slice(0, -3) : name;
    if (!isProfileName(base)) {
        log('warn', `memory: refusing profile file name ${JSON.stringify(name)} — allowed: [a-z0-9-] (no dots, no slashes)`);
        return undefined;
    }
    return fileInsideProfile(scope, `${base}.md`);
}
/**
 * Path inside `<root>/profile/`, contained by the scope but *not* name-filtered.
 *
 * The reader uses this: the layer is "plain markdown under `profile/`", so a file
 * a human dropped there (`hand.written.md`) is part of it. The name rule governs
 * names this plugin *creates* — which are always model-supplied — not the files
 * somebody wrote by hand.
 */
function fileInsideProfile(scope, fileName) {
    try {
        const file = path.join(profileDir(scope), fileName);
        assertInsideScope(scope, file);
        return file;
    }
    catch (error) {
        log('warn', `memory: refusing to use a profile path outside the scope (${error.message})`);
        return undefined;
    }
}
/** Read the layer's files, newest content first is not a thing here — order is fixed. */
export function readProfile(scope) {
    const entries = [];
    const dir = profileDir(scope);
    let names;
    try {
        names = fs.readdirSync(dir).filter((name) => name.endsWith('.md'));
    }
    catch {
        return entries;
    }
    const ordered = [
        ...PROFILE_FILES.filter((name) => names.includes(name)),
        ...names.filter((name) => !PROFILE_FILES.includes(name)).sort(),
    ];
    for (const name of ordered) {
        const file = fileInsideProfile(scope, name);
        if (file === undefined)
            continue;
        try {
            const stat = fs.statSync(file);
            if (!stat.isFile() || stat.size === 0)
                continue;
            if (stat.size > MAX_FILE_BYTES) {
                log('debug', `memory: profile file ${name} is larger than ${MAX_FILE_BYTES} bytes — truncated`);
            }
            const text = fs.readFileSync(file, 'utf8').slice(0, MAX_FILE_BYTES).trim();
            if (text !== '')
                entries.push({ name, text });
        }
        catch (error) {
            log('debug', `memory: skipping unreadable profile file ${name}:`, error);
        }
    }
    return entries;
}
/**
 * Render the layer for the resident section: a short heading, then each file's
 * lines until the budget is spent. Bounded like every other prompt surface.
 */
export function renderProfile(entries, budgetTokens = 200) {
    if (entries.length === 0)
        return '';
    const header = '偏好（L5，长期有效）：';
    const lines = [header];
    let used = 0;
    for (const entry of entries) {
        for (const raw of entry.text.split('\n')) {
            const line = raw.trim();
            if (line === '' || line.startsWith('---') || line.startsWith('#'))
                continue;
            // rough token estimate: CJK ≈ 1 token/char, ASCII ≈ 1/4
            const cost = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/.test(line)
                ? line.length
                : Math.ceil(line.length / 4);
            if (used + cost > budgetTokens)
                return lines.join('\n');
            used += cost;
            lines.push(line.startsWith('-') ? line : `- ${line}`);
        }
    }
    return lines.length > 1 ? lines.join('\n') : '';
}
/** Replace one profile file's content (used by a confirmed `memory_save`). */
export function writeProfile(scope, name, text) {
    const file = profileFilePath(scope, name);
    if (file === undefined)
        return undefined;
    try {
        fs.mkdirSync(profileDir(scope), { recursive: true });
        writeAtomic(file, text.endsWith('\n') ? text : `${text}\n`);
        return file;
    }
    catch (error) {
        log('warn', `memory: writing profile ${name} failed:`, error);
        return undefined;
    }
}
/**
 * Append one line to any L5 file, keeping it a list.
 *
 * `preferences.md` is the default door (`appendPreference`), but the layer is
 * "plain markdown under `profile/`": `conventions.md` and friends are legitimate
 * L5 files and had no write path at all before this. The name is validated here
 * rather than at the call site so every writer — tool, test, future caller —
 * gets the same guarantee.
 */
export function appendProfileLine(scope, name, line, now = new Date()) {
    if (!isProfileName(name)) {
        log('warn', `memory: refusing profile file name ${JSON.stringify(name)} — allowed: [a-z0-9-] (no dots, no slashes)`);
        return undefined;
    }
    const file = profileFilePath(scope, name);
    if (file === undefined)
        return undefined;
    try {
        const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : `${headingFor(name)}\n`;
        const trimmed = line.trim().replace(/^-\s*/, '');
        if (existing.includes(trimmed))
            return file;
        const body = `${existing.trimEnd()}\n- ${trimmed}  <!-- ${now.toISOString().slice(0, 10)} -->\n`;
        return writeProfile(scope, name, body);
    }
    catch (error) {
        log('warn', `memory: appending to profile ${name} failed:`, error);
        return undefined;
    }
}
/** Append one preference line to `preferences.md`, keeping it a list. */
export function appendPreference(scope, line, now = new Date()) {
    return appendProfileLine(scope, 'preferences', line, now);
}
//# sourceMappingURL=profile.js.map