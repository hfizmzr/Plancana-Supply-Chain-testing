"""
TP-UC5-002: Alt Flow — Save as Draft
Ref: TC-UC5-002, TCOV-UC5-002
Test Procedure: TP-UC5-002 (test procedure.md lines 288-296)

Steps:
  1. Login as Farmer → navigate to batch-registration
  2. Enter partial data (crop type, harvest date — leave quantity/GIS empty)
  3. Click 'Save as Draft' button
  4. Verify 'Draft saved successfully' confirmation
  5. Navigate to dashboard, locate 'Drafts' / 'Resume Submission'
  6. Resume draft → verify previous data preserved
  7. Complete remaining fields → submit → verify batch ID

Expected: ALL STEPS FAIL — 'Save as Draft' button does not exist in BatchRegistration.js.
The feature was specified in UC-5 Alt Flow but never implemented (same root cause as TIR-03-001).
"""
import time
import pytest
from selenium.webdriver.common.by import By
from selenium.common.exceptions import NoSuchElementException
from conftest import (
    login_as_farmer, fill_step0_all, click_named_button, BASE_URL,
)


class TestSaveAsDraft:
    """Verifies the Save-as-Draft feature described in UC-5 Alternative Flow."""

    @pytest.fixture(autouse=True)
    def setup(self, driver):
        self.d = driver

    def test_save_draft_button_exists(self):
        login_as_farmer(self.d)
        self.d.get(f"{BASE_URL}/farmer/batch-registration")
        time.sleep(2)

        page = self.d.page_source.lower()

        # Search for any button/link with 'draft' text
        draft_found = "save as draft" in page or "save draft" in page

        # Also search by XPath for any element with 'Draft' text
        try:
            draft_buttons = self.d.find_elements(
                By.XPATH,
                "//*[contains(translate(text(),'DRAFT','draft'),'draft')]"
            )
            draft_xpath_count = len(draft_buttons)
        except Exception:
            draft_xpath_count = 0

        print(f"  'save as draft' in page: {draft_found}")
        print(f"  Draft elements by XPath: {draft_xpath_count}")

        assert draft_found or draft_xpath_count > 0, (
            "FAIL (TIR-UC5-001): No 'Save as Draft' button found. "
            "The Save-as-Draft feature from UC-5 Alt Flow is not implemented."
        )

    def test_draft_confirmation_message(self):
        login_as_farmer(self.d)
        self.d.get(f"{BASE_URL}/farmer/batch-registration")
        time.sleep(2)

        # Enter partial data to set up the test
        fill_step0_all(self.d)

        # Attempt to click 'Save as Draft'
        try:
            click_named_button(self.d, "Save as Draft")
            time.sleep(2)
            page = self.d.page_source.lower()
            has_draft_msg = "draft" in page and ("saved" in page or "success" in page)
            assert has_draft_msg, (
                "FAIL: Clicked Save as Draft but no 'Draft saved successfully' message displayed."
            )
        except NoSuchElementException:
            pytest.fail(
                "FAIL (TIR-UC5-001): 'Save as Draft' button not found — "
                "cannot verify draft confirmation message."
            )

    def test_draft_appears_on_dashboard(self):
        login_as_farmer(self.d)

        # Navigate directly to dashboard
        self.d.get(f"{BASE_URL}/farmer/dashboard")
        time.sleep(2)

        page = self.d.page_source.lower()

        # Search for any draft-related text
        draft_found = ("draft" in page or "resume" in page)
        print(f"  'draft'/'resume' in dashboard: {draft_found}")

        # Try to find resume buttons/links
        try:
            resume_els = self.d.find_elements(
                By.XPATH,
                "//*[contains(translate(text(),'RESUME','resume'),'resume')]"
            )
            resume_count = len(resume_els)
        except Exception:
            resume_count = 0

        print(f"  Resume elements found: {resume_count}")

        assert draft_found or resume_count > 0, (
            "FAIL (TIR-UC5-001): No 'Drafts' section or 'Resume Submission' option "
            "found on farmer dashboard. Draft management UI is not implemented."
        )

    def test_draft_data_persists_on_resume(self):
        login_as_farmer(self.d)
        self.d.get(f"{BASE_URL}/farmer/batch-registration")
        time.sleep(2)

        # Fill partial data
        fill_step0_all(self.d)

        # Try clicking Save as Draft first, then resume
        try:
            click_named_button(self.d, "Save as Draft")
            time.sleep(1)
        except NoSuchElementException:
            pass  # Expected — button doesn't exist

        # Navigate to dashboard and try to resume
        self.d.get(f"{BASE_URL}/farmer/dashboard")
        time.sleep(2)

        try:
            resume_btn = self.d.find_element(
                By.XPATH,
                "//*[contains(translate(text(),'RESUME','resume'),'resume')]"
            )
            resume_btn.click()
            time.sleep(2)

            # Check if form data was preserved
            try:
                page = self.d.page_source.lower()
                has_data = "rice" in page or "basmati" in page
                assert has_data, (
                    "FAIL: Resumed draft but previous data (Rice) not found in form."
                )
            except AssertionError:
                raise
        except NoSuchElementException:
            pytest.fail(
                "FAIL (TIR-UC5-001): Cannot verify draft data persistence — "
                "'Resume' button not found on dashboard. "
                "Draft/Resume feature is not implemented."
            )
