/**
 * OpenTable Browser Automation
 *
 * Playwright-based automation for OpenTable reservation operations.
 */

import { chromium, Browser, BrowserContext, Page } from "patchright";
import { saveCookies, loadCookies, getAuthState, AuthState } from "./auth.js";

const OPENTABLE_BASE_URL = "https://www.opentable.com";
const DEFAULT_TIMEOUT = 30000;

// Singleton browser instance
let browser: Browser | null = null;
let context: BrowserContext | null = null;
let page: Page | null = null;

export interface Restaurant {
  id: string;
  name: string;
  cuisine: string;
  location: string;
  neighborhood?: string;
  rating?: number;
  reviewCount?: number;
  priceRange?: string;
  imageUrl?: string;
  profileUrl?: string;
}

export interface RestaurantDetails extends Restaurant {
  description?: string;
  address?: string;
  phone?: string;
  hours?: string;
  website?: string;
  features?: string[];
}

export interface AvailabilitySlot {
  time: string;
  partySize: number;
  date: string;
  reservationToken?: string;
}

export interface Reservation {
  id: string;
  restaurantName: string;
  date: string;
  time: string;
  partySize: number;
  status: string;
  confirmationNumber?: string;
  specialRequests?: string;
}

/**
 * Initialize browser.
 *
 * OpenTable's edge (Akamai) resets connections from headless browsers
 * outright, so this must run a real, headed Chrome. Patchright supplies the
 * stealth patches — do not add a custom user agent or init scripts, they
 * break its cover.
 */
async function initBrowser(): Promise<void> {
  if (browser) return;

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
  await page.route("**/*.{png,jpg,jpeg,gif,svg,woff,woff2,mp4,webm}", (route) =>
    route.abort()
  );
}

/**
 * Get the current page, initializing if needed
 */
async function getPage(): Promise<Page> {
  await initBrowser();
  if (!page) throw new Error("Page not initialized");
  return page;
}

/**
 * Get current context
 */
async function getContext(): Promise<BrowserContext> {
  await initBrowser();
  if (!context) throw new Error("Context not initialized");
  return context;
}

/**
 * Check if user is logged in to OpenTable
 */
export async function checkAuth(): Promise<AuthState> {
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

export function hasLoginEmail(): boolean {
  return !!process.env.OPENTABLE_EMAIL;
}

/**
 * Find the sign-in modal's iframe on the current page
 */
function findAuthFrame(p: Page, urlPart = "/authenticate/") {
  return p.frames().find((f) => f.url().includes(urlPart));
}

/**
 * Start the OpenTable email login flow: open the sign-in modal, choose
 * "Use email instead", and submit OPENTABLE_EMAIL. OpenTable then emails a
 * one-time verification code (there is no password login). The flow stays
 * open on the code-entry step until submitLoginCode() completes it.
 */
export async function requestLoginCode(): Promise<{
  success: boolean;
  message?: string;
  error?: string;
}> {
  const email = process.env.OPENTABLE_EMAIL;
  if (!email) {
    return {
      success: false,
      error:
        "OPENTABLE_EMAIL is not set. Add it to the MCP server config to enable login.",
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
    const emailButton = frame.locator(
      '[data-test="continue-with-email-button"]'
    );
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
      const text =
        (await frame.locator("body").textContent().catch(() => "")) || "";
      const hint = /captcha|not a robot/i.test(text)
        ? " A CAPTCHA appears to be blocking the flow."
        : "";
      throw new Error(`Did not reach the verification-code step.${hint}`);
    }

    return {
      success: true,
      message: `OpenTable sent a verification code to ${email}. Get the code from that inbox and call opentable_submit_code with it to finish logging in.`,
    };
  } catch (error) {
    return {
      success: false,
      error:
        error instanceof Error ? error.message : "Failed to request login code",
    };
  }
}

/**
 * Complete a login started by requestLoginCode() using the emailed code
 */
export async function submitLoginCode(code: string): Promise<{
  success: boolean;
  message?: string;
  error?: string;
}> {
  const p = await getPage();
  const ctx = await getContext();

  const frame = findAuthFrame(p, "verify-medium");
  if (!frame) {
    return {
      success: false,
      error:
        "No login in progress. Call opentable_login first to request a verification code.",
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
        message:
          "Logged in to OpenTable. The session is saved and will persist across restarts.",
      };
    }

    const text =
      (await frame.locator("body").textContent().catch(() => "")) || "";
    if (/invalid|incorrect|expired/i.test(text)) {
      return {
        success: false,
        error:
          "OpenTable rejected the code (invalid or expired). Call opentable_login to request a new one.",
      };
    }
    return {
      success: false,
      error: "Code was submitted but no logged-in session was created.",
    };
  } catch (error) {
    return {
      success: false,
      error:
        error instanceof Error ? error.message : "Failed to submit login code",
    };
  }
}

