/** @odoo-module **/

/**
 * Flip to false to silence all [m2m_b] output without touching call sites.
 */
export const M2M_DEBUG = true;

/**
 * Format a field value into a compact, readable string.
 *   Many2one object  {id:5, display_name:"Active"} → '5:"Active"'
 *   Legacy tuple     [5, "Active"]                 → '5:"Active"'
 *   false / null     → null
 *   anything else    → the value as-is
 */
export function fmtVal(v) {
    if (v === false || v === null || v === undefined || v === "") return null;
    if (v && typeof v === "object" && "id" in v) {
        return `${v.id}:"${v.display_name || v.name || ""}"`;
    }
    if (Array.isArray(v) && v.length >= 2) {
        return `${v[0]}:"${v[1]}"`;
    }
    return v;
}

/**
 * Snapshot of a record's current state for the given fields.
 *
 * Returns:
 *   { id, isNew, inEdition, data: {field→fmtVal}, _changes: {field→fmtVal} }
 *
 * `_changes` only appears when there are pending writes for the listed fields.
 * Comparing data vs _changes tells you whether Odoo's reconciliation will
 * revert the displayed value on next validation.
 */
export function snap(record, fields) {
    if (!record) return null;
    const data = {};
    const pending = {};
    for (const f of fields) {
        data[f] = fmtVal(record.data?.[f]);
        if (record._changes && f in record._changes) {
            pending[f] = fmtVal(record._changes[f]);
        }
    }
    return {
        id: record.id,
        isNew: Boolean(record.isNew),
        inEdition: Boolean(record.isInEdition),
        data,
        ...(Object.keys(pending).length ? { _changes: pending } : {}),
    };
}

/** console.group that is a no-op when M2M_DEBUG is false. */
export function dbgGroup(title) {
    if (M2M_DEBUG) console.group(`[m2m_b] ${title}`);
}

/** Paired close for dbgGroup. */
export function dbgGroupEnd() {
    if (M2M_DEBUG) console.groupEnd();
}

/** Single log line, no-op when M2M_DEBUG is false. */
export function dbg(...args) {
    if (M2M_DEBUG) console.log("[m2m_b]", ...args);
}

/** Error line always printed (bugs, not noise). */
export function dbgErr(...args) {
    console.error("[m2m_b]", ...args);
}
