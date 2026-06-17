/** @odoo-module **/

import { Component, onMounted, onPatched } from "@odoo/owl";
import { Field } from "@web/views/fields/field";

/**
 * Renders a single group-by cell in the batch view.
 *
 * Wraps Odoo's <Field> component bound to the FIRST record of the group
 * (`record`), giving the user a proper widget (Many2one dropdown, date
 * picker, etc.).  When the user changes the value, an effect propagates
 * it to every other record in the group via record.update() — i.e. a
 * bulk-edit semantic: editing state_id on a row of 3 vehicles updates
 * all 3.  The table then re-groups on the next render.
 *
 * Single-record groups (records.length === 1) are just a plain Field
 * with no propagation.
 */
export class GroupByCell extends Component {
    static template = "many2many_batch.GroupByCell";
    static components = { Field };

    static props = {
        record: { type: Object },          // host record (group.records[0])
        records: { type: Array },          // all records in the group
        name: { type: String },            // field name
        readonly: { type: Boolean, optional: true },
    };

    setup() {
        // Watch props.record across patches.  On every patch we ask:
        // "did the record that was at props.record on the previous patch
        // just have its value change?"  If yes, that's the user's edit —
        // push the new value to the current sibling set.
        //
        // Why track across patches instead of snapshotting at mount:
        // a cell can mount mid-async-flow (e.g. during draft confirm,
        // between awaited addNewRecord calls — the draft is still filtered
        // out of groups, so props.record at that instant is a clone, not
        // the soon-to-be-host original).  By the time the user edits, the
        // cell has been reused for the residual group; a mount-time
        // snapshot would still point at the clone, whose value never
        // changes, and the propagation would never fire.  Tracking the
        // most recently-seen record sidesteps this: when the user edits,
        // `_lastRecord` still points at the row they were looking at,
        // regardless of which record was first at mount time.
        this._lastRecord = null;
        this._lastValueKey = null;

        onMounted(() => this._snapshotLast());
        onPatched(() => {
            const last = this._lastRecord;
            if (last) {
                const currentKey = this._valueKey(last.data[this.props.name]);
                if (currentKey !== this._lastValueKey) {
                    this._propagateFrom(last);
                }
            }
            this._snapshotLast();
        });
    }

    _snapshotLast() {
        this._lastRecord = this.props.record;
        this._lastValueKey = this._valueKey(
            this.props.record.data[this.props.name]
        );
    }

    /**
     * Push `host`'s current value at this field into every other record
     * currently in the group whose value differs.
     */
    _propagateFrom(host) {
        const fieldName = this.props.name;
        const hostValue = host.data[fieldName];
        for (const sibling of this.props.records) {
            if (sibling === host) continue;
            if (!this._valuesEqual(sibling.data[fieldName], hostValue)) {
                sibling.update({ [fieldName]: hostValue });
            }
        }
    }

    /**
     * Compare two field values.  Many2one is special: equal if same id,
     * regardless of representation ([id,name] vs {id,display_name}).
     */
    _valuesEqual(a, b) {
        if (a === b) return true;
        const aId = this._extractId(a);
        const bId = this._extractId(b);
        if (aId !== null || bId !== null) return aId === bId;
        return false;
    }

    _extractId(value) {
        if (value && typeof value === "object" && "id" in value) return value.id;
        if (Array.isArray(value) && value.length >= 1) return value[0];
        return null;
    }

    /** Stable key for the value-change comparison. */
    _valueKey(value) {
        const id = this._extractId(value);
        if (id !== null) return `id:${id}`;
        if (value === false || value === null || value === undefined) return "empty";
        return `v:${String(value)}`;
    }
}
