// Background Service Worker - LinkedIn Profile Scraper
// Orchestrates deep scraping by navigating tabs and coordinates with content script

let userToken = null;

// Column order for the Google Sheet
const HEADERS = [
    "full_name", "headline", "location", "about",
    "current_company", "current_position", "current_location", "duration",
    "total_years_experience", "profile_url", "education", "top_skills", "all_experience"
];

// --- Message Listener ---
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "save_to_sheet") {
        handleSaveToSheet(request.sheetId, request.data, request.mode, request.zohoSave, request.zohoJobId)
            .then(result => sendResponse(result))
            .catch(e => sendResponse({ success: false, error: e.message }));
        return true; // async
    }
    else if (request.action === "full_scrape_orchestrate") {
        orchestrateFullScrape(request.tabId, request.sheetId, request.zohoSave, request.zohoJobId)
            .then(result => sendResponse(result))
            .catch(e => sendResponse({ success: false, error: e.message }));
        return true; // async
    }
    else if (request.action === "get_zoho_jobs") {
        getZohoJobs()
            .then(jobs => sendResponse({ success: true, jobs: jobs }))
            .catch(e => sendResponse({ success: false, error: e.message }));
        return true; // async
    }
    else if (request.action === "scrape_status") {
        // Forward status to popup (it might be closed, so catch errors)
        try { chrome.runtime.sendMessage(request); } catch (e) { }
    }
    return true;
});

// =====================================================
// MAIN SAVE HANDLER
// =====================================================

async function handleSaveToSheet(sheetId, data, mode, zohoSave, zohoJobId) {
    const token = await getAuthToken();

    // Ensure headers exist
    await checkAndAddHeaders(sheetId, token);

    // Build row in correct column order
    const row = HEADERS.map(key => data[key] || "");

    await appendToSheet(row, sheetId, token);
    
    // Save to Zoho if requested
    if (zohoSave) {
        broadcastStatus("🔄 Saving candidate to Zoho...");
        const candidateId = await createZohoCandidate(data);
        if (zohoJobId) {
            broadcastStatus("🔗 Associating with Job Opening...");
            await associateZohoCandidate(candidateId, zohoJobId);
        }
    }
    
    return { success: true };
}

// =====================================================
// ORCHESTRATE FULL SCRAPE (Background-driven)
// =====================================================

async function orchestrateFullScrape(tabId, sheetId, zohoSave, zohoJobId) {
    try {
        // Phase 1: Scrape main profile
        broadcastStatus("📄 Reading main profile page...");
        await sleep(1000);

        const mainData = await sendMessageToTab(tabId, { action: "scrape_main_profile" });
        if (!mainData.success) throw new Error("Failed to scrape main profile: " + mainData.error);

        const profileUrl = mainData.data.profile_url;
        const profileData = { ...mainData.data };

        // Phase 2: Deep scrape experience
        broadcastStatus("💼 Navigating to Experience...");
        await sleep(randomDelay(2000, 4000)); // Anti-ban delay

        const expUrl = profileUrl.replace(/\/$/, '') + '/details/experience/';
        const experienceItems = await navigateAndScrape(tabId, expUrl);

        // Phase 3: Deep scrape education
        broadcastStatus("🎓 Navigating to Education...");
        await sleep(randomDelay(2500, 4500)); // Anti-ban delay

        const eduUrl = profileUrl.replace(/\/$/, '') + '/details/education/';
        const educationItems = await navigateAndScrape(tabId, eduUrl);

        // Phase 4: Deep scrape skills
        broadcastStatus("🛠️ Navigating to Skills...");
        await sleep(randomDelay(2500, 4500)); // Anti-ban delay

        const skillsUrl = profileUrl.replace(/\/$/, '') + '/details/skills/';
        const skillsItems = await navigateAndScrape(tabId, skillsUrl);

        // Phase 5: Navigate back to profile
        broadcastStatus("🔙 Returning to profile...");
        await navigateTab(tabId, profileUrl);
        await sleep(2000);

        // Phase 6: Process all data
        broadcastStatus("⚙️ Processing & saving data...");

        const { currentCompany, currentPosition, currentLocation, duration, totalYears, allExperience } = parseExperience(experienceItems);

        const finalData = {
            full_name: profileData.full_name || "Unknown",
            headline: profileData.headline || "N/A",
            location: profileData.location || "N/A",
            about: profileData.about || "N/A",
            current_company: currentCompany,
            current_position: currentPosition,
            current_location: currentLocation,
            duration: duration,
            total_years_experience: totalYears,
            profile_url: profileUrl,
            education: educationItems.join(" ; ") || "N/A",
            top_skills: skillsItems.slice(0, 3).join(", ") || "N/A",
            all_experience: allExperience || "N/A",
            raw_experience_items: experienceItems
        };

        // Save to sheet
        const token = await getAuthToken();
        await checkAndAddHeaders(sheetId, token);
        const row = HEADERS.map(key => finalData[key] || "");
        await appendToSheet(row, sheetId, token);

        // Save to Zoho if requested
        if (zohoSave) {
            broadcastStatus("🔄 Saving candidate to Zoho...");
            const candidateId = await createZohoCandidate(finalData);
            if (zohoJobId) {
                broadcastStatus("🔗 Associating with Job Opening...");
                await associateZohoCandidate(candidateId, zohoJobId);
            }
        }

        broadcastStatus("✅ Full scrape complete! " + finalData.full_name + " saved.");
        return { success: true, data: finalData };

    } catch (e) {
        broadcastStatus("❌ Error: " + e.message);
        throw e;
    }
}

