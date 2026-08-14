/**
 * OpenTable Browser Automation
 *
 * Playwright-based automation for OpenTable reservation operations.
 */
import { chromium } from "patchright";
import { saveCookies, loadCookies, getAuthState } from "./auth.js";
const OPENTABLE_BASE_URL = "https://www.opentable.com";
const DEFAULT_TIMEOUT = 30000;
/**
 * Build a restaurant page URL. Accepts a full URL, a numeric rid
 * (/restaurant/profile/<rid>), or a slug (/r/<slug>).
 */
function restaurantUrl(restaurantId) {
    if (restaurantId.startsWith("http"))
        return restaurantId;
    if (/^\d+$/.test(restaurantId)) {
        return `${OPENTABLE_BASE_URL}/restaurant/profile/${restaurantId}`;
    }
    return `${OPENTABLE_BASE_URL}/r/${restaurantId}`;
}
/**
 * Parse "5:00 PM" or "17:00" to minutes since midnight; null if unparseable
 */
function timeToMinutes(t) {
    const ampm = t.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
    if (ampm) {
        let h = parseInt(ampm[1]) % 12;
        if (/pm/i.test(ampm[3]))
            h += 12;
        return h * 60 + parseInt(ampm[2]);
    }
    const h24 = t.trim().match(/^(\d{1,2}):(\d{2})$/);
    if (h24) {
        return parseInt(h24[1]) * 60 + parseInt(h24[2]);
    }
    return null;
}
// Singleton browser instance
let browser = null;
let context = null;
let page = null;
/**
 * Initialize browser.
 *
 * OpenTable's edge (Akamai) resets connections from headless browsers
 * outright, so this must run a real, headed Chrome. Patchright supplies the
 * stealth patches — do not add a custom user agent or init scripts, they
 * break its cover.
 */
async function initBrowser() {
    if (browser)
        return;
    browser = await chromium.launch({
        headless: false,
        channel: "chrome",
    });
    context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        locale: "en-US",
    });
    // Load saved cookies
    await loadCookies(context);
    page = await context.newPage();
    // Block unnecessary resources for speed
    await page.route("**/*.{png,jpg,jpeg,gif,svg,woff,woff2,mp4,webm}", (route) => route.abort());
}
/**
 * Get the current page, initializing if needed
 */
async function getPage() {
    await initBrowser();
    if (!page)
        throw new Error("Page not initialized");
    return page;
}
/**
 * Get current context
 */
async function getContext() {
    await initBrowser();
    if (!context)
        throw new Error("Context not initialized");
    return context;
}
/**
 * Check if user is logged in to OpenTable
 */
export async function checkAuth() {
    const ctx = await getContext();
    const p = await getPage();
    await p.goto(OPENTABLE_BASE_URL, {
        waitUntil: "domcontentloaded",
        timeout: DEFAULT_TIMEOUT,
    });
    await p.waitForTimeout(2000);
    const authState = await getAuthState(ctx);
    await saveCookies(ctx);
    return authState;
}
export function hasLoginEmail() {
    return !!process.env.OPENTABLE_EMAIL;
}
/**
 * Find the sign-in modal's iframe on the current page
 */
function findAuthFrame(p, urlPart = "/authenticate/") {
    return p.frames().find((f) => f.url().includes(urlPart));
}
/**
 * Start the OpenTable email login flow: open the sign-in modal, choose
 * "Use email instead", and submit OPENTABLE_EMAIL. OpenTable then emails a
 * one-time verification code (there is no password login). The flow stays
 * open on the code-entry step until submitLoginCode() completes it.
 */
