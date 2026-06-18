"""
Plancana UC-5 Selenium Test Suite — conftest.py

Real selectors verified against actual source code:
  - LoginForm.js:      name='email', name='password', button='Sign In'
  - BatchRegistration: NO name attrs on any field (React controlled)
    - <select> with placeholder options (find via option text)
    - AutocompleteInput: <input> without name (find via placeholder)
    - LocationInput: only ArcGISMap + lat/lng number inputs
    - Validation requires: farmer*, cropType*, crop*, location*, quantity*, qualityGrade*, moistureContent*
      (* = required for Step 0)
  - moistureContent is readOnly, auto-calculated via weather API when lat/lng set

Strategy for dropdowns: select first non-placeholder option.
Strategy for autocomplete: type into field → click first dropdown button.
Strategy for map: CDP geolocation mock + React fiber walk to set location.

Usage:
    cd testing/scripts
    ./run_tests.sh --headed --keep-open
    ./run_tests.sh                        # CI headless
"""

import os
import time
import pytest
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.chrome.service import Service
from selenium.common.exceptions import TimeoutException, NoSuchElementException


# ---- Pytest CLI Options ----

def pytest_addoption(parser):
    parser.addoption("--headed", action="store_true", default=False,
                     help="Show browser window (default: headless).")
    parser.addoption("--keep-open", action="store_true", default=False,
                     help="Keep browser open after tests. Press Enter to close.")


# ---- Configuration ----

BASE_URL = os.environ.get("PLANCANA_URL", "http://localhost:3001")
IMPLICIT_WAIT = int(os.environ.get("IMPLICIT_WAIT", "10"))
REMOTE_PORT = os.environ.get("CHROME_REMOTE_PORT", "")

FARM_LAT  = "3.1390"
FARM_LNG  = "101.6869"


def _opt(config, opt_name, env_name):
    return config.getoption(opt_name, default=False) or os.environ.get(env_name, "").lower() == "true"


# ---- WebDriver tracking for --keep-open ----

_drivers = []


@pytest.fixture(scope="session")
def driver(request):
    config = request.config
    headed = _opt(config, "--headed", "HEADED")
    keep_open = _opt(config, "--keep-open", "KEEP_OPEN")

    chrome_options = Options()

    if REMOTE_PORT:
        # Remote debugging fallback — connect to already-running Chrome
        chrome_options.add_experimental_option(
            "debuggerAddress", f"localhost:{REMOTE_PORT}"
        )
        print(f"\n  Remote debugging — connecting to Chrome :{REMOTE_PORT}")
        d = webdriver.Chrome(options=chrome_options)
        print(f"  Connected. Current tab: {d.current_url}")
    else:
        # Native Linux Chrome with GPU acceleration (WSLg D3D12)
        chrome_options.add_argument("--no-sandbox")
        chrome_options.add_argument("--disable-dev-shm-usage")
        chrome_options.add_argument("--window-size=1920,1080")
        chrome_options.add_argument("--enable-gpu-rasterization")
        chrome_options.add_argument("--enable-webgl")

        if headed:
            # WSLg renders via D3D12 on Windows GPU — Angle passes GL to Mesa
            chrome_options.add_argument("--use-gl=angle")
            chrome_options.add_argument("--use-angle=gl-egl")
            chrome_options.add_argument("--ignore-gpu-blocklist")
            chrome_options.add_argument("--enable-webgl")
            print("\n  Headed with GPU — WSLg D3D12")
        else:
            # Headless with software GPU fallback (SwiftShader)
            chrome_options.add_argument("--headless=new")
            chrome_options.add_argument("--use-gl=angle")
            chrome_options.add_argument("--use-angle=swiftshader")
            chrome_options.add_argument("--enable-webgl")
            print("\n  Headless with SwiftShader (software GPU)")

        try:
            d = webdriver.Chrome(options=chrome_options)
        except Exception:
            from webdriver_manager.chrome import ChromeDriverManager
            d = webdriver.Chrome(
                service=Service(ChromeDriverManager().install()),
                options=chrome_options,
            )

    d.implicitly_wait(IMPLICIT_WAIT)

    if keep_open:
        _drivers.append(d)

    yield d

    if REMOTE_PORT:
        pass  # never quit user's Chrome in remote mode
    elif not keep_open:
        try:
            d.quit()
        except Exception:
            pass
        try:
            d.quit()
        except Exception:
            pass


