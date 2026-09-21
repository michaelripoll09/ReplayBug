/**
 * Better Auth Drizzle schema mapping.
 * Re-exports the official adapter tables from `@replaybug/db` under the
 * names Better Auth expects. No parallel users table exists: every FK in
 * the domain references `user.id` directly.
 */
export {
  users as user,
  sessions as session,
  accounts as account,
  verifications as verification,
} from "@replaybug/db";
