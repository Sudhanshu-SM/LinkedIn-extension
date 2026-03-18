// Content Script - LinkedIn Profile Scraper
// Injected on linkedin.com/in/* pages
// This script ONLY scrapes the current page's DOM and responds.
// Navigation is handled by the background script.

// Guard against double-injection (manifest auto-injects AND background.js
// uses scripting.executeScript as a fallback — without this guard, const/let
// declarations throw "Identifier already declared" on the second injection).
(function () {
    if (window.__liScraperLoaded) return;
    window.__liScraperLoaded = true;

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
        await delay(2000);

        // Gentle scroll to load lazy items
        await gentleScroll();

        // Scope to <main> only — excludes sidebar/footer "People You May Know"
        // cards which share the same .pvs-list__paged-list-item class
        const mainContent = document.querySelector('main') ||
                            document.querySelector('.scaffold-layout__main') ||
                            document.body;

        // Try primary selector first; fall back to broader selectors if empty
        let items = mainContent.querySelectorAll('.pvs-list__paged-list-item');
        if (items.length === 0) {
            // Wait a bit more — SPA may still be rendering
            await delay(2000);
            items = mainContent.querySelectorAll(
                '.pvs-list__paged-list-item, li.artdeco-list__item, ' +
                'li.pvs-list__item--line-separated, .pvs-list__item--with-top-padding'
            );
        }

        const data = [];

        for (const item of items) {
            try {
                // Skip LinkedIn connection suggestion cards
                // (· 1st / · 2nd / · 3rd / "degree connection")
                if (/·\s*(?:1st|2nd|3rd)|degree connection/i.test(item.textContent)) continue;

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
            '.text-heading-xlarge',
            '.pv-text-details__left-panel h1',
            '.pv-top-card-v2-bg-color h1',
            '.top-card-layout__title',
            'h1'
        ];
        for (const sel of selectors) {
            const els = document.querySelectorAll(sel);
            for (const el of els) {
                const text = el.textContent.trim();
                if (text && text.length > 1) return text;
            }
        }
        return "Unknown";
    }

    function getHeadline() {
        const selectors = [
            '.text-body-medium.break-words',
            '.pv-text-details__left-panel .text-body-medium',
            '[data-generated-suggestion-target^="urn:li:fsu"] ~ .text-body-medium',
            'div.text-body-medium',
            '.top-card-layout__headline'
        ];
        for (const sel of selectors) {
            const els = document.querySelectorAll(sel);
            for (const el of els) {
                const text = el.textContent.trim();
                if (text && text.length > 3) return text;
            }
        }
        return "N/A";
    }

    function getLocation() {
        const pronouns = /^(he\/him|she\/her|they\/them|xe\/xem|ze\/hir|he\/they|she\/they)$/i;
        const skipWords = ['followers', 'connections', 'Contact', 'contact info', 'mutual', 'degree'];

        function isValidLocation(text) {
            if (!text || text.length < 3) return false;
            if (pronouns.test(text.trim())) return false;
            for (const skip of skipWords) {
                if (text.toLowerCase().includes(skip.toLowerCase())) return false;
            }
            return true;
        }

        const selectors = [
            '.mt2 span.text-body-small.inline.t-black--light.break-words',
            '.pv-text-details__left-panel span.text-body-small.inline.t-black--light.break-words',
            '.pv-top-card--list-bullet .text-body-small',
            'span.text-body-small.inline.t-black--light.break-words',
            '.text-body-small.inline.t-black--light.break-words',
            '.top-card__subline-item'
        ];

        for (const sel of selectors) {
            const els = document.querySelectorAll(sel);
            for (const el of els) {
                const text = el.textContent.trim();
                if (isValidLocation(text) && !el.closest('button')) return text;
            }
        }

        return "N/A";
    }

    function getAbout() {
        try {
            let container = null;

            // 1. Try anchor strategy
            const aboutAnchor = document.querySelector('#about') || document.querySelector('#about-section');
            if (aboutAnchor) {
                container = aboutAnchor.closest('section') || aboutAnchor.parentElement?.parentElement;
            }

            // 2. Try heading text strategy
            if (!container) {
                const sections = document.querySelectorAll('section');
                for (const sec of sections) {
                    const heading = sec.querySelector('h2');
                    if (heading && heading.textContent.toLowerCase().includes('about')) {
                        container = sec;
                        break;
                    }
                }
            }

            if (!container) return "N/A";

            // Click "see more" if present
            try {
                const seeMore = container.querySelector('.inline-show-more-text__button, button[aria-expanded="false"]');
                if (seeMore && seeMore.offsetParent !== null) seeMore.click();
            } catch (e) { }

            // Extract text from hidden span (LinkedIn pattern)
            const textEl = container.querySelector('.pv-shared-text-with-see-more span[aria-hidden="true"]') ||
                container.querySelector('.inline-show-more-text span[aria-hidden="true"]') ||
                container.querySelector('.pv-shared-text-with-see-more') ||
                container.querySelector('.display-flex.ph5.pv3 span[aria-hidden="true"]');

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

})(); // end IIFE guard
