"""
UC6 Process Crop Selenium PyTest script for Plancana.

Run from Windows while the application is running through Docker/WSL:
    pytest testing/scripts/test_uc6_process_crop.py -v

Optional environment variables:
    PLANCANA_FRONTEND_URL=http://localhost:3001
    PLANCANA_API_URL=http://localhost:3000/api
    PLANCANA_PROCESSOR_EMAIL=mill@processor.com
    PLANCANA_PROCESSOR_PASSWORD=processor123
    UC6_REGISTERED_BATCH_ID=<known registered batch id>
    UC6_PROCESSING_BATCH_ID=<known processing batch id>

The main flow needs a batch in REGISTERED status. If none exists, the
test skips instead of giving a false pass.
"""

import os
import time
from pathlib import Path

import pytest
import requests
from selenium import webdriver
from selenium.common.exceptions import TimeoutException
from selenium.webdriver.common.action_chains import ActionChains
from selenium.webdriver.common.by import By
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.support.ui import Select, WebDriverWait


FRONTEND_URL = os.getenv("PLANCANA_FRONTEND_URL", "http://localhost:3001").rstrip("/")
API_URL = os.getenv("PLANCANA_API_URL", "http://localhost:3000/api").rstrip("/")
PROCESSOR_EMAIL = os.getenv("PLANCANA_PROCESSOR_EMAIL", "mill@processor.com")
PROCESSOR_PASSWORD = os.getenv("PLANCANA_PROCESSOR_PASSWORD", "processor123")
ARTIFACT_DIR = Path(__file__).resolve().parents[1] / "artifacts"


@pytest.fixture
def driver():
    options = webdriver.ChromeOptions()
    options.add_argument("--start-maximized")
    options.add_argument("--disable-notifications")
    driver_instance = webdriver.Chrome(options=options)
    driver_instance.implicitly_wait(2)
    yield driver_instance
    driver_instance.quit()


def wait(driver, seconds=20):
    return WebDriverWait(driver, seconds)


def api_login_as_processor():
    response = requests.post(
        f"{API_URL}/auth/login",
        json={"email": PROCESSOR_EMAIL, "password": PROCESSOR_PASSWORD},
        timeout=15,
    )
    response.raise_for_status()
    data = response.json()
    assert data.get("success") is True, data
    return data["token"]


def get_available_batches():
    token = api_login_as_processor()
    response = requests.get(
        f"{API_URL}/processor/available-batches",
        headers={"Authorization": f"Bearer {token}"},
        timeout=15,
    )
    response.raise_for_status()
    data = response.json()
    assert data.get("success") is True, data
    return data.get("batches", [])


def get_batch_id_by_status(status, env_var_name=None):
    override_batch_id = os.getenv(env_var_name) if env_var_name else None
    if override_batch_id:
        return override_batch_id

    for batch in get_available_batches():
        if batch.get("status") == status:
            return batch.get("batchId")

    pytest.skip(f"No {status} batch is available for UC6 testing.")


def get_registered_batch_id():
    return get_batch_id_by_status("REGISTERED", "UC6_REGISTERED_BATCH_ID")


def get_processing_batch_id():
    return get_batch_id_by_status("PROCESSING", "UC6_PROCESSING_BATCH_ID")


def login_processor(driver):
    driver.get(f"{FRONTEND_URL}/login")
    wait(driver).until(EC.visibility_of_element_located((By.NAME, "email"))).send_keys(
        PROCESSOR_EMAIL
    )
    driver.find_element(By.NAME, "password").send_keys(PROCESSOR_PASSWORD)
    driver.find_element(By.XPATH, "//button[contains(., 'Sign In')]").click()

    wait(driver, 30).until(lambda d: "/processor" in d.current_url)
    assert "/processor" in driver.current_url


def type_by_name(driver, field_name, value):
    element = wait(driver).until(EC.visibility_of_element_located((By.NAME, field_name)))
    set_react_input_value(driver, element, value)


