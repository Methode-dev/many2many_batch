/** @odoo-module **/

import { useState } from "@odoo/owl";
import { makeContext } from "@web/core/context";
import { registry } from "@web/core/registry";
import { X2ManyField, x2ManyField } from "@web/views/fields/x2many/x2many_field";
import { BatchRenderer } from "../many2many_b_batch_renderer/batch_renderer";

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
            for (const record of [...group.records]) {
                await this.list.delete(record);
            }
            return;
        }

        if (delta > 0) {
            const context = this._buildContext(group.fieldValues);
            for (let i = 0; i < delta; i++) {
                await this.list.addNewRecord({ context, position: "bottom" });
            }
            return;
        }

        if (delta < 0) {
            const toRemove = group.records.slice(delta); // last |delta| items
            for (const record of toRemove) {
                await this.list.delete(record);
            }
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
     * After the user confirms a draft row with qty=N, clone the draft
     * (qty-1) more times so the group ends up with N records sharing the
     * draft's group-by values.
     */
    async onCloneDraft({ draft, qty }) {
        if (qty <= 1) return;
        const fieldValues = {};
        for (const field of this.groupByFields) {
            fieldValues[field] = draft.data[field];
        }
        const context = this._buildContext(fieldValues);
        for (let i = 0; i < qty - 1; i++) {
            await this.list.addNewRecord({ context, position: "bottom" });
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