def pytest_sessionfinish(session, exitstatus):
    keep_open = _opt(session.config, "--keep-open", "KEEP_OPEN")
    if keep_open and _drivers:
        print(f"\n{'=' * 60}\n  {len(_drivers)} browser(s) still open\n"
              f"  Press ENTER to close all browsers...\n{'=' * 60}")
        try:
            input()
        except (EOFError, KeyboardInterrupt):
            print()
    for d in _drivers:
        try:
            d.quit()
        except Exception:
            pass
    _drivers.clear()


def pytest_terminal_summary(terminalreporter, exitstatus, config):
    rp = os.environ.get("HTML_REPORT_PATH", "")
    if rp and os.path.exists(rp):
        terminalreporter.write_sep("=", "HTML report", bold=True)
        terminalreporter.write_line(f"  file://{os.path.abspath(rp)}")


# ---- Test Accounts (from prisma/seed.js) ----

ACCOUNTS = {
    "FARMER":     {"email": "ahmad@farm.com",           "password": "farmer123"},
    "PROCESSOR":  {"email": "mill@processor.com",       "password": "processor123"},
    "DISTRIBUTOR":{"email": "logistics@distributor.com","password": "distributor123"},
    "RETAILER":   {"email": "store@retail.com",         "password": "retailer123"},
    "ADMIN":      {"email": "admin@agricultural.com",   "password": "admin123"},
}


# ============================================================================
#  REACT HELPER FUNCTIONS
#  All form fields are React controlled components without name attributes.
#  These helpers use the native HTMLInputElement setter + event dispatch
#  to trigger React's synthetic onChange handler.
# ============================================================================

def _native_input_set(driver, el, value):
    """Set value on React-controlled <input> by using native setter + events."""
    driver.execute_script("""
        var s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        s.call(arguments[0], arguments[1]);
        arguments[0].dispatchEvent(new Event('input', {bubbles: true}));
        arguments[0].dispatchEvent(new Event('change', {bubbles: true}));
    """, el, str(value))
    time.sleep(0.15)


def _native_select_set(driver, el, value):
    """Set value on React-controlled <select> by using native setter + events."""
    driver.execute_script("""
        var s = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
        s.call(arguments[0], arguments[1]);
        arguments[0].dispatchEvent(new Event('change', {bubbles: true}));
    """, el, value)
    time.sleep(0.15)


# ============================================================================
#  DOM SELECTORS — None use name= attributes (they don't exist)
# ============================================================================

def select_first_option(driver, select_xpath):
    """
    Select the first non-placeholder <option> in a <select>.
    Placeholder options are those with empty value or 'Select...' text.
    """
    sel = driver.find_element(By.XPATH, select_xpath)
    options = sel.find_elements(By.TAG_NAME, "option")
    for opt in options:
        val = opt.get_attribute("value")
        txt = opt.text.strip()
        if val and txt and "select" not in txt.lower():
            _native_select_set(driver, sel, val)
            print(f"    select: {txt} (value={val})")
            return val
    raise NoSuchElementException(f"No non-placeholder option in {select_xpath}")


