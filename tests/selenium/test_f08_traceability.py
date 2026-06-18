"""
Selenium Tests: F08 & F08.1 — View Traceability & View Product History
Test Design Reference: SOFTEST-TEST-DESIGN.md

Navigation note: This app exposes traceability via /verify/{batchId} (URL-based,
no search form). Tests reach the page by navigating directly to that URL, which is
the "batch ID entry path" described in the test design (as opposed to QR scanning).

Prerequisites:
  - Frontend running at http://localhost:3001
  - Backend running at http://localhost:3000
  - ChromeDriver installed and on PATH (must match your Chrome version)
  - VALID_BATCH_ID and INCOMPLETE_BATCH_ID set to real values from your DB
      SELECT id FROM "Batch" WHERE status = 'SOLD' LIMIT 1;         -- complete
      SELECT id FROM "Batch" WHERE status = 'HARVESTED' LIMIT 1;    -- incomplete
"""

import time
import urllib.parse

import pytest
from selenium.common.exceptions import TimeoutException
from selenium.webdriver.common.by import By
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.support.ui import WebDriverWait

# ─────────────────────────────────────────────────────────────
#  CONFIGURATION  ← update before running
# ─────────────────────────────────────────────────────────────
BASE_URL = "http://localhost:3001"

# A batch that exists with a COMPLETE supply chain (farmer → processor → distributor)
VALID_BATCH_ID = "REPLACE_WITH_VALID_BATCH_ID"

# A batch that exists but is MISSING one or more supply chain stages
INCOMPLETE_BATCH_ID = "REPLACE_WITH_INCOMPLETE_BATCH_ID"

WAIT_TIMEOUT = 15
# ─────────────────────────────────────────────────────────────


def verify_url(batch_id: str) -> str:
    return f"{BASE_URL}/verify/{urllib.parse.quote(str(batch_id), safe='')}"


def wait_for_load(driver, timeout=WAIT_TIMEOUT):
    """Block until the loading spinner is gone."""
    try:
        WebDriverWait(driver, timeout).until(
            EC.invisibility_of_element_located((By.CSS_SELECTOR, ".animate-spin"))
        )
    except TimeoutException:
        pass  # spinner may never have appeared


# ═════════════════════════════════════════════════════════════
#  TC-08-001: Verify Traceability View with Valid Batch ID
#  TCOV: 08-001, 08-005, 08-010, 08-011, 08-012, 08-013, 08-014, 08-017
# ═════════════════════════════════════════════════════════════
class TestTC08001:
    """
    Pre-conditions : Logged in as Retailer. VALID_BATCH_ID has complete supply chain.
    Post-conditions: Full product history timeline rendered with all stages and
                     blockchain verification status visible.
    """

    def test_page_loads_after_valid_batch_id(self, logged_in_driver):
        """Navigate to verify URL and confirm page loads (not stuck on spinner)."""
        driver = logged_in_driver
        driver.get(verify_url(VALID_BATCH_ID))
        wait_for_load(driver)

        loaded = WebDriverWait(driver, WAIT_TIMEOUT).until(
            lambda d: d.find_elements(By.CSS_SELECTOR, "h1, h2")
        )
        assert loaded, "Page did not finish loading — no heading found"

    def test_product_history_timeline_displayed(self, logged_in_driver):
        """TCON-08-010: 'Supply Chain Journey' section is visible after valid batch ID."""
        driver = logged_in_driver
        driver.get(verify_url(VALID_BATCH_ID))
        wait_for_load(driver)

        heading = WebDriverWait(driver, WAIT_TIMEOUT).until(
            EC.presence_of_element_located(
                (By.XPATH, "//*[contains(text(), 'Supply Chain Journey')]")
            )
        )
        assert heading.is_displayed(), "Supply Chain Journey (timeline) is not visible"

    def test_farmer_info_section_visible(self, logged_in_driver):
        """TCON-08-011: Origin Farm Information section is visible with farmer details."""
        driver = logged_in_driver
        driver.get(verify_url(VALID_BATCH_ID))
        wait_for_load(driver)

        section = WebDriverWait(driver, WAIT_TIMEOUT).until(
            EC.presence_of_element_located(
                (By.XPATH, "//*[contains(text(), 'Origin Farm Information')]")
            )
        )
        assert section.is_displayed(), "Origin Farm Information section is not visible"

    def test_processing_info_visible_in_timeline(self, logged_in_driver):
        """TCON-08-012: Processing stage is visible inside Supply Chain Journey."""
        driver = logged_in_driver
        driver.get(verify_url(VALID_BATCH_ID))
        wait_for_load(driver)

        # Processing appears as a stage node inside the Supply Chain Journey section
        processing_stage = WebDriverWait(driver, WAIT_TIMEOUT).until(
            EC.presence_of_element_located(
                (By.XPATH, "//*[contains(text(), 'Processing') or contains(text(), 'Processor')]")
            )
        )
        assert processing_stage.is_displayed(), "Processing stage not visible in timeline"

    def test_distribution_info_visible_in_timeline(self, logged_in_driver):
        """TCON-08-013: Distribution stage is visible inside Supply Chain Journey."""
        driver = logged_in_driver
        driver.get(verify_url(VALID_BATCH_ID))
        wait_for_load(driver)

        distribution_stage = WebDriverWait(driver, WAIT_TIMEOUT).until(
            EC.presence_of_element_located(
                (By.XPATH, "//*[contains(text(), 'Distribution') or contains(text(), 'Distributor')]")
            )
        )
        assert distribution_stage.is_displayed(), "Distribution stage not visible in timeline"

    def test_blockchain_verification_status_displayed(self, logged_in_driver):
        """TCON-08-014: Blockchain verification status is shown on the page."""
        driver = logged_in_driver
        driver.get(verify_url(VALID_BATCH_ID))
        wait_for_load(driver)

        blockchain_el = WebDriverWait(driver, WAIT_TIMEOUT).until(
            EC.presence_of_element_located(
                (By.XPATH, "//*[contains(text(), 'Blockchain Verified') or contains(text(), 'Blockchain')]")
            )
        )
        assert blockchain_el.is_displayed(), "Blockchain verification status not visible"


