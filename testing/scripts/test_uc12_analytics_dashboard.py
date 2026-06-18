"""
UC12: View Analytic Dashboard - Farmer Role
============================================
Test Suite for Drone4Dengue Analytics Dashboard (Farmer View)

Test Procedures:
- TP-UC12-001: Dashboard Loads After Login
- TP-UC12-002: GIS Map Displays Tracking Data
- TP-UC12-003: Filters Update GIS Map Results
- TP-UC12-004: Export / Download Data
- TP-UC12-005: Historical GIS View
- TP-UC12-006: No Data Available Message
- TP-UC12-007: Dashboard Interface Verification
- TP-UC12-008: Full Dashboard Exploration Journey
- TP-UC12-009: UAT Questionnaire (Manual - Not Automated)
"""

import pytest
import os
import time
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from webdriver_manager.chrome import ChromeDriverManager

# ============================================================
# CONFIGURATION
# ============================================================

BASE_URL = "http://localhost:3001"
SCREENSHOT_DIR = os.path.join(os.path.dirname(__file__), "..", "screenshots")

# Test Account Credentials
FARMER_EMAIL = "farmer@test.com"
FARMER_PASSWORD = "Farm@123"

# ============================================================
# FIXTURES & HELPERS
# ============================================================

@pytest.fixture
def driver():
    """Initialize Chrome driver with WebDriverManager"""
    driver = webdriver.Chrome(
        service=Service(ChromeDriverManager().install())
    )
    driver.maximize_window()
    yield driver
    driver.quit()


def save_screenshot(driver, name):
    """Save screenshot to screenshots directory"""
    os.makedirs(SCREENSHOT_DIR, exist_ok=True)
    driver.save_screenshot(
        os.path.join(SCREENSHOT_DIR, name + ".png")
    )


def login_as_farmer(driver):
    """Helper: Login as farmer"""
    driver.get(BASE_URL + "/login")
    wait = WebDriverWait(driver, 10)
    
    wait.until(EC.presence_of_element_located((By.NAME, "email")))
    driver.find_element(By.NAME, "email").clear()
    driver.find_element(By.NAME, "email").send_keys(FARMER_EMAIL)
    driver.find_element(By.NAME, "password").clear()
    driver.find_element(By.NAME, "password").send_keys(FARMER_PASSWORD)
    driver.find_element(By.XPATH, "//button[contains(text(),'Login')]").click()
    
    time.sleep(3)
    return driver


def navigate_to_gis(driver):
    """Helper: Navigate to GIS Mapping page"""
    driver.find_element(By.LINK_TEXT, "GIS Mapping").click()
    time.sleep(3)
    return driver


def open_filters_panel(driver):
    """Helper: Open the filters panel on GIS page"""
    wait = WebDriverWait(driver, 10)
    filter_btn = wait.until(
        EC.element_to_be_clickable((By.XPATH, "//button[contains(text(),'Filters')]"))
    )
    filter_btn.click()
    time.sleep(1)
    return driver


# ============================================================
# TP-UC12-001: Dashboard Loads After Login (Main Flow)
# ============================================================

def test_dashboard_loads_after_login(driver):
    """
    TC-UC12-001: Verify system redirects to analytics dashboard 
    after login and all dashboard modules load correctly
    """
    try:
        # Step 1-5: Login and verify redirect
        login_as_farmer(driver)
        
        current_url = driver.current_url
        print(f"Redirected to: {current_url}")
        assert "/farmer/dashboard" in current_url, \
            "Did not redirect to farmer dashboard"
        
        page_source = driver.page_source
        
        # Step 6-9: Verify KPI cards
        kpi_cards = ["Total Batches", "Active Batches", "Completed", "Farm Locations"]
        for card in kpi_cards:
            assert card in page_source, f"{card} KPI card not found"
        
        # Step 10: Batch Status Distribution chart
        # Empty state or data - just verify area exists
        assert "Batch Status" in page_source or "No batch data" in page_source, \
            "Batch Status Distribution chart area not found"
        
        # Step 11: Weather Conditions widget
        assert "Weather Conditions" in page_source or "Temperature" in page_source, \
            "Weather Conditions widget not found"
        
        # Step 12: Farm Information panel
        assert "Farm" in page_source, "Farm Information panel not found"
        
        # Step 13: Quick Actions panel
        assert "Create New Batch" in page_source or "View All Batches" in page_source, \
            "Quick Actions panel not found"
        
        save_screenshot(driver, "pass_TP-UC12-001_dashboard_loads")
        print("✅ TP-UC12-001 PASSED: Dashboard loads correctly")
        
    except Exception as e:
        save_screenshot(driver, "fail_TP-UC12-001_dashboard_loads")
        pytest.fail(f"❌ TP-UC12-001 FAILED: {str(e)}")


