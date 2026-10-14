# SEO integration setup

The SEO dashboard uses Google Search Console only. Backlink reporting will be handled separately; no Semrush API key is required.

## 1. Run the database migration
Run the complete file `Backend/sql/005_seo_integration.sql` in Supabase SQL Editor.

## 2. Configure Google Search Console
1. Enable the Google Search Console API in Google Cloud.
2. Create a service account and download its JSON key.
3. Add the service account email as a user with restricted/read-only access to each eligible client's verified Search Console property.
4. In Hostinger Node.js environment variables, add `GSC_SERVICE_ACCOUNT_JSON` with the complete service-account JSON as a single-line JSON value. Keep this secret out of GitHub.
5. Configure the exact property URL in Admin > Clients > SEO Settings. For URL-prefix properties use the matching property URL. Domain properties may require a `sc-domain:example.com` property identifier.

## 3. Enable SEO only for purchased services
In Admin > Clients > SEO Settings, enable SEO only for clients who purchased the service and enter their Search Console property URL. Save settings, then choose Sync SEO Now. Client users without SEO enabled do not see the SEO navigation item.

## 4. Data and security
The portal displays only Search Console data successfully returned by the API; it does not use sample SEO metrics. Credentials are read from server environment variables. Client-facing endpoints scope settings and snapshots to the authenticated client's ID, and only admins can configure entitlements or run syncs.

## 5. Backlinks
Backlink metrics are not part of this integration yet. Use a separately supported data source or import verified reports later; do not treat Search Console query data as backlink data.