def coordinate_input(driver, label_text):
    return driver.find_element(
        By.XPATH,
        f"//label[normalize-space()='{label_text}']/parent::div/input[@type='number']",
    )


def coordinate_value(driver, label_text):
    return coordinate_input(driver, label_text).get_attribute("value")


def wait_for_location_widget(driver):
    wait(driver, 30).until(
        EC.visibility_of_element_located((By.CSS_SELECTOR, ".esri-view canvas"))
    )
    wait(driver, 30).until(
        EC.element_to_be_clickable(
            (
                By.XPATH,
                "//label[normalize-space()='Longitude']/parent::div/input[@type='number']",
            )
        )
    )
    # ArcGIS can still re-render briefly after the canvas appears.
    time.sleep(2)


def fill_coordinates(driver):
    wait_for_location_widget(driver)
    canvas = wait(driver, 30).until(
        EC.visibility_of_element_located((By.CSS_SELECTOR, ".esri-view canvas"))
    )
    driver.execute_script("arguments[0].scrollIntoView({block: 'center'});", canvas)
    time.sleep(1)

    # The coordinate inputs are controlled by LocationInput state, so the
    # reliable user-level action is selecting a point on the ArcGIS map.
    ActionChains(driver).move_to_element(canvas).click().perform()

    try:
        wait(driver, 30).until(
            lambda d: coordinate_value(d, "Longitude") and coordinate_value(d, "Latitude")
        )
    except TimeoutException:
        screenshot_path, html_path = save_debug_artifacts(
            driver, "uc6_coordinate_selection_failure"
        )
        pytest.fail(
            "Map click did not populate longitude and latitude. "
            f"Saved screenshot: {screenshot_path}; HTML: {html_path}"
        )


def assert_coordinate_value(driver, label_text):
    actual = coordinate_value(driver, label_text)
    assert actual, f"{label_text} value was empty"


def set_react_input_value(driver, element, value):
    """Set controlled React input/textarea values reliably."""
    driver.execute_script(
        """
        const element = arguments[0];
        const value = arguments[1];
        const prototype = element.tagName === 'TEXTAREA'
          ? window.HTMLTextAreaElement.prototype
          : window.HTMLInputElement.prototype;
        const valueSetter = Object.getOwnPropertyDescriptor(prototype, 'value').set;
        valueSetter.call(element, value);
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        """,
        element,
        str(value),
    )


def click_start_processing(driver):
    button = wait(driver).until(
        EC.element_to_be_clickable(
            (By.XPATH, "//button[.//span[contains(., 'Start Processing')]]")
        )
    )
    driver.execute_script("arguments[0].scrollIntoView({block: 'center'});", button)
    button.click()


def open_process_crop_page(driver, batch_id):
    driver.get(f"{FRONTEND_URL}/processor/process/{batch_id}")
    wait(driver, 30).until(
        EC.visibility_of_element_located(
            (By.XPATH, "//h1[contains(., 'Start Processing')]")
        )
    )
    assert f"/processor/process/{batch_id}" in driver.current_url


def open_quality_test_page(driver, batch_id):
    driver.get(f"{FRONTEND_URL}/processor/quality-test/{batch_id}")
    wait(driver, 30).until(
        EC.visibility_of_element_located(
            (By.XPATH, "//h1[contains(., 'Add Quality Test')]")
        )
    )
    assert f"/processor/quality-test/{batch_id}" in driver.current_url


def save_debug_artifacts(driver, name):
    ARTIFACT_DIR.mkdir(parents=True, exist_ok=True)
    screenshot_path = ARTIFACT_DIR / f"{name}.png"
    html_path = ARTIFACT_DIR / f"{name}.html"
    driver.save_screenshot(str(screenshot_path))
    html_path.write_text(driver.page_source, encoding="utf-8")
    return screenshot_path, html_path