// Navigate tab to URL and wait for it to fully load
function navigateTab(tabId, url) {
    return new Promise((resolve, reject) => {
        chrome.tabs.update(tabId, { url: url }, () => {
            if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
                return;
            }

            // Wait for tab to finish loading
            function onUpdated(updatedTabId, changeInfo) {
                if (updatedTabId === tabId && changeInfo.status === 'complete') {
                    chrome.tabs.onUpdated.removeListener(onUpdated);
                    resolve();
                }
            }
            chrome.tabs.onUpdated.addListener(onUpdated);

            // Timeout after 20s
            setTimeout(() => {
                chrome.tabs.onUpdated.removeListener(onUpdated);
                resolve(); // Proceed anyway
            }, 20000);
        });
    });
}

// Navigate to a detail page, wait, then scrape
async function navigateAndScrape(tabId, url) {
    await navigateTab(tabId, url);
    await sleep(3000); // Wait for SPA rendering + dynamic content

    // Inject content script if not already injected (detail pages match /in/* pattern)
    // Since /details/ pages are under /in/, the content script should auto-inject
    // But we also try scripting.executeScript as fallback

    try {
        const response = await sendMessageToTab(tabId, { action: "scrape_detail_page" });
        if (response && response.success) {
            return response.data || [];
        }
    } catch (e) {
        console.log("Direct message failed, trying executeScript...", e);
    }

    // Fallback: inject and run
    try {
        const results = await chrome.scripting.executeScript({
            target: { tabId: tabId },
            files: ['content.js']
        });
        await sleep(1000);
        const response = await sendMessageToTab(tabId, { action: "scrape_detail_page" });
        if (response && response.success) return response.data || [];
    } catch (e) {
        console.log("ExecuteScript fallback also failed:", e);
    }

    return [];
}

// Send message to tab with retry
function sendMessageToTab(tabId, message) {
    return new Promise((resolve, reject) => {
        chrome.tabs.sendMessage(tabId, message, (response) => {
            if (chrome.runtime.lastError) {
                // Retry once after a delay
                setTimeout(() => {
                    chrome.tabs.sendMessage(tabId, message, (retryResponse) => {
                        if (chrome.runtime.lastError) {
                            reject(new Error(chrome.runtime.lastError.message));
                        } else {
                            resolve(retryResponse);
                        }
                    });
                }, 2000);
            } else {
                resolve(response);
            }
        });
    });
}

// =====================================================
// EXPERIENCE PARSER (runs in background)
// =====================================================

