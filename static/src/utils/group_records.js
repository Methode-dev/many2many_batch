/** @odoo-module **/

/**
 * Groups an array of OWL/Odoo records by the given field names.
 *
 * @param {Object[]} records   - Array of record objects (from StaticList.records).
 *                               Each record has a `.data` dict of field values.
 * @param {string[]} groupByFields - Ordered list of field names to group by.
 * @returns {Array<{
 *   key: string,
 *   fieldValues: Object,   // { fieldName: rawValue }
 *   records: Object[]      // the original record objects in this group
 * }>}
 */
export function groupRecords(records, groupByFields) {
    /** @type {Map<string, {key: string, fieldValues: Object, records: Object[]}>} */
    const groups = new Map();

    for (const record of records) {
        // Build a stable, serialisable key from the group-by field values.
        // For many2one fields the value is [id, display_name]; we key on id only.
        const keyParts = groupByFields.map((f) => {
            const val = record.data[f];
            if (val && typeof val === "object" && !Array.isArray(val) && "id" in val) {
                return val.id;
            }
            if (Array.isArray(val) && val.length === 2) {
                // legacy [id, display_name] tuple
                return val[0];
            }
            return val ?? null;
        });

        const key = JSON.stringify(keyParts);

        if (!groups.has(key)) {
            // Store the raw .data values so the renderer can display them.
            const fieldValues = Object.fromEntries(
                groupByFields.map((f) => [f, record.data[f]])
            );
            groups.set(key, { key, fieldValues, records: [] });
        }
        groups.get(key).records.push(record);
    }

    return [...groups.values()];
}
