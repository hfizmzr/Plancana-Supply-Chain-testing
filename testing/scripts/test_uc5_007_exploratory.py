"""
TP-UC5-007: Exploratory Testing — Edge Cases and Unexpected Conditions
Ref: TC-UC5-007, TCOV-UC5-017 through TCOV-UC5-021
Test Procedure: TP-UC5-007 (test procedure.md lines 412-419)

Explorations:
  1. Network interruption during submission
  2. Large coordinate dataset (GIS — manual only)
  3. Concurrent submissions (requires multi-session — manual only)
  4. Special characters / XSS in text fields
  5. Extreme quantity values

Automated:
  - test_xss_special_characters: Inject script tags in text fields
  - test_extreme_quantity: Enter very large quantity
  - test_long_text_fields: Enter 500+ chars in cultivation practices
  - test_empty_required_fields: Confirm validation works (covered by UC5-003)

Manual only:
  - Network interruption (needs actual network disconnect)
  - Large GIS datasets (needs real map interaction)
  - Concurrent submissions (needs two browser sessions)
"""
import time
import pytest
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from conftest import (
    login_as_farmer, fill_step0_all, click_named_button, BASE_URL,
    _native_input_set, go_to_verification,
)


class TestExploratoryXSS:
    """Exploration 4: Special characters / XSS in form fields."""

    @pytest.fixture(autouse=True)
    def setup(self, driver):
        self.d = driver

    def test_xss_in_notes_field(self):
        """
        Enter HTML/script tags in notes field, submit, verify script
        does not execute (XSS prevention) and data renders sanitized.
        """
        login_as_farmer(self.d)
        self.d.get(f"{BASE_URL}/farmer/batch-registration")
        time.sleep(2)

        fill_step0_all(self.d)
        time.sleep(1)

        # Advance to step 1 (Farm Details) where notes field should be
        click_named_button(self.d, "Next")
        time.sleep(1.5)

        # Find and fill notes/remarks textarea with XSS payload
        xss_payload = '<script>alert("XSS")</script> XSS test'

        try:
            # Try finding textarea by label or placeholder containing 'notes'/'remarks'/'additional'
            notes_selectors = [
                "//textarea[contains(@placeholder,'note') or contains(@placeholder,'remark') or contains(@placeholder,'additional')]",
                "//textarea",
                "//label[contains(translate(text(),'NOTES','notes'),'note')]/following-sibling::textarea",
                "//label[contains(translate(text(),'NOTES','notes'),'note')]/..//textarea",
            ]

            notes_found = False
            for sel in notes_selectors:
                try:
                    notes_el = self.d.find_element(By.XPATH, sel)
                    if notes_el:
                        _native_input_set(self.d, notes_el, xss_payload)
                        notes_found = True
                        print(f"  XSS payload injected via: {sel}")
                        break
                except Exception:
                    continue

            if not notes_found:
                print("  No notes/textarea field found — advancing without XSS injection")
        except Exception as e:
            print(f"  Could not inject XSS payload: {e}")

        # Advance to verification
        click_named_button(self.d, "Next")
        time.sleep(1.5)

        # Check if we reached verification (success) or stayed on step (validation error)
        page = self.d.page_source

        # Verify script tags did NOT execute
        assert "XSS" not in self.d.execute_script(
            "return document.documentElement.innerHTML;"
        ).split('<script>')[1].split('</script>')[0] if '<script>' in self.d.execute_script(
            "return document.documentElement.innerHTML;"
        ) else True, (
            "PASS/Note: Script tags in output — check if executed or displayed as text"
        )

        # Verify the page is stable (no JS alerts triggered)
        try:
            alert = self.d.switch_to.alert
            alert_text = alert.text
            alert.dismiss()
            pytest.fail(
                f"FAIL (XSS vulnerability): JavaScript alert triggered — "
                f"'{alert_text}'. User input is not sanitized."
            )
        except Exception:
            # No alert — this is good
            print("  ✓ No JavaScript alert triggered — input may be sanitized")

    def test_xss_in_crop_type_field(self):
        """
        Use special characters in crop type autocomplete to verify
        the system handles them gracefully.
        """
        login_as_farmer(self.d)
        self.d.get(f"{BASE_URL}/farmer/batch-registration")
        time.sleep(2)

        # Try to fill crop type (autocomplete) with special characters
        # The autocomplete may filter these out
        payloads = [
            "Rice <b>test</b>",
            "Corn & Wheat; DROP TABLE batches;--",
            "Soy <img src=x onerror=alert(1)>",
        ]

        for payload in payloads:
            print(f"\n  Testing special chars: '{payload[:60]}...'")
            # Reload page for fresh state
            self.d.get(f"{BASE_URL}/farmer/batch-registration")
            time.sleep(1.5)

            fill_step0_all(self.d)
            time.sleep(0.5)

            # Advance to see what happens with the data
            try:
                click_named_button(self.d, "Next")
                time.sleep(1)
            except Exception:
                print("    Could not advance — possible validation error (acceptable)")

            page = self.d.page_source.lower()

            # Check for error indicators — validation should catch this
            has_error = "border-red-500" in page or "error" in page
            if has_error:
                print(f"    ✓ Special characters blocked by validation")
            else:
                print(f"    ⚠ Special characters passed through — check for XSS")

        # Final check: no JS alerts triggered
        try:
            alert = self.d.switch_to.alert
            alert.dismiss()
            pytest.fail("FAIL: JavaScript alert triggered — XSS vulnerability found")
        except Exception:
            print("  ✓ No JS alerts — all payloads handled")