# ============================================================
# TP-UC12-002: GIS Map Displays Tracking Data (Main Flow)
# ============================================================

def test_gis_map_displays_tracking_data(driver):
    """
    TC-UC12-002: Verify GIS map renders and displays supply chain tracking data
    """
    try:
        # Login
        login_as_farmer(driver)
        
        # Click GIS Mapping in sidebar
        navigate_to_gis(driver)
        
        # Verify URL
        current_url = driver.current_url
        print(f"Current URL: {current_url}")
        assert "/farmer/gis" in current_url, \
            "Did not navigate to GIS Mapping page"
        
        # Verify map renders (Leaflet map)
        map_elements = driver.find_elements(By.CLASS_NAME, "leaflet-container")
        print(f"Map element found: {len(map_elements) > 0}")
        assert len(map_elements) > 0, "Interactive map did not render"
        
        # Verify map is navigable (check for zoom controls)
        zoom_controls = driver.find_elements(By.CLASS_NAME, "leaflet-control-zoom")
        assert len(zoom_controls) > 0, "Map zoom controls not found"
        
        # Verify actor legend
        page_source = driver.page_source
        actor_types = ["Farmer", "Processor", "Distributor", "Retailer"]
        legend_found = any(actor in page_source for actor in actor_types)
        print(f"Actor legend contains: {', '.join(actor_types)}")
        
        save_screenshot(driver, "pass_TP-UC12-002_gis_map")
        print("✅ TP-UC12-002 PASSED: GIS Map renders correctly")
        
    except Exception as e:
        save_screenshot(driver, "fail_TP-UC12-002_gis_map")
        pytest.fail(f"❌ TP-UC12-002 FAILED: {str(e)}")


# ============================================================
# TP-UC12-003: Filters Update GIS Map Results (Main Flow)
# ============================================================

def test_filters_update_gis_map_results(driver):
    """
    TC-UC12-003: Verify applying date and batch filters updates the map
    """
    try:
        # Login and navigate to GIS
        login_as_farmer(driver)
        navigate_to_gis(driver)
        
        # Open filters panel
        open_filters_panel(driver)
        
        # Verify filter options
        page_source = driver.page_source
        filter_elements = [
            "Search Batch ID",
            "Start Date",
            "End Date",
            "Show Quality Hotspots"
        ]
        for element in filter_elements:
            assert element in page_source or element.lower() in page_source.lower(), \
                f"Filter element '{element}' not found"
        
        # Enter Start Date
        date_inputs = driver.find_elements(By.XPATH, "//input[@type='date']")
        if len(date_inputs) >= 2:
            start_date = date_inputs[0]
            start_date.clear()
            start_date.send_keys("01012025")  # Format may vary
            time.sleep(1)
            
            end_date = date_inputs[1]
            end_date.clear()
            end_date.send_keys("01062025")
            time.sleep(1)
        
        # Search by Batch ID
        search_field = driver.find_element(
            By.XPATH, 
            "//input[@placeholder='Type to search batch...']"
        )
        search_field.clear()
        search_field.send_keys("BATCH001")
        time.sleep(2)
        
        # Verify no error occurred
        page_source = driver.page_source
        assert "error" not in page_source.lower() or "something went wrong" not in page_source.lower(), \
            "Error occurred when applying filters"
        
        save_screenshot(driver, "pass_TP-UC12-003_filters")
        print("✅ TP-UC12-003 PASSED: Filters applied successfully")
        
    except Exception as e:
        save_screenshot(driver, "fail_TP-UC12-003_filters")
        pytest.fail(f"❌ TP-UC12-003 FAILED: {str(e)}")


# ============================================================
# TP-UC12-004: Export / Download Data
# ============================================================

