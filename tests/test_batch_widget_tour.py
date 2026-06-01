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
        - Adding lines via the pending-row form
        - Incrementing / decrementing qty
        - Removing a full group
        - Saving and verifying persistence after reload
    """

    def test_batch_editing_tour(self):
        # Start from a blank new-record form (no existing record needed;
        # the action opens in create mode by default).
        self.start_tour(
            "/odoo/action-many2many_batch.action_test_batch_parent",
            "many2many_b_batch_editing",
            login="admin",
        )