export async function requestLoginCode() {
    const email = process.env.OPENTABLE_EMAIL;
    if (!email) {
        return {
            success: false,
            error: "OPENTABLE_EMAIL is not set. Add it to the MCP server config to enable login.",
        };
    }
    const p = await getPage();
    try {
        await p.goto(OPENTABLE_BASE_URL, {
            waitUntil: "domcontentloaded",
            timeout: DEFAULT_TIMEOUT,
        });
        await p.waitForTimeout(2000);
        await p.locator('[data-test="header-sign-in-button"]').first().click();
        let frame = findAuthFrame(p);
        for (let i = 0; i < 20 && !frame; i++) {
            await p.waitForTimeout(500);
            frame = findAuthFrame(p);
        }
        if (!frame) {
            throw new Error("Sign-in dialog did not appear");
        }
        // The modal defaults to phone login; switch to email
        const emailButton = frame.locator('[data-test="continue-with-email-button"]');
        await emailButton.waitFor({ timeout: 10000 });
        await emailButton.click();
        const emailField = frame.locator('input[type="email"], #email').first();
        await emailField.waitFor({ timeout: 10000 });
        await emailField.fill(email);
        await frame.locator('[data-test="continue-button"]').first().click();
        // Wait for the verification-code step
        let verifyFrame = null;
        for (let i = 0; i < 20 && !verifyFrame; i++) {
            await p.waitForTimeout(500);
            verifyFrame = findAuthFrame(p, "verify-medium");
        }
        if (!verifyFrame) {
            const text = (await frame.locator("body").textContent().catch(() => "")) || "";
            const hint = /captcha|not a robot/i.test(text)
                ? " A CAPTCHA appears to be blocking the flow."
                : "";
            throw new Error(`Did not reach the verification-code step.${hint}`);
        }
        return {
            success: true,
            message: `OpenTable sent a verification code to ${email}. Get the code from that inbox and call opentable_submit_code with it to finish logging in.`,
        };
    }
    catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : "Failed to request login code",
        };
    }
}
/**
 * Complete a login started by requestLoginCode() using the emailed code
 */
export async function submitLoginCode(code) {
    const p = await getPage();
    const ctx = await getContext();
    const frame = findAuthFrame(p, "verify-medium");
    if (!frame) {
        return {
            success: false,
            error: "No login in progress. Call opentable_login first to request a verification code.",
        };
    }
    try {
        await frame.locator("#emailVerificationCode").fill(code.trim());
        await frame.locator('button:has-text("Continue")').first().click();
        await p.waitForTimeout(5000);
        const authState = await getAuthState(ctx);
        if (authState.isLoggedIn) {
            await saveCookies(ctx);
            return {
                success: true,
                message: "Logged in to OpenTable. The session is saved and will persist across restarts.",
            };
        }
        const text = (await frame.locator("body").textContent().catch(() => "")) || "";
        if (/invalid|incorrect|expired/i.test(text)) {
            return {
                success: false,
                error: "OpenTable rejected the code (invalid or expired). Call opentable_login to request a new one.",
            };
        }
        return {
            success: false,
            error: "Code was submitted but no logged-in session was created.",
        };
    }
    catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : "Failed to submit login code",
        };
    }
}
/**
 * Ensure there is a logged-in session. If there isn't one and
 * OPENTABLE_EMAIL is configured, kicks off the code flow so the caller can
 * relay the emailed verification code via opentable_submit_code.
 */
export async function ensureLoggedIn() {
    const ctx = await getContext();
    const authState = await getAuthState(ctx);
    if (authState.isLoggedIn) {
        return { loggedIn: true };
    }
    if (!hasLoginEmail()) {
        return {
            loggedIn: false,
            error: "Not logged in to OpenTable. Set OPENTABLE_EMAIL in the MCP server config, then use the opentable_login tool.",
        };
    }
    const request = await requestLoginCode();
    if (request.success) {
        return { loggedIn: false, error: request.message };
    }
    return {
        loggedIn: false,
        error: `Not logged in, and requesting a login code failed: ${request.error}`,
    };
}
/**
 * Search restaurants on OpenTable
 */