def fill_valid_process_crop_form(driver):
    Select(driver.find_element(By.NAME, "processType")).select_by_value("milling")
    type_by_name(driver, "inputQuantity", "100")
    type_by_name(driver, "outputQuantity", "85")
    type_by_name(driver, "wasteQuantity", "15")
    type_by_name(driver, "processingTime", "120")
    type_by_name(driver, "energyUsage", "25")
    type_by_name(driver, "waterUsage", "40")
    type_by_name(driver, "notes", "UC6 Selenium PyTest processing flow.")
    fill_coordinates(driver)


def valid_processing_payload():
    return {
        "processType": "milling",
        "processingLocation": "Kuala Lumpur Processing Centre",
        "latitude": 3.1390,
        "longitude": 101.6869,
        "inputQuantity": 100,
        "outputQuantity": 85,
        "wasteQuantity": 15,
        "processingTime": 120,
        "energyUsage": 25,
        "waterUsage": 40,
        "notes": "UC6 invalid status API guard check.",
    }


def click_save_quality_test(driver):
    button = wait(driver).until(
        EC.element_to_be_clickable(
            (By.XPATH, "//button[.//span[contains(., 'Save Quality Test')]]")
        )
    )
    driver.execute_script("arguments[0].scrollIntoView({block: 'center'});", button)
    button.click()


def fill_valid_quality_test_form(driver):
    Select(driver.find_element(By.NAME, "testType")).select_by_visible_text(
        "Moisture Content Test"
    )
    Select(driver.find_element(By.NAME, "testingLab")).select_by_visible_text(
        "SGS Malaysia Sdn Bhd"
    )
    type_by_name(driver, "certificateUrl", "https://example.com/uc6-quality-cert.pdf")

    parameter_inputs = driver.find_elements(By.XPATH, "//input[@placeholder='Parameter name']")
    value_inputs = driver.find_elements(By.XPATH, "//input[@placeholder='Value']")
    assert parameter_inputs, "No quality test parameter inputs were found"
    assert value_inputs, "No quality test value inputs were found"
    set_react_input_value(driver, parameter_inputs[0], "moistureContent")
    set_react_input_value(driver, value_inputs[0], "12")


def test_uc6_processing_qr_redirects_processor_to_process_form(driver):
    """Covers TC-06-002 and supports the UC6 QR redirect flow."""
    batch_id = get_registered_batch_id()
    login_processor(driver)

    driver.get(f"{FRONTEND_URL}/process-batch/{batch_id}")
    wait(driver, 30).until(lambda d: f"/processor/process/{batch_id}" in d.current_url)
    wait(driver, 30).until(
        EC.visibility_of_element_located(
            (By.XPATH, "//h1[contains(., 'Start Processing')]")
        )
    )

    assert f"/processor/process/{batch_id}" in driver.current_url
    assert driver.find_element(By.XPATH, "//h1[contains(., 'Start Processing')]").is_displayed()


def test_uc6_non_existent_batch_cannot_be_processed(driver):
    """Covers TC-06-004."""
    login_processor(driver)

    driver.get(f"{FRONTEND_URL}/processor/process/BATCH-NOTFOUND-001")
    wait(driver, 30).until(
        lambda d: "Error" in d.page_source
        and "Failed to fetch batch details" in d.page_source
    )

    assert "Error" in driver.page_source
    assert "Failed to fetch batch details" in driver.page_source
    assert "Start Processing" not in driver.page_source


def test_uc6_validation_rejects_missing_location_and_invalid_quantities(driver):
    """Covers TC-06-006, TC-06-007, and part of TC-06-009."""
    batch_id = get_registered_batch_id()
    login_processor(driver)
    open_process_crop_page(driver, batch_id)

    type_by_name(driver, "inputQuantity", "100")
    type_by_name(driver, "outputQuantity", "85")
    click_start_processing(driver)
    wait(driver).until(
        lambda d: "GPS coordinates are required for traceability" in d.page_source
        or "Processing location coordinates are required" in d.page_source
    )

    fill_coordinates(driver)
    type_by_name(driver, "inputQuantity", "0")
    type_by_name(driver, "outputQuantity", "85")
    click_start_processing(driver)
    wait(driver).until(
        lambda d: "Input quantity is required and must be greater than 0" in d.page_source
    )

    type_by_name(driver, "inputQuantity", "100")
    type_by_name(driver, "outputQuantity", "0")
    click_start_processing(driver)
    wait(driver).until(
        lambda d: "Output quantity is required and must be greater than 0" in d.page_source
    )


