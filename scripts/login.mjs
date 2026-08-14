#!/usr/bin/env node
// Interactive first-time login, e.g. when provisioning a new machine:
//   OPENTABLE_EMAIL=you@example.com node scripts/login.mjs
// Requests a verification code, prompts for it, and saves the session.
import readline from "node:readline/promises";
import { requestLoginCode, submitLoginCode, cleanup } from "../dist/browser.js";

const request = await requestLoginCode();
console.log(JSON.stringify(request, null, 2));
if (!request.success) {
  await cleanup();
  process.exit(1);
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const code = await rl.question("Enter the verification code: ");
rl.close();

const result = await submitLoginCode(code);
console.log(JSON.stringify(result, null, 2));
await cleanup();
process.exit(result.success ? 0 : 1);
