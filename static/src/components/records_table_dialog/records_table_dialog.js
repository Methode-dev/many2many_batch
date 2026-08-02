/** @odoo-module **/

import { Component, onMounted, onWillUnmount, useRef } from "@odoo/owl";
import { Dialog } from "@web/core/dialog/dialog";
import { _t } from "@web/core/l10n/translation";
import { useService } from "@web/core/utils/hooks";
import { useDebounced } from "@web/core/utils/timing";
import { GroupByCell } from "../group_by_cell/group_by_cell";

/**
 * RecordsTableDialog — the whole x2many as one wide table.
 *
 * The stock "open record" dialog of an x2many shows a single record in the
 * comodel's form view: a two-column layout that reads nothing like the list it
 * was opened from, one record at a time. When the records are rows of short
 * values (a crew member's identity and travel documents, a line of
 * measurements…), the useful view is the *table* — every record, every column,
 * side by side and comparable, which is also how you spot the one row missing a
 * passport number.
 *
 * So clicking any row opens this: the full list, the columns configured on the
 * field, and the clicked record highlighted and scrolled into view. Cells are
 * plain Odoo <Field> widgets (through GroupByCell, which also forwards many2one
 * domains), so they edit and validate exactly like anywhere else and are saved
 * with the parent form.
 */
export class RecordsTableDialog extends Component {
    static template = "many2many_batch.RecordsTableDialog";
    static components = { Dialog, GroupByCell };

    static props = {
        records: { type: Array },
        // [{ name, label }] — resolved by Many2ManyBField from the option.
        columns: { type: Array },
        // The row that was clicked: highlighted and scrolled to.
        activeRecord: { type: Object, optional: true },
        readonly: { type: Boolean, optional: true },
        // Write each row through as soon as one of its cells changes, instead of
        // waiting for the parent form to be saved (see onCellChanged).
        autosave: { type: Boolean, optional: true },
        // Name of a method on the rows' own model returning an action. When set,
        // a trailing column shows a button per row that runs it — the way to
        // reach whatever the row's columns only mirror (see onEditRow).
        editAction: { type: String, optional: true },
        size: { type: String, optional: true },
        title: { type: String, optional: true },
        close: { type: Function },
    };

    setup() {
        this.rootRef = useRef("root");
        this.notification = useService("notification");
        this.orm = useService("orm");
        this.action = useService("action");
        // Rows whose save is in flight — see onCellChanged.
        this.saving = new Set();
        // Saving on a short idle rather than on every cell exit keeps typing
        // responsive (see onCellChanged). execBeforeUnmount so a pending save is
        // run, not dropped, if the dialog goes away first.
        this.scheduleSave = useDebounced(() => this.saveDirtyRows(), 500, {
            execBeforeUnmount: true,
        });
        // Bound once so every cell gets the same prop rather than a new closure
        // on each render.
        this.onCellChanged = this.onCellChanged.bind(this);
        // A cell edit that is still pending when the dialog closes would
        // otherwise be dropped: useRecordObserver invalidates its queued
        // callbacks on destroy. Not awaited (unmount is synchronous) — the
        // request still goes out, and saving does not depend on the component.
        onWillUnmount(() => this.flush());
        // Records loaded from the database sit in "readonly" mode, which makes
        // <Field> render static text. Flip them for the dialog's lifetime and put
        // back exactly the ones we touched, so we never hand a stack of
        // in-edition rows to the list renderer (it allows only one).
        this.flipped = [];
        if (!this.props.readonly) {
            for (const record of this.props.records) {
                if (record && !record.isInEdition && typeof record.switchMode === "function") {
                    record.switchMode("edit");
                    this.flipped.push(record);
                }
            }
        }
        onWillUnmount(() => {
            for (const record of this.flipped) {
                if (record.isInEdition && typeof record.switchMode === "function") {
                    record.switchMode("readonly");
                }
            }
        });
        onMounted(() => {
            const row = this.rootRef.el?.querySelector(".o_m2m_b_table_active_row");
            row?.scrollIntoView({ block: "nearest", inline: "nearest" });
        });
    }

    get columns() {
        // Drop columns the sub-view did not load: a <Field> on an unknown field
        // throws, and a silently missing column beats a broken dialog.
        const fields = this.props.records[0]?.fields || {};
        return this.props.columns.filter((column) => column.name in fields);
    }

    label(column) {
        return (
            column.label ||
            this.props.records[0]?.fields?.[column.name]?.string ||
            column.name
        );
    }

    isActive(record) {
        return record === this.props.activeRecord;
    }

    // -------------------------------------------------------------------------
    // Row action (opt-in through the `table_dialog_edit_action` option)
    // -------------------------------------------------------------------------

    get canEdit() {
        return Boolean(this.props.editAction);
    }

