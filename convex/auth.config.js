/**
 * Google as the identity provider, directly.
 *
 * No Clerk. The repo has @clerk/clerk-react installed and commented out, but
 * Clerk is a whole hosted auth service and the requirement is "log in with
 * Google" — Convex can verify a Google ID token itself, against Google's public
 * keys, so the only thing needed is an OAuth client ID.
 *
 * `applicationID` must equal the `aud` claim of the token, which for a Google
 * ID token is the OAuth client ID that requested it. A mismatch fails closed:
 * every authenticated call is rejected rather than silently trusting anyone.
 *
 * GOOGLE_CLIENT_ID is set on the deployment (npx convex env set), not here.
 *
 * When it is absent the provider list is EMPTY rather than half-formed.
 * Convex refuses to push a config that references an unset variable, so
 * declaring the provider unconditionally would mean nobody can deploy anything
 * until OAuth is registered — auth is optional here, and a deploy blocked on it
 * is not.
 */
const clientId = process.env.GOOGLE_CLIENT_ID;

export default {
  providers: clientId
    ? [{ domain: 'https://accounts.google.com', applicationID: clientId }]
    : [],
};