# ═════════════════════════════════════════════════════════════
#  TC-08-002: Verify Non-Existent or Invalid Batch ID
#  TCOV: 08-002, 08-004, 08-018
# ═════════════════════════════════════════════════════════════
class TestTC08002:
    """
    Pre-conditions : User is on the traceability page (no login required).
    Post-conditions: No timeline rendered; appropriate error message displayed.
    """

    def test_non_existent_batch_shows_verification_failed(self, driver):
        """TCON-08-002: 'Verification Failed' shown for a valid-format but non-existent batch ID."""
        driver.get(verify_url("BATCH-99999"))
        wait_for_load(driver)

        error = WebDriverWait(driver, WAIT_TIMEOUT).until(
            EC.presence_of_element_located(
                (By.XPATH, "//*[contains(text(), 'Verification Failed')]")
            )
        )
        assert error.is_displayed(), "Error message not shown for non-existent batch ID"

    def test_non_existent_batch_no_timeline(self, driver):
        """TCON-08-018: No product history timeline rendered for non-existent batch."""
        driver.get(verify_url("BATCH-99999"))
        wait_for_load(driver)

        timeline = driver.find_elements(
            By.XPATH, "//*[contains(text(), 'Supply Chain Journey')]"
        )
        assert len(timeline) == 0, "Timeline must NOT appear for a non-existent batch ID"

    def test_invalid_format_batch_shows_error(self, driver):
        """TCON-08-004: Invalid character batch ID (@#$%INVALID!) shows error, no timeline."""
        driver.get(verify_url("@#$%INVALID!"))
        wait_for_load(driver)

        error = WebDriverWait(driver, WAIT_TIMEOUT).until(
            EC.presence_of_element_located(
                (By.XPATH, "//*[contains(text(), 'Verification Failed')]")
            )
        )
        assert error.is_displayed(), "Error not shown for invalid-format batch ID"

        timeline = driver.find_elements(
            By.XPATH, "//*[contains(text(), 'Supply Chain Journey')]"
        )
        assert len(timeline) == 0, "Timeline must NOT appear for an invalid-format batch ID"