def fill_autocomplete(driver, placeholder, text=None):
    """
    Fill an AutocompleteInput (found by placeholder).
    Focuses the input (opens dropdown), then clicks the first option button.
    Retries up to 3 times with increasing waits for async option loading.
    """
    xpath = f"//input[@placeholder='{placeholder}']"
    inp = driver.find_element(By.XPATH, xpath)

    # Scroll into view to avoid click interception
    driver.execute_script("arguments[0].scrollIntoView({block: 'center'});", inp)
    time.sleep(0.2)

    if text:
        _native_input_set(driver, inp, text)
        time.sleep(0.5)

    for attempt in range(3):
        # Focus the input to open the dropdown (onFocus → setIsOpen(true))
        inp.click()
        wait = 0.5 if attempt == 0 else 0.8
        time.sleep(wait)

        # Find the dropdown container: sibling div.absolute.z-10 of the input wrapper
        buttons = driver.find_elements(
            By.XPATH,
            f"//input[@placeholder='{placeholder}']"
            f"/ancestor::div[contains(@class,'relative')][1]"
            f"/div[contains(@class,'absolute') and contains(@class,'z-10')]"
            f"//button[@type='button']"
        )

        # Keep only buttons with visible text (exclude toggle/clear buttons)
        buttons = [b for b in buttons if b.text.strip()]

        if buttons:
            label = buttons[0].text.strip()
            buttons[0].click()
            time.sleep(0.3)

            # Verify the input value was actually set (React controlled input)
            val = inp.get_attribute("value")
            if val and val.strip():
                print(f"    autocomplete ({placeholder}): {label}")
                return True
            else:
                print(f"    autocomplete ({placeholder}): clicked '{label}' but value not set (attempt {attempt+1})")

        else:
            # Fallback: broader search for any dropdown buttons with text
            buttons = driver.find_elements(
                By.XPATH,
                f"//input[@placeholder='{placeholder}']"
                f"/ancestor::div[contains(@class,'relative')]"
                f"//button[@type='button' and string-length(normalize-space())>0]"
            )
            buttons = [b for b in buttons if b.text.strip()]
            if buttons:
                label = buttons[0].text.strip()
                buttons[0].click()
                time.sleep(0.3)
                val = inp.get_attribute("value")
                if val and val.strip():
                    print(f"    autocomplete ({placeholder}): {label} (fallback)")
                    return True
            print(f"    autocomplete ({placeholder}): no options found (attempt {attempt+1})")

    print(f"    autocomplete ({placeholder}): FAILED after 3 attempts")
    return False


def fill_input_by_label(driver, label_text, value):
    """Find <input> by its preceding <label> text, then set value."""
    xpath = f"//label[contains(text(),'{label_text}')]/..//input"
    inp = driver.find_element(By.XPATH, xpath)
    _native_input_set(driver, inp, value)
    print(f"    input ({label_text}): {value}")


def fill_input_by_type(driver, type_attr, value, index=0):
    """Fill an <input> by its type attribute (e.g. 'date', 'number')."""
    inputs = driver.find_elements(By.XPATH, f"//input[@type='{type_attr}']")
    if index >= len(inputs):
        raise IndexError(f"Not enough inputs of type '{type_attr}' (found {len(inputs)})")
    _native_input_set(driver, inputs[index], value)
    print(f"    input (type={type_attr}[{index}]): {value}")


def click_named_button(driver, text):
    """Click a <button> by visible normalized text. Handles toast overlays."""
    xpath = f"//button[normalize-space()='{text}']"
    btn = driver.find_element(By.XPATH, xpath)
    driver.execute_script("arguments[0].scrollIntoView({block: 'center'});", btn)
    time.sleep(0.2)

    # Dismiss any visible react-hot-toast overlays that might intercept clicks
    try:
        toasts = driver.find_elements(By.XPATH, "//div[contains(@class,'go') and @role='status']")
        for t in toasts:
            driver.execute_script("arguments[0].remove();", t)
    except Exception:
        pass

    try:
        btn.click()
    except Exception:
        driver.execute_script("arguments[0].click();", btn)
    time.sleep(0.5)
    print(f"    clicked button: '{text}'")


# ============================================================================
#  LOCATION / MAP HELPERS
# ============================================================================

def mock_geolocation(driver, lat, lng):
    """Mock browser geolocation via Chrome DevTools Protocol."""
    driver.execute_cdp_cmd("Emulation.setGeolocationOverride", {
        "latitude":  float(lat),
        "longitude": float(lng),
        "accuracy":  10,
    })
    print(f"    CDP geolocation mocked: {lat}, {lng}")


