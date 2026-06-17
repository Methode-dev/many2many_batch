/** @odoo-module **/

import { Component } from "@odoo/owl";
import { Field } from "@web/views/fields/field";

/**
 * Thin wrapper around Odoo's <Field> for a group-by cell in the batch table.
 *
 * Propagation of value changes to all records in the same group is handled
 * by BatchRenderer, which wraps group.records[0].update() and awaits each
 * sibling update in sequence.  This component has no propagation logic.
 */
export class GroupByCell extends Component {
    static template = "many2many_batch.GroupByCell";
    static components = { Field };

    static props = {
        record: { type: Object },
        name: { type: String },
        readonly: { type: Boolean, optional: true },
    };
}