export async function searchRestaurants(params) {
    const p = await getPage();
    const ctx = await getContext();
    try {
        const { location, cuisine, partySize = 2, date, time } = params;
        // Build search URL with query parameters
        const searchParams = new URLSearchParams();
        searchParams.set("term", location);
        if (cuisine)
            searchParams.set("cuisine", cuisine);
        searchParams.set("covers", String(partySize));
        if (date)
            searchParams.set("dateTime", `${date}T${time || "19:00"}:00`);
        const searchUrl = `${OPENTABLE_BASE_URL}/s?${searchParams.toString()}`;
        await p.goto(searchUrl, {
            waitUntil: "domcontentloaded",
            timeout: DEFAULT_TIMEOUT,
        });
        await p.waitForTimeout(3000);
        await p
            .locator('[data-test="restaurant-card"]')
            .first()
            .waitFor({ timeout: 10000 })
            .catch(() => { });
        // Results lazy-render; scroll to flush more cards into the DOM
        for (let i = 0; i < 3; i++) {
            await p.mouse.wheel(0, 1500);
            await p.waitForTimeout(1000);
        }
        const restaurants = await p.evaluate((fallbackLocation) => {
            const cards = Array.from(document.querySelectorAll('[data-test="restaurant-card"]')).slice(0, 20);
            return cards
                .map((card, i) => {
                const link = card.querySelector('a[data-test^="restaurant-card-profile-link-"]') || card.querySelector('a[href*="/r/"]');
                const name = link
                    ?.getAttribute("aria-label")
                    ?.replace(/^View /, "")
                    .replace(/ restaurant details$/, "") ||
                    card.querySelector("img")?.getAttribute("alt") ||
                    (card.textContent || "").split("\n").map((l) => l.trim())[0] ||
                    "";
                const rid = card.getAttribute("data-rid") || `restaurant-${i}`;
                // Cuisine / price / neighborhood are unlabeled text; parse them
                // best-effort from the card's text lines
                const lines = (card.textContent || "")
                    .split("\n")
                    .map((l) => l.trim())
                    .filter(Boolean);
                const priceLine = lines.find((l) => /^\$+/.test(l)) || "";
                const ratingMatch = (card.textContent || "").match(/(\d\.\d)\s*\((\d+[\d,]*)\)?/);
                return {
                    id: rid,
                    name,
                    cuisine: "",
                    location: fallbackLocation,
                    rating: ratingMatch ? parseFloat(ratingMatch[1]) : undefined,
                    reviewCount: ratingMatch
                        ? parseInt(ratingMatch[2].replace(/,/g, "")) || undefined
                        : undefined,
                    priceRange: priceLine || undefined,
                    profileUrl: link?.href || undefined,
                };
            })
                .filter((r) => r.name);
        }, location);
        await saveCookies(ctx);
        return { success: true, restaurants };
    }
    catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : "Failed to search restaurants",
        };
    }
}
/**
 * Get detailed information about a specific restaurant
 */