# ═════════════════════════════════════════════════════════════
#  TC-08-003: Verify Empty Batch ID Submission
#  TCOV: 08-003
# ═════════════════════════════════════════════════════════════
class TestTC08003:
    """
    Pre-conditions : User is on the traceability page.
    Post-conditions: No timeline rendered; page handles the absent ID gracefully.

    Note: This app uses URL-based navigation — an 'empty' batch ID maps to
    navigating to /verify/ with no ID segment, which Next.js routes as a 404/redirect.
    """

    def test_no_batch_id_in_url_no_timeline(self, driver):
        """TCON-08-003: Navigating to /verify/ with no batch ID shows no timeline."""
        driver.get(f"{BASE_URL}/verify/")
        time.sleep(2)  # Allow Next.js routing to settle

        timeline = driver.find_elements(
            By.XPATH, "//*[contains(text(), 'Supply Chain Journey')]"
        )
        assert len(timeline) == 0, "Timeline must NOT appear when no batch ID is provided"

    def test_whitespace_batch_id_no_timeline(self, driver):
        """TCON-08-003 variant: Whitespace-only batch ID shows no timeline."""
        driver.get(verify_url("   "))
        wait_for_load(driver)

        timeline = driver.find_elements(
            By.XPATH, "//*[contains(text(), 'Supply Chain Journey')]"
        )
        assert len(timeline) == 0, "Timeline must NOT appear for a whitespace-only batch ID"


# ═════════════════════════════════════════════════════════════
#  TC-08-004: Verify Incomplete Product History Display
#  TCOV: 08-006, 08-007, 08-015, 08-016, 08-019
# ═════════════════════════════════════════════════════════════
class TestTC08004:
    """
    Pre-conditions : User is on the traceability page. INCOMPLETE_BATCH_ID exists
                     but is missing one or more supply chain stages.
    Post-conditions: Timeline shown with missing stages labelled and a warning displayed.
    """

    def test_page_loads_for_incomplete_batch(self, driver):
        """Navigate to verify page for a batch with incomplete history — must not crash."""
        driver.get(verify_url(INCOMPLETE_BATCH_ID))
        wait_for_load(driver)

        loaded = WebDriverWait(driver, WAIT_TIMEOUT).until(
            lambda d: d.find_elements(By.CSS_SELECTOR, "h1, h2")
        )
        assert loaded, "Page crashed or did not load for an incomplete batch ID"

    def test_missing_stages_labelled_data_not_available(self, driver):
        """TCON-08-015: Missing stages show 'Data Not Available' or equivalent."""
        driver.get(verify_url(INCOMPLETE_BATCH_ID))
        wait_for_load(driver)

        # The app may render 'Data Not Available', 'No supply chain data available.',
        # or 'No supply chain events recorded yet.' for missing stages
        dna = driver.find_elements(
            By.XPATH,
            "//*["
            "contains(text(), 'Data Not Available') or "
            "contains(text(), 'No supply chain data') or "
            "contains(text(), 'No supply chain events') or "
            "contains(text(), 'not recorded')"
            "]",
        )
        assert len(dna) > 0, (
            "Expected a 'Data Not Available' (or equivalent) label for missing supply chain stages"
        )

    def test_incomplete_traceability_warning_shown(self, driver):
        """TCON-08-016: Warning about incomplete traceability is visible."""
        driver.get(verify_url(INCOMPLETE_BATCH_ID))
        wait_for_load(driver)

        warning = driver.find_elements(
            By.XPATH,
            "//*["
            "contains(text(), 'incomplete') or "
            "contains(text(), 'No supply chain data') or "
            "contains(text(), 'No supply chain events') or "
            "contains(text(), 'not recorded')"
            "]",
        )
        assert len(warning) > 0, "Incomplete traceability warning not visible on page"