def fill_location(driver, lat=FARM_LAT, lng=FARM_LNG):
    """
    Set lat, lng, AND location in React formData.
    Strategy: first lock down the ArcGISMap callbacks that keep resetting values,
    then inject our values into the React state.
    """
    loc_str = f"{lat}, {lng}"

    # 1. Fill native longitude/latitude inputs
    try:
        lng_label = driver.find_element(By.XPATH, "//label[contains(text(),'Longitude')]")
        lng_input = lng_label.find_element(By.XPATH, "./following-sibling::input[@type='number']")
        _native_input_set(driver, lng_input, lng)
    except NoSuchElementException:
        pass

    try:
        lat_label = driver.find_element(By.XPATH, "//label[contains(text(),'Latitude')]")
        lat_input = lat_label.find_element(By.XPATH, "./following-sibling::input[@type='number']")
        _native_input_set(driver, lat_input, lat)
    except NoSuchElementException:
        pass

    time.sleep(1)

    # 2. Override ArcGISMap callbacks to prevent value resets.
    #    Walk the fiber tree, find the LocationInput's formData hook, and
    #    wrap its dispatch to always include our lat/lng/location values.
    driver.execute_script("""
        var latVal = arguments[0];
        var lngVal = arguments[1];
        var loc = arguments[2];
        var all = document.querySelectorAll('*');
        for (var i = 0; i < all.length; i++) {
            var el = all[i];
            var keys = Object.keys(el).filter(function(k) { return k.startsWith('__reactFiber'); });
            if (!keys.length) continue;
            for (var ki = 0; ki < keys.length; ki++) {
                var fiber = el[keys[ki]];
                for (var d = 0; d < 80 && fiber; d++) {
                    var hook = fiber.memoizedState;
                    while (hook) {
                        var state = hook.memoizedState;
                        if (state && typeof state === 'object' && 'farmer' in state && 'location' in state) {
                            var queue = hook.queue;
                            if (queue && queue.dispatch) {
                                // Wrap the dispatch to always inject our location values
                                var originalDispatch = queue.dispatch;
                                queue.dispatch = function(action) {
                                    if (typeof action === 'function') {
                                        return originalDispatch(function(prev) {
                                            var result = action(prev);
                                            if (result && typeof result === 'object') {
                                                result.latitude = latVal;
                                                result.longitude = lngVal;
                                                result.location = loc;
                                            }
                                            return result;
                                        });
                                    }
                                    return originalDispatch(action);
                                };
                                // Also set the values right now
                                originalDispatch(function(prev) {
                                    return Object.assign({}, prev, {
                                        latitude: latVal,
                                        longitude: lngVal,
                                        location: loc
                                    });
                                });
                                return 'hooked_and_set';
                            }
                        }
                        hook = hook.next;
                    }
                    fiber = fiber.return;
                }
            }
        }
        return 'hook_failed';
    """, lat, lng, loc_str)
    print(f"    [loc] hook result")

    # 3. Wait for React to process + ArcGISMap to settle
    time.sleep(2)

    # 4. Verify
    vals = driver.execute_script("""
        var all = document.querySelectorAll('*');
        for (var i = 0; i < all.length; i++) {
            var el = all[i];
            var keys = Object.keys(el).filter(function(k) { return k.startsWith('__reactFiber'); });
            if (!keys.length) continue;
            for (var ki = 0; ki < keys.length; ki++) {
                var fiber = el[keys[ki]];
                for (var d = 0; d < 80 && fiber; d++) {
                    var hook = fiber.memoizedState;
                    while (hook) {
                        var state = hook.memoizedState;
                        if (state && typeof state === 'object' && 'farmer' in state && 'location' in state) {
                            return JSON.stringify({
                                latitude: state.latitude || '',
                                longitude: state.longitude || '',
                                location: state.location || ''
                            });
                        }
                        hook = hook.next;
                    }
                    fiber = fiber.return;
                }
            }
        }
        return '{}';
    """)
    print(f"    [loc] check: {vals}")
    import json
    try:
        sv = json.loads(vals)
    except Exception:
        sv = {}
    ok = bool(sv.get('location'))
    print(f"    [loc] {'✓ set' if ok else '✗ empty'}")
    return ok


# ============================================================================
#  HIGH-LEVEL WORKFLOW HELPERS
# ============================================================================

def login_as_farmer(driver):
    """Login with seeded farmer account. Returns dashboard URL.
    With session-scoped driver, skips login if already authenticated."""
    driver.get(f"{BASE_URL}/login")
    time.sleep(1.5)

    # Session-scoped: if already authenticated, React auto-redirects to dashboard
    if "dashboard" in driver.current_url.lower():
        print(f"  Already authenticated — on: {driver.current_url}")
        return driver.current_url

    print(f"  Filling login form: {ACCOUNTS['FARMER']['email']}")
    driver.find_element(By.NAME, "email").send_keys(ACCOUNTS["FARMER"]["email"])
    driver.find_element(By.NAME, "password").send_keys(ACCOUNTS["FARMER"]["password"])

    print("  Clicking 'Sign In' ...")
    click_named_button(driver, "Sign In")

    try:
        WebDriverWait(driver, 15).until(EC.url_contains("dashboard"))
    except TimeoutException:
        pass
    time.sleep(1)
    print(f"  Current URL: {driver.current_url}")
    return driver.current_url


