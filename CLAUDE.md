# many2many_batch — Odoo 19.0 Module

A generic, reusable Odoo addon that extends the standard `Many2many` field
with a **batch entry mode**: records can be viewed and edited either
individually (standard list) or grouped by key fields with a quantity column.

---

## Quick orientation

```
many2many_batch/
├── __init__.py
├── __manifest__.py                       # assets declared inline here (there is no views/assets.xml)
├── models/test_models.py                 # tour fixture models
├── views/test_form_view.xml              # tour fixture form + action
├── tests/                                # HttpCase tour tests
└── static/src/
    ├── index.js                          # field registration entry point
    ├── tours/                            # browser tours (web.assets_tests bundle)
    ├── utils/debug.js                    # namespaced console logging (M2M_DEBUG)
    └── components/
        ├── many2many_b_field/            # main OWL component (.js / .xml / .scss)
        ├── many2many_b_batch_renderer/   # grouped-table sub-component (.js / .xml / .scss)
        ├── records_table_dialog/         # whole list as one wide table, on row click (.js / .xml / .scss)
        └── group_by_cell/                # <Field> wrapper with domain forwarding (.js / .xml)
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

### `table_dialog` — open the whole list as one wide table

```xml
<field name="seafarer_ids" widget="many2many_b"
       options='{"batch_group_by": "nationality_id",
                 "table_dialog_size": "fs",
                 "table_dialog": "nationality_id, visa_situation_id:VISA, passport_number:Ppt n°"}'>
    <list>
        <field name="nationality_id"/>
        <field name="visa_situation_id"/>
        <field name="passport_number" column_invisible="1"/>
    </list>
