/** @odoo-module **/

/**
 * Entry point — importing the field module causes it to self-register in
 * the "fields" registry via the call at the bottom of many2many_b_field.js.
 *
 * The glob in __manifest__.py already picks up every JS file under static/src/,
 * so this re-export is mainly for human readers (and tools that follow imports).
 */
export * from "./components/many2many_b_field/many2many_b_field";