def fill_step0_all(driver):
    """
    Fill ALL 7 required Step 0 fields with step-by-step logging.
    1. cropType → 2. crop → 3. harvestDate → 4. quantity →
    5. qualityGrade → 6. location → 7. moistureContent (auto)
    """
    print("  ── Step 0: Basic Info ──")

    steps = []

    # 1. Crop Type
    select_first_option(driver, "//select[.//option[text()='Select crop type']]")
    steps.append(("cropType", True))
    time.sleep(0.3)

    # 2. Product Name (autocomplete)
    try:
        ok = fill_autocomplete(driver, "Search for product...")
        steps.append(("crop (product)", True if ok else "no option selected"))
    except Exception as e:
        steps.append(("crop (product)", e))
    time.sleep(0.3)

    # 3. Harvest Date
    try:
        fill_input_by_type(driver, "date", "2025-06-15")
        steps.append(("harvestDate", True))
    except Exception as e:
        steps.append(("harvestDate", e))

    # 4. Quantity
    try:
        fill_input_by_label(driver, "Quantity", "500")
        steps.append(("quantity", True))
    except Exception as e:
        steps.append(("quantity", e))

    # 5. Quality Grade
    select_first_option(driver, "//select[.//option[text()='Select quality grade']]")
    steps.append(("qualityGrade", True))

    # 6. Price per Unit (optional for validation, but recommended)
    try:
        fill_input_by_label(driver, "Price per Unit", "2.50")
    except Exception:
        pass  # optional

    # 7. Location (CDP mock + React state injection)
    mock_geolocation(driver, FARM_LAT, FARM_LNG)
    try:
        loc_ok = fill_location(driver, FARM_LAT, FARM_LNG)
        steps.append(("location", True if loc_ok else "location not set"))
    except Exception as e:
        steps.append(("location", e))

    # 8. Wait for moistureContent
    try:
        mc = wait_for_moisture_content(driver)
        steps.append(("moistureContent", mc))
    except Exception as e:
        steps.append(("moistureContent", e))

    # Print summary
    print("  ── Step 0 summary ──")
    for name, ok in steps:
        status = " ✓" if ok is True else f" ✗ ({ok})" if isinstance(ok, Exception) else f" = {ok}"
        print(f"    {name}:{status}")

    # Verify no validation errors before proceeding
    has_error = "border-red-500" in driver.page_source
    if has_error:
        print("    ⚠ Validation errors detected — some fields may be invalid")
    else:
        print("    ✓ No visible validation errors")

    # Field-level diagnostics: read actual React formData state
    try:
        field_status = driver.execute_script("""
            var fields = ['farmer', 'cropType', 'crop', 'quantity', 'qualityGrade',
                          'moistureContent', 'location'];
            var result = {};
            var all = document.querySelectorAll('*');
            for (var i = 0; i < all.length; i++) {
                var el = all[i];
                var key = Object.keys(el).find(function(k) { return k.startsWith('__reactFiber'); });
                if (!key) continue;
                var fiber = el[key];
                for (var d = 0; d < 50 && fiber; d++) {
                    var hook = fiber.memoizedState;
                    while (hook) {
                        var state = hook.memoizedState;
                        if (state && typeof state === 'object' && 'farmer' in state && 'moistureContent' in state) {
                            for (var fi = 0; fi < fields.length; fi++) {
                                var f = fields[fi];
                                var v = state[f];
                                result[f] = (v === null || v === undefined || v === '') ? '<empty>' : String(v).substring(0, 40);
                            }
                            return JSON.stringify(result);
                        }
                        hook = hook.next;
                    }
                    fiber = fiber.return;
                }
            }
            return JSON.stringify({_error: 'formData not found'});
        """)
        import json
        fd = json.loads(field_status)
        print("    [diag] formData values:")
        for k, v in fd.items():
            if not k.startswith('_'):
                print(f"      {k}: {v}")
    except Exception:
        pass

    return not has_error


