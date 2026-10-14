# Google Ads integration setup

Google Ads reporting is an agency-managed integration. OAuth refresh tokens are encrypted at rest using the portal's existing `META_TOKEN_ENC_KEY` (recommended) or the existing `JWT_SECRET` fallback from `Backend/services/crypto.js`. Do not commit API credentials or tokens.

## 1. Database migration
Run the complete file `Backend/sql/007_google_ads_integration.sql` in the Supabase SQL Editor.

## 2. Hostinger environment variables
In the existing Hostinger Node.js application, add these variables (do not overwrite the existing `GOOGLE_CLIENT_ID`, which is used for portal sign-in):

- `GOOGLE_ADS_DEVELOPER_TOKEN`: Google Ads API developer token.
- `GOOGLE_ADS_CLIENT_ID`: OAuth Web application Client ID. The route falls back to `GOOGLE_CLIENT_ID` if this is omitted, but a dedicated variable is clearer.
- `GOOGLE_ADS_CLIENT_SECRET`: OAuth Web application client secret.
- `GOOGLE_ADS_MANAGER_CUSTOMER_ID`: manager account's 10-digit customer ID, without hyphens.
- `GOOGLE_ADS_REDIRECT_URI`: exact callback URL below.

Callback URL: `https://darkgray-beaver-562547.hostingersite.com/api/google-ads/oauth/callback`

Add that exact URL under the OAuth client's **Authorized redirect URIs** in Google Cloud Console. Do not add it under JavaScript origins instead of redirect URIs.

## 3. Connect and sync
1. Sign in to the AQ Setu portal as an administrator.
2. Call `POST /api/google-ads/connect` with the portal's existing bearer token; open the returned `authorizationUrl` in the browser and grant Google Ads access.
3. After the callback page confirms connection, return to the portal.
4. Call `POST /api/google-ads/sync-accounts` with the admin bearer token to refresh the accessible account list.
5. Assign account IDs to clients using `PUT /api/google-ads/client-accounts/:clientId` with JSON `{"customerIds":["1234567890"]}`.
6. Read campaign reporting from `GET /api/google-ads/campaigns?startDate=2026-10-01&endDate=2026-10-14` for a client, or include `clientId` as an administrator.

## 4. Security and limits
- OAuth start, account listing, account sync, and client assignment require an admin session.
- Client campaign requests are scoped to the authenticated user's own client ID.
- Each Google Ads customer ID may be assigned to only one portal client.
- Only real Google Ads API results are returned; no placeholder metrics are generated.
- The API version can be changed using `GOOGLE_ADS_API_VERSION` if Google retires the default version.
- If a user previously authorized without a refresh token, revoke the AQ Setu Google Ads authorization in Google Account permissions and reconnect.
