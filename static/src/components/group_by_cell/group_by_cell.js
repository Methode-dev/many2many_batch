/** @odoo-module **/

import { Component, useEffect } from "@odoo/owl";
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
        useEffect(
            () => this._propagateToSiblings(),
            () => [this._valueKey(this.props.record.data[this.props.name])]
        );
    }

    /**
     * After the host record's value changed, push the new value into every
     * sibling whose current value differs.  No-op on initial mount because
     * all siblings already share the value (that's what put them in the
     * same group).
     */
    _propagateToSiblings() {
        const fieldName = this.props.name;
        const hostValue = this.props.record.data[fieldName];
        for (let i = 1; i < this.props.records.length; i++) {
            const sibling = this.props.records[i];
            if (sibling === this.props.record) continue;
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

    /** Stable key for the useEffect dependency array. */
    _valueKey(value) {
        const id = this._extractId(value);
        if (id !== null) return `id:${id}`;
        if (value === false || value === null || value === undefined) return "empty";
        return `v:${String(value)}`;
    }
}