</field>
```

Clicking any row in **individual** mode then opens `RecordsTableDialog`: the whole
list as one wide table of those columns, with the clicked row highlighted and
scrolled into view — instead of the clicked record alone in the comodel's form
view. The compact list stays the overview; the dialog is where the full data set is
read and completed.

| Option | Meaning |
|---|---|
| `table_dialog` | Comma-separated, **ordered** field names. `field:Custom header` overrides that column's label. Empty/absent → stock form dialog. |
| `table_dialog_size` | Dialog size: `sm` / `md` / `lg` / `xl` / `fs`. Default `xl`; use `fs` past ~8 columns. |
| `table_dialog_title` | Dialog title. Defaults to the field's own label. |
| `table_dialog_autosave` | `True` → each row is written to the database shortly after one of its cells changes, instead of waiting for the parent form to be saved. Off by default. |
| `table_dialog_edit_action` | Method name on the related model returning an action. Adds a trailing column with one button per row that opens it. Off by default. |

### `table_dialog_edit_action` — a way out to the record that owns the data

Some columns only *mirror* another record: a crew line's name, passport number and
seaman book are related fields on the seafarer's contact, and the full name is
computed there, so it cannot be typed into at all. Point the option at a method
returning an action and the dialog grows a pinned right-hand column whose button
opens it:

```xml
options='{"table_dialog": "...", "table_dialog_edit_action": "action_open_seafarer_contact"}'
```

- Called as `<related model>.<method>(row_id)`; anything falsy is ignored (e.g. the
  crew line has no contact yet).
- Pending table edits are flushed **before** the action opens, so the form cannot
  silently discard a cell that was just typed.
- On close, only that row is refreshed, with `record.load()` — it refetches the
  same datapoint in place, whereas reloading the parent would swap out the record
  objects the open table is rendering.
- The column is `position: sticky; right: 0`, so the button stays in reach on a
  table wide enough to scroll sideways.

### `table_dialog_autosave` — write-through editing

With it on, the dialog is a live grid: a cell edit marks its row dirty, and half a
second of quiet later that row is saved with `record.save({reload: false})` — a
`web_save` on the comodel record itself, which is the same call Odoo makes for a
many2many row edited through its own record dialog (`updateRecord` in
`web/.../relational_utils.js`). Consequences worth knowing:

- It saves **the row, not the parent form**: nothing else pending on the form is
  written, and it works even when the list is a computed field with no inverse (an
  operation's crew wizard) — the case where a parent save would drop the change.
- `reload: false` is required. A reloading save rebuilds the parent's x2many list,
  swapping out the record objects the open table is rendering.
- Saving is **debounced and guarded by `record.dirty`**, and never done straight
  from the cell's change handler. `Record._save()` ends with
  `this.data = {...this._values}` *even when the changes were empty*, which
  re-notifies every cell observer of that row; saving from there loops forever, one
  round per animation frame, each round paying a model-wide `_askChanges()` (one
  handler per mounted input). That mistake made the table unusable — keep the
  dirty check and the idle timer.
- Rows with no `resId` (added but never saved) are skipped: they still go with the
  parent.
- A row that is invalid is left dirty and retried on the next edit; a failed save
  raises a notification instead of throwing out of the field.
- Closing flushes: the Close button awaits it, and `onWillUnmount` /
  `execBeforeUnmount` cover ✕ and Escape.

- Cells are ordinary `<Field>` widgets (through `GroupByCell`, so many2one domains
  and the `allowed_<field>_ids` convention work), **editable** when the parent
  field is not readonly, and saved with the parent form.
- Every `table_dialog` field must be loaded by the sub-view — declare it as a
  `<list>` column, with `column_invisible="1"` to keep it out of the list itself.
  A column that is not loaded is skipped rather than crashing the dialog.
- **Many2one columns must use `optional="hide"`, not `column_invisible="1"`.**
  `extractFieldsFromArchInfo` ORs `column_invisible` into `invisible`
  (`combineModifiers(null, "1", "OR") === "1"`), and `getFieldsSpec` loads an
  always-invisible Many2one as `fields: {}` — the id with **no `display_name`**,
  since nothing was supposed to render it. The dialog renders it anyway, so the
  cell reads "Unnamed" (the Many2one widget's fallback for a value with no name)
  while its internal link still opens the right record. Setting a value looks
  fine — the name comes from the autocomplete — and it only breaks after a
  reload. `optional="hide"` leaves `invisible` unset, so the name is loaded, and
  keeps the column out of the list (toggleable from its column menu).
  Char/Date/Selection columns have no sub-spec and load fine either way; x2many
  columns used only for their ids (the `allowed_<field>_ids` domain convention)
  are also fine invisible.
- Only fires where Odoo itself opens a record, i.e. when the sub-list is **not**
  `editable` (`X2ManyField.canOpenRecord`); an editable list keeps editing inline.
- Records load in readonly mode, so the dialog flips them to edit for its lifetime
  and restores exactly those it touched on close — the list renderer allows only
  one in-edition row.
- Headers are sticky and the table scrolls inside the dialog, so a long crew list
  never pushes the footer off-screen.

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
`this.props.crudOptions.batch_group_by`. Group order tracks each group's
**oldest** record (first occurrence) in the underlying list: a draft that
introduces a brand-new combination lands at the bottom (its first record was
just appended), while a draft that merges into an existing group keeps that
group anchored at its original position — the freshly-cloned siblings join
silently, no reshuffle. Keying is by raw IDs/values (not display names), so
two distinct comodel rows sharing a display_name never collapse into one
group.

---

## Adding a line in batch mode (draft rows)

"Add a line" opens a **draft row**: a real new record, kept out of the groups
until it is left. There is no confirm button. The row commits itself when the
user leaves it — a click anywhere outside (capture-phase `click` listener),
Tab out (`focusout`), or Enter — and is dropped when none of its group-by
fields was filled. Esc or the trash icon discards it. Its qty uses the same
− / + stepper as a group.

Committing goes through `Many2ManyBField.onSettleDraft`, which runs as **one
model-mutex job**, and that ordering is load-bearing:

- the edit of the field just left (a Char/Integer input writes on `change`, as
  focus leaves it) is queued *ahead* of the job, so the draft is read complete;
- a Save the same click goes on to trigger is queued *behind* it, so it stores
  all N records, not one.

The N-1 copies (and the records [+] adds) are created and stamped with the
group's values inside that job, without an onchange (`_createRecordsLike`): a
creation onchange may default them otherwise — a crew row's nationality
onchange re-defaults its visa situation — and a Save slipping in between would
persist the default. It uses `StaticList` internals (`_createNewRecordDatapoint`,
`_addRecord`, `_applyCommands`, `_onUpdate`) because the public methods take the
mutex themselves.

### Records are tracked by identity, never by count

A save reloads the list into **new record objects of the same length**. Every
effect that has to see each record (switching it to edit mode so its cells show
inputs, wrapping each group's host so an edit reaches the whole group) is keyed
on the records themselves (`() => [...this.props.records]`), not on
`records.length`. Keyed on the count, the reloaded rows stayed readonly and
unwrapped: a saved group lost its inputs, and an edit reached only its first
record — the group split.

Likewise, an edit finds the records it must reach **by value at the moment of
the edit** (`_groupSiblings`: same group-by key, drafts excluded), never by
position: which record is a group's `records[0]` changes as lines come and go.
Siblings are updated through their *original* `update`, so a sibling that is
itself wrapped never propagates a second time.

A draft is registered **before its record joins the list** (`onAddDraft`
hands it to the renderer from inside the mutex job). Registered after, it
rendered for a frame as an ordinary group row and got wrapped as that group's
host.

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

Grouping is the `BatchRenderer.groups` getter (client-side, no side effects):
```js
// Returns Array<{ key, fieldValues, displayValues, records }>, ordered by
// each group's oldest (first-occurrence) record in the underlying list.
get groups()
```

`key` is a stable string keyed on the *raw* group-by values (Many2one → id):
`JSON.stringify(groupByFields.map(f => rawValue(record.data[f])))`.

---

## Phase 1 scope (shipped)

- [x] Module scaffold (`__manifest__`, assets registration)
- [x] `Many2ManyBField` OWL component with mode toggle pills
- [x] `BatchRenderer` with grouped table (field… | qty | actions)
- [x] Client-side grouping (`BatchRenderer.groups` getter)
- [x] Qty `[+]` / `[−]` / `[🗑]` controls wired to `StaticList.addNewRecord()` / `.delete()`
- [x] Draft rows ("Add a line" → group-by cells + qty, confirm clones the draft)
- [x] Readonly mode: hide all edit controls
- [x] SCSS: pill toggle, batch table, merge-flash animation

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
- [ ] Unit tests: the `BatchRenderer.groups` grouping logic
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
- Field options access: **`this.props.crudOptions`** (mapped from `options='{…}'` by `x2ManyField.extractProps`; `props.attrs` / `props.options` do **not** exist — see the prop-pipeline note above)
- Asset bundle: `web.assets_backend`, declared inline in `__manifest__.py` (there is no `views/assets.xml`); tours ship in `web.assets_tests`
- OWL component registration: `registry.category("fields").add("many2many_b", many2ManyBField)`

### Group-by fields must be columns of the sub-view

`BatchRenderer` renders each group-by cell with Odoo's `<Field>` on
`group.records[0]`, so the field must be in the sub-view's `activeFields` —
i.e. declared as a `<list>` column. A `batch_group_by` entry that is not a
column falls back to a muted "—" cell (`props.fields[fieldName]` is undefined).
Use `column_invisible="1"` to keep a field in `activeFields` without showing it
in Individual mode.

---

## Known limitations (phase 1, by design)

- Grouping is 100% client-side; not suitable for M2M with thousands of records
- Mode resets to `default_mode` on every form load (no persistence)
- `batch_group_by` fields must be stored (non-computed) writable fields on the
  comodel, and must be columns of the sub-view (see above)
- No aggregation columns beyond the count
- Drag-to-reorder not available
- `[−]` is disabled once any record in the group carries data outside the
  group-by / `default_values` fields (`isAllRecordsVirgin`): removing a specific
  one is an Individual-mode operation
