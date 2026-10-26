/** @odoo-module **/

import { useState } from "@odoo/owl";
import { makeContext } from "@web/core/context";
import { x2ManyCommands } from "@web/core/orm_service";
import { registry } from "@web/core/registry";
import { X2ManyField, x2ManyField } from "@web/views/fields/x2many/x2many_field";
import { BatchRenderer } from "../many2many_b_batch_renderer/batch_renderer";
import { dbg, dbgErr, dbgGroup, dbgGroupEnd, snap } from "../../utils/debug";

/**
 * Many2manyB — a One2many/Many2many widget with two view modes:
 *
 *   - individual : standard embedded Odoo list (one row per item).
 *   - batch      : custom grouped table (Qty | <group_by_field>... | actions).
 *
 * Items are grouped CLIENT-SIDE by the fields listed in batch_group_by.
 * Qty per group = group.records.length (live, reactive).
 *
 * XML usage:
 *   <field name="vehicle_ids"
 *          widget="many2many_b"
 *          options='{"batch_group_by": "state_id",
 *                    "default_mode":   "batch",
 *                    "default_values": {"odometer_unit": "km"}}'/>
 *
 * Options:
 *   batch_group_by  : comma-separated field names on the related model.
 *   default_mode    : "batch" | "individual" (default "individual").
 *   default_values  : plain object of field->value pairs injected as
 *                     default_<field> context keys when creating new items.
 *                     Used for mandatory fields that are not group-by fields
 *                     (e.g. odometer_unit on fleet.vehicle).
 */
export class Many2ManyBField extends X2ManyField {
    static template = "many2many_batch.Many2ManyBField";
    static components = {
        ...X2ManyField.components,
        BatchRenderer,
    };

    setup() {
        super.setup();
        const defaultMode =
            this.props.crudOptions?.default_mode === "batch" ? "batch" : "individual";
        this.batchState = useState({ mode: defaultMode });
    }

    // -------------------------------------------------------------------------
    // Derived properties
    // -------------------------------------------------------------------------

    get groupByFields() {
        const raw = this.props.crudOptions?.batch_group_by || "";
        return raw.split(",").map((f) => f.trim()).filter(Boolean);
    }

    get hasBatchMode() {
        return this.groupByFields.length > 0;
    }

    get isReadonly() {
        return this.props.readonly;
    }

    /**
     * Fields auto-filled when a NEW ITEM is created in batch mode:
     *   - the batch_group_by fields (taken from the group's identity)
     *   - any fields in default_values
     * Used by BatchRenderer's virgin-record guard.
     */
    get defaultValueKeys() {
        const staticKeys = Object.keys(this.props.crudOptions?.default_values || {});
        return [...this.groupByFields, ...staticKeys];
    }

    // -------------------------------------------------------------------------
    // Mode switching
    // -------------------------------------------------------------------------

    setMode(mode) {
        this.batchState.mode = mode;
    }

    // -------------------------------------------------------------------------
    // "Add a line" — force inline quick-create for Many2many (individual mode)
    // -------------------------------------------------------------------------

    /**
     * Stock X2ManyField.onAdd hard-codes SelectCreateDialog for Many2many,
     * regardless of editable="bottom". We want sale-order-line UX: clicking
     * "Add a line" appends an inline draft row. Logic mirrors the editable
     * branch of the stock implementation.
     */
    async onAdd({ context, editable } = {}) {
        if (!this.isMany2Many || !editable) {
            return super.onAdd({ context, editable });
        }
        context = makeContext([this.props.context, context]);
        const edited = this.list.editedRecord;
        if (edited) {
            const proms = [];
            this.list.model.bus.trigger("NEED_LOCAL_CHANGES", { proms });
            await Promise.all([...proms, edited._updatePromise]);
            await this.list.leaveEditMode({ canAbandon: false });
        }
        if (!this.list.editedRecord) {
            return this.addInLine({ context, editable });
        }
    }

    // -------------------------------------------------------------------------
    // Qty-change handler (called by BatchRenderer)
    // -------------------------------------------------------------------------

    /**
     * @param {{ group: {fieldValues, records[]}, delta: number|"remove_all" }} param0
     *
     * delta > 0          : add |delta| new items to this group.
     * delta < 0          : remove |delta| items from this group (last first).
     * delta = "remove_all" : delete every item of this group.
     */
    async onQtyChange({ group, delta }) {
        if (delta === "remove_all") {
            // ── LOG ─────────────────────────────────────────────────────────
            dbgGroup(`QTY REMOVE ALL | group key: ${group.key} | ${group.records.length} records`);
            for (const [i, r] of group.records.entries()) {
                dbg(`  record[${i}]:`, snap(r, this.groupByFields));
            }
            // ────────────────────────────────────────────────────────────────
            for (const record of [...group.records]) {
                await this.list.delete(record);
            }
            dbg("AFTER  all deleted");
            dbgGroupEnd();
            return;
        }

        if (delta > 0) {
            // ── LOG ─────────────────────────────────────────────────────────
            dbgGroup(`QTY INCREMENT +${delta} | group key: ${group.key}`);
            dbg("ACTION  group fieldValues:", group.fieldValues);
            // ────────────────────────────────────────────────────────────────
            await this._addRecordsLike(group.fieldValues, delta);
            dbgGroupEnd();
            return;
        }

        if (delta < 0) {
            const toRemove = group.records.slice(delta); // last |delta| items
            // ── LOG ─────────────────────────────────────────────────────────
            dbgGroup(`QTY DECREMENT ${delta} | group key: ${group.key}`);
            for (const [i, r] of toRemove.entries()) {
                dbg(`  removing record[${i}]:`, snap(r, this.groupByFields));
            }
            // ────────────────────────────────────────────────────────────────
            for (const record of toRemove) {
                await this.list.delete(record);
            }
            dbg("AFTER  deleted");
            dbgGroupEnd();
        }
    }

