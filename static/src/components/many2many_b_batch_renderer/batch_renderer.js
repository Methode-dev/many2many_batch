/** @odoo-module **/

import { Component, onWillUnmount, useEffect, useState } from "@odoo/owl";
import { useService } from "@web/core/utils/hooks";
import { ConfirmationDialog } from "@web/core/confirmation_dialog/confirmation_dialog";
import { GroupByCell } from "../group_by_cell/group_by_cell";

/**
 * Renders the batch view of the many2many_b widget.
 *
 * Table layout:
 *   Qty | <groupByField_1> | ... | <groupByField_N> | (actions)
 *
 * Records are grouped CLIENT-SIDE by the configured groupByFields.
 * Each row = one group. Qty = group.records.length (live, reactive).
 *
 * Drafts: "Add a line" creates a real (but unsaved) record via the parent's
 * onAddDraft callback. The draft is tracked in state.drafts and rendered as
 * its own row with proper Field widgets, separate from grouped rows.  On
 * confirm, qty-1 additional records are cloned from the draft; on discard,
 * the draft is deleted.
 */
export class BatchRenderer extends Component {
    static template = "many2many_batch.BatchRenderer";
    static components = { GroupByCell };

    static props = {
        records: { type: Array },           // list.records (item records)
        groupByFields: { type: Array },     // ["state_id", "driver_id", ...]
        defaultValueKeys: { type: Array },  // fields auto-filled at item creation
        fields: { type: Object },           // field descriptors of the item model
        readonly: { type: Boolean },
        onQtyChange: { type: Function },    // ({group, delta}) => Promise<void>
        onAddDraft: { type: Function },     // () => Promise<OwlRecord>
        onCloneDraft: { type: Function },   // ({draft, qty}) => Promise<void>
        onDiscardDraft: { type: Function }, // (draft) => Promise<void>
    };

    setup() {
        this.dialogService = useService("dialog");
        this.state = useState({ drafts: [] }); // [{ record, qty }]

        // Flip every record into edit mode so embedded <Field> widgets render
        // editable.  Records loaded from DB default to "readonly" mode in
        // Odoo 19 (isInEdition only auto-true when isNew); without this flip
        // <Field> shows a static link/text instead of an input.  Re-runs
        // whenever the records collection grows (drafts added, etc.).
        useEffect(
            () => this._ensureRecordsEditable(),
            () => [this.props.records.length]
        );

        // On unmount (mode switch to individual), undo the bulk edit-mode flip
        // so the standard list renderer's single-editedRecord invariant holds.
        // Without this, clicking "Add a line" in individual mode walks through
        // every leaked in-edit record one click at a time before creating one.
        onWillUnmount(() => this._restoreRecordsReadonly());
    }

    _ensureRecordsEditable() {
        for (const record of this.props.records) {
            if (record && !record.isInEdition && typeof record.switchMode === "function") {
                record.switchMode("edit");
            }
        }
    }

    _restoreRecordsReadonly() {
        for (const record of this.props.records) {
            if (!record || record.isNew) continue;
            if (record.isInEdition && typeof record.switchMode === "function") {
                record.switchMode("readonly");
            }
        }
    }

    // -------------------------------------------------------------------------
    // Drafts
    // -------------------------------------------------------------------------

    get draftRecordIds() {
        const ids = new Set();
        for (const entry of this.state.drafts) {
            ids.add(entry.record.id);
        }
        return ids;
    }

    // -------------------------------------------------------------------------
    // Grouping (live, derived from props.records, excluding drafts)
    // -------------------------------------------------------------------------

    /**
     * Returns the list of groups derived from props.records, excluding any
     * draft records (which are rendered as their own rows).
     *
     * Groups are keyed by the *raw* values of the configured groupByFields
     * (Many2one → id, Selection/Char → value) so two distinct comodel rows
     * with the same display_name never collapse.  Groups are sorted by
     * displayValues in the declared groupByFields order, giving deterministic
     * output for ordered multi-field grouping (e.g. article_type, then
     * material_type within each type).
     *
     * Each group:
     *   {
     *     key:           stable JSON key for t-key,
     *     fieldValues:   { <field>: <raw record.data value> },
     *     displayValues: { <field>: <human-readable string> },
     *     records:       OwlRecord[],
     *   }
     */
    get groups() {
        const draftIds = this.draftRecordIds;
        const byKey = new Map();
        for (const record of this.props.records) {
            if (draftIds.has(record.id)) continue;
            const fieldValues = {};
            const displayValues = {};
            const keyParts = [];
            for (const field of this.props.groupByFields) {
                const value = record.data[field];
                fieldValues[field] = value;
                displayValues[field] = this._formatValue(value);
                keyParts.push(this._keyValue(value));
            }
            const key = JSON.stringify(keyParts);
            if (!byKey.has(key)) {
                byKey.set(key, { key, fieldValues, displayValues, records: [] });
            }
            byKey.get(key).records.push(record);
        }
        return Array.from(byKey.values()).sort((a, b) => this._compareGroups(a, b));
    }