function parseExperience(experienceItems) {
    let currentCompany = "N/A";
    let currentPosition = "N/A";
    let currentLocation = "N/A";
    let duration = "N/A";
    let totalYears = "N/A";
    let allExperience = experienceItems.join(" ; ") || "N/A";

    if (experienceItems.length === 0) {
        return { currentCompany, currentPosition, currentLocation, duration, totalYears, allExperience };
    }

    // --- Pattern helpers ---
    const dateRangePattern = /(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4}\s*[-–]\s*(?:(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4}|Present)/i;
    const durationPattern = /\d+\s*(?:yr|year|mo|month)s?/i;
    const locationIndicators = /(?:India|Remote|On-site|Hybrid|United|States|UK|Singapore|Hong Kong|SAR|Germany|Canada|Australia|Delhi|Mumbai|Bangalore|Bengaluru|Hyderabad|Chennai|Kolkata|Pune|Kharagpur|Jamshedpur)/i;

    function isDuration(text) { return durationPattern.test(text) && !dateRangePattern.test(text) && text.trim().length < 25; }
    function isDateRange(text) { return dateRangePattern.test(text); }
    function isLocation(text) { return locationIndicators.test(text) && !dateRangePattern.test(text) && !isDuration(text); }

    function classifyParts(parts) {
        let title = null, company = null, loc = null, dur = null, dateRange = null;

        const remaining = [];
        for (const part of parts) {
            const p = part.trim();
            if (/^(Full-time|Part-time|Internship|Contract|Freelance|Self-employed|Seasonal|Apprenticeship)$/i.test(p)) continue;
            
            if (!dateRange && isDateRange(p)) { dateRange = p; }
            else if (!dur && isDuration(p) && !isDateRange(p)) { dur = p; }
            else { remaining.push(p); }
        }

        if (remaining.length === 1) {
            title = remaining[0];
        } else if (remaining.length === 2) {
            title = remaining[0];
            if (isLocation(remaining[1])) loc = remaining[1];
            else company = remaining[1];
        } else if (remaining.length >= 3) {
            title = remaining[0];
            company = remaining[1];
            loc = remaining.slice(2).join(", ");
        }

        return { title, company, location: loc, duration: dur, dateRange };
    }

    // --- Detect if first entry is a grouped company header ---
    // Grouped headers look like: "Company Name | total duration | location | date1 | date2 ..."
    // They have NO date range in position 0 and have a duration + location
    const firstParts = experienceItems[0].split(" | ");
    const firstClassified = classifyParts(firstParts);

    // Check if the first entry is a grouped company (no real "company" field, just a title + duration + location)
    // A grouped entry typically: first part = company name, second+ = duration/location/dates
    const isGrouped = firstParts.length >= 3 &&
        !firstParts[0].includes("·") && // Company names don't usually have · (employment type indicator)
        isDuration(firstParts[1]) &&
        experienceItems.length > 1;

    if (isGrouped) {
        // First item = company group header
        currentCompany = firstParts[0].trim();

        // Find location and total duration from the group header
        for (const part of firstParts) {
            const p = part.trim();
            if (isDuration(p) && duration === "N/A") duration = p;
            if (isLocation(p) && currentLocation === "N/A") currentLocation = p;
        }

        // Second item = first (current) role under this company
        if (experienceItems.length > 1) {
            const roleParts = experienceItems[1].split(" | ");
            if (roleParts.length >= 1) {
                currentPosition = roleParts[0].trim();
            }
            // Try to get this role's specific duration
            for (const part of roleParts) {
                const p = part.trim();
                if (isDateRange(p)) { duration = p; break; }
            }
        }
    } else {
        // Single-role entry: "Position | Company · Type | Date Range | Location"
        if (firstClassified.title) currentPosition = firstClassified.title;
        if (firstClassified.company) currentCompany = firstClassified.company;
        if (firstClassified.location) currentLocation = firstClassified.location;
        if (firstClassified.dateRange) duration = firstClassified.dateRange;
        else if (firstClassified.duration) duration = firstClassified.duration;
    }

    // --- Calculate total experience using date ranges (merge overlaps) ---
    totalYears = calculateTotalExperience(experienceItems);

    return { currentCompany, currentPosition, currentLocation, duration, totalYears, allExperience };
}