export async function getRestaurantDetails(restaurantId) {
    const p = await getPage();
    const ctx = await getContext();
    try {
        const url = restaurantUrl(restaurantId);
        await p.goto(url, { waitUntil: "domcontentloaded", timeout: DEFAULT_TIMEOUT });
        await p.waitForTimeout(3000);
        const name = (await p
            .locator("h1, [data-test='restaurant-name']")
            .first()
            .textContent()
            .catch(() => "")) || "";
        const description = (await p
            .locator('[data-test="restaurant-description"], p.description, [aria-label*="description"]')
            .first()
            .textContent()
            .catch(() => "")) || "";
        const cuisineText = (await p
            .locator('[data-test="cuisine-link"], a[href*="/cuisine"]')
            .first()
            .textContent()
            .catch(() => "")) || "";
        const address = (await p
            .locator('[data-test="address"], address, [itemprop="address"]')
            .first()
            .textContent()
            .catch(() => "")) || "";
        const phone = (await p
            .locator('[data-test="phone"], a[href^="tel:"], [itemprop="telephone"]')
            .first()
            .textContent()
            .catch(() => "")) || "";
        const ratingText = (await p
            .locator('[data-test="rating-value"], [aria-label*="stars"]')
            .first()
            .textContent()
            .catch(() => "")) || "";
        const reviewCountText = (await p
            .locator('[data-test="review-count"]')
            .first()
            .textContent()
            .catch(() => "")) || "";
        const priceRange = (await p
            .locator('[data-test="price"], [aria-label*="price"]')
            .first()
            .textContent()
            .catch(() => "")) || "";
        const neighborhood = (await p
            .locator('[data-test="neighborhood"], [data-testid="neighborhood"]')
            .first()
            .textContent()
            .catch(() => "")) || "";
        // Extract feature tags
        const featureElements = p.locator('[data-test="feature-tag"], [data-testid="feature"], li.feature');
        const featureCount = await featureElements.count();
        const features = [];
        for (let i = 0; i < Math.min(featureCount, 10); i++) {
            const feat = await featureElements
                .nth(i)
                .textContent()
                .catch(() => "");
            if (feat?.trim())
                features.push(feat.trim());
        }
        await saveCookies(ctx);
        return {
            success: true,
            restaurant: {
                id: restaurantId,
                name: name.trim(),
                cuisine: cuisineText.trim(),
                location: address.trim() || neighborhood.trim(),
                neighborhood: neighborhood.trim() || undefined,
                description: description.trim() || undefined,
                address: address.trim() || undefined,
                phone: phone.trim() || undefined,
                rating: parseFloat(ratingText.replace(/[^0-9.]/g, "")) || undefined,
                reviewCount: parseInt(reviewCountText.replace(/[^0-9]/g, "")) || undefined,
                priceRange: priceRange.trim() || undefined,
                features: features.length > 0 ? features : undefined,
                profileUrl: url,
            },
        };
    }
    catch (error) {
        return {
            success: false,
            error: error instanceof Error
                ? error.message
                : "Failed to get restaurant details",
        };
    }
}
/**
 * Check available reservation times for a restaurant
 */
export async function checkAvailability(params) {
    const p = await getPage();
    const ctx = await getContext();
    try {
        const { restaurantId, date, time, partySize, earliestTime, latestTime } = params;
        const fullUrl = `${restaurantUrl(restaurantId)}?dateTime=${date}T${time}:00&covers=${partySize}`;
        await p.goto(fullUrl, { waitUntil: "domcontentloaded", timeout: DEFAULT_TIMEOUT });
        await p.waitForTimeout(3000);
        const restaurantName = (await p.locator("h1").first().textContent().catch(() => "")) ||
            "Unknown Restaurant";
        // Slots render as list items under the "Select a time" module. The page
        // renders the module more than once (desktop + overlay variants), so
        // scope to the first list and dedupe.
        await p
            .locator('[data-test="time-slots"] [data-test^="time-slot"]')
            .first()
            .waitFor({ timeout: 10000 })
            .catch(() => { });
        const slotTimes = [
            ...new Set(await p
                .locator('[data-test="time-slots"]')
                .first()
                .locator('[data-test^="time-slot"]')
                .evaluateAll((els) => els.map((e) => (e.textContent || "").trim()).filter(Boolean))),
        ];
        const earliest = earliestTime ? timeToMinutes(earliestTime) : null;
        const latest = latestTime ? timeToMinutes(latestTime) : null;
        const slots = slotTimes
            .filter((t) => {
            const m = timeToMinutes(t);
            if (m === null)
                return true;
            if (earliest !== null && m < earliest)
                return false;
            if (latest !== null && m > latest)
                return false;
            return true;
        })
            .map((t) => ({ time: t, partySize, date }));
        await saveCookies(ctx);
        const windowNote = earliest !== null || latest !== null
            ? ` within the requested window (all offered: ${slotTimes.join(", ") || "none"})`
            : "";
        return {
            success: true,
            restaurantName: restaurantName.trim(),
            slots,
            message: `${slots.length} available time slot(s)${windowNote}.`,
        };
    }
    catch (error) {
        return {
            success: false,
            error: error instanceof Error
                ? error.message
                : "Failed to check availability",
        };
    }
}
/**
 * Make a reservation at a restaurant
 */