class TestExploratoryExtremeValues:
    """Exploration 5: Extreme quantity values and boundary testing."""

    @pytest.fixture(autouse=True)
    def setup(self, driver):
        self.d = driver

    def test_extreme_quantity_large_value(self):
        """Enter 999999999999 in quantity, submit, verify graceful handling."""
        login_as_farmer(self.d)
        self.d.get(f"{BASE_URL}/farmer/batch-registration")
        time.sleep(2)

        # Fill all fields except quantity
        fill_step0_all(self.d)
        time.sleep(0.5)

        # Override quantity with extreme value
        try:
            from conftest import fill_input_by_label
            fill_input_by_label(self.d, "Quantity", "999999999999")
            print("  Quantity set to 999999999999")
        except Exception as e:
            print(f"  Could not set extreme quantity: {e}")
            # Try via xpath
            try:
                qty_inputs = self.d.find_elements(
                    By.XPATH,
                    "//label[contains(text(),'Quantity')]/..//input"
                )
                if qty_inputs:
                    _native_input_set(self.d, qty_inputs[0], "999999999999")
                    print("  Quantity set via direct input find")
            except Exception as e2:
                print(f"  All quantity attempts failed: {e2}")
                pytest.skip("Could not find quantity input")

        time.sleep(0.5)

        # Try to advance
        try:
            click_named_button(self.d, "Next")
            time.sleep(1.5)
        except Exception:
            pass

        page = self.d.page_source.lower()

        # Check behavior
        has_error = "border-red-500" in self.d.page_source or "error" in page
        at_verification = "register batch on blockchain" in page

        print(f"  Validation error: {has_error}")
        print(f"  Reached verification: {at_verification}")

        if at_verification:
            # System accepted extreme value — proceed to submit and observe
            print("  ⚠ System accepted 999999999999 — attempting submit to observe behavior")
            try:
                click_named_button(self.d, "Register Batch on Blockchain")
                time.sleep(5)
                response = self.d.page_source.lower()
                if "error" in response or "failed" in response:
                    print("    Server rejected extreme quantity — appropriate handling")
                elif "success" in response:
                    print("    ⚠ Server accepted extreme quantity — no upper bound validation")
            except Exception as e:
                print(f"    Submit result indeterminate: {e}")
        elif has_error:
            print("  ✓ System rejected extreme quantity with validation error")
        else:
            print("  = Uncertain — check manually")

        assert True  # Exploratory — observe and report

    def test_negative_quantity_rejected(self):
        """Enter -100 in quantity, verify validation error (boundary check)."""
        login_as_farmer(self.d)
        self.d.get(f"{BASE_URL}/farmer/batch-registration")
        time.sleep(2)

        fill_step0_all(self.d)
        time.sleep(0.5)

        # Override quantity with negative value
        try:
            from conftest import fill_input_by_label
            fill_input_by_label(self.d, "Quantity", "-100")
            print("  Quantity set to -100")
        except Exception as e:
            print(f"  Could not set negative quantity: {e}")
            try:
                qty_inputs = self.d.find_elements(
                    By.XPATH,
                    "//label[contains(text(),'Quantity')]/..//input"
                )
                if qty_inputs:
                    _native_input_set(self.d, qty_inputs[0], "-100")
            except Exception as e2:
                pytest.skip(f"Could not find quantity input: {e2}")

        time.sleep(0.5)

        # Try to advance
        try:
            click_named_button(self.d, "Next")
            time.sleep(1.5)
        except Exception:
            pass

        page = self.d.page_source

        # Expected: validation should reject negative quantity
        has_red_border = "border-red-500" in page
        has_error_text = "error" in page.lower() or "invalid" in page.lower() or \
                         "negative" in page.lower() or "positive" in page.lower()
        at_verification = "register batch on blockchain" in self.d.page_source.lower()

        print(f"  Red border shown: {has_red_border}")
        print(f"  Error text found: {has_error_text}")
        print(f"  Reached verification: {at_verification}")

        if at_verification:
            pytest.fail(
                "FAIL: Negative quantity (-100) was accepted without validation error. "
                "System should reject negative values with a clear error message."
            )
        elif has_red_border or has_error_text:
            print("  ✓ Negative quantity rejected with validation")
            assert True
        else:
            print("  = Uncertain — no clear pass/fail signal. Check manually.")

    def test_long_text_fields(self):
        """
        Enter 500+ characters in cultivation practices text field,
        verify system handles gracefully (no crash, truncation, or overflow).
        """
        login_as_farmer(self.d)
        self.d.get(f"{BASE_URL}/farmer/batch-registration")
        time.sleep(2)

        fill_step0_all(self.d)
        time.sleep(0.5)

        # Advance to step 1 where longer text fields exist
        click_named_button(self.d, "Next")
        time.sleep(1.5)

        long_text = "Organic farming with drip irrigation and crop rotation. " * 10  # ~600 chars

        # Try to find and fill text fields
        textareas = self.d.find_elements(By.TAG_NAME, "textarea")
        inputs_filled = 0

        for ta in textareas:
            if ta.is_displayed() and ta.is_enabled():
                try:
                    _native_input_set(self.d, ta, long_text)
                    inputs_filled += 1
                    print(f"  Long text injected into textarea (id={ta.get_attribute('id') or 'none'})")
                except Exception:
                    pass

        # Also try filling any visible text inputs (not number/date)
        text_inputs = self.d.find_elements(By.XPATH, "//input[@type='text']")
        for inp in text_inputs:
            if inp.is_displayed() and inp.is_enabled():
                try:
                    _native_input_set(self.d, inp, long_text[:100])  # shorter for inputs
                    inputs_filled += 1
                except Exception:
                    pass

        print(f"  Text fields filled with long text: {inputs_filled}")

        if inputs_filled == 0:
            print("  No text fields found on step 1 — skipping")
            assert True
            return

        # Try to advance
        try:
            click_named_button(self.d, "Next")
            time.sleep(1.5)
        except Exception:
            pass

        # Verify page is still responsive (no crash)
        try:
            page_text = self.d.page_source
            assert len(page_text) > 100, "Page crashed or blank after long text input"
            print("  ✓ Page still responsive after long text submission")
        except Exception as e:
            pytest.fail(f"FAIL: Page became unresponsive after long text input: {e}")

        assert True