function calculateTotalExperience(experienceItems) {
    const monthMap = { 'jan': 0, 'feb': 1, 'mar': 2, 'apr': 3, 'may': 4, 'jun': 5, 'jul': 6, 'aug': 7, 'sep': 8, 'oct': 9, 'nov': 10, 'dec': 11 };
    const dateRangeRegex = /(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{4})\s*[-–]\s*((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{4})|Present)/gi;

    // Step 1: Extract all date ranges
    const ranges = [];
    const fullText = experienceItems.join(" | ");

    let match;
    while ((match = dateRangeRegex.exec(fullText)) !== null) {
        const startMonth = monthMap[match[1].toLowerCase()];
        const startYear = parseInt(match[2]);
        const startDate = new Date(startYear, startMonth);

        let endDate;
        if (match[3].toLowerCase() === 'present') {
            endDate = new Date(); // now
        } else {
            const endParts = match[3].match(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{4})/i);
            if (endParts) {
                endDate = new Date(parseInt(endParts[2]), monthMap[endParts[1].toLowerCase()]);
            } else {
                continue;
            }
        }

        if (startDate < endDate) {
            ranges.push({ start: startDate.getTime(), end: endDate.getTime() });
        }
    }

    if (ranges.length === 0) return "N/A";

    // Step 2: Filter out group-header durations (they duplicate sub-role durations)
    // Group headers span the full range of their sub-roles, so they are supersets
    // We keep only non-superset ranges to avoid double counting
    // Sort by start date, then by end date descending
    ranges.sort((a, b) => a.start - b.start || b.end - a.end);

    // Step 3: Merge overlapping ranges
    const merged = [ranges[0]];
    for (let i = 1; i < ranges.length; i++) {
        const last = merged[merged.length - 1];
        if (ranges[i].start <= last.end) {
            // Overlapping — extend the end if needed
            last.end = Math.max(last.end, ranges[i].end);
        } else {
            merged.push({ ...ranges[i] });
        }
    }

    // Step 4: Sum total months from merged ranges
    let totalMonths = 0;
    for (const range of merged) {
        const diffMs = range.end - range.start;
        totalMonths += Math.round(diffMs / (1000 * 60 * 60 * 24 * 30.44)); // ms to months
    }

    if (totalMonths <= 0) return "N/A";

    const years = Math.floor(totalMonths / 12);
    const months = totalMonths % 12;

    if (years > 0 && months > 0) return `${years} yr${years > 1 ? 's' : ''} ${months} mo${months > 1 ? 's' : ''}`;
    if (years > 0) return `${years} yr${years > 1 ? 's' : ''}`;
    return `${months} mo${months > 1 ? 's' : ''}`;
}

// =====================================================
// GOOGLE SHEETS API
// =====================================================

async function getAuthToken() {
    return new Promise((resolve, reject) => {
        chrome.identity.getAuthToken({ interactive: true }, function (token) {
            if (chrome.runtime.lastError || !token) {
                reject(chrome.runtime.lastError || new Error("No token"));
            } else {
                userToken = token;
                resolve(token);
            }
        });
    });
}

async function checkAndAddHeaders(sheetId, token) {
    const headerLabels = [
        "full_name", "headline", "location", "about",
        "current_company", "current_position", "current_location", "duration",
        "total_years_experience", "profile_url", "education", "top_skills", "all_experience"
    ];

    const range = `Sheet1!A1:M1`;
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}`;

    try {
        const response = await fetch(url, {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        if (response.ok) {
            const data = await response.json();
            const existing = data.values ? data.values[0] : [];

            if (JSON.stringify(existing) !== JSON.stringify(headerLabels)) {
                // Overwrite row 1 with headers using UPDATE (not append)
                const updateUrl = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}?valueInputOption=USER_ENTERED`;
                await fetch(updateUrl, {
                    method: 'PUT',
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ values: [headerLabels] })
                });
            }
        }
    } catch (e) {
        console.error("Header check failed:", e);
        // If first row doesn't exist, append headers
        await appendToSheet(headerLabels, sheetId, token);
    }
}

