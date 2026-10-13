// Prints the anon and service_role keys for the current JWT_SECRET.
// Usage: JWT_SECRET=... bun run keys
import { apiKeys } from "./jwt";

const secret = process.env.JWT_SECRET;
if (!secret) {
  console.error("Set JWT_SECRET first");
  process.exit(1);
}
const { anonKey, serviceKey } = await apiKeys(secret);
console.log(`ANON_KEY=${anonKey}\nSERVICE_ROLE_KEY=${serviceKey}`);