export async function makeReservation(params) {
    const p = await getPage();
    const ctx = await getContext();
    try {
        const { restaurantId, date, time, partySize, specialRequests, confirm, } = params;
        // Booking requires an authenticated session; previews don't
        if (confirm) {
            const auth = await ensureLoggedIn();
            if (!auth.loggedIn) {
                return { success: false, error: auth.error };
            }
        }
        const fullUrl = `${restaurantUrl(restaurantId)}?dateTime=${date}T${time}:00&covers=${partySize}`;
        await p.goto(fullUrl, { waitUntil: "domcontentloaded", timeout: DEFAULT_TIMEOUT });
        await p.waitForTimeout(3000);
        const restaurantName = (await p.locator("h1").first().textContent().catch(() => "")) ||
            "Unknown Restaurant";
        // If not confirmed, return a preview
        if (!confirm) {
            return {
                success: true,
                requiresConfirmation: true,
                preview: {
                    restaurantName: restaurantName.trim(),
                    date,
                    time,
                    partySize,
                    specialRequests,
                },
            };
        }
        // Find and click the requested time slot; slot labels are 12-hour
        // ("5:00 PM"), the time param is 24-hour ("17:00")
        // The page renders the slot module twice; only one instance is visible
        const targetMinutes = timeToMinutes(time);
        const slotLocator = p.locator('[data-test^="time-slot"]:visible');
        await slotLocator.first().waitFor({ timeout: 10000 }).catch(() => { });
        const slotTexts = await slotLocator.evaluateAll((els) => els.map((e) => (e.textContent || "").trim()));
        const matchIndex = slotTexts.findIndex((t) => timeToMinutes(t) !== null && timeToMinutes(t) === targetMinutes);
        if (matchIndex >= 0) {
            await slotLocator.nth(matchIndex).click();
            await p.waitForTimeout(3000);
        }
        else if (slotTexts.length > 0) {
            return {
                success: false,
                error: `The requested time ${time} is not available. Offered slots: ${slotTexts.join(", ")}. Pick one and try again.`,
            };
        }
        else {
            return {
                success: false,
                error: "No available time slots found for that date and party size.",
            };
        }
        // Fill in special requests if provided
        if (specialRequests) {
            const requestsField = p.locator('textarea[name*="request"], textarea[placeholder*="request"], [data-test="special-requests"]');
            if (await requestsField.isVisible({ timeout: 3000 })) {
                await requestsField.fill(specialRequests);
            }
        }
        // Click the reserve/complete button
        const reserveButton = p
            .locator('button:has-text("Complete reservation"), button:has-text("Reserve"), button[data-test="complete-reservation"], button[type="submit"]')
            .first();
        if (await reserveButton.isVisible({ timeout: 5000 })) {
            await reserveButton.click();
            await p.waitForTimeout(5000);
        }
        // Extract confirmation number from success page
        const confirmationText = (await p
            .locator('[data-test="confirmation-number"], h2:has-text("Confirmed"), [aria-label*="confirmation"]')
            .first()
            .textContent()
            .catch(() => "")) || "";
        const confirmationMatch = confirmationText.match(/[A-Z0-9]{6,}/);
        const confirmationNumber = confirmationMatch?.[0];
        // Get reservation ID from URL
        const urlMatch = p.url().match(/reservation\/([^/?]+)/);
        const reservationId = urlMatch?.[1] || `res-${Date.now()}`;
        await saveCookies(ctx);
        return {
            success: true,
            reservation: {
                id: reservationId,
                restaurantName: restaurantName.trim(),
                date,
                time,
                partySize,
                status: "confirmed",
                confirmationNumber,
                specialRequests,
            },
        };
    }
    catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : "Failed to make reservation",
        };
    }
}
/**
 * Get list of upcoming reservations
 */