    _formatValue(value) {
        if (value === false || value === null || value === undefined || value === "") return "";
        if (Array.isArray(value) && value.length === 2) return String(value[1]);
        if (typeof value === "object" && value !== null) {
            if ("display_name" in value) return String(value.display_name);
            if ("name" in value) return String(value.name);
            if ("id" in value) return String(value.id);
        }
        return String(value);
    }

    _keyValue(value) {
        if (value === false || value === null || value === undefined || value === "") return null;
        if (value && typeof value === "object" && "id" in value) return value.id;
        if (Array.isArray(value) && value.length === 2) return value[0];
        return value;
    }

    /**
     * Order groups by displayValues using the declared groupByFields as a
     * sort key tuple (primary, secondary, ...).  Empty/unset values sort
     * last within each level so populated groups always lead.
     */
    _compareGroups(a, b) {
        for (const field of this.props.groupByFields) {
            const av = a.displayValues[field] || "";
            const bv = b.displayValues[field] || "";
            if (av === bv) continue;
            if (av === "") return 1;
            if (bv === "") return -1;
            const cmp = av.localeCompare(bv);
            if (cmp !== 0) return cmp;
        }
        return 0;
    }

    // -------------------------------------------------------------------------
    // Field labels
    // -------------------------------------------------------------------------

    getFieldLabel(fieldName) {
        return this.props.fields?.[fieldName]?.string || fieldName;
    }

    // -------------------------------------------------------------------------
    // Virgin-record guard
    // -------------------------------------------------------------------------

    /**
     * Returns true when every record in a group is "virgin"
     * (has no data beyond the fields that were auto-filled at creation time).
     *
     * Non-virgin records have been individually edited → the [−] button is
     * disabled so the user must switch to individual mode to remove them.
     */
    isAllRecordsVirgin(group) {
        const skip = new Set([
            ...this.props.defaultValueKeys,
            "id",
            "display_name",
        ]);
        for (const record of group.records) {
            for (const [key, value] of Object.entries(record.data)) {
                if (skip.has(key) || key.startsWith("__")) continue;
                if (this._isValueSet(value)) return false;
            }
        }
        return true;
    }

    _isValueSet(value) {
        if (value === false || value === null || value === undefined || value === "") return false;
        if (typeof value === "number" && value === 0) return false;
        if (Array.isArray(value) && value.length === 0) return false;
        if (value && typeof value === "object" && "records" in value) {
            return value.records.length > 0;
        }
        return true;
    }

    // -------------------------------------------------------------------------
    // Group actions
    // -------------------------------------------------------------------------

    onIncrement(group) {
        this.props.onQtyChange({ group, delta: 1 });
    }

    onDecrement(group) {
        if (group.records.length > 1 && this.isAllRecordsVirgin(group)) {
            this.props.onQtyChange({ group, delta: -1 });
        }
    }

    onRemoveAll(group) {
        const count = group.records.length;
        this.dialogService.add(ConfirmationDialog, {
            title: "Remove group",
            body: `Remove this group (${count} record${count !== 1 ? "s" : ""})? This cannot be undone until the form is saved.`,
            confirmLabel: "Remove",
            confirm: () => this.props.onQtyChange({ group, delta: "remove_all" }),
            cancel: () => {},
        });
    }

    // -------------------------------------------------------------------------
    // Draft-row lifecycle (Add a line)
    // -------------------------------------------------------------------------

    async addDraft() {
        const draft = await this.props.onAddDraft();
        if (draft) {
            this.state.drafts.push({ record: draft, qty: 1 });
        }
    }

    updateDraftQty(entry, rawValue) {
        const qty = parseInt(rawValue, 10);
        if (!isNaN(qty) && qty >= 1) entry.qty = qty;
    }

    async confirmDraft(entry) {
        if (entry.qty < 1) entry.qty = 1;
        await this.props.onCloneDraft({ draft: entry.record, qty: entry.qty });
        this._removeDraft(entry);
    }

    async discardDraft(entry) {
        await this.props.onDiscardDraft(entry.record);
        this._removeDraft(entry);
    }

    _removeDraft(entry) {
        const idx = this.state.drafts.indexOf(entry);
        if (idx !== -1) this.state.drafts.splice(idx, 1);
    }
}
