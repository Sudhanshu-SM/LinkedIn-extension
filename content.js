// Content Script - LinkedIn Profile Scraper
// Injected on linkedin.com/in/* pages
// This script ONLY scrapes the current page's DOM and responds.
// Navigation is handled by the background script.

const log = (msg) => console.log("[LI Scraper]", msg);

// --- Message Listener ---
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "quick_scrape") {
        try {
            const data = quickScrape();
            sendResponse({ success: true, data: data });
        } catch (e) {
            log("Quick scrape error: " + e.message);
            sendResponse({ success: false, error: e.message });
        }
    }
    else if (request.action === "scrape_main_profile") {
        try {
            const data = scrapeMainProfile();
            sendResponse({ success: true, data: data });
        } catch (e) {
            log("Main profile scrape error: " + e.message);
            sendResponse({ success: false, error: e.message });
        }
    }
    else if (request.action === "scrape_detail_page") {
        scrapeDetailPage().then(data => {
            sendResponse({ success: true, data: data });
        }).catch(e => {
            log("Detail scrape error: " + e.message);
            sendResponse({ success: false, error: e.message, data: [] });
        });
        return true; // async
    }
    return true;
});

// =====================================================
// QUICK SCRAPE - Name + URL only (no navigation)
// =====================================================
function quickScrape() {
    log("Quick scrape...");
    return {
        full_name: getFullName(),
        headline: "",
        location: "",
        about: "",
        current_company: "",
        current_position: "",
        current_location: "",
        duration: "",
        total_years_experience: "",
        profile_url: getProfileUrl(),
        education: "",
        top_skills: "",
        all_experience: ""
    };
}

// =====================================================
// SCRAPE MAIN PROFILE PAGE (name, headline, location, about)
// =====================================================
function scrapeMainProfile() {
    log("Scraping main profile page...");

    const full_name = getFullName();
    const headline = getHeadline();
    const location = getLocation();
    const about = getAbout();
    const profile_url = getProfileUrl();

    return { full_name, headline, location, about, profile_url };
}

// =====================================================
// SCRAPE DETAIL PAGE (/details/experience|education|skills/)
// Scrolls to load all items, then extracts
// =====================================================
async function scrapeDetailPage() {
    log("Scraping detail page: " + window.location.href);

    // Wait for content to render
    await delay(1500);

    // Gentle scroll to load lazy items
    await gentleScroll();

    // Extract items from PVS list
    const items = document.querySelectorAll('.pvs-list__paged-list-item');
    const data = [];

    for (const item of items) {
        try {
            const text = extractItemText(item);
            if (text) data.push(text);
        } catch (e) { continue; }
    }

    log(`Extracted ${data.length} items`);
    return data;
}

// =====================================================
// DOM EXTRACTORS
// =====================================================

function getFullName() {
    const selectors = [
        'h1.text-heading-xlarge',
        'h1.inline.t-24',
        '.pv-top-card--list .text-heading-xlarge',
        'h1'
    ];
    for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el && el.textContent.trim()) return el.textContent.trim();
    }
    return "Unknown";
}

function getHeadline() {
    const selectors = [
        '.text-body-medium.break-words',
        '.pv-top-card--list .text-body-medium',
        'div.text-body-medium'
    ];
    for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el && el.textContent.trim()) return el.textContent.trim();
    }
    return "N/A";
}

function getLocation() {
    // Pronouns to filter out
    const pronouns = /^(he\/him|she\/her|they\/them|xe\/xem|ze\/hir|he\/they|she\/they)$/i;
    const skipWords = ['followers', 'connections', 'Contact', 'contact info', 'mutual', 'degree'];

    function isValidLocation(text) {
        if (!text || text.length < 3) return false;
        if (pronouns.test(text.trim())) return false;
        for (const skip of skipWords) {
            if (text.includes(skip)) return false;
        }
        return true;
    }

    // Strategy 1: Look in the top card section for location-specific elements
    const topSection = document.querySelector('.mt2.relative') ||
        document.querySelector('.pv-text-details__left-panel') ||
        document.querySelector('.ph5');

    if (topSection) {
        // LinkedIn typically puts location in a specific span within the top section
        const spans = topSection.querySelectorAll('span.text-body-small');
        for (const span of spans) {
            const text = span.textContent.trim();
            if (isValidLocation(text)) return text;
        }
    }

    // Strategy 2: Try known selectors
    const selectors = [
        '.text-body-small.mt2 .text-body-small.inline',
        '.pv-top-card--list-bullet .text-body-small',
    ];
    for (const sel of selectors) {
        const els = document.querySelectorAll(sel);
        for (const el of els) {
            const text = el.textContent.trim();
            if (isValidLocation(text)) return text;
        }
    }

    return "N/A";
}

