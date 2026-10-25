/**
 * Shared MCP access-token lifetime. Keep it explicit instead of inheriting the
 * OAuth provider's library default so FAS sign-in behaviour remains stable.
 */
export const MCP_ACCESS_TOKEN_TTL_SECONDS = 30 * 86_400;