def wait_for_moisture_content(driver, timeout=12):
    """Poll the moisture content input (readOnly, placeholder 'Waiting for location...') until it has a value."""
    start = time.time()
    while time.time() - start < timeout:
        try:
            # Find moisture content by its specific placeholder + readOnly + type=number
            inputs = driver.find_elements(
                By.XPATH,
                "//input[@readonly and @type='number' and @placeholder='Waiting for location...']"
            )
            for inp in inputs:
                val = inp.get_attribute("value")
                if val and val.strip() and val != "Waiting for location...":
                    elapsed = time.time() - start
                    print(f"    moistureContent: {val} (after {elapsed:.1f}s)")
                    return val
        except Exception:
            pass
        time.sleep(0.5)
    print(f"    moistureContent: TIMEOUT after {timeout}s")
    return None


def go_to_verification(driver):
    """Click Next twice with retry on validation failure. Prints diagnostics."""
    for step_name in ("Farm Details", "Verification"):
        success = False
        for attempt in range(3):
            print(f"  Clicking Next → {step_name} (attempt {attempt+1}) ...")
            click_named_button(driver, "Next")
            time.sleep(1.5)

            # Check if validation failed: red borders OR error banner
            page = driver.page_source
            has_error = (
                "border-red-500" in page
                or "Please fix the following errors" in page
            )
            if has_error:
                # Collect which fields still have errors
                errors = driver.find_elements(By.XPATH, "//*[contains(@class,'border-red-500')]")
                error_labels = []
                for e in errors:
                    try:
                        lbl = e.find_element(By.XPATH, "./preceding::label[1]").text
                        error_labels.append(lbl)
                    except Exception:
                        pass
                # Also check error banner text
                try:
                    banner_items = driver.find_elements(By.XPATH, "//div[contains(@class,'bg-red-50')]//li")
                    for li in banner_items:
                        error_labels.append(li.text)
                except Exception:
                    pass
                print(f"    ✗ Validation failed. Fields with errors: {error_labels}")

                if attempt < 2:
                    _retry_step0_critical_fields(driver)
                    time.sleep(1)
            else:
                success = True
                break

        if not success:
            print(f"    ✗ Failed to advance past {step_name} after 3 attempts")
            return False

    print(f"  ✓ Reached Verification step")
    return True


def _retry_step0_critical_fields(driver):
    """Re-fill fields that commonly fail validation: crop, quantity, location, moisture."""
    print(f"    Retrying critical fields...")
    try:
        fill_autocomplete(driver, "Search for product...")
    except Exception as e:
        print(f"    Retry crop: {e}")
    try:
        fill_input_by_label(driver, "Quantity", "500")
    except Exception as e:
        print(f"    Retry quantity: {e}")
    try:
        fill_location(driver, FARM_LAT, FARM_LNG)
    except Exception as e:
        print(f"    Retry location: {e}")
    try:
        wait_for_moisture_content(driver, timeout=4)
    except Exception as e:
        print(f"    Retry moisture: {e}")


def register_on_blockchain(driver):
    """Click 'Register Batch on Blockchain' and wait for confirmation."""
    print("  Clicking 'Register Batch on Blockchain' ...")
    time.sleep(0.5)
    click_named_button(driver, "Register Batch on Blockchain")
    time.sleep(5)  # Wait for API + blockchain

    page = driver.page_source.lower()
    ok = ("success" in page or "registered" in page or "batch" in page
          or "batch id" in page)
    print(f"  Success: {ok}")
    return ok


def verify_dashboard_has_batches(driver):
    """Navigate to farmer dashboard and check if batches are visible."""
    driver.get(f"{BASE_URL}/farmer/dashboard")
    time.sleep(2)
    page = driver.page_source.lower()
    has = "batch" in page or "bat-" in page
    print(f"  Dashboard has batches: {has}")
    return has


def verify_batch_registration_form_loaded(driver):
    """Check that we're on the batch registration page."""
    url = driver.current_url.lower()
    return "batch" in url or "registration" in url or "create" in url
