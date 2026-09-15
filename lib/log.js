/**
 * File-only logger. The plugin must never write to stdout or stderr: the TUI
 * renders stdout and the web server owns its own console (DESIGN §9.3).
 *
 * Every function here is failure-tolerant — logging must never break a hook.
 */
import fs from 'node:fs';
import path from 'node:path';
const MAX_BYTES = 5 * 1024 * 1024;
let logFile;
let disabled = false;
/** Point the logger at `file` (already home-expanded). `undefined` disables it. */
export function setLogFile(file) {
    logFile = file;
    disabled = file === undefined;
    if (file === undefined)
        return;
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
    }
    catch {
        disabled = true;
    }
}
function rotateIfNeeded(file) {
    try {
        const stat = fs.statSync(file);
        if (stat.size < MAX_BYTES)
            return;
        fs.renameSync(file, `${file}.1`);
    }
    catch {
        // missing file or rename failure: keep appending
    }
}
export function log(level, ...args) {
    if (disabled || logFile === undefined)
        return;
    const line = `[${new Date().toISOString()}] [${level}] ${args.map(format).join(' ')}\n`;
    try {
        rotateIfNeeded(logFile);
        fs.appendFileSync(logFile, line);
    }
    catch {
        // never propagate: a failed log write is not a session failure
    }
}
function format(value) {
    if (typeof value === 'string')
        return value;
    if (value instanceof Error)
        return `${value.name}: ${value.message}`;
    try {
        return JSON.stringify(value);
    }
    catch {
        return String(value);
    }
}
//# sourceMappingURL=log.js.map