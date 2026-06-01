# many2many_batch

> **Odoo 19.0 — `many2many_b` widget**  
> A drop-in replacement for any `Many2many` field that adds a **Batch mode**: records are grouped by key fields and shown with a quantity counter — no extra model, no extra RPC.

---

## What it does

Standard Odoo Many2many fields display linked records as a flat list.  
`many2many_b` adds a second view that **groups identical records** and lets you
adjust quantities with `[−]` / `[+]` buttons, or remove an entire group with one click.

The two modes are toggled with a pill switch rendered directly above the field:

```
  [ ☰ Individual ]  [ ⊞ Batch ]
```

Both modes share the exact same underlying data — switching never mutates records.

---

## Installation

1. Copy the `many2many_batch` directory into your Odoo `addons` path.
2. Restart the Odoo server.
3. Go to **Settings → Technical → Update Apps List** (developer mode required).
4. Install **Many2many Batch**.

---

## Usage

Add `widget="many2many_b"` and a `batch_group_by` attribute to any `<field>` tag
inside a form view:

```xml
<field name="vehicle_ids"
       widget="many2many_b"
       batch_group_by="brand,model"
       string="Vehicles"/>
```

`batch_group_by` is a **comma-separated list of field names** on the *related* model
(the comodel of the Many2many). These are the fields used to group records together.

### Requirements

| Requirement | Detail |
|---|---|
| Odoo version | 19.0 |
| Related field types | `Char`, `Integer`, `Many2one`, `Selection` — any stored field |
| `batch_group_by` fields | Must be stored (non-computed) and readable on the comodel |
| Fallback behaviour | If `batch_group_by` is omitted, the widget behaves like a plain M2M list |

---

## Tutorial

### Scenario

You have a `fleet.vehicle` model with `brand` and `model` fields, and a form
that links a record to many vehicles.  You want to enter 5 Toyota Corollas
and 3 Honda Civics quickly, without clicking "Add a line" eight times.

### Step 1 — Define your view

```xml
<record id="view_order_form" model="ir.ui.view">
  <field name="model">sale.order</field>
  <field name="arch" type="xml">
    <form>
      <sheet>
        <field name="name"/>

        <!-- Drop-in replacement for a standard Many2many -->
        <field name="vehicle_ids"
               widget="many2many_b"
               batch_group_by="brand,model"
               string="Vehicles"/>
      </sheet>
    </form>
  </field>
</record>
```

### Step 2 — Open the form in Odoo

When the form opens you see the field in **Individual mode** (the default),
which is identical to a standard Odoo list widget:

```
┌─────────────────────────────────────────────────────────────────────┐
│  Name   [Order #001                                               ]  │
│                                                                      │
│  Vehicles                                                            │
│  [ ☰ Individual ]  [ ⊞ Batch ]                                       │
│ ┌────────────────────────────────────────────────────────────────┐   │
│ │  Brand      │  Model    │  Plate                               │   │
│ ├────────────────────────────────────────────────────────────────┤   │
│ │  (empty list)                                                  │   │
│ ├────────────────────────────────────────────────────────────────┤   │
│ │  + Add a line                                                  │   │
│ └────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

### Step 3 — Switch to Batch mode

Click the **⊞ Batch** pill. The list is replaced by the batch table:

```
┌─────────────────────────────────────────────────────────────────────┐
│  Vehicles                                                            │
│  [ ☰ Individual ]  [ ⊞ Batch ]   ← "Batch" pill is now active       │
│ ┌──────────────────┬───────────┬──────────┬────┐                    │
│ │  Qty             │  Brand    │  Model   │    │                    │
│ ├──────────────────┼───────────┼──────────┼────┤                    │
│ │  (empty)                                     │                    │
│ ├──────────────────┴───────────┴──────────┴────┤                    │
│ │  + Add a line                                │                    │
│ └──────────────────────────────────────────────┘                    │
└─────────────────────────────────────────────────────────────────────┘
```

### Step 4 — Add a pending row

Click **+ Add a line**. A highlighted row with input fields appears at the bottom:

```
│ ┌──────────────────┬─────────────────┬──────────────┬────────────┐  │
│ │  Qty             │  Brand          │  Model       │            │  │
│ ├──────────────────┼─────────────────┼──────────────┼────────────┤  │
│ │  [ 5 ▲▼ ]       │  [ Toyota     ] │  [ Corolla ] │  ✓   ✕    │  │
│ └──────────────────┴─────────────────┴──────────────┴────────────┘  │
│    + Add a line                                                       │
```

Type **5** in Qty, **Toyota** in Brand, **Corolla** in Model, then click ✓.

### Step 5 — Confirm and add more groups

The pending row is confirmed and the table now shows a real group.  
Click **+ Add a line** again for the second batch:

```
│ ┌──────────────────┬─────────────────┬──────────────┬────────────┐  │
│ │  Qty             │  Brand          │  Model       │            │  │
│ ├──────────────────┼─────────────────┼──────────────┼────────────┤  │
│ │  [−]  5  [+]    │  Toyota         │  Corolla     │  🗑        │  │
│ ├──────────────────┼─────────────────┼──────────────┼────────────┤  │
│ │  [ 3 ▲▼ ]       │  [ Honda      ] │  [ Civic   ] │  ✓   ✕    │  │
│ └──────────────────┴─────────────────┴──────────────┴────────────┘  │
│    + Add a line                                                       │
```

Confirm the second row. You now have two groups, 8 records in total.

### Step 6 — Adjust quantities

Need 6 Corollas instead of 5? Click **[+]** in the Toyota / Corolla row.
The counter increments immediately and a new record is created in the background:

```
│ │  [−]  6  [+]    │  Toyota         │  Corolla     │  🗑        │  │
│ │  [−]  3  [+]    │  Honda          │  Civic       │  🗑        │  │
```

Click **[−]** to remove one record from a group.  
The **[−]** button is disabled when the group has only 1 record (prevents accidental
deletion — use 🗑 to remove the whole group at once).

### Step 7 — Switch back to Individual mode

Click **☰ Individual** at any time. You'll see all 9 records as a flat list,
each with its own Brand and Model populated:

```
│ ┌────────────┬──────────────┬────────┐                               │
│ │  Brand     │  Model       │  Plate │                               │
│ ├────────────┼──────────────┼────────┤                               │
│ │  Toyota    │  Corolla     │  —     │                               │
│ │  Toyota    │  Corolla     │  —     │                               │
│ │  Toyota    │  Corolla     │  —     │                               │
│ │  Toyota    │  Corolla     │  —     │                               │
│ │  Toyota    │  Corolla     │  —     │                               │
│ │  Toyota    │  Corolla     │  —     │                               │
│ │  Honda     │  Civic       │  —     │                               │
│ │  Honda     │  Civic       │  —     │                               │
│ │  Honda     │  Civic       │  —     │                               │
│ ├────────────┼──────────────┼────────┤                               │
│ │  + Add a line                      │                               │
│ └────────────┴──────────────┴────────┘                               │
```

> **Tip — Fill the remaining fields**: records created in batch mode leave
> non-group-by fields (e.g. `Plate`) empty. Switch to Individual mode and
> edit each row to fill them in.

### Step 8 — Save

Click **Save** (or navigate away). The widget generates standard Odoo M2M
write commands — no custom Python required. On reload, Individual mode
is shown again (mode resets per the Phase 1 spec; persistence comes in Phase 2).

### Readonly forms

When the parent record is in readonly mode (view, not edit), the batch table
hides all controls — no `[+]`, `[−]`, `🗑`, or **+ Add a line**:

```
│  Vehicles  (readonly)                                                │
│  [ ☰ Individual ]  [ ⊞ Batch ]                                       │
│ ┌──────────┬─────────┬──────────┐                                    │
│ │  Qty     │  Brand  │  Model   │                                    │
│ ├──────────┼─────────┼──────────┤                                    │
│ │  6       │  Toyota │  Corolla │                                    │
│ │  3       │  Honda  │  Civic   │                                    │
│ └──────────┴─────────┴──────────┘                                    │
```

The pill toggle is still available so users can switch between grouped
and flat views even in readonly.

---

## How grouping works

Grouping is **100% client-side** — no extra RPC, no intermediate model.

The `groupRecords(records, groupByFields)` utility builds a stable key:

```js
// For a record { brand: "Toyota", model: "Corolla", plate: "AB-123" }
// with groupByFields = ["brand", "model"]
key = JSON.stringify(["Toyota", "Corolla"])
    = '["Toyota","Corolla"]'
```

Records that share the same key are merged into one group; their count
becomes the displayed Qty.

For **Many2one** values the id is used as the key component (not the display
name), so renames of a related record don't cause a group split.

---

## Architecture at a glance

```
Many2ManyBField (extends X2ManyField)
│
├── state.mode = "individual" | "batch"
│
├── [individual mode]
│     └─ renders the standard <X2ManyField> template unchanged
│
└── [batch mode]
      └─ <BatchRenderer>
           ├── groupRecords() — pure function, no side-effects
           ├── Existing groups  → [−] qty [+]   🗑
           ├── Pending rows     → text inputs + ✓ / ✕
           └── Add a line       → addPendingRow()

StaticList (Odoo internal)
  ├── addNew({ context })   ← called by onQtyChange (delta > 0)
  └── delete(record)        ← called by onQtyChange (delta < 0 or "remove_all")
```

---

## File map

```
many2many_batch/
├── __manifest__.py
├── models/
│   └── test_models.py                      # fixture models for the tour
├── views/
│   └── test_form_view.xml                  # fixture form view + action
└── static/src/
    ├── index.js                            # field registration
    ├── utils/
    │   └── group_records.js               # pure grouping utility
    └── components/
        ├── many2many_b_field/
        │   ├── many2many_b_field.js        # main OWL component + qty logic
        │   ├── many2many_b_field.xml       # pill toggle + mode routing
        │   └── many2many_b_field.scss      # pill + table styles
        └── many2many_b_batch_renderer/
            ├── batch_renderer.js           # grouped table component
            └── batch_renderer.xml          # table template
```

---

## Known limitations (Phase 1)

- Client-side grouping only — not suitable for M2M with thousands of records.
- Mode resets to `individual` on every form load (localStorage persistence is Phase 2).
- `batch_group_by` fields must be stored, non-computed, and writable on the comodel.
- No aggregation columns beyond the count.
- Drag-to-reorder not yet available.

---

## License

LGPL-3 — see [`__manifest__.py`](./__manifest__.py).