/**
 * Ensure there is a logged-in session. If there isn't one and
 * OPENTABLE_EMAIL is configured, kicks off the code flow so the caller can
 * relay the emailed verification code via opentable_submit_code.
 */
export async function ensureLoggedIn(): Promise<{
  loggedIn: boolean;
  error?: string;
}> {
  const ctx = await getContext();
  const authState = await getAuthState(ctx);
  if (authState.isLoggedIn) {
    return { loggedIn: true };
  }

  if (!hasLoginEmail()) {
    return {
      loggedIn: false,
      error:
        "Not logged in to OpenTable. Set OPENTABLE_EMAIL in the MCP server config, then use the opentable_login tool.",
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
export async function searchRestaurants(params: {
  location: string;
  cuisine?: string;
  partySize?: number;
  date?: string;
  time?: string;
}): Promise<{ success: boolean; restaurants?: Restaurant[]; error?: string }> {
  const p = await getPage();
  const ctx = await getContext();

  try {
    const { location, cuisine, partySize = 2, date, time } = params;

    // Build search URL with query parameters
    const searchParams = new URLSearchParams();
    searchParams.set("term", location);
    if (cuisine) searchParams.set("cuisine", cuisine);
    searchParams.set("covers", String(partySize));
    if (date) searchParams.set("dateTime", `${date}T${time || "19:00"}:00`);

    const searchUrl = `${OPENTABLE_BASE_URL}/s?${searchParams.toString()}`;
    await p.goto(searchUrl, {
      waitUntil: "domcontentloaded",
      timeout: DEFAULT_TIMEOUT,
    });
    await p.waitForTimeout(3000);

    // Wait for restaurant results
    await p
      .locator(
        '[data-test="search-result"], [data-testid="restaurant-card"], article[data-restaurant-id]'
      )
      .first()
      .waitFor({ timeout: 10000 })
      .catch(() => {});

    const restaurants: Restaurant[] = [];

    // Extract restaurant cards
    const cards = p.locator(
      '[data-test="search-result"], [data-testid="restaurant-card"], [data-restaurant-id]'
    );
    const cardCount = await cards.count();

    for (let i = 0; i < Math.min(cardCount, 20); i++) {
      const card = cards.nth(i);

      try {
        const name =
          (await card
            .locator('h2, h3, [data-test="restaurant-name"], a[data-ot-track-component="Restaurant Name"]')
            .first()
            .textContent()
            .catch(() => "")) || "";

        const cuisineText =
          (await card
            .locator('[data-test="cuisine"], span:has-text("Cuisine")')
            .first()
            .textContent()
            .catch(() => "")) || "";

        const neighborhoodText =
          (await card
            .locator('[data-test="neighborhood"], [data-testid="neighborhood"]')
            .first()
            .textContent()
            .catch(() => "")) || "";

        const ratingText =
          (await card
            .locator('[data-test="rating"], [aria-label*="rating"]')
            .first()
            .textContent()
            .catch(() => "")) || "";

        const reviewCountText =
          (await card
            .locator('[data-test="review-count"], span:has-text("reviews")')
            .first()
            .textContent()
            .catch(() => "")) || "";

        const priceRange =
          (await card
            .locator('[data-test="price"], span:has-text("$")')
            .first()
            .textContent()
            .catch(() => "")) || "";

        // Get profile link and extract restaurant ID
        const profileLink =
          (await card
            .locator("a[href*='/restaurant/']")
            .first()
            .getAttribute("href")
            .catch(() => "")) || "";
        const ridMatch = profileLink.match(/\/restaurant\/([^/?]+)/);
        const restaurantId = ridMatch?.[1] || `restaurant-${i}`;

        const restaurantIdAttr =
          (await card.getAttribute("data-restaurant-id").catch(() => "")) || restaurantId;

        if (name.trim()) {
          restaurants.push({
            id: restaurantIdAttr || restaurantId,
            name: name.trim(),
            cuisine: cuisineText.trim(),
            location: neighborhoodText.trim() || location,
            neighborhood: neighborhoodText.trim(),
            rating: parseFloat(ratingText.replace(/[^0-9.]/g, "")) || undefined,
            reviewCount:
              parseInt(reviewCountText.replace(/[^0-9]/g, "")) || undefined,
            priceRange: priceRange.trim() || undefined,
            profileUrl: profileLink
              ? `${OPENTABLE_BASE_URL}${profileLink}`
              : undefined,
          });
        }
      } catch {
        // Skip problematic cards
      }
    }

    await saveCookies(ctx);

    return { success: true, restaurants };
  } catch (error) {
    return {
      success: false,
      error:
        error instanceof Error ? error.message : "Failed to search restaurants",
    };
  }
}

/**
 * Get detailed information about a specific restaurant
 */
export async function getRestaurantDetails(
  restaurantId: string
): Promise<{ success: boolean; restaurant?: RestaurantDetails; error?: string }> {
  const p = await getPage();
  const ctx = await getContext();

  try {
    const url = restaurantId.startsWith("http")
      ? restaurantId
      : `${OPENTABLE_BASE_URL}/restaurant/${restaurantId}`;

    await p.goto(url, { waitUntil: "domcontentloaded", timeout: DEFAULT_TIMEOUT });
    await p.waitForTimeout(3000);

    const name =
      (await p
        .locator("h1, [data-test='restaurant-name']")
        .first()
        .textContent()
        .catch(() => "")) || "";

    const description =
      (await p
        .locator('[data-test="restaurant-description"], p.description, [aria-label*="description"]')
        .first()
        .textContent()
        .catch(() => "")) || "";

    const cuisineText =
      (await p
        .locator('[data-test="cuisine-link"], a[href*="/cuisine"]')
        .first()
        .textContent()
        .catch(() => "")) || "";

    const address =
      (await p
        .locator('[data-test="address"], address, [itemprop="address"]')
        .first()
        .textContent()
        .catch(() => "")) || "";

    const phone =
      (await p
        .locator('[data-test="phone"], a[href^="tel:"], [itemprop="telephone"]')
        .first()
        .textContent()
        .catch(() => "")) || "";

    const ratingText =
      (await p
        .locator('[data-test="rating-value"], [aria-label*="stars"]')
        .first()
        .textContent()
        .catch(() => "")) || "";

    const reviewCountText =
      (await p
        .locator('[data-test="review-count"]')
        .first()
        .textContent()
        .catch(() => "")) || "";

    const priceRange =
      (await p
        .locator('[data-test="price"], [aria-label*="price"]')
        .first()
        .textContent()
        .catch(() => "")) || "";

    const neighborhood =
      (await p
        .locator('[data-test="neighborhood"], [data-testid="neighborhood"]')
        .first()
        .textContent()
        .catch(() => "")) || "";

    // Extract feature tags
    const featureElements = p.locator(
      '[data-test="feature-tag"], [data-testid="feature"], li.feature'
    );
    const featureCount = await featureElements.count();
    const features: string[] = [];
    for (let i = 0; i < Math.min(featureCount, 10); i++) {
      const feat = await featureElements
        .nth(i)
        .textContent()
        .catch(() => "");
      if (feat?.trim()) features.push(feat.trim());
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
        reviewCount:
          parseInt(reviewCountText.replace(/[^0-9]/g, "")) || undefined,
        priceRange: priceRange.trim() || undefined,
        features: features.length > 0 ? features : undefined,
        profileUrl: url,
      },
    };
  } catch (error) {
    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : "Failed to get restaurant details",
    };
  }
}

/**
 * Check available reservation times for a restaurant
 */
export async function checkAvailability(params: {
  restaurantId: string;
  date: string;
  time: string;
  partySize: number;
}): Promise<{
  success: boolean;
  slots?: AvailabilitySlot[];
  restaurantName?: string;
  error?: string;
}> {
  const p = await getPage();
  const ctx = await getContext();

  try {
    const { restaurantId, date, time, partySize } = params;

    // Build restaurant URL with availability params
    const url = restaurantId.startsWith("http")
      ? restaurantId
      : `${OPENTABLE_BASE_URL}/restaurant/${restaurantId}`;

    const fullUrl = `${url}?dateTime=${date}T${time}:00&covers=${partySize}`;
    await p.goto(fullUrl, { waitUntil: "domcontentloaded", timeout: DEFAULT_TIMEOUT });
    await p.waitForTimeout(3000);

    const restaurantName =
      (await p
        .locator("h1, [data-test='restaurant-name']")
        .first()
        .textContent()
        .catch(() => "")) || "Unknown Restaurant";

    // Wait for availability slots to load
    await p
      .locator(
        '[data-test="availability-time"], [data-testid="time-slot"], button[data-datetime]'
      )
      .first()
      .waitFor({ timeout: 10000 })
      .catch(() => {});

    const slots: AvailabilitySlot[] = [];

    // Extract available time slots
    const timeSlots = p.locator(
      '[data-test="availability-time"], [data-testid="time-slot"], button[data-datetime], [aria-label*="Reserve"]'
    );
    const slotCount = await timeSlots.count();

    for (let i = 0; i < Math.min(slotCount, 30); i++) {
      const slot = timeSlots.nth(i);

      try {
        const timeText =
          (await slot.textContent().catch(() => "")) || "";
        const datetime =
          (await slot.getAttribute("data-datetime").catch(() => "")) || "";
        const token =
          (await slot.getAttribute("data-reservation-token").catch(() => "")) ||
          undefined;

        if (timeText.trim()) {
          slots.push({
            time: timeText.trim(),
            partySize,
            date,
            reservationToken: token,
          });
        }
      } catch {
        // Skip problematic slots
      }
    }

    await saveCookies(ctx);

    return {
      success: true,
      restaurantName: restaurantName.trim(),
      slots,
    };
  } catch (error) {
    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : "Failed to check availability",
    };
  }
}

