/**
 * OpenTable Browser Automation
 *
 * Playwright-based automation for OpenTable reservation operations.
 */
import { AuthState } from "./auth.js";
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
    manageUrl?: string;
}
/**
 * Check if user is logged in to OpenTable
 */
export declare function checkAuth(): Promise<AuthState>;
export declare function hasLoginEmail(): boolean;
/**
 * Start the OpenTable email login flow: open the sign-in modal, choose
 * "Use email instead", and submit OPENTABLE_EMAIL. OpenTable then emails a
 * one-time verification code (there is no password login). The flow stays
 * open on the code-entry step until submitLoginCode() completes it.
 */
export declare function requestLoginCode(): Promise<{
    success: boolean;
    message?: string;
    error?: string;
}>;
/**
 * Complete a login started by requestLoginCode() using the emailed code
 */
export declare function submitLoginCode(code: string): Promise<{
    success: boolean;
    message?: string;
    error?: string;
}>;
/**
 * Ensure there is a logged-in session. If there isn't one and
 * OPENTABLE_EMAIL is configured, kicks off the code flow so the caller can
 * relay the emailed verification code via opentable_submit_code.
 */
export declare function ensureLoggedIn(): Promise<{
    loggedIn: boolean;
    error?: string;
}>;
/**
 * Search restaurants on OpenTable
 */
export declare function searchRestaurants(params: {
    location: string;
    cuisine?: string;
    partySize?: number;
    date?: string;
    time?: string;
}): Promise<{
    success: boolean;
    restaurants?: Restaurant[];
    error?: string;
}>;
/**
 * Get detailed information about a specific restaurant
 */
export declare function getRestaurantDetails(restaurantId: string): Promise<{
    success: boolean;
    restaurant?: RestaurantDetails;
    error?: string;
}>;
/**
 * Check available reservation times for a restaurant
 */
export declare function checkAvailability(params: {
    restaurantId: string;
    date: string;
    time: string;
    partySize: number;
    earliestTime?: string;
    latestTime?: string;
}): Promise<{
    success: boolean;
    slots?: AvailabilitySlot[];
    restaurantName?: string;
    message?: string;
    error?: string;
}>;
/**
 * Make a reservation at a restaurant
 */
export declare function makeReservation(params: {
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
}>;
/**
 * Get list of upcoming reservations
 */
export declare function getReservations(): Promise<{
    success: boolean;
    reservations?: Reservation[];
    error?: string;
}>;
/**
 * Cancel a reservation
 */
export declare function cancelReservation(params: {
    reservationId: string;
    confirm: boolean;
}): Promise<{
    success: boolean;
    requiresConfirmation?: boolean;
    message?: string;
    error?: string;
}>;
/**
 * Check what times the modify flow offers for an existing reservation
 */
export declare function checkModifyAvailability(params: {
    reservationUrl: string;
    time: string;
    partySize?: number;
    earliestTime?: string;
    latestTime?: string;
}): Promise<{
    success: boolean;
    currentReservation?: string;
    sameDaySlotsInWindow?: string[];
    allSameDaySlots?: string[];
    otherDaySuggestions?: {
        day: string;
        times: string[];
    }[];
    error?: string;
}>;
/**
 * Modify an existing reservation to a new time (same date) via the modify
 * flow. With confirm=false, previews the offered times without changing
 * anything.
 */
export declare function modifyReservation(params: {
    reservationUrl: string;
    newTime: string;
    partySize?: number;
    confirm: boolean;
}): Promise<{
    success: boolean;
    requiresConfirmation?: boolean;
    message?: string;
    offeredTimes?: string[];
    error?: string;
}>;
/**
 * Cleanup browser resources
 */
export declare function cleanup(): Promise<void>;