    /**
     * Run the configured action for one row and open whatever it returns.
     *
     * The point of the column: several of the table's cells only *mirror* data
     * that lives on another record — a crew line's name, passport and seaman book
     * are related fields on the seafarer's contact — and a couple of them cannot
     * be edited here at all (a computed full name has nowhere to write). This
     * button opens the record that owns them, so the table stays the overview and
     * the form stays the place where the details are completed.
     */
    async onEditRow(record) {
        if (!this.canEdit || !record.resId) {
            return;
        }
        // Persist what is already typed in the table first: the form about to open
        // edits the same underlying record, so a pending cell must not be lost to
        // it (no-op when autosave is off — the parent form still holds it).
        await this.flush();
        const action = await this.orm.call(record.resModel, this.props.editAction, [record.resId]);
        if (!action) {
            return;
        }
        await this.action.doAction(action, {
            // Refresh just this row when the form closes, so the mirrored columns
            // show what was just changed. Record.load() refetches this very
            // datapoint in place, which keeps the record objects the open table is
            // rendering — a parent reload would swap them out from under it.
            onClose: () => record.load(),
        });
    }

    // -------------------------------------------------------------------------
    // Auto-save (opt-in through the `table_dialog_autosave` option)
    // -------------------------------------------------------------------------

    get canAutoSave() {
        return Boolean(this.props.autosave) && !this.props.readonly;
    }

    /**
     * Persist one row, right after one of its cells changed.
     *
     * Saves the ROW, not the parent form: `record.save()` on an x2many child
     * issues a web_save on the comodel record itself — the same call Odoo makes
     * when a many2many row is edited through its own record dialog
     * (`saveRecord`/`updateRecord` in web/.../relational_utils.js). So the edit
     * lands in the database immediately, whatever the parent is: a transient
     * wizard whose list is a computed field with no inverse, or a form the user
     * has not saved. Nothing else pending on the parent form is touched.
     *
     * `reload: false` matters: a reloading save rebuilds the parent's x2many list
     * from scratch, which would swap out the very record objects this open table
     * is rendering. Without it, the values are merged in place and the row simply
     * becomes clean.
     *
     * Rows with no resId (a line added but not yet saved) are left alone — there
     * is nothing to write them onto yet, so they keep the standard behaviour of
     * being saved with the parent.
     */
    onCellChanged(record) {
        if (!this.canAutoSave || !record.resId || !record.dirty) {
            return;
        }
        // Only arm the timer — synchronously, cheaply. Saving straight from here
        // is what made the table lag, in two ways:
        //
        //   * Every save puts an RPC in the model's mutex, and the next cell's
        //     commit queues behind it: typing stutters while a row is in flight.
        //   * Record._save() ends with `this.data = { ...this._values }` — even on
        //     its no-op path, when the changes turned out to be empty. That
        //     reassignment notifies every observer that read `record.data[...]`,
        //     i.e. all of this row's cells, so each of them saved again and
        //     reassigned `data` again: a self-sustaining loop, one round per
        //     animation frame, each round paying a model-wide `_askChanges()`
        //     (which awaits one handler per mounted input — hundreds, on a wide
        //     table). The dirty check above and the idle save below break it:
        //     when the timer fires, no row is dirty, so nothing is written and
        //     nothing is notified.
        this.scheduleSave();
    }

    /** Save every row that has pending changes. */
    async saveDirtyRows() {
        if (!this.canAutoSave) {
            return;
        }
        for (const record of this.props.records) {
            if (!record.resId || !record.dirty || this.saving.has(record)) {
                continue;
            }
            this.saving.add(record);
            try {
                await this.saveRow(record);
            } finally {
                this.saving.delete(record);
            }
        }
    }

    async saveRow(record) {
        // An incomplete or invalid row is not written: the offending cell is
        // already flagged in red, and the save follows as soon as it is fixed.
        if (!(await record.checkValidity())) {
            return;
        }
        try {
            await record.save({ reload: false });
        } catch (error) {
            // An auto-save must not throw out of a field's change handler; say
            // what happened and leave the row dirty so the next edit retries.
            this.notification.add(error.data?.message || error.message || _t("Unknown error"), {
                title: _t("The change could not be saved"),
                type: "danger",
            });
        }
    }

    /** Write through anything still dirty (closing, or a cell left mid-edit). */
    async flush() {
        if (!this.canAutoSave) {
            return;
        }
        const [first] = this.props.records;
        if (!first) {
            return;
        }
        // checkValidity() asks every mounted field for its pending value first,
        // and does so model-wide — so this single call is what makes the `dirty`
        // flags accurate, including a value typed but never blurred.
        await first.checkValidity();
        await this.saveDirtyRows();
    }

    /** Footer button: flush first, so the last edit is never lost to the close. */
    async onClose() {
        await this.flush();
        this.props.close();
    }
}