async function appendToSheet(row, sheetId, token) {
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/Sheet1!A1:M1:append?valueInputOption=USER_ENTERED`;
    const body = { values: [row] };

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
    });

    if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error?.message || "Sheets API error");
    }
}

// =====================================================
// UTILITIES
// =====================================================

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

function randomDelay(min, max) {
    return min + Math.random() * (max - min);
}

function broadcastStatus(message) {
    chrome.runtime.sendMessage({ action: "scrape_status", message: message }).catch(() => {});
}

// =====================================================
// ZOHO RECRUIT API
// =====================================================

async function getZohoCreds() {
    return new Promise(resolve => {
        chrome.storage.local.get(['zohoClientId', 'zohoClientSecret', 'zohoRefreshToken', 'zohoDomain', 'zohoApiDomain'], res => {
            resolve(res);
        });
    });
}

async function refreshZohoToken() {
    const creds = await getZohoCreds();
    if (!creds.zohoClientId || !creds.zohoRefreshToken) {
        throw new Error("Zoho Recruit credentials not configured.");
    }

    const domain = creds.zohoDomain || 'https://accounts.zoho.in';
    const url = `${domain}/oauth/v2/token`;

    const body = new URLSearchParams({
        refresh_token: creds.zohoRefreshToken,
        client_id: creds.zohoClientId,
        client_secret: creds.zohoClientSecret,
        grant_type: 'refresh_token'
    });

    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString()
    });
    const data = await response.json();

    if (data.error) throw new Error("Zoho Auth Error: " + data.error);
    if (!data.access_token) throw new Error("Zoho token refresh failed: " + JSON.stringify(data));
    return data.access_token;
}

async function getZohoJobs() {
    const token = await refreshZohoToken();
    const creds = await getZohoCreds();
    const apiDomain = creds.zohoApiDomain || 'https://recruit.zoho.in';
    const url = `${apiDomain}/recruit/v2/Job_Openings?fields=id,Job_Opening_Name&sort_by=Created_Time&sort_order=desc`;

    const response = await fetch(url, {
        headers: {
            'Authorization': `Zoho-oauthtoken ${token}`
        }
    });

    if (!response.ok) throw new Error("Failed to fetch jobs");
    const data = await response.json();
    
    if (!data.data) return [];
    
    return data.data.map(job => ({
        id: job.id,
        title: job.Job_Opening_Name
    }));
}

async function createZohoCandidate(candidateData) {
    const token = await refreshZohoToken();
    const creds = await getZohoCreds();
    const apiDomain = creds.zohoApiDomain || 'https://recruit.zoho.in';
    
    // Split name
    const nameParts = (candidateData.full_name || "Unknown").trim().split(" ");
    const lastName = nameParts.length > 1 ? nameParts.pop() : "Unknown";
    const firstName = nameParts.join(" ");

    const jobTitle = (candidateData.current_position || candidateData.headline || "").substring(0, 100);

    const record = {
        "First_Name": firstName || "Unknown",
        "Last_Name": lastName || "Unknown",
        "Current_Job_Title": jobTitle,
        "Current_Employer": candidateData.current_company || "",
        "Skill_Set": candidateData.top_skills || "",
        "LinkedIn_Id": candidateData.profile_url || "",
        "Website": candidateData.profile_url || "",
        "Current_Location": candidateData.location || ""
    };

    // Add structured Experience_Details
    if (candidateData.raw_experience_items && candidateData.raw_experience_items.length > 0) {
        const expDetails = [];
        let currentGroup = "";
        for (const item of candidateData.raw_experience_items) {
            const parts = item.split(" | ").map(p => p.trim());
            if (parts.length === 0) continue;
            
            // Check if grouped header
            if (parts.length >= 2 && !parts[0].includes("·") && parts[1].match(/\d+\s*(?:yr|year|mo|month)s?/i)) {
                currentGroup = parts[0];
                continue; // Skip the group header row itself
            }
            
            let title = parts[0];
            let company = parts.length > 1 ? parts[1] : (currentGroup || "");
            let dates = parts.length > 2 ? parts[2] : "";

            // If it's a sub-role, the second part is usually dates, not company
            if (currentGroup && (parts.length > 1 && (parts[1].match(/Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec/i) || parts[1].match(/mos?|yrs?/i)))) {
                dates = parts[1];
                company = currentGroup;
            } else if (!currentGroup && parts.length > 1) {
                company = parts[1];
            } else if (currentGroup && parts.length === 1) {
                company = currentGroup;
            } else if (!currentGroup && parts.length === 1) {
                // Reset group context if format doesn't match
                currentGroup = ""; 
            }

            expDetails.push({
                "Occupation_Title": (title || "Unknown").substring(0, 255),
                "Company": (company || "Unknown").substring(0, 255),
                "Summary": (dates ? `[${dates}]\n${item}` : item).substring(0, 32000)
            });
        }
        
        if (expDetails.length > 0) {
            record["Experience_Details"] = expDetails;
        }
    }

    const url = `${apiDomain}/recruit/v2/Candidates`;
    const body = { data: [record] };

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Authorization': `Zoho-oauthtoken ${token}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
    });

    const data = await response.json();
    if (data.data && data.data[0] && data.data[0].code === "SUCCESS") {
        return data.data[0].details.id;
    } else {
        throw new Error("Zoho create candidate failed: " + JSON.stringify(data));
    }
}

async function associateZohoCandidate(candidateId, jobOpeningId) {
    const token = await refreshZohoToken();
    const creds = await getZohoCreds();
    const apiDomain = creds.zohoApiDomain || 'https://recruit.zoho.in';
    
    const url = `${apiDomain}/recruit/v2/Candidates/actions/associate`;

    const body = {
        "data": [
            {
                "ids": [candidateId],
                "jobids": [jobOpeningId]
            }
        ]
    };

    const response = await fetch(url, {
        method: 'PUT',
        headers: {
            'Authorization': `Zoho-oauthtoken ${token}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
    });

    const data = await response.json();
    if (data.data && data.data[0] && data.data[0].code === "SUCCESS") {
        return true;
    } else {
        throw new Error("Zoho associate failed: " + JSON.stringify(data));
    }
}
