/** @odoo-module **/

/**
 * Tour: many2many_b_batch_editing
 *
 * Full lifecycle of the many2many_b widget in batch mode. A new line has no
 * confirm button: it joins the table as soon as it is left.
 *
 *   1. Renault Megane ×2, committed by moving on to the next line.
 *   2. Peugeot 208 ×1, committed with Enter.
 *   3. A line left empty is dropped; one cancelled with Esc is dropped.
 *   4. [+] / [−] on the Renault group, then remove the Peugeot group.
 *   5. Individual mode shows one row per record.
 *   6. Citroen C3 ×2, saved straight from its line with the form's Save.
 *   7. After the save: Renault ×2 and Citroen ×2, nothing else.
 *   8. A saved group is still editable, and the edit reaches every record.
 *   9. A line added after a save leaves the saved groups alone.
 */

import { registry } from "@web/core/registry";

const PENDING = ".o_many2many_b_pending_row";
// Groups keep the order of their first record, so a group's row is stable.
const row = (position) => `.o_many2many_b_group_row:nth-child(${position})`;

/** The group at ``position`` is ``brand`` with ``qty`` records. */
function expectGroup(position, brand, qty) {
    return [
        // Shown as text, or as an input while the row's record is editable.
        {
            trigger: `${row(position)} [name='brand']:contains(${brand}), ` +
                `${row(position)} [name='brand'] input:value(${brand})`,
        },
        {trigger: `${row(position)} .o_many2many_b_qty_value:contains('${qty}')`},
    ];
}

function fillLine(brand, model) {
    return [
        {trigger: ".o_many2many_b_btn_add_line", run: "click"},
        {trigger: `${PENDING} [name='brand'] input`, run: `edit ${brand}`},
        {trigger: `${PENDING} [name='model'] input`, run: `edit ${model}`},
    ];
}

registry.category("web_tour.tours").add("many2many_b_batch_editing", {
    steps: () => [
        {trigger: ".o_form_view .o_field_widget[name='item_ids'] .o_many2many_b_batch_renderer"},

        // ── 1. Committed by moving on ─────────────────────────────────────────
        ...fillLine("Renault", "Megane"),
        {content: "Qty 2 on the new line", trigger: `${PENDING} .o_many2many_b_btn_plus`, run: "click"},
        {trigger: `${PENDING} .o_many2many_b_qty_value:contains('2')`},

        // ── 2. Committed with Enter ───────────────────────────────────────────
        ...fillLine("Peugeot", "208"),
        // Starting the second line committed the first, with its qty.
        ...expectGroup(1, "Renault", 2),
        {trigger: `${PENDING} [name='model'] input`, run: "press Enter"},
        {trigger: `body:not(:has(${PENDING}))`},
        ...expectGroup(2, "Peugeot", 1),

        // ── 3. Empty and cancelled lines are dropped ──────────────────────────
        {trigger: ".o_many2many_b_btn_add_line", run: "click"},
        {trigger: PENDING},
        {content: "Leave the empty line", trigger: ".o_form_sheet", run: "click"},
        {trigger: `body:not(:has(${PENDING}))`},
        {trigger: ".o_many2many_b_batch_renderer:not(:has(.o_many2many_b_group_row:nth-child(3)))"},
        {trigger: ".o_many2many_b_btn_add_line", run: "click"},
        {trigger: `${PENDING} [name='brand'] input`, run: "edit Fiat"},
        {trigger: `${PENDING} [name='brand'] input`, run: "press Escape"},
        {trigger: `body:not(:has(${PENDING}))`},
        {trigger: ".o_many2many_b_batch_renderer:not(:has(.o_many2many_b_group_row:nth-child(3)))"},

        // ── 4. [+] / [−] / remove ─────────────────────────────────────────────
        {trigger: `${row(1)} .o_many2many_b_btn_plus`, run: "click"},
        ...expectGroup(1, "Renault", 3),
        {trigger: `${row(1)} .o_many2many_b_btn_minus`, run: "click"},
        ...expectGroup(1, "Renault", 2),
        {trigger: `${row(2)} .o_many2many_b_btn_remove`, run: "click"},
        {trigger: ".modal .btn-primary", run: "click"},
        {trigger: ".o_many2many_b_batch_renderer:not(:has(.o_many2many_b_group_row:nth-child(2)))"},

        // ── 5. Individual mode: one row per record ────────────────────────────
        {trigger: ".o_many2many_b_toggle [data-mode='individual']", run: "click"},
        {trigger: ".o_field_widget[name='item_ids'] .o_data_row:nth-child(2)"},
        {trigger: ".o_field_widget[name='item_ids']:not(:has(.o_data_row:nth-child(3)))"},
        {trigger: ".o_many2many_b_toggle [data-mode='batch']", run: "click"},
        {trigger: ".o_many2many_b_batch_renderer"},

        // ── 6. Saved straight from the line ───────────────────────────────────
        ...fillLine("Citroen", "C3"),
        {trigger: `${PENDING} .o_many2many_b_btn_plus`, run: "click"},
        {trigger: `${PENDING} .o_many2many_b_qty_value:contains('2')`},
        {content: "Save without leaving the line first", trigger: ".o_form_button_save", run: "click"},
        {trigger: "body:not(:has(.o_form_button_save:visible))"},

        // ── 7. What was saved ─────────────────────────────────────────────────
        ...expectGroup(1, "Renault", 2),
        ...expectGroup(2, "Citroen", 2),
        {trigger: ".o_many2many_b_batch_renderer:not(:has(.o_many2many_b_group_row:nth-child(3)))"},

        // ── 8. The saved rows are new record objects: still editable, and an
        //      edit still reaches the whole group (it used to split it) ───────
        {trigger: `${row(1)} [name='model'] input`, run: "edit Clio && press Tab"},
        {trigger: `${row(1)} [name='model'] input:value(Clio)`},
        ...expectGroup(1, "Renault", 2),
        {trigger: ".o_many2many_b_batch_renderer:not(:has(.o_many2many_b_group_row:nth-child(3)))"},

        // ── 9. A line added after a save leaves the saved groups alone ───────
        ...fillLine("Fiat", "Panda"),
        {trigger: `${PENDING} [name='model'] input`, run: "press Enter"},
        {trigger: `body:not(:has(${PENDING}))`},
        ...expectGroup(1, "Renault", 2),
        ...expectGroup(2, "Citroen", 2),
        ...expectGroup(3, "Fiat", 1),
        {trigger: ".o_form_button_save:visible", run: "click"},
        {trigger: "body:not(:has(.o_form_button_save:visible))"},
        ...expectGroup(1, "Renault", 2),
    ],
});
