"""
TP-UC5-002: Alt Flow — Wizard navigation and data persistence
Ref: TC-UC5-002, TCOV-UC5-002

Note: no Save Draft button exists. Tests cover multi-step wizard navigation.
"""
import time
import pytest
from conftest import (
    login_as_farmer, fill_step0_all, click_named_button, BASE_URL,
)


class TestWizardNavigation:

    @pytest.fixture(autouse=True)
    def setup(self, driver):
        self.d = driver

    def test_form_loads(self):
        login_as_farmer(self.d)
        self.d.get(f"{BASE_URL}/farmer/batch-registration")
        time.sleep(1)
        page = self.d.page_source.lower()
        assert "next" in page, "Step navigation not found"

    def test_data_persists_across_back_nav(self):
        login_as_farmer(self.d)
        self.d.get(f"{BASE_URL}/farmer/batch-registration")
        time.sleep(1)
        fill_step0_all(self.d)

        click_named_button(self.d, "Next")     # → Step 1
        time.sleep(1)
        click_named_button(self.d, "Previous") # ← Step 0
        time.sleep(1)
        click_named_button(self.d, "Next")     # → Step 1 again

        assert "border-red-500" not in self.d.page_source, (
            "Data lost after back navigation"
        )

    def test_skip_farm_details_to_verification(self):
        login_as_farmer(self.d)
        self.d.get(f"{BASE_URL}/farmer/batch-registration")
        time.sleep(1)
        fill_step0_all(self.d)

        click_named_button(self.d, "Next")  # → Step 1
        time.sleep(0.5)
        click_named_button(self.d, "Next")  # → Step 2

        assert "register batch on blockchain" in self.d.page_source.lower()