    // -------------------------------------------------------------------------
    // Draft lifecycle (called by BatchRenderer for the "Add a line" flow)
    // -------------------------------------------------------------------------

    /**
     * Creates one new item with only static default_values pre-filled (no
     * group-by values yet — the user will type them via Field widgets in the
     * draft row).  Returns the newly created OWL record.
     */
    async onAddDraft() {
        const context = this._buildContext({});
        return await this.list.addNewRecord({ context, position: "bottom" });
    }

    /**
     * Commit a draft row left by the user: N-1 more records like it for a
     * qty of N, or the draft dropped when none of its group-by fields was
     * filled. Resolves to whether it was kept.
     *
     * Queued on the model mutex rather than run now, and that ordering is the
     * point: the edit of the field the user just left (a Char or Integer input
     * writes on change, i.e. as focus leaves it) is already queued ahead of
     * it, and a Save the same click goes on to trigger is queued behind it.
     * Read now, the draft would miss its last field; run later, the Save would
     * store a single record instead of N.
     */
    onSettleDraft({ draft, qty }) {
        const list = this.list;
        return list.model.mutex.exec(async () => {
            const filled = this.groupByFields.some((field) => {
                const value = draft.data[field];
                return !(value === false || value === null || value === undefined || value === "" || value === 0);
            });
            if (!filled) {
                await list._applyCommands([[x2ManyCommands.DELETE, draft.resId || draft._virtualId]]);
                await list._onUpdate();
                return false;
            }
            dbg(`SETTLE DRAFT #${draft.id} × ${qty}`, snap(draft, this.groupByFields));
            await this._createRecordsLike(this._groupValues(draft), qty - 1);
            await list._onUpdate();
            return true;
        });
    }

    _groupValues(record) {
        const values = {};
        for (const field of this.groupByFields) {
            const value = record.data[field];
            if (value === false || value === null || value === undefined || value === "") continue;
            values[field] = value;
        }
        return values;
    }

    /**
     * Add ``count`` records carrying a group's ``fieldValues``, as one model
     * mutex job: a Save clicked right after [+] must find them complete.
     */
    _addRecordsLike(fieldValues, count) {
        const list = this.list;
        return list.model.mutex.exec(async () => {
            await this._createRecordsLike(fieldValues, count);
            await list._onUpdate();
        });
    }

    /**
     * Create ``count`` records at the bottom of the list, stamped with
     * ``fieldValues`` without an onchange. Call it from inside a mutex job.
     *
     * Stamping in the same job as the creation is what keeps the values: the
     * creation's onchange may default them differently (a crew row's
     * nationality onchange re-defaults its visa situation, which once saved 8
     * "VOA" joiners as 1 VOA + 7 "VISA at consulate"), and a Save slipping in
     * between would persist the default.
     *
     * Uses StaticList internals (_createNewRecordDatapoint, _addRecord) since
     * the public addNewRecord takes the mutex itself.
     */
    async _createRecordsLike(fieldValues, count) {
        const list = this.list;
        const context = this._buildContext(fieldValues);
        for (let added = 0; added < count; added++) {
            const record = await list._createNewRecordDatapoint({ context, manuallyAdded: true });
            await record._update(fieldValues, { withoutOnchange: true });
            await list._addRecord(record, { position: "bottom" });
        }
    }

    /** Delete a discarded draft from the bound list. */
    async onDiscardDraft(draft) {
        await this.list.delete(draft);
    }

    /**
     * Build a context dict with default_<field> keys from default_values
     * (static) overlaid with group field values.
     */
    _buildContext(fieldValues) {
        const context = {};
        const staticDefaults = this.props.crudOptions?.default_values || {};
        for (const [field, value] of Object.entries(staticDefaults)) {
            context[`default_${field}`] = value;
        }
        for (const [field, value] of Object.entries(fieldValues || {})) {
            if (value && typeof value === "object" && "id" in value) {
                context[`default_${field}`] = value.id;
            } else if (Array.isArray(value) && value.length === 2) {
                context[`default_${field}`] = value[0];
            } else if (value !== false && value !== null && value !== undefined && value !== "") {
                context[`default_${field}`] = value;
            }
        }
        return context;
    }
}

// ---------------------------------------------------------------------------
// Field registration
// ---------------------------------------------------------------------------

export const many2ManyBField = {
    ...x2ManyField,
    component: Many2ManyBField,
};

registry.category("fields").add("many2many_b", many2ManyBField);