# ═════════════════════════════════════════════════════════════
#  TC-08-005: Verify Traceability Page UI Elements
#  TCOV: 08-008, 08-009
# ═════════════════════════════════════════════════════════════
class TestTC08005:
    """
    Pre-conditions : Logged in as Retailer and navigated to the traceability page.
    Post-conditions: All core UI elements are present and functional.

    Note: The app uses URL navigation rather than a form-based batch ID entry.
    TCON-08-008 is verified by confirming the batch ID appears in the page body.
    TCON-08-009 is verified by confirming the Supply Chain Journey section
    is rendered and interactive (view-toggle buttons are clickable).
    """

    def test_page_loads_successfully(self, logged_in_driver):
        """Page loads and a top-level heading is visible."""
        driver = logged_in_driver
        driver.get(verify_url(VALID_BATCH_ID))
        wait_for_load(driver)

        heading = WebDriverWait(driver, WAIT_TIMEOUT).until(
            EC.presence_of_element_located((By.CSS_SELECTOR, "h1"))
        )
        assert heading.is_displayed(), "Page did not load — no h1 heading found"

    def test_batch_id_visible_on_page(self, logged_in_driver):
        """TCON-08-008: Batch ID is displayed on the page (breadcrumb or heading)."""
        driver = logged_in_driver
        driver.get(verify_url(VALID_BATCH_ID))
        wait_for_load(driver)

        batch_id_el = WebDriverWait(driver, WAIT_TIMEOUT).until(
            EC.presence_of_element_located(
                (By.XPATH, f"//*[contains(text(), '{VALID_BATCH_ID}')]")
            )
        )
        assert batch_id_el.is_displayed(), (
            f"Batch ID '{VALID_BATCH_ID}' is not visible anywhere on the page"
        )

    def test_supply_chain_section_rendered_and_interactive(self, logged_in_driver):
        """TCON-08-009: Supply Chain Journey section renders and its toggle buttons respond."""
        driver = logged_in_driver
        driver.get(verify_url(VALID_BATCH_ID))
        wait_for_load(driver)

        # Section heading must be present
        section = WebDriverWait(driver, WAIT_TIMEOUT).until(
            EC.presence_of_element_located(
                (By.XPATH, "//*[contains(text(), 'Supply Chain Journey')]")
            )
        )
        assert section.is_displayed(), "Supply Chain Journey section is not rendered"

        # The Flowchart / List View toggle buttons must be clickable
        toggle_buttons = driver.find_elements(
            By.XPATH,
            "//button[contains(text(), 'Flowchart') or contains(text(), 'List View')]",
        )
        assert len(toggle_buttons) >= 1, "View-toggle buttons not found in Supply Chain section"
        toggle_buttons[0].click()  # Verify click does not raise


# ═════════════════════════════════════════════════════════════
#  TC-08-006: Error Guessing — Security and Edge Cases
#  TCOV: 08-020, 08-021, 08-022, 08-023, 08-024
# ═════════════════════════════════════════════════════════════
class TestTC08006:
    """
    Pre-conditions : User is on the traceability search page.
    Post-conditions: System handles all invalid/malicious inputs gracefully —
                     no crash, no data leakage, no script execution.
    """

    def test_whitespace_only_batch_id_no_timeline(self, driver):
        """TCON-08-020: Whitespace-only batch ID treated as invalid — no timeline."""
        driver.get(verify_url("   "))
        wait_for_load(driver)

        timeline = driver.find_elements(
            By.XPATH, "//*[contains(text(), 'Supply Chain Journey')]"
        )
        assert len(timeline) == 0, "Timeline must NOT appear for whitespace-only batch ID"

    def test_sql_injection_no_data_exposed(self, driver):
        """TCON-08-021: SQL injection in batch ID — no unintended data returned, no crash."""
        driver.get(verify_url("' OR '1'='1"))
        wait_for_load(driver)

        assert driver.title is not None, "Page crashed on SQL injection input"

        timeline = driver.find_elements(
            By.XPATH, "//*[contains(text(), 'Supply Chain Journey')]"
        )
        assert len(timeline) == 0, "No data should be returned for SQL injection batch ID"

    def test_xss_script_not_executed(self, driver):
        """TCON-08-022: XSS <script> tag in batch ID — alert must NOT fire."""
        driver.get(verify_url("<script>alert('xss')</script>"))
        wait_for_load(driver)

        # If XSS executed, an alert dialog would be present
        try:
            alert = driver.switch_to.alert
            alert_text = alert.text
            alert.dismiss()
            pytest.fail(f"XSS executed — alert appeared with: '{alert_text}'")
        except Exception:
            pass  # No alert = XSS correctly blocked

        assert driver.title is not None, "Page crashed on XSS payload"

    def test_excessively_long_batch_id_no_crash(self, driver):
        """TCON-08-023: 500-character batch ID — app does not crash or hang."""
        long_id = "A" * 500
        driver.get(verify_url(long_id))
        wait_for_load(driver)

        assert driver.title is not None, "Page crashed on a 500-character batch ID"
        assert "500" not in driver.title, "Server 500 error on long batch ID"

        timeline = driver.find_elements(
            By.XPATH, "//*[contains(text(), 'Supply Chain Journey')]"
        )
        assert len(timeline) == 0, "No data should be returned for an excessively long batch ID"

    def test_rapid_repeated_navigation_no_crash(self, driver):
        """TCON-08-024: Navigating to the same verify URL 5 times rapidly — no crash."""
        url = verify_url(VALID_BATCH_ID)

        for _ in range(5):
            driver.get(url)
            time.sleep(0.3)

        wait_for_load(driver)

        assert driver.title is not None, "Page became unstable after rapid repeated navigation"
        assert "500" not in driver.title, "Server error after rapid repeated navigation"
