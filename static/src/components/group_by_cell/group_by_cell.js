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
        // Snapshot the host record at mount.  props.record is `group.records[0]`,
        // which OWL re-evaluates on every render — and the first render after a
        // bulk-edit puts a *different* record in that slot (the original host
        // has moved to a new group containing just itself).  If the effect dep
        // read `this.props.record`, the value comparison would happen against
        // the new sibling-turned-first-record (unchanged value) and miss the
        // edit entirely, leaving the row split.  Anchoring on the original
        // record keeps the dep faithful to "did the user-edited record's value
        // change?" regardless of how OWL reshuffles the group rows afterwards.
        this._host = this.props.record;
        useEffect(
            () => this._propagateToSiblings(),
            () => [this._valueKey(this._host.data[this.props.name])]
        );
    }

    /**
     * After the host record's value changed, push the new value into every
     * other record currently in the group.  Reads `props.records` (live) so
     * records added after mount (qty+ clones) are included; reads `_host`
     * (snapshot) so we always know which record the user actually edited.
     */
    _propagateToSiblings() {
        const fieldName = this.props.name;
        const hostValue = this._host.data[fieldName];
        for (const sibling of this.props.records) {
            if (sibling === this._host) continue;
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
