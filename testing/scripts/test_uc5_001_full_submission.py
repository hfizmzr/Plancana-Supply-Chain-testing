"""
TP-UC5-001: Main Flow — Full Crop Data Submission
Ref: TC-UC5-001, TCOV-UC5-001
"""
import pytest
from conftest import (
    login_as_farmer, fill_step0_all, go_to_verification,
    register_on_blockchain, verify_dashboard_has_batches,
    verify_batch_registration_form_loaded, BASE_URL,
)


class TestFullSubmission:

    @pytest.fixture(autouse=True)
    def setup(self, driver):
        self.d = driver

    def test_login_as_farmer(self):
        url = login_as_farmer(self.d)
        assert "dashboard" in url.lower(), f"Not on dashboard: {url}"

    def test_navigate_to_batch_registration(self):
        login_as_farmer(self.d)
        self.d.get(f"{BASE_URL}/farmer/batch-registration")
        import time; time.sleep(1)
        assert verify_batch_registration_form_loaded(self.d)

    def test_fill_step0_basic_info(self):
        login_as_farmer(self.d)
        self.d.get(f"{BASE_URL}/farmer/batch-registration")
        import time; time.sleep(1)
        fill_step0_all(self.d)
        assert "border-red-500" not in self.d.page_source, (
            "Validation errors after filling valid data"
        )

    def test_reach_verification_step(self):
        login_as_farmer(self.d)
        self.d.get(f"{BASE_URL}/farmer/batch-registration")
        import time; time.sleep(1)
        fill_step0_all(self.d)
        go_to_verification(self.d)
        assert "register batch on blockchain" in self.d.page_source.lower()

    def test_submit_and_verify_success(self):
        login_as_farmer(self.d)
        self.d.get(f"{BASE_URL}/farmer/batch-registration")
        import time; time.sleep(1)
        fill_step0_all(self.d)
        go_to_verification(self.d)
        ok = register_on_blockchain(self.d)
        assert ok, f"No success confirmation. URL: {self.d.current_url}"

    def test_batch_appears_in_dashboard(self):
        login_as_farmer(self.d)
        self.d.get(f"{BASE_URL}/farmer/batch-registration")
        import time; time.sleep(1)
        fill_step0_all(self.d)
        go_to_verification(self.d)
        register_on_blockchain(self.d)
        assert verify_dashboard_has_batches(self.d), "No batches in dashboard"
