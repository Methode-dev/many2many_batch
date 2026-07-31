/** @odoo-module **/

import { Component, onMounted, onWillUnmount, useRef } from "@odoo/owl";
import { Dialog } from "@web/core/dialog/dialog";
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
        size: { type: String, optional: true },
        title: { type: String, optional: true },
        close: { type: Function },
    };

    setup() {
        this.rootRef = useRef("root");
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
}