export async function getReservations() {
    const p = await getPage();
    const ctx = await getContext();
    try {
        const auth = await ensureLoggedIn();
        if (!auth.loggedIn) {
            return { success: false, error: auth.error };
        }
        await p.goto(`${OPENTABLE_BASE_URL}/user/dining-dashboard`, {
            waitUntil: "domcontentloaded",
            timeout: DEFAULT_TIMEOUT,
        });
        await p.waitForTimeout(3000);
        await p
            .locator('a[href*="/booking/view"]')
            .first()
            .waitFor({ timeout: 10000 })
            .catch(() => { });
        // Reservation cards are links to /booking/view. Cards before the
        // "Past reservations" heading are upcoming.
        const reservations = await p.evaluate(() => {
            const pastHeading = Array.from(document.querySelectorAll("h2")).find((h) => /past reservations/i.test(h.textContent || ""));
            const cards = Array.from(document.querySelectorAll('a[href*="/booking/view"]'));
            return cards
                .filter((card) => !pastHeading ||
                !!(pastHeading.compareDocumentPosition(card) &
                    Node.DOCUMENT_POSITION_PRECEDING))
                .map((card, i) => {
                const name = card.querySelector("span")?.textContent?.trim() || "";
                const status = card
                    .querySelector('[data-test="icSuccess"]')
                    ?.parentElement?.textContent?.trim() || "upcoming";
                // The details span holds the icPerson icon, party size as a text
                // node, the icCalendar icon, then the date/time as a text node
                const detailSpan = card.querySelector('[data-test="icPerson"]')
                    ?.parentElement;
                const textParts = [];
                detailSpan?.childNodes.forEach((n) => {
                    if (n.nodeType === Node.TEXT_NODE && n.textContent?.trim()) {
                        textParts.push(n.textContent.trim());
                    }
                });
                const dateTime = textParts[1] || "";
                const [date, time] = dateTime.split(" at ");
                const url = new URL(card.href);
                const confnumber = url.searchParams.get("confnumber");
                return {
                    id: confnumber || `res-${i}`,
                    restaurantName: name,
                    date: (date || dateTime).trim(),
                    time: (time || "").trim(),
                    partySize: parseInt(textParts[0] || "") || 0,
                    status,
                    confirmationNumber: confnumber || undefined,
                    manageUrl: url.pathname + url.search,
                };
            })
                .filter((r) => r.restaurantName);
        });
        await saveCookies(ctx);
        return { success: true, reservations };
    }
    catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : "Failed to get reservations",
        };
    }
}
/**
 * Cancel a reservation
 */
export async function cancelReservation(params) {
    const p = await getPage();
    const ctx = await getContext();
    try {
        const { reservationId, confirm } = params;
        if (!confirm) {
            return {
                success: true,
                requiresConfirmation: true,
                message: `Please confirm cancellation of reservation ${reservationId}. Set confirm=true to proceed.`,
            };
        }
        const auth = await ensureLoggedIn();
        if (!auth.loggedIn) {
            return { success: false, error: auth.error };
        }
        // reservationId is the manageUrl (/booking/view?...) from
        // opentable_get_reservations
        if (!/booking\/view/.test(reservationId)) {
            return {
                success: false,
                error: "Pass the manageUrl from opentable_get_reservations (a /booking/view?... path) as the reservationId.",
            };
        }
        const url = reservationId.startsWith("http")
            ? reservationId
            : `${OPENTABLE_BASE_URL}${reservationId}`;
        await p.goto(url, { waitUntil: "domcontentloaded", timeout: DEFAULT_TIMEOUT });
        await p.waitForTimeout(3000);
        // Click cancel button
        const cancelButton = p
            .locator('[data-test="cancel-reservation"], button:has-text("Cancel reservation"), button:has-text("Cancel")')
            .first();
        if (!(await cancelButton.isVisible({ timeout: 5000 }))) {
            return {
                success: false,
                error: "Cancel button not found. Reservation may not be cancellable.",
            };
        }
        await cancelButton.click();
        await p.waitForTimeout(2000);
        // Confirm cancellation in dialog if present
        const confirmButton = p
            .locator('button:has-text("Yes, cancel"), button:has-text("Confirm cancel"), [data-test="confirm-cancel"]')
            .first();
        if (await confirmButton.isVisible({ timeout: 3000 })) {
            await confirmButton.click();
            await p.waitForTimeout(3000);
        }
        await saveCookies(ctx);
        return {
            success: true,
            message: `Reservation ${reservationId} has been cancelled successfully.`,
        };
    }
    catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : "Failed to cancel reservation",
        };
    }
}
/**
 * Convert 24h "HH:MM" to the 12h label OpenTable renders ("6:00 PM")
 */