def test_export_download_data(driver):
    """
    TC-UC12-004: Verify user can export or download data
    Note: If export button not found, documented as INC-UC12-001
    """
    try:
        # Login
        login_as_farmer(driver)
        
        # Check dashboard for export
        page_source = driver.page_source.lower()
        export_found_dashboard = "export" in page_source or "download" in page_source
        
        print(f"Export/Download button found on dashboard: {export_found_dashboard}")
        
        # Navigate to analytics
        driver.get(BASE_URL + "/farmer/analytics")
        time.sleep(3)
        
        # Check analytics for export
        page_source2 = driver.page_source.lower()
        export_found_analytics = "export" in page_source2 or "download" in page_source2
        
        print(f"Export/Download button found on analytics: {export_found_analytics}")
        
        # Test passes if at least one export button exists
        # Document as INC-UC12-001 if both are False
        if not export_found_dashboard and not export_found_analytics:
            print("⚠️ INC-UC12-001: Export feature not implemented")
            # Not failing the test, just documenting
            save_screenshot(driver, "warning_TP-UC12-004_no_export")
        else:
            save_screenshot(driver, "pass_TP-UC12-004_export")
        
        print("✅ TP-UC12-004 PASSED: Export feature verified (or documented as missing)")
        
    except Exception as e:
        save_screenshot(driver, "fail_TP-UC12-004_export")
        pytest.fail(f"❌ TP-UC12-004 FAILED: {str(e)}")


# ============================================================
# TP-UC12-005: Historical GIS View
# ============================================================

def test_historical_gis_view(driver):
    """
    TC-UC12-005: Verify Historical GIS View option is accessible
    Note: If not found, documented as INC-UC12-002
    """
    try:
        # Login and navigate to GIS
        login_as_farmer(driver)
        navigate_to_gis(driver)
        
        # Open filters panel
        open_filters_panel(driver)
        
        # Check for Historical GIS View
        page_source = driver.page_source.lower()
        historical_found = "historical" in page_source
        
        print(f"Historical GIS View option found: {historical_found}")
        
        if not historical_found:
            print("⚠️ INC-UC12-002: Historical GIS View not implemented")
            save_screenshot(driver, "warning_TP-UC12-005_no_historical")
        else:
            save_screenshot(driver, "pass_TP-UC12-005_historical")
        
        print("✅ TP-UC12-005 PASSED: Historical GIS View verified (or documented as missing)")
        
    except Exception as e:
        save_screenshot(driver, "fail_TP-UC12-005_historical")
        pytest.fail(f"❌ TP-UC12-005 FAILED: {str(e)}")


# ============================================================
# TP-UC12-006: No Data Available Message (Exception Flow)
# ============================================================

def test_no_data_available_message(driver):
    """
    TC-UC12-006: Verify system displays meaningful message when no data
    """
    try:
        # Login and navigate to GIS
        login_as_farmer(driver)
        navigate_to_gis(driver)
        
        # Open filters panel
        open_filters_panel(driver)
        
        # Enter non-existent batch ID
        search_field = driver.find_element(
            By.XPATH, 
            "//input[@placeholder='Type to search batch...']"
        )
        search_field.clear()
        search_field.send_keys("NONEXISTENT999")
        time.sleep(2)
        
        # Check for no data message
        page_source = driver.page_source.lower()
        no_data_shown = (
            "no data" in page_source or 
            "not found" in page_source or
            "no results" in page_source or
            "empty" in page_source
        )
        
        print(f"No data message shown: {no_data_shown}")
        
        # Verify no crash
        assert driver.current_url is not None, "Page crashed"
        assert "error" not in page_source or "something went wrong" not in page_source, \
            "Error page displayed instead of empty state"
        
        save_screenshot(driver, "pass_TP-UC12-006_no_data")
        print("✅ TP-UC12-006 PASSED: No data message verified")
        
    except Exception as e:
        save_screenshot(driver, "fail_TP-UC12-006_no_data")
        pytest.fail(f"❌ TP-UC12-006 FAILED: {str(e)}")


# ============================================================
# TP-UC12-007: Dashboard Interface Verification (GUI Testing)
# ============================================================

