import { log } from '../log.js';
import { getMeta, setMeta } from '../store/sqlite/db.js';
import { estimateTokens } from './rank.js';
const KEY_PREFIX = 'embed_spend:';
/** UTC day key — the same boundary `dailyDistillTokens` uses. */
export function spendDay(now = new Date()) {
    return new Date(now.getTime() - (now.getTime() % 86_400_000)).toISOString().slice(0, 10);
}
/** Tokens charged to one day (0 when nothing was spent). */
export function embeddingSpend(db, day = spendDay()) {
    const raw = getMeta(db, `${KEY_PREFIX}${day}`);
    if (raw === undefined)
        return 0;
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : 0;
}
/** Add tokens to today's counter. Never throws; the counter is bookkeeping. */
export function chargeEmbedding(db, tokens, now = new Date()) {
    if (!Number.isFinite(tokens) || tokens <= 0)
        return;
    try {
        const day = spendDay(now);
        setMeta(db, `${KEY_PREFIX}${day}`, String(Math.round(embeddingSpend(db, day) + tokens)));
    }
    catch (error) {
        log('debug', 'memory: recording embedding spend failed:', error);
    }
}
/** True when today's embedding budget is used up. `maxTokensPerDay: 0` = no cap. */
export function embeddingBudgetExhausted(config, db, now = new Date()) {
    const cap = config.semantic.maxTokensPerDay;
    if (cap <= 0)
        return false;
    return embeddingSpend(db, spendDay(now)) >= cap;
}
/** Estimated tokens for one batch of texts (what the endpoint will bill roughly). */
export function estimateEmbeddingTokens(texts) {
    let total = 0;
    for (const text of texts)
        total += estimateTokens(text);
    return total;
}
/** Month-to-date embedding spend (sum of the daily keys), for `memory_stats`. */
export function embeddingSpendMonth(db, now = new Date()) {
    const month = spendDay(now).slice(0, 7);
    let total = 0;
    try {
        const rows = db.prepare('SELECT key, value FROM meta WHERE key LIKE ?').all(`${KEY_PREFIX}${month}-%`);
        for (const row of rows) {
            const value = Number(row['value']);
            if (Number.isFinite(value) && value > 0)
                total += value;
        }
    }
    catch {
        // a missing meta table (or a malformed row) means "nothing recorded"
    }
    return total;
}
//# sourceMappingURL=embed-budget.js.map