function to12h(t24) {
    const m = timeToMinutes(t24);
    if (m === null)
        return null;
    const h = Math.floor(m / 60);
    const mins = String(m % 60).padStart(2, "0");
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `${h12}:${mins} ${h < 12 ? "AM" : "PM"}`;
}
/**
 * Build the /book/modify URL from a reservation's manageUrl
 */
function modifyUrlFromManageUrl(manageUrl) {
    try {
        const u = new URL(manageUrl.startsWith("http")
            ? manageUrl
            : `${OPENTABLE_BASE_URL}${manageUrl}`);
        const rid = u.searchParams.get("rid");
        const conf = u.searchParams.get("confnumber") ||
            u.searchParams.get("confirmationNumber");
        const token = u.searchParams.get("token") || u.searchParams.get("securityToken");
        if (!rid || !conf || !token)
            return null;
        return `${OPENTABLE_BASE_URL}/book/modify?rid=${rid}&confirmationNumber=${conf}&securityToken=${encodeURIComponent(token)}`;
    }
    catch {
        return null;
    }
}
/**
 * Open the modify flow for an existing reservation, request the desired
 * time/party size, and collect the offered slot times. Modify-flow inventory
 * can differ from the new-reservation flow (the diner's own table is
 * released back into it), so availability must be checked here, not on the
 * restaurant profile page.
 */
async function openModifyFlowAndGetSlots(params) {
    const p = await getPage();
    const { reservationUrl, time, partySize } = params;
    const modifyUrl = modifyUrlFromManageUrl(reservationUrl);
    if (!modifyUrl) {
        throw new Error("reservationUrl must be the manageUrl from opentable_get_reservations (a /booking/view?... path with rid, confnumber, and token).");
    }
    await p.goto(modifyUrl, {
        waitUntil: "domcontentloaded",
        timeout: DEFAULT_TIMEOUT,
    });
    await p.waitForTimeout(3000);
    const bodyText = ((await p.locator("body").textContent().catch(() => "")) || "").replace(/\s+/g, " ");
    const currentReservation = bodyText.match(/Your current reservation\s*(.*?)\s*Modify your reservation/)?.[1] || "";
    await p.locator("#time-picker").waitFor({ timeout: 10000 });
    await p.locator("#time-picker").selectOption(`2000-02-01T${time}:00`);
    if (partySize) {
        await p
            .locator("#party-size-picker")
            .selectOption(String(partySize))
            .catch(() => { });
    }
    await p.waitForTimeout(500);
    await p.locator('[data-test="dtpPicker-submit"]').click();
    await p.waitForTimeout(5000);
    // Offered slots render as plain buttons whose text is a time, repeated
    // per dining area; dedupe and sort
    const slotTexts = await p
        .locator("button:visible")
        .evaluateAll((els) => els
        .map((e) => (e.textContent || "").trim())
        .filter((t) => /^\d{1,2}:\d{2}\s*(AM|PM)$/i.test(t)));
    const slotTimes = [...new Set(slotTexts)].sort((a, b) => (timeToMinutes(a) ?? 0) - (timeToMinutes(b) ?? 0));
    return { page: p, currentReservation, slotTimes };
}
/**
 * Check what times the modify flow offers for an existing reservation
 */