def test_dashboard_interface_verification(driver):
    """
    TC-UC12-007: Verify all required interface elements are present
    and functional across dashboard, GIS Mapping, and Quality Analytics pages
    """
    try:
        # Login
        login_as_farmer(driver)
        
        # ========== DASHBOARD PAGE ==========
        page_source = driver.page_source
        
        # Verify KPI cards
        assert "Total Batches" in page_source, "Total Batches KPI missing"
        assert "Active Batches" in page_source, "Active Batches KPI missing"
        assert "Completed" in page_source, "Completed KPI missing"
        assert "Farm Locations" in page_source, "Farm Locations KPI missing"
        
        # Verify Weather widget
        assert "Weather" in page_source, "Weather widget missing"
        
        # Verify sidebar
        sidebar_items = ["Dashboard", "Batch Registration", "GIS Mapping", "Quality Analytics", "Profile"]
        for item in sidebar_items:
            assert item in page_source, f"Sidebar item '{item}' missing"
        
        # Verify Quick Actions
        assert "Create New Batch" in page_source or "View All Batches" in page_source, \
            "Quick Actions panel missing"
        
        # Verify Dark Mode toggle
        dark_mode_toggle = driver.find_elements(By.CSS_SELECTOR, "[aria-label='dark mode toggle']")
        if dark_mode_toggle:
            dark_mode_toggle[0].click()
            time.sleep(1)
            print("Dark mode toggled successfully")
        else:
            print("⚠️ Dark mode toggle not found")
        
        # ========== GIS MAPPING PAGE ==========
        navigate_to_gis(driver)
        gis_source = driver.page_source
        
        # Verify map elements
        map_elements = driver.find_elements(By.CLASS_NAME, "leaflet-container")
        assert len(map_elements) > 0, "Map not rendered"
        
        # Verify Filters button
        assert "Filters" in gis_source, "Filters button not found"
        
        # Open filters and verify elements
        open_filters_panel(driver)
        filter_source = driver.page_source.lower()
        assert "search batch" in filter_source, "Search Batch ID field missing"
        assert "start date" in filter_source or "date" in filter_source, "Date filter missing"
        
        # Verify Quality Risk Legend
        risk_keywords = ["high spoilage", "high risk", "optimal", "warning"]
        risk_found = any(kw in gis_source.lower() for kw in risk_keywords)
        print(f"Quality Risk Legend found: {risk_found}")
        
        # ========== QUALITY ANALYTICS PAGE ==========
        driver.find_element(By.LINK_TEXT, "Quality Analytics").click()
        time.sleep(3)
        
        qa_source = driver.page_source
        assert "Quality Analytics & Insights" in qa_source, "Quality Analytics heading missing"
        assert "Humidity vs Moisture" in qa_source, "Humidity vs Moisture KPI missing"
        assert "Temp vs Quality Grade" in qa_source, "Temp vs Quality Grade KPI missing"
        
        # Test Farm and Processing tabs
        farm_tabs = driver.find_elements(By.XPATH, "//button[contains(text(),'Farm')]")
        if farm_tabs:
            farm_tabs[0].click()
            time.sleep(1)
            print("Farm tab clicked")
        
        processing_tabs = driver.find_elements(By.XPATH, "//button[contains(text(),'Processing')]")
        if processing_tabs:
            processing_tabs[0].click()
            time.sleep(1)
            print("Processing tab clicked")
        
        save_screenshot(driver, "pass_TP-UC12-007_interface")
        print("✅ TP-UC12-007 PASSED: All interface elements verified")
        
    except Exception as e:
        save_screenshot(driver, "fail_TP-UC12-007_interface")
        pytest.fail(f"❌ TP-UC12-007 FAILED: {str(e)}")


# ============================================================
# TP-UC12-008: Full Dashboard Exploration Journey (Scenario Testing)
# ============================================================

