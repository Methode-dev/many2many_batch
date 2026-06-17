/** @odoo-module **/

import { Component, onWillUnmount, useEffect, useRef, useState } from "@odoo/owl";
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
        this.rootRef = useRef("root");
        this._pendingFocusDraftId = null;
        this.state = useState({ drafts: [] }); // [{ record, qty }]
        this.state = useState({
            drafts: [],         // [{ record, qty }]
            mergeFlash: null,   // { key, delta, token } — animates the qty cell
                                // of an existing group right after a draft
                                // confirm absorbed records into it
        });
        this._mergeFlashToken = 0;

        useEffect(
            () => {
                if (this._pendingFocusDraftId === null) return;
                this._focusDraftRow(this._pendingFocusDraftId);
                this._pendingFocusDraftId = null;
            },
            () => [this.state.drafts.length]
        );

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

    /**
     * Drafts whose underlying record is still present in props.records by
     * **object reference**.  Reference-identity (not record.id) is the right
     * primitive here because a view switch can auto-save and reload the list,
     * which swaps the OWL record object for a brand-new one with a different
     * id (virtual → real).  Without this prune, the stale draft entry would
     * still render its row while the freshly-swapped record also surfaces in
     * `groups` (id no longer matches the stored draft id) — yielding the
     * duplicate-row flicker seen during widget destruction.  With it, the
     * draft entry drops out on the same render the new record joins `groups`,
     * so the validated row visually replaces the draft row.
     */
    get pendingDrafts() {
        const live = new Set(this.props.records);
        return this.state.drafts.filter((entry) => live.has(entry.record));
    }

    get draftRecords() {
        return new Set(this.pendingDrafts.map((entry) => entry.record));
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
     * with the same display_name never collapse.  Order follows each group's
     * **oldest** record (first occurrence) in props.records: a new group with
     * no prior match lands at the bottom (its first — and only — record was
     * just appended), but when a draft confirms into an *existing* group the
     * group keeps the position of its original record instead of jumping to
     * the bottom alongside the freshly-appended clones.
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
        const draftRecords = this.draftRecords;
        const byKey = new Map();
        let position = 0;
        for (const record of this.props.records) {
            if (draftRecords.has(record)) continue;
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
                byKey.set(key, { key, fieldValues, displayValues, records: [], _firstIndex: position });
            }
            byKey.get(key).records.push(record);
            position++;
        }
        return Array.from(byKey.values()).sort((a, b) => a._firstIndex - b._firstIndex);
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
     * Build the group key for a single record using the same scheme as the
     * `groups` getter — needed by mergeFlash detection to match a draft
     * against existing groups before it is confirmed.
     */
    _recordGroupKey(record) {
        const keyParts = this.props.groupByFields.map((field) =>
            this._keyValue(record.data[field])
        );
        return JSON.stringify(keyParts);
    }

    /** View helper: returns the merge-flash entry for this group, or null. */
    mergeFlashFor(group) {
        const flash = this.state.mergeFlash;
        return flash && flash.key === group.key ? flash : null;
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
            this._pendingFocusDraftId = draft.id;
        }
    }

    /**
     * After the draft row is mounted, focus the first editable cell so the
     * user can start typing immediately without an extra click.
     */
    _focusDraftRow(draftId) {
        const root = this.rootRef.el;
        if (!root) return;
        const rows = root.querySelectorAll(".o_many2many_b_pending_row");
        const row = rows[rows.length - 1];
        if (!row) return;
        const target = row.querySelector(
            "input:not([type='hidden']):not([disabled]), select:not([disabled]), textarea:not([disabled]), [contenteditable='true']"
        );
        if (target) {
            target.focus();
            if (typeof target.select === "function") {
                try { target.select(); } catch (_) {}
            }
        }
    }

    updateDraftQty(entry, rawValue) {
        const qty = parseInt(rawValue, 10);
        if (!isNaN(qty) && qty >= 1) entry.qty = qty;
    }

    async confirmDraft(entry) {
        if (entry.qty < 1) entry.qty = 1;
        // Detect "this draft will merge into an existing group" BEFORE the
        // groups list rebuilds — once we splice the draft out of state.drafts
        // it's just another record in props.records and we lose the signal.
        const draftKey = this._recordGroupKey(entry.record);
        const targetGroup = this.groups.find((g) => g.key === draftKey);
        const isMerge = !!targetGroup;
        const addedQty = entry.qty;

        await this.props.onCloneDraft({ draft: entry.record, qty: entry.qty });
        this._removeDraft(entry);

        if (isMerge) {
            const token = ++this._mergeFlashToken;
            this.state.mergeFlash = { key: draftKey, delta: addedQty, token };
            // Auto-clear after the animation has played; guard against a
            // newer merge flash overriding ours in the meantime.
            setTimeout(() => {
                if (this.state.mergeFlash && this.state.mergeFlash.token === token) {
                    this.state.mergeFlash = null;
                }
            }, 1200);
        }
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
