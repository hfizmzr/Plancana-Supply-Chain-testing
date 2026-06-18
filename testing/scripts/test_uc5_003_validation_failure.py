"""
TP-UC5-003: Exception Flow — Validation Failure
Ref: TC-UC5-003, TCOV-UC5-003
"""
import time
import pytest
from conftest import (
    login_as_farmer, fill_step0_all, click_named_button,
    _native_input_set, select_first_option, fill_autocomplete,
    BASE_URL,
)


class TestValidationFailure:

    @pytest.fixture(autouse=True)
    def setup(self, driver):
        self.d = driver

    def test_empty_required_fields(self):
        login_as_farmer(self.d)
        self.d.get(f"{BASE_URL}/farmer/batch-registration")
        time.sleep(1)

        click_named_button(self.d, "Next")  # all fields empty
        time.sleep(1)

        assert "border-red-500" in self.d.page_source, (
            "No validation errors on empty form"
        )

    def test_negative_quantity(self):
        login_as_farmer(self.d)
        self.d.get(f"{BASE_URL}/farmer/batch-registration")
        time.sleep(1)

        fill_step0_all(self.d)
        # Override quantity with negative
        qty = self.d.find_elements("xpath", "//input[@type='number']")[0]
        _native_input_set(self.d, qty, "-50")

        click_named_button(self.d, "Next")
        time.sleep(1)

        assert "border-red-500" in self.d.page_source, (
            "Negative quantity not flagged"
        )

    def test_missing_quality_grade(self):
        login_as_farmer(self.d)
        self.d.get(f"{BASE_URL}/farmer/batch-registration")
        time.sleep(1)

        # Fill everything except quality grade
        select_first_option(self.d, "//select[.//option[text()='Select crop type']]")
        time.sleep(0.3)
        fill_autocomplete(self.d, "Search for product...")
        from conftest import fill_input_by_type
        fill_input_by_type(self.d, "date", "2025-06-15")
        fill_input_by_type(self.d, "number", "500", index=0)
        # skip qualityGrade

        click_named_button(self.d, "Next")
        time.sleep(1)

        assert "border-red-500" in self.d.page_source, (
            "Missing quality grade not flagged"
        )

    def test_fix_errors_then_proceed(self):
        login_as_farmer(self.d)
        self.d.get(f"{BASE_URL}/farmer/batch-registration")
        time.sleep(1)

        # Submit empty first
        click_named_button(self.d, "Next")
        time.sleep(1)
        assert "border-red-500" in self.d.page_source, "Expected validation error"

        # Fix everything
        fill_step0_all(self.d)
        click_named_button(self.d, "Next")
        time.sleep(1)

        assert "border-red-500" not in self.d.page_source, (
            "Errors not cleared after fixing"
        )
