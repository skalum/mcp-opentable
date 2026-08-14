#!/usr/bin/env node
/**
 * Strider Labs OpenTable MCP Server
 *
 * MCP server that gives AI agents the ability to search restaurants,
 * check availability, make reservations, and manage bookings on OpenTable.
 * https://striderlabs.ai
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, } from "@modelcontextprotocol/sdk/types.js";
import { checkAuth, hasLoginEmail, requestLoginCode, submitLoginCode, checkModifyAvailability, modifyReservation, searchRestaurants, getRestaurantDetails, checkAvailability, makeReservation, getReservations, cancelReservation, cleanup, } from "./browser.js";
import { hasStoredCookies, clearCookies, getCookiesPath } from "./auth.js";
// Initialize server
const server = new Server({
    name: "io.github.markswendsen-code/opentable",
    version: "0.1.0",
}, {
    capabilities: {
        tools: {},
    },
});
// Tool definitions
server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
        tools: [
            {
                name: "opentable_status",
                description: "Check if the user is logged in to OpenTable. Returns login status and instructions if not authenticated. Call this before any other OpenTable operations.",
                inputSchema: {
                    type: "object",
                    properties: {},
                },
            },
            {
                name: "opentable_login",
                description: "Start the OpenTable login flow: has OpenTable email a one-time verification code to the configured OPENTABLE_EMAIL address (OpenTable has no password login). Ask the user for the code from their inbox, then call opentable_submit_code to finish. Use this when opentable_status returns not logged in.",
                inputSchema: {
                    type: "object",
                    properties: {},
                },
            },
            {
                name: "opentable_submit_code",
                description: "Finish an OpenTable login started with opentable_login by submitting the verification code that was emailed to the user.",
                inputSchema: {
                    type: "object",
                    properties: {
                        code: {
                            type: "string",
                            description: "The verification code from the email OpenTable sent",
                        },
                    },
                    required: ["code"],
                },
            },
            {
                name: "opentable_logout",
                description: "Clear the stored OpenTable session cookies. Use this to log out or reset the authentication state.",
                inputSchema: {
                    type: "object",
                    properties: {},
                },
            },
            {
                name: "opentable_search",
                description: "Search for restaurants on OpenTable by location, cuisine, party size, date, and time.",
                inputSchema: {
                    type: "object",
                    properties: {
                        location: {
                            type: "string",
                            description: "Location to search (city, neighborhood, or address, e.g. 'San Francisco', 'Manhattan')",
                        },
                        cuisine: {
                            type: "string",
                            description: "Filter by cuisine type (e.g. 'italian', 'sushi', 'american', 'french')",
                        },
                        partySize: {
                            type: "number",
                            description: "Number of guests (default: 2)",
                        },
                        date: {
                            type: "string",
                            description: "Reservation date in YYYY-MM-DD format",
                        },
                        time: {
                            type: "string",
                            description: "Preferred time in HH:MM format (e.g. '19:00')",
                        },
                    },
                    required: ["location"],
                },
            },
            {
                name: "opentable_get_restaurant",
                description: "Get detailed information about a specific restaurant including description, address, hours, and features.",
                inputSchema: {
                    type: "object",
                    properties: {
                        restaurantId: {
                            type: "string",
                            description: "The restaurant ID or profile URL (from search results)",
                        },
                    },
                    required: ["restaurantId"],
                },
            },
            {
                name: "opentable_check_availability",
                description: "Check available reservation time slots for a restaurant on a specific date and party size. Optionally filter to a time window (e.g. only slots between 17:00 and 19:30) — useful when watching for a specific time to open up.",
                inputSchema: {
                    type: "object",
                    properties: {
                        restaurantId: {
                            type: "string",
                            description: "The restaurant ID (numeric rid), slug, or profile URL (from search results)",
                        },
                        date: {
                            type: "string",
                            description: "Date to check in YYYY-MM-DD format",
                        },
                        time: {
                            type: "string",
                            description: "Preferred time in HH:MM format (e.g. '19:00'). Availability is shown for nearby times.",
                        },
                        partySize: {
                            type: "number",
                            description: "Number of guests",
                        },
                        earliestTime: {
                            type: "string",
                            description: "Optional: only return slots at or after this time (HH:MM)",
                        },
                        latestTime: {
                            type: "string",
                            description: "Optional: only return slots at or before this time (HH:MM)",
                        },
                    },
                    required: ["restaurantId", "date", "time", "partySize"],
                },
            },
            {
                name: "opentable_make_reservation",
                description: "Book a restaurant reservation on OpenTable. Set confirm=false to preview before booking, confirm=true to actually book. Requires the user to be logged in.",
                inputSchema: {
                    type: "object",
                    properties: {
                        restaurantId: {
                            type: "string",
                            description: "The restaurant ID or profile URL",
                        },
                        date: {
                            type: "string",
                            description: "Reservation date in YYYY-MM-DD format",
                        },
                        time: {
                            type: "string",
                            description: "Reservation time in HH:MM format (e.g. '19:00')",
                        },
                        partySize: {
                            type: "number",
                            description: "Number of guests",
                        },
                        specialRequests: {
                            type: "string",
                            description: "Any special requests or dietary requirements (optional)",
                        },
                        confirm: {
                            type: "boolean",
                            description: "Set to true to actually book the reservation, false to just preview details",
                        },
                    },
                    required: ["restaurantId", "date", "time", "partySize", "confirm"],
                },
            },
            {
                name: "opentable_check_modify_availability",
                description: "Check what alternative times are available for an EXISTING reservation via OpenTable's modify flow. Use this — not opentable_check_availability — when looking to move an existing reservation. Returns sameDaySlotsInWindow / allSameDaySlots for the reservation's own date, plus otherDaySuggestions (times OpenTable offers on nearby OTHER days — do not confuse these with same-day availability). Optionally filter to a time window.",
                inputSchema: {
                    type: "object",
                    properties: {
                        reservationUrl: {
                            type: "string",
                            description: "The reservation's manageUrl from opentable_get_reservations",
                        },
                        time: {
                            type: "string",
                            description: "Desired time in HH:MM (24h) to anchor the search (e.g. '18:00')",
                        },
                        partySize: {
                            type: "number",
                            description: "Optional: change party size (defaults to current)",
                        },
                        earliestTime: {
                            type: "string",
                            description: "Optional: only return slots at or after this time (HH:MM)",
                        },
                        latestTime: {
                            type: "string",
                            description: "Optional: only return slots at or before this time (HH:MM)",
                        },
                    },
                    required: ["reservationUrl", "time"],
                },
            },
            {
                name: "opentable_modify_reservation",
                description: "Move an existing reservation to a new time on the same date via the modify flow. Set confirm=false to preview whether the time is offered, confirm=true to actually move it.",
                inputSchema: {
                    type: "object",
                    properties: {
                        reservationUrl: {
                            type: "string",
                            description: "The reservation's manageUrl from opentable_get_reservations",
                        },
                        newTime: {
                            type: "string",
                            description: "The new time in HH:MM (24h), e.g. '18:00'",
                        },
                        partySize: {
                            type: "number",
                            description: "Optional: change party size (defaults to current)",
                        },
                        confirm: {
                            type: "boolean",
                            description: "true to actually move the reservation, false to preview",
                        },
                    },
                    required: ["reservationUrl", "newTime", "confirm"],
                },
            },
            {
                name: "opentable_get_reservations",
                description: "List all upcoming reservations for the logged-in user, including each reservation's manageUrl (needed for cancellation). Requires authentication.",
                inputSchema: {
                    type: "object",
                    properties: {},
                },
            },
            {
                name: "opentable_cancel_reservation",
                description: "Cancel an existing reservation. Set confirm=false to preview, confirm=true to actually cancel. This action cannot be undone.",
                inputSchema: {
                    type: "object",
                    properties: {
                        reservationId: {
                            type: "string",
                            description: "The reservation's manageUrl from opentable_get_reservations (a /booking/view?... path)",
                        },
                        confirm: {
                            type: "boolean",
                            description: "Set to true to actually cancel, false to preview the cancellation",
                        },
                    },
                    required: ["reservationId", "confirm"],
                },
            },
        ],
    };
});
// Tool execution
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
        switch (name) {
            case "opentable_status": {
                const hasCookies = hasStoredCookies();
                const authState = hasCookies
                    ? await checkAuth()
                    : { isLoggedIn: false };
                if (authState.isLoggedIn) {
                    return {
                        content: [
                            {
                                type: "text",
                                text: JSON.stringify({
                                    success: true,
                                    isLoggedIn: true,
                                    message: "Logged in to OpenTable.",
                                }),
                            },
                        ],
                    };
                }
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify({
                                success: true,
                                isLoggedIn: false,
                                message: hasCookies
                                    ? "Session expired or invalid."
                                    : "Not logged in to OpenTable.",
                                instructions: hasLoginEmail()
                                    ? "Call opentable_login to have a verification code emailed, then opentable_submit_code with the code from the inbox."
                                    : "Set OPENTABLE_EMAIL in the MCP server config, then call opentable_login.",
                                cookiesPath: getCookiesPath(),
                            }),
                        },
                    ],
                };
            }
            case "opentable_login": {
                const result = await requestLoginCode();
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify(result),
                        },
                    ],
                    isError: !result.success,
                };
            }
            case "opentable_submit_code": {
                const { code } = args;
                const result = await submitLoginCode(code);
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify(result),
                        },
                    ],
                    isError: !result.success,
                };
            }
            case "opentable_logout": {
                clearCookies();
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify({
                                success: true,
                                message: "OpenTable session cleared. You will need to log in again.",
                            }),
                        },
                    ],
                };
            }
            case "opentable_search": {
                const { location, cuisine, partySize, date, time } = args;
                const result = await searchRestaurants({
                    location,
                    cuisine,
                    partySize,
                    date,
                    time,
                });
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify(result),
                        },
                    ],
                    isError: !result.success,
                };
            }
            case "opentable_get_restaurant": {
                const { restaurantId } = args;
                const result = await getRestaurantDetails(restaurantId);
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify(result),
                        },
                    ],
                    isError: !result.success,
                };
            }
            case "opentable_check_availability": {
                const { restaurantId, date, time, partySize, earliestTime, latestTime } = args;
                const result = await checkAvailability({
                    restaurantId,
                    date,
                    time,
                    partySize,
                    earliestTime,
                    latestTime,
                });
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify(result),
                        },
                    ],
                    isError: !result.success,
                };
            }
            case "opentable_make_reservation": {
                const { restaurantId, date, time, partySize, specialRequests, confirm, } = args;
                const result = await makeReservation({
                    restaurantId,
                    date,
                    time,
                    partySize,
                    specialRequests,
                    confirm,
                });
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify(result),
                        },
                    ],
                    isError: !result.success,
                };
            }
            case "opentable_check_modify_availability": {
                const { reservationUrl, time, partySize, earliestTime, latestTime } = args;
                const result = await checkModifyAvailability({
                    reservationUrl,
                    time,
                    partySize,
                    earliestTime,
                    latestTime,
                });
                return {
                    content: [{ type: "text", text: JSON.stringify(result) }],
                    isError: !result.success,
                };
            }
            case "opentable_modify_reservation": {
                const { reservationUrl, newTime, partySize, confirm } = args;
                const result = await modifyReservation({
                    reservationUrl,
                    newTime,
                    partySize,
                    confirm,
                });
                return {
                    content: [{ type: "text", text: JSON.stringify(result) }],
                    isError: !result.success,
                };
            }
            case "opentable_get_reservations": {
                const result = await getReservations();
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify(result),
                        },
                    ],
                    isError: !result.success,
                };
            }
            case "opentable_cancel_reservation": {
                const { reservationId, confirm } = args;
                const result = await cancelReservation({ reservationId, confirm });
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify(result),
                        },
                    ],
                    isError: !result.success,
                };
            }
            default:
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify({
                                success: false,
                                error: `Unknown tool: ${name}`,
                            }),
                        },
                    ],
                    isError: true,
                };
        }
    }
    catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({
                        success: false,
                        error: errorMessage,
                    }),
                },
            ],
            isError: true,
        };
    }
});
// Cleanup on exit
process.on("SIGINT", async () => {
    await cleanup();
    process.exit(0);
});
process.on("SIGTERM", async () => {
    await cleanup();
    process.exit(0);
});
// Start server
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Strider OpenTable MCP server running");
}
main().catch(console.error);