function getAbout() {
    try {
        const aboutSection = document.querySelector('#about');
        if (!aboutSection) return "N/A";

        const container = aboutSection.closest('section') || aboutSection.parentElement?.parentElement;
        if (!container) return "N/A";

        // Click "see more" if present
        try {
            const seeMore = container.querySelector('.inline-show-more-text__button, button[aria-expanded="false"]');
            if (seeMore && seeMore.offsetParent !== null) seeMore.click();
        } catch (e) { }

        // Extract text from hidden span (LinkedIn pattern)
        const textEl = container.querySelector('.pv-shared-text-with-see-more span[aria-hidden="true"]') ||
            container.querySelector('.inline-show-more-text span[aria-hidden="true"]') ||
            container.querySelector('.pv-shared-text-with-see-more');

        if (textEl) return textEl.textContent.trim();

        // Fallback
        const allSpans = container.querySelectorAll('span');
        for (const span of allSpans) {
            const text = span.textContent.trim();
            if (text.length > 30 && !text.includes('About') && !text.toLowerCase().includes('see more')) {
                return text;
            }
        }
    } catch (e) {
        log("About error: " + e);
    }
    return "N/A";
}

function getProfileUrl() {
    let url = window.location.href.split("?")[0].split("#")[0];
    if (!url.endsWith("/")) url += "/";
    return url;
}

// =====================================================
// DETAIL PAGE ITEM EXTRACTOR
// =====================================================

function extractItemText(item) {
    const parts = [];

    // Title (role name, degree, skill)
    const title = item.querySelector('.t-bold span[aria-hidden="true"]') ||
        item.querySelector('.mr1.t-bold span[aria-hidden="true"]') ||
        item.querySelector('.t-bold');
    if (title) parts.push(title.textContent.trim());

    // Subtitle (company, school name)
    const subtitleCandidates = item.querySelectorAll('.t-14.t-normal:not(.t-black--light) span[aria-hidden="true"]');
    for (const sub of subtitleCandidates) {
        const text = sub.textContent.trim();
        if (text && !parts.includes(text) && text.length > 1) {
            parts.push(text);
            break;
        }
    }

    // Date range / duration / meta info
    const metaCandidates = item.querySelectorAll('.t-14.t-normal.t-black--light span[aria-hidden="true"]');
    for (const meta of metaCandidates) {
        const text = meta.textContent.trim();
        if (text && !parts.includes(text)) parts.push(text);
    }

    // Also check for caption wrapper (used in some layouts)
    if (parts.length <= 1) {
        const caption = item.querySelector('.pvs-entity__caption-wrapper');
        if (caption) {
            const text = caption.textContent.trim();
            if (text && !parts.includes(text)) parts.push(text);
        }
    }

    if (parts.length === 0) {
        // Nuclear fallback: get all text
        const fullText = item.textContent.replace(/\s+/g, ' ').trim();
        if (fullText.length > 5) return fullText.substring(0, 500);
        return null;
    }

    return parts.join(" | ");
}

// =====================================================
// UTILITIES
// =====================================================

function delay(ms) {
    return new Promise(r => setTimeout(r, ms));
}

async function gentleScroll() {
    let lastHeight = document.body.scrollHeight;
    let noChangeCount = 0;

    for (let i = 0; i < 15; i++) {
        const step = 300 + Math.random() * 400;
        window.scrollBy({ top: step, behavior: 'smooth' });
        await delay(700 + Math.random() * 800);

        const newHeight = document.body.scrollHeight;
        if (newHeight === lastHeight) {
            noChangeCount++;
            if (noChangeCount >= 3) break;
        } else {
            noChangeCount = 0;
        }
        lastHeight = newHeight;
    }

    window.scrollTo({ top: 0, behavior: 'smooth' });
    await delay(300);
}
