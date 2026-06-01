"""
Test-fixture models for the many2many_batch widget.

Architecture:
    many2many.batch.test.parent
        └── item_ids: One2many → many2many.batch.test.item

    many2many.batch.test.item is the leaf record (brand + model + plate).
    Grouping for the batch view is done client-side by the widget.
"""
from odoo import fields, models


class Many2manyBatchTestItem(models.Model):
    _name = "many2many.batch.test.item"
    _description = "Test Item (many2many_batch fixture)"

    parent_id = fields.Many2one(
        "many2many.batch.test.parent",
        string="Parent",
        ondelete="cascade",
    )
    brand = fields.Char(string="Brand")
    model = fields.Char(string="Model")
    plate = fields.Char(string="Plate")


class Many2manyBatchTestParent(models.Model):
    _name = "many2many.batch.test.parent"
    _description = "Test Parent (many2many_batch fixture)"

    name = fields.Char(default="Test Record")
    item_ids = fields.One2many(
        "many2many.batch.test.item",
        "parent_id",
        string="Items",
    )
