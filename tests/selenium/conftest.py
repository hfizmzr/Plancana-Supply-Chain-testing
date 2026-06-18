"""
Shared pytest fixtures for Plancana Selenium tests.
"""

import pytest
from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC

BASE_URL = "http://localhost:3001"
RETAILER_EMAIL = "store@retail.com"
RETAILER_PASSWORD = "retailer123"
WAIT_TIMEOUT = 15


@pytest.fixture(scope="function")
def driver():
    """Bare Chrome WebDriver — no login state."""
    options = Options()
    options.add_argument("--start-maximized")
    options.add_argument("--no-sandbox")
    options.add_argument("--disable-dev-shm-usage")
    options.add_argument("--disable-extensions")

    drv = webdriver.Chrome(options=options)
    drv.implicitly_wait(3)
    yield drv
    drv.quit()


@pytest.fixture(scope="function")
def logged_in_driver(driver):
    """Chrome WebDriver pre-authenticated as Retailer (store@retail.com)."""
    driver.get(f"{BASE_URL}/login")
    wait = WebDriverWait(driver, WAIT_TIMEOUT)

    email_input = wait.until(EC.presence_of_element_located((By.ID, "email")))
    email_input.clear()
    email_input.send_keys(RETAILER_EMAIL)

    driver.find_element(By.ID, "password").send_keys(RETAILER_PASSWORD)
    driver.find_element(By.CSS_SELECTOR, "button[type='submit']").click()

    wait.until(EC.url_contains("/retailer/dashboard"))
    yield driver
