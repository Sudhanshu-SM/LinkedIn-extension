// Popup Script - LinkedIn Profile Scraper

document.addEventListener('DOMContentLoaded', function () {
    const loginBtn = document.getElementById('login-btn');
    const quickBtn = document.getElementById('quick-btn');
    const fullBtn = document.getElementById('full-btn');
    const statusDiv = document.getElementById('status');
    const sheetStatusDiv = document.getElementById('sheet-status');
    const sheetText = document.getElementById('sheet-text');
    const profileStatusDiv = document.getElementById('profile-status');
    const profileText = document.getElementById('profile-text');

    let currentSheetId = null;
    let linkedinTabId = null;
    let isAuthenticated = false;

    // Init
    checkAuth();
    detectSheetAndProfile();

    // --- AUTH ---
    loginBtn.addEventListener('click', function () {
        chrome.identity.getAuthToken({ interactive: true }, function (token) {
            if (chrome.runtime.lastError) {
                setStatus('Auth Error: ' + chrome.runtime.lastError.message, 'error');
            } else {
                isAuthenticated = true;
                loginBtn.textContent = '✅ Account Connected';
                loginBtn.classList.add('connected');
                loginBtn.disabled = true;
                checkReady();
            }
        });
    });

    // --- Ensure content script is injected before messaging ---
    function ensureContentScript(tabId) {
        return chrome.scripting.executeScript({
            target: { tabId: tabId },
            files: ['content.js']
        }).catch(() => { /* already injected, ignore */ });
    }

    // --- QUICK ADD ---
    quickBtn.addEventListener('click', async function () {
        if (!linkedinTabId) {
            setStatus('No LinkedIn profile tab found.', 'error');
            return;
        }
        setStatus('⚡ Quick scraping name & URL...', 'working');
        disableButtons();

        await ensureContentScript(linkedinTabId);

        chrome.tabs.sendMessage(linkedinTabId, { action: "quick_scrape" }, function (response) {
            if (chrome.runtime.lastError) {
                setStatus('Error: ' + chrome.runtime.lastError.message + '\nMake sure you are on a LinkedIn profile page.', 'error');
                enableButtons();
                return;
            }
            if (response && response.success) {
                chrome.runtime.sendMessage({
                    action: "save_to_sheet",
                    sheetId: currentSheetId,
                    data: response.data,
                    mode: "quick",
                    zohoSave: saveZohoCb.checked,
                    zohoJobId: zohoJobSelect.value
                }, function (saveResp) {
                    if (saveResp && saveResp.success) {
                        setStatus('✅ Quick Add successful!\n' + response.data.full_name + ' saved to sheet.', 'success');
                    } else {
                        const errMsg = saveResp ? saveResp.error : 'Unknown error';
                        setStatus('❌ Failed to save: ' + errMsg, 'error');
                        alert("API Error:\n" + errMsg);
                    }
                    enableButtons();
                });
            } else {
                setStatus('❌ Scraping failed: ' + (response ? response.error : 'No response'), 'error');
                enableButtons();
            }
        });
    });

    // --- FULL SCRAPE (background-orchestrated) ---
    fullBtn.addEventListener('click', async function () {
        if (!linkedinTabId) {
            setStatus('No LinkedIn profile tab found.', 'error');
            return;
        }
        setStatus('🔄 Full scrape started...\nNavigating detail pages (~30-45s)', 'working');
        disableButtons();

        await ensureContentScript(linkedinTabId);

        // Send to background script which orchestrates navigation
        chrome.runtime.sendMessage({
            action: "full_scrape_orchestrate",
            tabId: linkedinTabId,
            sheetId: currentSheetId,
            zohoSave: saveZohoCb.checked,
            zohoJobId: zohoJobSelect.value
        }, function (response) {
            if (response && response.success) {
                setStatus('✅ Full scrape complete!\n' + response.data.full_name + ' — all details saved.', 'success');
            } else {
                const errMsg = response ? response.error : 'Unknown error';
                setStatus('❌ Scrape failed: ' + errMsg, 'error');
                alert("API Error:\n" + errMsg);
            }
            enableButtons();
        });
    });

    // --- Listen for status updates from content script ---
    chrome.runtime.onMessage.addListener(function (request) {
        if (request.action === "scrape_status") {
            setStatus(request.message, 'working');
        }
    });

    // --- ZOHO RECRUIT INTEGRATION ---
    const saveZohoCb = document.getElementById('save-zoho-cb');
    const zohoJobSelect = document.getElementById('zoho-job-select');
    const openOptionsLink = document.getElementById('open-options');

    openOptionsLink.addEventListener('click', (e) => {
        e.preventDefault();
        if (chrome.runtime.openOptionsPage) {
            chrome.runtime.openOptionsPage();
        } else {
            window.open(chrome.runtime.getURL('options.html'));
        }
    });

    function loadZohoJobs() {
        chrome.storage.local.get(['zohoRefreshToken', 'zohoClientId'], (result) => {
            if (!result.zohoRefreshToken || !result.zohoClientId) {
                zohoJobSelect.innerHTML = '<option value="">(Zoho APIs not configured)</option>';
                saveZohoCb.checked = false;
                saveZohoCb.disabled = true;
                return;
            }

            zohoJobSelect.innerHTML = '<option value="">Loading active jobs...</option>';
            chrome.runtime.sendMessage({ action: "get_zoho_jobs" }, function(response) {
                if (response && response.success && response.jobs) {
                    zohoJobSelect.innerHTML = '<option value="">(No Job Selected)</option>';
                    response.jobs.forEach(job => {
                        const opt = document.createElement('option');
                        opt.value = job.id;
                        opt.textContent = job.title;
                        zohoJobSelect.appendChild(opt);
                    });
                } else {
                    const errorMsg = (response && response.error) ? response.error : "Failed to load jobs";
                    zohoJobSelect.innerHTML = `<option value="">(Error: ${errorMsg})</option>`;
                }
            });
        });
    }

    // Call this to load jobs on popup initialization
    loadZohoJobs();

    // --- HELPERS ---
    function checkAuth() {
        chrome.identity.getAuthToken({ interactive: false }, function (token) {
            if (token) {
                isAuthenticated = true;
                loginBtn.textContent = '✅ Account Connected';
                loginBtn.classList.add('connected');
                loginBtn.disabled = true;
                checkReady();
            }
        });
    }

    function detectSheetAndProfile() {
        chrome.tabs.query({}, function (tabs) {
            // Find a Google Sheet tab
            for (const tab of tabs) {
                if (tab.url && tab.url.includes("docs.google.com/spreadsheets")) {
                    const match = tab.url.match(/\/d\/([a-zA-Z0-9-_]+)/);
                    if (match && match[1]) {
                        currentSheetId = match[1];
                        sheetText.textContent = `Sheet: ${currentSheetId.substring(0, 15)}...`;
                        sheetStatusDiv.style.display = 'block';
                        break;
                    }
                }
            }

            // Find a LinkedIn profile tab
            for (const tab of tabs) {
                if (tab.url && tab.url.includes("linkedin.com/in/")) {
                    linkedinTabId = tab.id;
                    const profileSlug = tab.url.match(/linkedin\.com\/in\/([^/?]+)/);
                    profileText.textContent = `Profile: ${profileSlug ? profileSlug[1] : 'detected'}`;
                    profileStatusDiv.style.display = 'block';
                    break;
                }
            }

            if (!currentSheetId) {
                setStatus('⚠️ Open a Google Sheet in any tab first.', 'error');
            } else if (!linkedinTabId) {
                setStatus('⚠️ Open a LinkedIn profile page in any tab.', 'error');
            } else {
                setStatus('Ready! Choose an action below.', '');
            }

            checkReady();
        });
    }

    function checkReady() {
        const ready = isAuthenticated && currentSheetId && linkedinTabId;
        quickBtn.disabled = !ready;
        fullBtn.disabled = !ready;
    }

    function disableButtons() {
        quickBtn.disabled = true;
        fullBtn.disabled = true;
        saveZohoCb.disabled = true;
        zohoJobSelect.disabled = true;
    }

    function enableButtons() {
        checkReady();
        chrome.storage.local.get(['zohoRefreshToken'], (res) => {
            saveZohoCb.disabled = !res.zohoRefreshToken;
        });
        zohoJobSelect.disabled = false;
    }

    function setStatus(msg, type) {
        statusDiv.innerHTML = msg;
        statusDiv.className = 'status-box' + (type ? ' ' + type : '');
    }
});
