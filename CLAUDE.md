# many2many_batch — Odoo 19.0 Module

A generic, reusable Odoo addon that extends the standard `Many2many` field
with a **batch entry mode**: records can be viewed and edited either
individually (standard list) or grouped by key fields with a quantity column.

---

## Quick orientation

```
many2many_batch/
├── __init__.py
├── __manifest__.py
├── views/
│   └── assets.xml                        # asset bundle registration
└── static/src/
    ├── index.js                          # field registration entry point
    └── components/
        ├── many2many_b_field/
        │   ├── many2many_b_field.js      # main OWL component
        │   ├── many2many_b_field.xml     # OWL template (toggle pills + slot)
        │   └── many2many_b_field.scss    # pill styles, batch table styles
        └── many2many_b_batch_renderer/
            ├── batch_renderer.js         # grouped-table sub-component
            └── batch_renderer.xml        # OWL template
```

---

## Architecture decisions (locked for phase 1)

| Concern | Decision | Rationale |
|---|---|---|
| Data storage | Real records only; qty is derived by JS grouping | No intermediate model; ORM stays standard |
| GroupBy config | `batch_group_by="field1,field2"` XML attribute on `<field>` | Parsed from `props.attrs` in OWL; zero Python changes |
| New record creation (batch mode) | `StaticList.addNew()` with only `batch_group_by` fields pre-filled; rest left empty (`False`) | No dialog; silent; user fills remaining fields after switching to individual mode |
| Record removal (batch mode) | Decrease qty → `StaticList.delete()` on last record in group; qty = 0 → delete all in group | Deterministic: always removes the "last" (highest index) record in the group |
| Mode switch | Pure re-render; zero data mutation in either direction | Individual→Batch groups on the fly; Batch→Individual just un-groups |
| Initial mode on load | `individual` by default; override with `default_mode="batch"` XML attr | Consistent with standard Odoo widget behaviour; no stored state in phase 1 |
| Readonly parent form | Batch view visible and navigable; qty controls and add/remove buttons hidden | Standard Odoo convention: widget reflects parent editability |
| Grouping execution | Client-side JS only | Acceptable for typical M2M sizes; avoids extra RPC |

---

## Consumer-side XML usage

```xml
<field name="vehicle_ids"
       widget="many2many_b"
       options='{"batch_group_by": "state_id,driver_id", "default_mode": "batch",
                 "default_values": {"odometer_unit": "km"}}'
       string="Vehicles"/>
```

`default_values` is an optional plain object of **field → value** pairs injected as
`default_<field>` context keys on every new record created in batch mode.  Use it to
satisfy mandatory fields that are not part of `batch_group_by` and that have no
server-side default (e.g. `odometer_unit` on `fleet.vehicle`).
Group-by field values always override `default_values` when the same field appears
in both.

> **⚠️ Odoo 19 prop pipeline (critical):**
> ```
> XML  options='{…}'
>   → x2ManyField.extractProps receives `options` arg
>   → returned as  props.crudOptions  on the component
> ```
> Bare XML attrs (e.g. `batch_group_by="state_id"`) are stripped by the view
> compiler before `extractProps` runs — they never reach the component.
> `props.attrs` and `props.options` do **not** exist; use **`props.crudOptions`**.

`batch_group_by` is a comma-separated **ordered** list of field names on the
**related** model. The widget reads them from
`this.props.crudOptions.batch_group_by`. Groups are sorted by displayValues
using this list as a tuple sort key (primary, secondary, ...) — e.g.
`"article_type,material_type"` shows article types alphabetically with
materials sorted within each type. Empty/unset values sort last at each level.
Keying is by raw IDs/values (not display names), so two distinct comodel rows
sharing a display_name never collapse into one group.

---

## Key OWL component contracts

### `Many2ManyBField`

- Inherits `X2ManyField` (Odoo 19 base for both O2M and M2M list sub-views)
- Custom options come in via **`props.crudOptions`** (mapped from `options='{…}'` by `x2ManyField.extractProps`)
- `state.mode`: `"individual"` | `"batch"`
- In `individual` mode: delegates entirely to the standard Odoo list renderer
- In `batch` mode: mounts `<BatchRenderer>` instead

### `BatchRenderer`

Receives props:
| Prop | Type | Description |
|---|---|---|
| `records` | `StaticList` | Live OWL record list from `props.value` |
| `groupByFields` | `string[]` | Parsed `batch_group_by` field names |
| `fields` | `object` | Field descriptors of the related model |
| `readonly` | `boolean` | Mirrors parent form editability |
| `onQtyChange` | `(groupKey, delta) => void` | Callback; delta = +1 / -1 / "remove_all" |

Grouping utility (pure function, no side effects):
```js
// Returns Map<groupKey, { fieldValues: {}, records: Record[] }>
groupRecords(records, groupByFields)
```

`groupKey` is a stable string: `JSON.stringify(groupByFields.map(f => record.data[f]))`.

---

## Phase 1 scope (implement now)