/**
 * Make a reservation at a restaurant
 */
export async function makeReservation(params: {
  restaurantId: string;
  date: string;
  time: string;
  partySize: number;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  specialRequests?: string;
  confirm: boolean;
}): Promise<{
  success: boolean;
  reservation?: Partial<Reservation>;
  requiresConfirmation?: boolean;
  preview?: {
    restaurantName: string;
    date: string;
    time: string;
    partySize: number;
    specialRequests?: string;
  };
  error?: string;
}> {
  const p = await getPage();
  const ctx = await getContext();

  try {
    const {
      restaurantId,
      date,
      time,
      partySize,
      specialRequests,
      confirm,
    } = params;

    // Booking requires an authenticated session; previews don't
    if (confirm) {
      const auth = await ensureLoggedIn();
      if (!auth.loggedIn) {
        return { success: false, error: auth.error };
      }
    }

    const url = restaurantId.startsWith("http")
      ? restaurantId
      : `${OPENTABLE_BASE_URL}/restaurant/${restaurantId}`;

    const fullUrl = `${url}?dateTime=${date}T${time}:00&covers=${partySize}`;
    await p.goto(fullUrl, { waitUntil: "domcontentloaded", timeout: DEFAULT_TIMEOUT });
    await p.waitForTimeout(3000);

    const restaurantName =
      (await p
        .locator("h1, [data-test='restaurant-name']")
        .first()
        .textContent()
        .catch(() => "")) || "Unknown Restaurant";

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

    // Find and click the time slot
    const timeSlot = p
      .locator(
        `[data-test="availability-time"]:has-text("${time}"), button[data-datetime*="${time}"], [aria-label*="${time}"]`
      )
      .first();

    if (await timeSlot.isVisible({ timeout: 5000 })) {
      await timeSlot.click();
      await p.waitForTimeout(2000);
    } else {
      // Try clicking the first available slot
      const firstSlot = p
        .locator(
          '[data-test="availability-time"], [data-testid="time-slot"], button[data-datetime]'
        )
        .first();
      if (await firstSlot.isVisible({ timeout: 5000 })) {
        await firstSlot.click();
        await p.waitForTimeout(2000);
      }
    }

    // Fill in special requests if provided
    if (specialRequests) {
      const requestsField = p.locator(
        'textarea[name*="request"], textarea[placeholder*="request"], [data-test="special-requests"]'
      );
      if (await requestsField.isVisible({ timeout: 3000 })) {
        await requestsField.fill(specialRequests);
      }
    }

    // Click the reserve/complete button
    const reserveButton = p
      .locator(
        'button:has-text("Complete reservation"), button:has-text("Reserve"), button[data-test="complete-reservation"], button[type="submit"]'
      )
      .first();

    if (await reserveButton.isVisible({ timeout: 5000 })) {
      await reserveButton.click();
      await p.waitForTimeout(5000);
    }

    // Extract confirmation number from success page
    const confirmationText =
      (await p
        .locator(
          '[data-test="confirmation-number"], h2:has-text("Confirmed"), [aria-label*="confirmation"]'
        )
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
  } catch (error) {
    return {
      success: false,
      error:
        error instanceof Error ? error.message : "Failed to make reservation",
    };
  }
}

/**
 * Get list of upcoming reservations
 */
export async function getReservations(): Promise<{
  success: boolean;
  reservations?: Reservation[];
  error?: string;
}> {
  const p = await getPage();
  const ctx = await getContext();

  try {
    const auth = await ensureLoggedIn();
    if (!auth.loggedIn) {
      return { success: false, error: auth.error };
    }

    await p.goto(`${OPENTABLE_BASE_URL}/account/reservations`, {
      waitUntil: "domcontentloaded",
      timeout: DEFAULT_TIMEOUT,
    });
    await p.waitForTimeout(3000);

    // Wait for reservations to load
    await p
      .locator(
        '[data-test="reservation-card"], [data-testid="reservation"], article[data-reservation-id]'
      )
      .first()
      .waitFor({ timeout: 10000 })
      .catch(() => {});

    const reservations: Reservation[] = [];

    const cards = p.locator(
      '[data-test="reservation-card"], [data-testid="reservation"], article[data-reservation-id]'
    );
    const cardCount = await cards.count();

    for (let i = 0; i < Math.min(cardCount, 20); i++) {
      const card = cards.nth(i);

      try {
        const restaurantName =
          (await card
            .locator(
              'h2, h3, [data-test="restaurant-name"], a[data-ot-track-component="Restaurant Name"]'
            )
            .first()
            .textContent()
            .catch(() => "")) || "";

        const dateText =
          (await card
            .locator('[data-test="reservation-date"], time, [datetime]')
            .first()
            .textContent()
            .catch(() => "")) || "";

        const timeText =
          (await card
            .locator('[data-test="reservation-time"], [aria-label*="time"]')
            .first()
            .textContent()
            .catch(() => "")) || "";

        const partySizeText =
          (await card
            .locator('[data-test="party-size"], [aria-label*="guest"]')
            .first()
            .textContent()
            .catch(() => "")) || "";

        const statusText =
          (await card
            .locator('[data-test="reservation-status"], [aria-label*="status"]')
            .first()
            .textContent()
            .catch(() => "upcoming")) || "upcoming";

        const confirmationText =
          (await card
            .locator(
              '[data-test="confirmation-number"], span:has-text("Confirmation")'
            )
            .first()
            .textContent()
            .catch(() => "")) || "";

        const reservationId =
          (await card
            .getAttribute("data-reservation-id")
            .catch(() => "")) || `res-${i}`;

        if (restaurantName.trim()) {
          reservations.push({
            id: reservationId,
            restaurantName: restaurantName.trim(),
            date: dateText.trim(),
            time: timeText.trim(),
            partySize: parseInt(partySizeText.replace(/[^0-9]/g, "")) || 2,
            status: statusText.trim(),
            confirmationNumber: confirmationText.trim() || undefined,
          });
        }
      } catch {
        // Skip problematic cards
      }
    }

    await saveCookies(ctx);

    return { success: true, reservations };
  } catch (error) {
    return {
      success: false,
      error:
        error instanceof Error ? error.message : "Failed to get reservations",
    };
  }
}

/**
 * Cancel a reservation
 */
export async function cancelReservation(params: {
  reservationId: string;
  confirm: boolean;
}): Promise<{
  success: boolean;
  requiresConfirmation?: boolean;
  message?: string;
  error?: string;
}> {
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

    // Navigate to the reservation page
    const url = `${OPENTABLE_BASE_URL}/account/reservations/${reservationId}`;
    await p.goto(url, { waitUntil: "domcontentloaded", timeout: DEFAULT_TIMEOUT });
    await p.waitForTimeout(2000);

    // Click cancel button
    const cancelButton = p
      .locator(
        'button:has-text("Cancel reservation"), button:has-text("Cancel"), [data-test="cancel-reservation"]'
      )
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
      .locator(
        'button:has-text("Yes, cancel"), button:has-text("Confirm cancel"), [data-test="confirm-cancel"]'
      )
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
  } catch (error) {
    return {
      success: false,
      error:
        error instanceof Error ? error.message : "Failed to cancel reservation",
    };
  }
}

/**
 * Cleanup browser resources
 */
export async function cleanup(): Promise<void> {
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
