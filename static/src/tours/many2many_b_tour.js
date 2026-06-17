/** @odoo-module **/

/**
 * Tour: many2many_b_batch_editing
 *
 * Full lifecycle test for the many2many_b widget in batch-edit mode:
 *
 *   1.  Open a new test-parent form.
 *   2.  Switch to Batch mode via the toggle pill.
 *   3.  Add line: Brand=Renault, Model=Megane, Qty=2 → Confirm.
 *   4.  Add line: Brand=Peugeot, Model=208,    Qty=1 → Confirm.
 *   5.  Increment the Renault group (2 → 3).
 *   6.  Decrement the Renault group (3 → 2).
 *   7.  Switch to Individual mode → verify 3 rows exist.
 *   8.  Switch back to Batch mode.
 *   9.  Remove the Peugeot group entirely.
 *   10. Save.
 *   11. Reload: switch to Batch → verify exactly one group (2× Renault Megane).
 */

import { registry } from "@web/core/registry";

registry.category("web_tour.tours").add("many2many_b_batch_editing", {
    test: true,
    url: "/odoo/action-many2many_batch.action_test_batch_parent",

    steps: () => [

        // ── 1. Form is open ──────────────────────────────────────────────────
        {
            trigger: ".o_form_view .o_field_widget[name='item_ids']",
            content: "Form view is open with the item_ids field",
            auto: true,
        },

        // ── 2. Switch to Batch mode ──────────────────────────────────────────
        {
            trigger: ".o_many2many_b_toggle [data-mode='batch']",
            content: "Click the Batch toggle pill",
            run: "click",
        },
        {
            trigger: ".o_many2many_b_batch_renderer",
            content: "Batch renderer is now visible",
            auto: true,
        },

        // ── 3a. Add first line ───────────────────────────────────────────────
        {
            trigger: ".o_many2many_b_btn_add_line",
            content: "Open a new pending row",
            run: "click",
        },
        {
            trigger: ".o_many2many_b_pending_row [data-field='brand']",
            content: "Type Brand = Renault",
            run: "edit Renault",
        },
        {
            trigger: ".o_many2many_b_pending_row [data-field='model']",
            content: "Type Model = Megane",
            run: "edit Megane",
        },
        {
            trigger: ".o_many2many_b_pending_row [data-field='qty']",
            content: "Set Qty = 2",
            run: "edit 2",
        },

        // ── 3b. Confirm first line ───────────────────────────────────────────
        {
            trigger: ".o_many2many_b_pending_row .btn-success",
            content: "Confirm the Renault Megane row",
            run: "click",
        },
        {
            // After confirmation the group row appears; no pending row remains.
            trigger: ".o_many2many_b_group_row .o_many2many_b_qty_value:contains('2')",
            content: "Renault Megane group shows qty 2",
            auto: true,
        },

        // ── 4a. Add second line ──────────────────────────────────────────────
        {
            trigger: ".o_many2many_b_btn_add_line",
            content: "Open a second pending row",
            run: "click",
        },
        {
            trigger: ".o_many2many_b_pending_row [data-field='brand']",
            content: "Type Brand = Peugeot",
            run: "edit Peugeot",
        },
        {
            trigger: ".o_many2many_b_pending_row [data-field='model']",
            content: "Type Model = 208",
            run: "edit 208",
        },
        {
            trigger: ".o_many2many_b_pending_row [data-field='qty']",
            content: "Set Qty = 1",
            run: "edit 1",
        },

        // ── 4b. Confirm second line ──────────────────────────────────────────
        {
            trigger: ".o_many2many_b_pending_row .btn-success",
            content: "Confirm the Peugeot 208 row",
            run: "click",
        },
        {
            // Now there are two groups; look for the second one.
            trigger: ".o_many2many_b_group_row:nth-child(2)",
            content: "Two groups are now visible",
            auto: true,
        },

        // ── 5. Increment Renault group (2 → 3) ──────────────────────────────
        // Initially: Renault is :first-child (added first), Peugeot
        // :nth-child(2).  Clicking [+] adds a new Renault record at the
        // bottom of the underlying list, which bumps the Renault group to
        // the bottom of the table — so after the click Renault is
        // :nth-child(2) and Peugeot is :first-child.
        {
            trigger: ".o_many2many_b_group_row:first-child .o_many2many_b_btn_plus",
            content: "Increment the Renault Megane group",
            run: "click",
        },
        {
            trigger: ".o_many2many_b_group_row:nth-child(2) .o_many2many_b_qty_value:contains('3')",
            content: "Renault Megane qty is now 3 (and the group has bumped to row 2)",
            auto: true,
        },

        // ── 6. Decrement Renault group (3 → 2) ──────────────────────────────
        // Removing the last-added Renault record drops its lastIndex back
        // below Peugeot's, so Renault returns to :first-child.
        {
            trigger: ".o_many2many_b_group_row:nth-child(2) .o_many2many_b_btn_minus",
            content: "Decrement the Renault Megane group back to 2",
            run: "click",
        },
        {
            trigger: ".o_many2many_b_group_row:first-child .o_many2many_b_qty_value:contains('2')",
            content: "Renault Megane qty is back to 2 (and the group returns to row 1)",
            auto: true,
        },

        // ── 7. Switch to Individual mode ─────────────────────────────────────
        {
            trigger: ".o_many2many_b_toggle [data-mode='individual']",
            content: "Switch to Individual mode",
            run: "click",
        },
        {
            // 2 Renault + 1 Peugeot = 3 individual rows in the embedded list.
            trigger: ".o_field_widget[name='item_ids'] .o_data_row:nth-child(3)",
            content: "Three individual rows are visible",
            auto: true,
        },

        // ── 8. Switch back to Batch mode ─────────────────────────────────────
        {
            trigger: ".o_many2many_b_toggle [data-mode='batch']",
            content: "Switch back to Batch mode",
            run: "click",
        },
        {
            trigger: ".o_many2many_b_batch_renderer",
            content: "Batch renderer is visible again",
            auto: true,
        },

        // ── 9. Remove the Peugeot group ──────────────────────────────────────
        // After the increment+decrement above, the order is back to Renault
        // (:first-child) then Peugeot (:nth-child(2)).
        {
            trigger: ".o_many2many_b_group_row:nth-child(2) .o_many2many_b_btn_remove",
            content: "Remove the Peugeot 208 group",
            run: "click",
        },
        {
            // Only one group row should remain.
            trigger:
                ".o_many2many_b_batch_renderer .o_many2many_b_group_row:only-child",
            content: "Only one group remains (Renault Megane)",
            auto: true,
        },

        // ── 10. Save ──────────────────────────────────────────────────────────
        {
            trigger: ".o_form_button_save",
            content: "Save the record",
            run: "click",
        },
        {
            trigger: ".o_form_view:not(.o_form_dirty)",
            content: "Record saved successfully",
            auto: true,
        },

        // ── 11. Reload: verify persistence ───────────────────────────────────
        {
            // After save Odoo stays on the same form; switch to Batch to verify.
            trigger: ".o_many2many_b_toggle [data-mode='batch']",
            content: "Switch to Batch after reload",
            run: "click",
        },
        {
            trigger:
                ".o_many2many_b_batch_renderer .o_many2many_b_group_row:only-child " +
                ".o_many2many_b_qty_value:contains('2')",
            content: "Exactly one group with qty 2 survives the save/reload cycle",
            auto: true,
        },
    ],
});