- [x] Module scaffold (`__manifest__`, assets registration)
- [ ] `Many2ManyBField` OWL component with mode toggle pills
- [ ] `BatchRenderer` with grouped table (qty | field… | actions)
- [ ] Client-side `groupRecords()` utility
- [ ] Qty `[+]` / `[−]` / `[✕]` controls wired to `StaticList.addNew()` / `.delete()`
- [ ] Silent record creation with `batch_group_by` fields pre-filled
- [ ] Readonly mode: hide all edit controls
- [ ] SCSS: pill toggle, batch table, "Undefined" cell placeholder style

---

## Phase 2 — TODOs

### UX / interaction
- [ ] **Mode persistence via `localStorage`**
      Key: `many2many_b.mode.<model>.<fieldName>`.
      Falls back to `"individual"` if key absent or value invalid.
      Clear on module uninstall via JS hook.

- [ ] **Drag-to-reorder in individual mode**
      Use Odoo's existing `useSortable` hook (available in `@web/core/utils/sortable`).
      Requires the related model to have a `sequence` field; widget should check for
      its presence and silently skip drag handles if absent.

- [ ] **Drag-to-reorder in batch mode**
      Reorder groups, not individual records. Persist order by reordering all records
      of each group together. Interacts with `sequence` field (same prerequisite).

- [ ] **Aggregations beyond count**
      Support `batch_aggregate="field:sum,field:avg"` XML attr.
      Example: show total mileage per brand group alongside the count.
      Requires deciding how to handle mixed-type fields gracefully.

### Performance / scalability
- [ ] **Server-side grouping**
      When M2M record count exceeds a configurable threshold (default: 200),
      fall back to a `read_group` RPC call instead of client-side grouping.
      Threshold configurable via `batch_server_group_threshold` XML attr or
      system parameter `many2many_batch.server_group_threshold`.
      Note: server-side grouping cannot easily interleave with unsaved `StaticList`
      changes — must flush/save first or handle the diff carefully.

- [ ] **Virtual scrolling for large individual lists**
      Investigate reusing Odoo 19's `VirtualList` component for M2M with 500+ records.

### State & persistence
- [ ] **Save current mode per user (server-side)**
      Field `x_many2many_b_mode` on `res.users` or a dedicated
      `many2many.batch.user.pref` model keyed by `(uid, model, field_name)`.
      Heavier than localStorage; only worthwhile for multi-device / kiosk workflows.

### Developer ergonomics
- [ ] **Python field class `Many2manyB`**
      Subclass `fields.Many2many`; add `batch_group_by` as a proper field kwarg.
      Validates that all listed fields exist on the comodel at `_setup_complete`.
      Makes IDE autocompletion and static analysis work properly.

- [ ] **View validation**: warn (not crash) when `batch_group_by` references a field
      that does not exist on the comodel or is not readable.

- [ ] **`batch_group_by` on computed fields**
      Currently untested. Computed fields may not be writable on `addNew()`.
      Needs a compatibility test and documented limitation or workaround.

### Testing
- [ ] Unit tests: `groupRecords()` utility (pure JS, no Odoo needed)
- [ ] Tour test: toggle individual↔batch, change qty, save, reload, verify record count
- [ ] Tour test: readonly parent → verify all edit controls hidden in both modes
- [ ] Python test: M2M write commands generated by the widget survive a save/reload cycle

---

## Odoo 19 technical notes

- Frontend framework: **OWL 2** (`@odoo/owl`)
- Field base class: `X2ManyField` from `@web/views/fields/x2many/x2many_field`
- Many2many list renderer: `ListRenderer` from `@web/views/list/list_renderer`
- Record list model: `StaticList` from `@web/model/relational_model/static_list`
  - `addNewRecord({ context, position, mode, activeFields, withoutParent })` — creates a new linked record (⚠️ **not** `addNew` — that does not exist in Odoo 19)
  - `delete(record)` — stages unlink of that record
- Readonly detection: `this.props.record.isInEdition` (false = readonly)
- Field attrs access: `this.props.attrs` (raw XML attrs dict)
- Asset bundle: `web.assets_backend` in `views/assets.xml`
- OWL component registration: `registry.category("fields").add("many2many_b", Many2ManyBField)`

### Sub-view must declare the item field for [+]/[−] to work

The widget's `[+]`/`[−]` buttons rely on the nested item `StaticList`, which is
only loaded when the item field is declared in the sub-view (otherwise it's not
in `activeFields`).  Use `column_invisible="1"` to keep the field in
`activeFields` without showing a column:

```xml
<record id="fleet_batch_line_view_list" model="ir.ui.view">
    <field name="model">fleet.batch.line</field>
    <field name="arch" type="xml">
        <list>
            <field name="state_id"/>
            <field name="qty"/>
            <field name="vehicle_ids" column_invisible="1"/>  <!-- enables [+]/[−] -->
        </list>
    </field>
</record>
```

`BatchRenderer.getItemList(batchLine)` returns null when the item field is not
loaded, and `canEditItems(batchLine)` disables the buttons (with a tooltip).

---

## Known limitations (phase 1, by design)

- Grouping is 100% client-side; not suitable for M2M with thousands of records
- Mode resets to `individual` on every form load
- `batch_group_by` fields must be stored (non-computed) writable fields on the comodel
- No aggregation columns beyond the count
- Drag-to-reorder not available
- `[+]`/`[−]` buttons are disabled when the sub-view doesn't declare the item
  field (`item_field` option) — see "Sub-view must declare the item field" above