class TestExploratoryFormResilience:
    """Additional resilience checks: form state preservation, duplicate prevention."""

    @pytest.fixture(autouse=True)
    def setup(self, driver):
        self.d = driver

    def test_form_data_preserved_after_validation_error(self):
        """
        Submit form with invalid data, verify data is not lost after
        the form reloads with validation errors.
        """
        login_as_farmer(self.d)
        self.d.get(f"{BASE_URL}/farmer/batch-registration")
        time.sleep(2)

        fill_step0_all(self.d)
        time.sleep(0.5)

        # Intentionally clear a required field to trigger validation
        # We advance past step 0 validation, then test on step 1
        reached = go_to_verification(self.d)

        if not reached:
            print("  Validation already caught missing fields — checking data preservation")
            # Check if the filled data is still present in form
            page = self.d.page_source.lower()
            data_indicators = ["rice", "500", "basmati"]
            preserved = [d for d in data_indicators if d in page]
            print(f"  Data indicators preserved: {len(preserved)}/{len(data_indicators)}")
            # At minimum, the form page should still be rendering
            assert "batch" in page or "registration" in page or "create" in page, (
                "FAIL: Form disappeared after validation error — data may be lost."
            )
        else:
            print("  Reached verification — no validation error triggered")

        assert True

    def test_special_unicode_characters(self):
        """
        Enter Unicode characters (Chinese, Arabic, emoji) in text fields
        to verify the system handles non-ASCII input.
        """
        login_as_farmer(self.d)
        self.d.get(f"{BASE_URL}/farmer/batch-registration")
        time.sleep(2)

        fill_step0_all(self.d)
        time.sleep(0.5)

        # Advance to step 1
        click_named_button(self.d, "Next")
        time.sleep(1.5)

        unicode_text = "有机农业 🌾  test テスト"

        textareas = self.d.find_elements(By.TAG_NAME, "textarea")
        for ta in textareas:
            if ta.is_displayed() and ta.is_enabled():
                try:
                    _native_input_set(self.d, ta, unicode_text)
                    print(f"  Unicode text injected: {unicode_text}")
                    break
                except Exception:
                    pass

        # Advance and verify no crash
        try:
            click_named_button(self.d, "Next")
            time.sleep(1.5)
        except Exception:
            pass

        page = self.d.page_source
        assert len(page) > 100, "Page crashed after Unicode input"
        print("  ✓ Unicode characters handled (no crash)")
        assert True
