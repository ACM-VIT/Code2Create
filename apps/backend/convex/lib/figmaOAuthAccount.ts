export const figmaOAuthScopes = [
  "current_user:read",
  "file_metadata:read",
  "file_content:read",
  "file_versions:read",
  "file_comments:read",
  "webhooks:write",
] as const;

export function figmaAccountIdentityMatches(tokenUserId: string, accountUserId: string) {
  return tokenUserId === accountUserId;
}