def test_uc6_processor_can_add_quality_test_result(driver):
    """Covers TC-06-003 and supports TC-06-010."""
    batch_id = get_registered_batch_id()
    login_processor(driver)
    open_quality_test_page(driver, batch_id)
    fill_valid_quality_test_form(driver)
    click_save_quality_test(driver)

    wait(driver, 30).until(
        EC.visibility_of_element_located(
            (By.XPATH, "//*[contains(., 'Quality Test Added!')]")
        )
    )

    assert "Quality Test Added!" in driver.page_source
    assert "Moisture Content Test" in driver.page_source
    assert "SGS Malaysia Sdn Bhd" in driver.page_source
    assert "PASS" in driver.page_source


def test_uc6_processor_can_start_processing_for_registered_batch(driver):
    """Covers TC-06-001 and part of TC-06-012."""
    batch_id = get_registered_batch_id()
    login_processor(driver)
    open_process_crop_page(driver, batch_id)
    fill_valid_process_crop_form(driver)
    click_start_processing(driver)

    try:
        wait(driver, 45).until(
            EC.visibility_of_element_located(
                (By.XPATH, "//*[contains(., 'Processing Started!')]")
            )
        )
    except TimeoutException:
        screenshot_path, html_path = save_debug_artifacts(driver, "uc6_process_success_failure")
        pytest.fail(
            "Processing success message did not appear. "
            f"Saved screenshot: {screenshot_path}; HTML: {html_path}"
        )

    assert "Processing Started!" in driver.page_source
    assert "Input:" in driver.page_source
    assert "Output:" in driver.page_source

    # Give the backend a moment to persist status before checking the API.
    time.sleep(1)
    token = api_login_as_processor()
    response = requests.get(
        f"{API_URL}/processor/available-batches",
        headers={"Authorization": f"Bearer {token}"},
        timeout=15,
    )
    response.raise_for_status()
    processed_batch = next(
        (
            batch
            for batch in response.json().get("batches", [])
            if batch.get("batchId") == batch_id
        ),
        None,
    )
    assert processed_batch is not None
    assert processed_batch.get("status") == "PROCESSING"


def test_uc6_invalid_batch_status_cannot_be_processed(driver):
    """Covers TC-06-005 and part of TC-06-012."""
    batch_id = get_processing_batch_id()
    login_processor(driver)

    driver.get(f"{FRONTEND_URL}/process-batch/{batch_id}")
    wait(driver, 30).until(
        lambda d: "Cannot Process Batch" in d.page_source
        or f"/processor/process/{batch_id}" in d.current_url
    )

    assert f"/processor/process/{batch_id}" not in driver.current_url
    page_text = driver.find_element(By.TAG_NAME, "body").text
    assert "Cannot Process Batch" in page_text
    assert "Error Details:" in page_text

    token = api_login_as_processor()
    validation_response = requests.get(
        f"{API_URL}/batch/validate-access/{batch_id}",
        headers={"Authorization": f"Bearer {token}"},
        timeout=15,
    )
    assert validation_response.status_code == 403
    validation_data = validation_response.json()
    assert validation_data.get("success") is False
    assert validation_data.get("canProcess") is False
    assert validation_data.get("currentStatus") == "PROCESSING"
    assert "REGISTERED" in validation_data.get("validStatuses", [])

    response = requests.post(
        f"{API_URL}/processor/process/{batch_id}",
        headers={"Authorization": f"Bearer {token}"},
        json=valid_processing_payload(),
        timeout=15,
    )

    assert response.status_code == 400
    data = response.json()
    assert data.get("success") is False
    assert "Cannot process batch with status" in data.get("error", "")