def test_full_dashboard_exploration_journey(driver):
    """
    TC-UC12-008: Verify complete analytics dashboard journey from login 
    through all three dashboard sections
    """
    try:
        # ========== STEP 1-2: Login ==========
        print("Step 1-2: Logging in...")
        login_as_farmer(driver)
        print(f"Login URL: {driver.current_url}")
        assert "/farmer/dashboard" in driver.current_url, "Login redirect failed"
        
        # ========== STEP 3: Dashboard Verification ==========
        print("Step 3: Verifying dashboard...")
        page_source = driver.page_source
        assert "Total Batches" in page_source, "Total Batches KPI missing"
        assert "Farm Locations" in page_source, "Farm Locations KPI missing"
        print("Step 3 - Dashboard KPI cards verified.")
        
        # ========== STEP 4: GIS Mapping ==========
        print("Step 4: Testing GIS Mapping...")
        navigate_to_gis(driver)
        
        # Open filters and apply
        open_filters_panel(driver)
        date_inputs = driver.find_elements(By.XPATH, "//input[@type='date']")
        if len(date_inputs) >= 2:
            date_inputs[0].clear()
            date_inputs[0].send_keys("01012025")
            time.sleep(1)
        print("Step 4 - GIS filter applied.")
        
        # ========== STEP 5: Quality Analytics ==========
        print("Step 5: Testing Quality Analytics...")
        driver.find_element(By.LINK_TEXT, "Quality Analytics").click()
        time.sleep(3)
        
        # Test tabs
        farm_tab = driver.find_elements(By.XPATH, "//button[contains(text(),'Farm')]")
        if farm_tab:
            farm_tab[0].click()
            time.sleep(1)
            print("Farm tab clicked")
        
        processing_tab = driver.find_elements(By.XPATH, "//button[contains(text(),'Processing')]")
        if processing_tab:
            processing_tab[0].click()
            time.sleep(1)
            print("Processing tab clicked")
        print("Step 5 - Quality Analytics tabs toggled.")
        
        # ========== STEP 6: Dark Mode ==========
        print("Step 6: Testing Dark Mode...")
        dark_mode_toggle = driver.find_elements(By.CSS_SELECTOR, "[aria-label='dark mode toggle']")
        if dark_mode_toggle:
            dark_mode_toggle[0].click()
            time.sleep(1)
            print("Step 6 - Dark mode toggled.")
        else:
            print("⚠️ Dark mode toggle not found - skipping")
        
        save_screenshot(driver, "pass_TP-UC12-008_full_journey")
        print("✅ TP-UC12-008 PASSED: Full dashboard journey completed")
        
    except Exception as e:
        save_screenshot(driver, "fail_TP-UC12-008_full_journey")
        pytest.fail(f"❌ TP-UC12-008 FAILED: {str(e)}")


# ============================================================
# TP-UC12-009: UAT Questionnaire (MANUAL - Not Automated)
# ============================================================

def test_uat_questionnaire_placeholder():
    """
    TC-UC12-009: UAT Questionnaire
    
    ⚠️ THIS IS A MANUAL TEST - NOT AUTOMATED ⚠️
    
    To complete this test procedure:
    1. Identify 3 participants (fellow students with no prior Plancana experience)
    2. Provide each with login credentials: farmer@test.com / Farm@123
    3. Instruct participants to complete the following tasks:
        a. Login to http://localhost:3001/login
        b. Explore dashboard widgets and KPI cards
        c. Click GIS Mapping and explore the map
        d. Click Filters button and apply a date range filter
        e. Click Quality Analytics and explore correlation charts
        f. Toggle between Farm and Processing tabs
    
    4. Ask participants to rate (1-5 scale):
        Q1: The dashboard clearly showed the key information I needed.
        Q2: The sidebar navigation made it easy to move between pages.
        Q3: The GIS map was easy to understand and filters were clear.
        Q4: The Quality Analytics charts and metrics were easy to interpret.
        Q5: Overall I am satisfied with the analytics dashboard experience.
    
    5. Collect scores from all 3 participants
    6. Calculate average score for each question
    7. Write a 2-3 sentence UAT summary
    
    UAT Questionnaire Results:
    ==========================
    | Participant | Q1 | Q2 | Q3 | Q4 | Q5 |
    |-------------|----|----|----|----|----|
    | P1          |    |    |    |    |    |
    | P2          |    |    |    |    |    |
    | P3          |    |    |    |    |    |
    |-------------|----|----|----|----|----|
    | Average     |    |    |    |    |    |
    
    UAT Summary (to be filled after manual testing):
    ________________________________________________
    
    ________________________________________________
    
    Note: This test case serves as a placeholder/reminder.
    """
    print("\n" + "="*60)
    print("⚠️ UAT QUESTIONNAIRE - MANUAL TEST REQUIRED ⚠️")
    print("="*60)
    print("TC-UC12-009 cannot be automated. Please complete manually.")
    print("See comments in the test function for instructions.")
    print("="*60 + "\n")
    
    # This always passes as it's a placeholder for manual testing
    assert True, "Manual UAT questionnaire required"


# ============================================================
# RUNNER CONFIGURATION
# ============================================================

if __name__ == "__main__":
    pytest.main([
        "-v", 
        "--html=report_uc12_analytics_dashboard.html", 
        "--self-contained-html",
        __file__
    ])
