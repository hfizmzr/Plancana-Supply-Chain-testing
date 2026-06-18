"""
TP-UC5-005: Scenario — Full Farmer Journey
Ref: TC-UC5-005, TCOV-UC5-001 through TCOV-UC5.3-001

End-to-end: login → form → fill step 0 → verify → register → dashboard
"""
import time
import pytest
from conftest import (
    login_as_farmer, fill_step0_all, go_to_verification,
    register_on_blockchain, verify_dashboard_has_batches, BASE_URL,
)


class TestFullJourney:

    @pytest.fixture(autouse=True)
    def setup(self, driver):
        self.d = driver

    @pytest.mark.scenario
    def test_end_to_end(self):
        """Single test covering the complete farmer journey."""

        # 1. Login
        url = login_as_farmer(self.d)
        assert "dashboard" in url.lower(), "Step 1 FAIL: login"

        # 2. Navigate to batch registration
        self.d.get(f"{BASE_URL}/farmer/batch-registration")
        time.sleep(1.5)
        assert "batch" in self.d.current_url.lower(), "Step 2 FAIL: navigation"

        # 3. Fill Step 0 (UC-5.1 + UC-5.2 data)
        fill_step0_all(self.d)
        assert "border-red-500" not in self.d.page_source, "Step 3 FAIL: validation errors"

        # 4. Navigate to verification
        go_to_verification(self.d)
        assert "register batch on blockchain" in self.d.page_source.lower(), (
            "Step 4 FAIL: not on verification"
        )

        # 5. Register on blockchain (UC-5.3)
        ok = register_on_blockchain(self.d)
        assert ok, "Step 5 FAIL: registration"

        # 6. Verify batch in dashboard
        assert verify_dashboard_has_batches(self.d), "Step 6 FAIL: no batches"

        print("\n===== SCENARIO PASSED =====")
