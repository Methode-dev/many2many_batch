"""
Tour-based integration tests for the many2many_b widget.

Run with:
    ./odoo-bin --test-enable --stop-after-init \
        -m many2many_batch \
        --test-tags many2many_batch

Or from the Odoo shell:
    odoo-bin -i many2many_batch --test-tags many2many_batch
"""

from odoo.tests import tagged
from odoo.tests.common import HttpCase


@tagged("post_install", "-at_install", "many2many_batch")
class TestMany2ManyBWidgetTour(HttpCase):
    """
    Drives the JS tour `many2many_b_batch_editing` through a real browser
    session.  The tour covers:

        - Switching individual ↔ batch mode
        - Adding lines that commit themselves when left, or with Enter
        - Dropping a line left empty, or cancelled with Esc
        - Incrementing / decrementing qty
        - Removing a full group
        - Saving straight from a line being entered, its qty included
        - Editing a saved group (its records are reloaded objects) without
          splitting it, and adding a line after a save
    """

    def test_batch_editing_tour(self):
        # Start from a blank new-record form (no existing record needed;
        # the action opens in create mode by default).
        self.start_tour(
            "/odoo/action-many2many_batch.action_test_batch_parent",
            "many2many_b_batch_editing",
            login="admin",
        )
        parent = self.env["many2many.batch.test.parent"].search([], order="id desc", limit=1)
        self.assertEqual(
            sorted(parent.item_ids.mapped(lambda item: (item.brand, item.model))),
            [("Citroen", "C3"), ("Citroen", "C3"), ("Fiat", "Panda"),
             ("Renault", "Clio"), ("Renault", "Clio")],
        )
