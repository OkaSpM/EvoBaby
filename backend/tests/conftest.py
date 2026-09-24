"""Keep API integration runs isolated from the user's saved ending cards."""
import pytest

import app.api.controller as controller_module


@pytest.fixture(autouse=True)
def isolated_ending_card_storage(tmp_path, monkeypatch):
    # The controller resolves its storage root from this module path. Redirect
    # before construction so tests neither load nor write production card data.
    monkeypatch.setattr(controller_module, "__file__", str(
        tmp_path / "backend" / "app" / "api" / "controller.py"))
