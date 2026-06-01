{
    "name": "Many2many Batch",
    "version": "19.0.1.0.0",
    "summary": "Generic Many2many field with individual / batch (group-by + qty) entry modes",
    "description": """
        Adds the ``many2many_b`` field widget.

        Usage in any form view::

            <field name="vehicle_ids"
                   widget="many2many_b"
                   batch_group_by="brand,model"/>

        ``batch_group_by`` is a comma-separated list of field names
        on the *related* model to group by in batch mode.
    """,
    "category": "Technical",
    "license": "LGPL-3",
    "depends": ["web"],
    "data": [
        "security/ir.model.access.csv",
        "views/test_form_view.xml",
    ],
    "assets": {
        "web.assets_backend": [
            # Exclude tours from production bundle — they live in assets_tests.
            "many2many_batch/static/src/utils/**/*.js",
            "many2many_batch/static/src/components/**/*.js",
            "many2many_batch/static/src/components/**/*.xml",
            "many2many_batch/static/src/components/**/*.scss",
            "many2many_batch/static/src/index.js",
        ],
        "web.assets_tests": [
            "many2many_batch/static/src/tours/**/*.js",
        ],
    },
    "installable": True,
    "auto_install": False,
    "application": False,
}
