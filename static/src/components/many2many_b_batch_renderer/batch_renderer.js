/** @odoo-module **/

import { Component, onWillUnmount, useEffect, useRef, useState } from "@odoo/owl";
import { useService } from "@web/core/utils/hooks";
import { ConfirmationDialog } from "@web/core/confirmation_dialog/confirmation_dialog";
import { GroupByCell } from "../group_by_cell/group_by_cell";
import { dbg, dbgErr, dbgGroup, dbgGroupEnd, snap } from "../../utils/debug";

/**
 * Renders the batch view of the many2many_b widget.
 *
 * Table layout:
 *   <groupByField_1> | ... | <groupByField_N> | Qty | (actions)
 *
 * Records are grouped CLIENT-SIDE by the configured groupByFields.
 * Each row = one group. Qty = group.records.length (live, reactive).
 *
 * Batch-edit propagation
 * ─────────────────────
 * For each group, BatchRenderer wraps group.records[0].update() so that any
 * change to a group-by field is:
 *   1. Synchronously mirrored into sibling.data (prevents the render flash
 *      that would briefly show a split row before siblings catch up).
 *   2. Properly awaited via sibling.update() so that _changes is written and
 *      the change survives Odoo's reactive reconciliation on validation.
 *
 * The wrap is installed whenever a new host record (records[0] of a group)
 * appears, and torn down on unmount.
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
        this.state = useState({
            drafts: [],         // [{ record, qty }]
            mergeFlash: null,   // { key, delta, token } — animates the qty cell
            highlightedIds: {},
            isBusy: false,      // true while a multi-record async op is running
        });
        this._mergeFlashToken = 0;
        this._previousRecordIds = new Set();

        // Host-wrapping for batch-edit propagation.
        this._wrappedHosts = new Set();
        this._originalUpdates = new WeakMap();

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
        // <Field> shows a static link/text instead of an input.
        useEffect(
            () => this._ensureRecordsEditable(),
            () => [this.props.records.length]
        );

        // Install the host-update wrapper on any new group host records.
        // Depends on records.length — new records may introduce new groups.
        useEffect(
            () => this._wrapNewHosts(),
            () => [this.props.records.length]
        );

        onWillUnmount(() => {
            this._unwrapAllHosts();
            this._restoreRecordsReadonly();
        });

        // Highlight newly added records with a yellow fade-out animation.
        useEffect(
            () => {
                const currentIds = new Set(this.props.records.map((r) => r.id));
                const newIds = [...currentIds].filter((id) => !this._previousRecordIds.has(id));

                if (newIds.length > 0) {
                    const newHighlighted = { ...this.state.highlightedIds };
                    for (const id of newIds) {
                        newHighlighted[id] = true;
                        setTimeout(() => {
                            const ids = { ...this.state.highlightedIds };
                            delete ids[id];
                            this.state.highlightedIds = ids;
                        }, 2000);
                    }
                    this.state.highlightedIds = newHighlighted;
                }

                this._previousRecordIds = currentIds;
            },
            () => [this.props.records.length]
        );
    }

    // -------------------------------------------------------------------------
    // Record edit-mode helpers
    // -------------------------------------------------------------------------

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
    // Batch-edit host wrapping
    // -------------------------------------------------------------------------

    /**
     * For each group whose host (records[0]) has not yet been wrapped, installs
     * a wrapper on host.update() that propagates group-by field changes to all
     * sibling records in the group.
     *
     * The wrapper:
     *   1. Synchronously writes newValue into sibling.data[field] (visual sync,
     *      prevents the brief split-then-merge flash on re-render).
     *   2. Awaits originalUpdate(changes) on the host so _changes is written.
     *   3. Sequentially awaits sibling.update({ field: newValue }) for every
     *      sibling so their _changes are written and survive Odoo's reactive
     *      reconciliation at validation time.
     */
    _wrapNewHosts() {
        for (const group of this.groups) {
            const host = group.records[0];
            if (!host || this._wrappedHosts.has(host)) continue;
            this._wrapHostUpdate(host);
            this._wrappedHosts.add(host);
        }
    }

    _wrapHostUpdate(host) {
        const originalUpdate = host.update.bind(host);
        this._originalUpdates.set(host, originalUpdate);

        // Keep a live reference to the component so the wrapper can read
        // this.groups / this.props.groupByFields at call time.
        const self = this;

        host.update = async function batchUpdate(changes) {
            const groupByFields = self.props.groupByFields;

            // Only changes to group-by fields need propagation.
            const groupByChanges = Object.fromEntries(
                Object.entries(changes).filter(([f]) => groupByFields.includes(f))
            );

            if (Object.keys(groupByChanges).length === 0) {
                return originalUpdate(changes);
            }

            // Identify siblings at the moment the change fires (before re-render).
            const currentGroup = self.groups.find((g) => g.records[0] === host);
            const siblings = currentGroup
                ? currentGroup.records.filter((r) => r !== host)
                : [];

            // ── LOG: USER ACTION ────────────────────────────────────────────
            dbgGroup(`BATCH EDIT host#${host.id} | fields: ${Object.keys(groupByChanges).join(", ")}`);
            dbg("ACTION  group-by changes →", groupByChanges);
            dbg("BEFORE  host   :", snap(host, groupByFields));
            for (const [i, s] of siblings.entries()) {
                dbg(`BEFORE  sibling[${i}]#${s.id} :`, snap(s, groupByFields));
            }
            // ────────────────────────────────────────────────────────────────

            // 1. Synchronous data mutation — all records reflect the new value
            //    before OWL re-renders, preventing any split flash.
            for (const sibling of siblings) {
                for (const [f, v] of Object.entries(groupByChanges)) {
                    sibling.data[f] = v;
                }
            }
            dbg("STEP 1  sync data mutation applied to", siblings.length, "siblings");

            // 2. Host update (marks host._changes, triggers OWL update).
            const result = await originalUpdate(changes);
            dbg("STEP 2  host.update() done :", snap(host, groupByFields));

            // 3. Sibling updates — run in parallel so all _changes are written
            //    in one OWL render cycle instead of one render per sibling.
            await Promise.all(
                siblings.map(async (sibling, i) => {
                    try {
                        await sibling.update(groupByChanges);
                        dbg(`STEP 3  sibling[${i}]#${sibling.id} update OK :`, snap(sibling, groupByFields));
                    } catch (err) {
                        dbgErr(`STEP 3  sibling[${i}]#${sibling.id} update FAILED`, err, snap(sibling, groupByFields));
                    }
                })
            );

            dbgGroupEnd();
            return result;
        };
    }

    /** Runs fn(), holding isBusy=true for the duration. Always clears on exit. */
    async _withBusy(fn) {
        this.state.isBusy = true;
        try {
            await fn();
        } finally {
            this.state.isBusy = false;
        }
    }

    _unwrapAllHosts() {
        for (const host of this._wrappedHosts) {
            const original = this._originalUpdates.get(host);
            if (original) {
                host.update = original;
            }
        }
        this._wrappedHosts.clear();
        this._originalUpdates = new WeakMap();
    }

    // -------------------------------------------------------------------------
    // Drafts
    // -------------------------------------------------------------------------

    /**
     * Drafts whose underlying record is still present in props.records by
     * object reference.  Reference-identity (not record.id) is the right
     * primitive here because a view switch can auto-save and reload the list,
     * swapping OWL record objects.  Without this prune, a stale draft entry
     * would render its row while the freshly-swapped record also surfaces in
     * `groups`, yielding duplicate rows.
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
     * Returns the list of groups derived from props.records, excluding drafts.
     *
     * Groups are keyed by the *raw* values of the configured groupByFields
     * (Many2one → id, Selection/Char → value).  Order follows each group's
     * oldest record (first occurrence) in props.records.
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

    _recordGroupKey(record) {
        const keyParts = this.props.groupByFields.map((field) =>
            this._keyValue(record.data[field])
        );
        return JSON.stringify(keyParts);
    }

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
    // Row highlighting
    // -------------------------------------------------------------------------

    isHighlighted(recordId) {
        return !!this.state.highlightedIds[recordId];
    }

    // -------------------------------------------------------------------------
    // Virgin-record guard
    // -------------------------------------------------------------------------

    /**
     * Returns true when every record in a group is "virgin"
     * (has no data beyond the fields that were auto-filled at creation time).
     *
     * Non-virgin records have been individually edited → the [−] button is
     * disabled so the user must switch to individual mode to remove a specific one.
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
            confirm: () => this._withBusy(() => this.props.onQtyChange({ group, delta: "remove_all" })),
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
        const draftKey = this._recordGroupKey(entry.record);
        const targetGroup = this.groups.find((g) => g.key === draftKey);
        const isMerge = !!targetGroup;
        const addedQty = entry.qty;

        // ── LOG: USER ACTION ────────────────────────────────────────────────
        dbgGroup(`CONFIRM DRAFT #${entry.record.id} qty=${entry.qty} merge=${isMerge}`);
        dbg("ACTION  draft record :", snap(entry.record, this.props.groupByFields));
        if (isMerge) dbg("        will merge into existing group key:", draftKey);
        // ────────────────────────────────────────────────────────────────────

        await this._withBusy(async () => {
            await this.props.onCloneDraft({ draft: entry.record, qty: entry.qty });
            dbg("AFTER   onCloneDraft done");
            this._removeDraft(entry);
        });
        dbgGroupEnd();

        if (isMerge) {
            const token = ++this._mergeFlashToken;
            this.state.mergeFlash = { key: draftKey, delta: addedQty, token };
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