export async function checkModifyAvailability(params) {
    const ctx = await getContext();
    try {
        const auth = await ensureLoggedIn();
        if (!auth.loggedIn) {
            return { success: false, error: auth.error };
        }
        const { currentReservation, slotTimes } = await openModifyFlowAndGetSlots(params);
        const earliest = params.earliestTime
            ? timeToMinutes(params.earliestTime)
            : null;
        const latest = params.latestTime ? timeToMinutes(params.latestTime) : null;
        const slots = slotTimes.filter((t) => {
            const m = timeToMinutes(t);
            if (m === null)
                return false;
            if (earliest !== null && m < earliest)
                return false;
            if (latest !== null && m > latest)
                return false;
            return true;
        });
        await saveCookies(ctx);
        return {
            success: true,
            currentReservation: currentReservation.trim() || undefined,
            slots,
            allOffered: slotTimes,
        };
    }
    catch (error) {
        return {
            success: false,
            error: error instanceof Error
                ? error.message
                : "Failed to check modify availability",
        };
    }
}
/**
 * Modify an existing reservation to a new time (same date) via the modify
 * flow. With confirm=false, previews the offered times without changing
 * anything.
 */
export async function modifyReservation(params) {
    const ctx = await getContext();
    try {
        const auth = await ensureLoggedIn();
        if (!auth.loggedIn) {
            return { success: false, error: auth.error };
        }
        const target12h = to12h(params.newTime);
        if (!target12h) {
            return {
                success: false,
                error: `Could not parse newTime "${params.newTime}" — use HH:MM (24h).`,
            };
        }
        const { page: p, slotTimes } = await openModifyFlowAndGetSlots({
            reservationUrl: params.reservationUrl,
            time: params.newTime,
            partySize: params.partySize,
        });
        if (!slotTimes.includes(target12h)) {
            return {
                success: false,
                offeredTimes: slotTimes,
                error: `${target12h} is not offered in the modify flow right now. Offered: ${slotTimes.join(", ") || "none"}.`,
            };
        }
        if (!params.confirm) {
            return {
                success: true,
                requiresConfirmation: true,
                offeredTimes: slotTimes,
                message: `${target12h} is available. Set confirm=true to move the reservation.`,
            };
        }
        // Take the slot, then complete whatever confirmation step follows
        await p
            .locator("button:visible")
            .filter({ hasText: new RegExp(`^${target12h.replace(/[:\s]/g, "\\$&")}$`) })
            .first()
            .click();
        await p.waitForTimeout(4000);
        const confirmButton = p
            .locator('[data-test*="confirm"], button:has-text("Confirm"), button:has-text("Complete"), button[type="submit"]')
            .locator("visible=true")
            .first();
        if (await confirmButton.isVisible({ timeout: 5000 }).catch(() => false)) {
            await confirmButton.click();
            await p.waitForTimeout(5000);
        }
        const bodyText = ((await p.locator("body").textContent().catch(() => "")) || "").replace(/\s+/g, " ");
        const succeeded = /reservation (confirmed|modified|updated)/i.test(bodyText);
        await saveCookies(ctx);
        return {
            success: succeeded,
            message: succeeded
                ? `Reservation moved to ${target12h}.`
                : `Clicked ${target12h} and submitted, but could not verify the change — check the reservation with opentable_get_reservations. Page said: ${bodyText.slice(0, 300)}`,
        };
    }
    catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : "Failed to modify reservation",
        };
    }
}
/**
 * Cleanup browser resources
 */
export async function cleanup() {
    if (context) {
        await saveCookies(context);
    }
    if (browser) {
        await browser.close();
        browser = null;
        context = null;
        page = null;
    }
}
