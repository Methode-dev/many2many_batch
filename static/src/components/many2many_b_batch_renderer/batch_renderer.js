/** @odoo-module **/

import { Component, onWillUnmount, useEffect, useExternalListener, useRef, useState } from "@odoo/owl";
import { useService } from "@web/core/utils/hooks";
import { ConfirmationDialog } from "@web/core/confirmation_dialog/confirmation_dialog";
import { GroupByCell } from "../group_by_cell/group_by_cell";
import { dbg, dbgErr, dbgGroup, dbgGroupEnd, snap } from "../../utils/debug";

// Focus or a click landing here has not left the draft row: a picker's
// dropdown, a popover (date picker…) or a dialog it opened ("Search More…").
const DRAFT_OVERLAYS = ".o-autocomplete--dropdown-menu, .o-dropdown--menu, .o_popover, .modal";

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
        fieldNodes: { type: Object, optional: true }, // the sub-list's columns, as parsed
        readonly: { type: Boolean },
        onQtyChange: { type: Function },    // ({group, delta}) => Promise<void>
        onAddDraft: { type: Function },     // ({onCreated}) => Promise<OwlRecord>
        onSettleDraft: { type: Function },  // ({draft, qty}) => Promise<boolean kept>
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

        // Keyed on the record objects themselves, not on how many there are:
        // a save reloads the list into new record objects of the same length,
        // and keying on the count left those readonly (no inputs in the group
        // cells) and without propagation (an edit reached only the host, and
        // the group split).
        //
        // Records loaded from the DB start "readonly" in Odoo 19 (isInEdition
        // is only true for new ones); <Field> needs them in edit mode to render
        // an input.
        useEffect(
            () => {
                this._ensureRecordsEditable();
                this._syncHostWrappers();
            },
            () => [...this.props.records]
        );

        // A click outside a draft row commits it — in the capture phase, so
        // ahead of whatever the click is for (Save, a form button): see the
        // field's onSettleDraft for why that ordering matters.
        useExternalListener(document, "click", (ev) => this._onDocumentClick(ev), {
            capture: true,
        });

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
        // Only in an editable batch view.  In readonly consumers the records
        // must stay in their natural (readonly) mode — flipping them to edit
        // would leave stale in-edition rows behind on unmount and serves no
        // purpose since the inline <Field> cells render readonly anyway.
        if (this.props.readonly) return;
        for (const record of this.props.records) {
            if (record && !record.isInEdition && typeof record.switchMode === "function") {
                record.switchMode("edit");
            }
        }
    }

    _restoreRecordsReadonly() {
        // Switch every in-edition record (including brand-new ones) back to
        // readonly on unmount.  New records report isInEdition === true unless
        // their mode is explicitly "readonly" (record.js), so skipping them
        // would hand several simultaneously-in-edition rows to the stock
        // editable list in Individual mode — breaking its single-edited-record
        // invariant (clicking one row kicks another out of edit).  Readonly
        // mode preserves the new/dirty state, so the records still save.
        for (const record of this.props.records) {
            if (!record) continue;
            if (record.isInEdition && typeof record.switchMode === "function") {
                record.switchMode("readonly");
            }
        }
    }

    // -------------------------------------------------------------------------
    // Batch-edit host wrapping
    // -------------------------------------------------------------------------

    /**
     * Wrap the host (records[0]) of every group so an edit of a group-by
     * field reaches the whole group, and release records that left the list.
     *
     * The wrapper:
     *   1. Synchronously writes newValue into sibling.data[field] (visual sync,
     *      prevents the brief split-then-merge flash on re-render).
     *   2. Awaits originalUpdate(changes) on the host so _changes is written.
     *   3. Awaits each sibling's *original* update so their _changes are
     *      written too — the original, so a sibling that is itself wrapped
     *      does not propagate a second time.
     */
    _syncHostWrappers() {
        const live = new Set(this.props.records);
        for (const record of [...this._wrappedHosts]) {
            if (!live.has(record)) {
                record.update = this._originalUpdates.get(record) || record.update;
                this._wrappedHosts.delete(record);
            }
        }
        for (const group of this.groups) {
            const host = group.records[0];
            if (!host || this._wrappedHosts.has(host)) continue;
            this._wrapHostUpdate(host);
            this._wrappedHosts.add(host);
        }
    }

    /**
     * The records sharing ``record``'s group-by values, drafts excluded —
     * looked up by value at the moment of the edit, never by position: which
     * record happens to be a group's records[0] changes as lines come and go.
     */
    _groupSiblings(record) {
        if (this.draftRecords.has(record)) return [];
        const key = this._recordGroupKey(record);
        const drafts = this.draftRecords;
        return this.props.records.filter(
            (other) => other !== record && !drafts.has(other) && this._recordGroupKey(other) === key
        );
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

            // Siblings by value, before the change moves the host's key.
            const siblings = self._groupSiblings(host);

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
                        const update = self._originalUpdates.get(sibling) || sibling.update.bind(sibling);
                        await update(groupByChanges);
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
            return await fn();
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

    /** The sub-list's column for ``fieldName`` — carries its widget, if any. */
    columnFieldNode(fieldName) {
        return Object.values(this.props.fieldNodes || {}).find((node) => node.name === fieldName);
    }

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
    // What [−] may remove
    // -------------------------------------------------------------------------

    /**
     * [−] removes the group's last record, so only that one is checked: it
     * must carry nothing the user entered beyond the group's own values. A
     * named seafarer is not silently dropped — that takes Individual mode.
     *
     * Readonly fields don't count: they are computed, never typed, and a crew
     * row always carries some (its allowed movement / visa options), which
     * used to keep [−] disabled on every crew group.
     */
    canRemoveOne(group) {
        return group.records.length > 1 && !this._hasEnteredData(group.records.at(-1));
    }

    _hasEnteredData(record) {
        const groupValues = new Set([...this.props.defaultValueKeys, "id", "display_name"]);
        return Object.entries(record.data).some(
            ([field, value]) =>
                !groupValues.has(field) &&
                !field.startsWith("__") &&
                !this.props.fields[field]?.readonly &&
                this._isValueSet(value)
        );
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
        if (this.canRemoveOne(group)) {
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

    /**
     * The draft is registered the moment its record exists, before the record
     * joins the list: registered after, it would render for a frame as an
     * ordinary group row — and get wrapped as that group's host.
     */
    async addDraft() {
        const draft = await this.props.onAddDraft({
            onCreated: (record) => this.state.drafts.push({ record, qty: 1 }),
        });
        if (draft) {
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

    stepDraftQty(entry, delta) {
        entry.qty = Math.max(1, entry.qty + delta);
    }

    _draftRow(entry) {
        return this.rootRef.el?.querySelector(
            `.o_many2many_b_pending_row[data-draft-id="${entry.record.id}"]`
        );
    }

    _isInsideDraft(entry, element) {
        if (!element) return false;
        const row = this._draftRow(entry);
        return Boolean((row && row.contains(element)) || element.closest(DRAFT_OVERLAYS));
    }

    _onDocumentClick(ev) {
        for (const entry of [...this.pendingDrafts]) {
            if (!this._isInsideDraft(entry, ev.target)) {
                this.settleDraft(entry);
            }
        }
    }

    /** Tabbing out of the row commits it too. */
    onDraftFocusOut(entry, ev) {
        // Focus that leaves for nowhere (a click on plain page) is the click
        // listener's to handle.
        if (ev.relatedTarget && !this._isInsideDraft(entry, ev.relatedTarget)) {
            this.settleDraft(entry);
        }
    }

    onDraftKeydown(entry, ev) {
        // Enter / Esc belong to a picker while its dropdown is open.
        if (this._draftRow(entry)?.querySelector(".o-autocomplete--dropdown-menu")) return;
        if (ev.key === "Enter") {
            ev.preventDefault();
            ev.stopPropagation();
            // Leaving the input writes what was typed into it, ahead of the
            // commit.
            document.activeElement?.blur();
            this.settleDraft(entry);
        } else if (ev.key === "Escape") {
            ev.preventDefault();
            ev.stopPropagation();
            this.discardDraft(entry);
        }
    }

    /**
     * Hand a left draft to the field to commit (or drop, when empty). Runs at
     * most once per draft: leaving the row by a click fires both the click
     * listener and focusout.
     */
    async settleDraft(entry) {
        if (entry.settled || !this.state.drafts.includes(entry)) return;
        entry.settled = true;
        const { record, qty } = entry;
        this._removeDraft(entry);
        const kept = await this._withBusy(() => this.props.onSettleDraft({ draft: record, qty }));
        if (!kept) return;
        const key = this._recordGroupKey(record);
        const group = this.groups.find((g) => g.key === key);
        if (group && group.records.length > qty) {
            this._flashMerge(key, qty);
        }
    }

    _flashMerge(key, delta) {
        const token = ++this._mergeFlashToken;
        this.state.mergeFlash = { key, delta, token };
        setTimeout(() => {
            if (this.state.mergeFlash && this.state.mergeFlash.token === token) {
                this.state.mergeFlash = null;
            }
        }, 1200);
    }

    async discardDraft(entry) {
        entry.settled = true;
        this._removeDraft(entry);
        await this.props.onDiscardDraft(entry.record);
    }

    _removeDraft(entry) {
        const idx = this.state.drafts.indexOf(entry);
        if (idx !== -1) this.state.drafts.splice(idx, 1);
    }
}
