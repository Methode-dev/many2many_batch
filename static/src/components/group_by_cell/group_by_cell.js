/** @odoo-module **/

import { Component } from "@odoo/owl";
import { Field } from "@web/views/fields/field";
import { Domain } from "@web/core/domain";

/**
 * Thin wrapper around Odoo's <Field> for a group-by cell in the batch table.
 *
 * Propagation of value changes to all records in the same group is handled
 * by BatchRenderer, which wraps group.records[0].update() and awaits each
 * sibling update in sequence.  This component has no propagation logic.
 *
 * Domain forwarding
 * ─────────────────
 * In Odoo 19 the view compiler bakes domain expressions directly into compiled
 * template code; they are NOT stored in activeFields.  GroupByCell bypasses
 * the compiler, so activeFields[name].domain is always undefined here.
 *
 * Instead we use the pre-computed "allowed_<field>_ids" Many2many pattern:
 * if the comodel record exposes e.g. allowed_visa_situation_ids in its
 * evalContext, we build [['id', 'in', <ids>]] and pass it to <Field>.
 *
 * Only applied to many2one fields — other widgets (e.g. IntegerField) do not
 * accept domain in their static props and OWL would throw an unknown-key error.
 */
export class GroupByCell extends Component {
    static template = "many2many_batch.GroupByCell";
    static components = { Field };

    static props = {
        record: { type: Object },
        name: { type: String },
        readonly: { type: Boolean, optional: true },
    };

    get fieldProps() {
        const record = this.props.record;
        const name = this.props.name;
        const base = { record, name, readonly: this.props.readonly };

        const fieldType = record.fields?.[name]?.type;
        if (fieldType !== "many2one") {
            return base;
        }

        // Primary path: domain stored in activeFields (Odoo <19 / future versions).
        const domainExpr = record.activeFields?.[name]?.domain;
        if (domainExpr) {
            try {
                return { ...base, domain: new Domain(domainExpr).toList(record.evalContext) };
            } catch (e) {
                console.warn(`[GroupByCell:${name}] domain eval failed:`, e, domainExpr);
            }
        }

        // Fallback: allowed_<field_base>_ids in evalContext.
        // visa_situation_id → allowed_visa_situation_ids
        const allowedKey = `allowed_${name.replace(/_id$/, "")}_ids`;
        const allowedIds = record.evalContext?.[allowedKey];
        if (allowedIds !== undefined && allowedIds !== false) {
            try {
                return { ...base, domain: [["id", "in", [...allowedIds]]] };
            } catch (e) {
                console.warn(`[GroupByCell:${name}] allowed-ids fallback failed:`, e);
            }
        }

        return base;
    }
}
