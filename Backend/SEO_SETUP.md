# SEO integration setup

The SEO dashboard uses Google Search Console and Semrush APIs. It deliberately shows no sample metrics.

## 1. Run the database migration
Run the complete file `Backend/sql/005_seo_integration.sql` in Supabase SQL Editor.

## 2. Configure Google Search Console
1. Create or select a Google Cloud service account and enable the Search Console API.
2. Create a JSON key for that service account.
3. Add the service account email as an owner or user of each eligible client's verified Search Console property.
4. In Hostinger Node.js environment variables, add `GSC_SERVICE_ACCOUNT_JSON` with the complete service-account JSON as a single-line JSON value. Keep this secret out of GitHub.
5. For a URL-prefix property, configure the exact property URL (including scheme and trailing slash where appropriate) in the client's SEO settings. Domain properties may require the `sc-domain:example.com` property identifier.

## 3. Configure Semrush
Add `SEMRUSH_API_KEY` to Hostinger environment variables. The account must have API access/units enabled. The client SEO settings country code defaults to `in`; use the appropriate two-letter Semrush database code for each target market.

## 4. Enable SEO only for purchased services
In Admin > Clients > SEO Settings, enable SEO only for clients with an SEO service, enter their site URL and database code, and save. Use Sync SEO Now to fetch current snapshots. Clients without SEO enabled do not see the SEO navigation item or SEO data.

## 5. Security and data scope
Credentials are read only from server environment variables. The client-facing API scopes settings and snapshots to the authenticated client's ID; only admins can configure entitlements or start a sync. No real metrics are shown until a provider successfully syncs.
