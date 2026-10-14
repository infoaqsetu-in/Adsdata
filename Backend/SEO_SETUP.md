# SEO integration setup

The SEO dashboard uses Google Search Console only. No Semrush API key is required.

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

## 4. Automatic daily syncing
The repository includes a GitHub Actions workflow at `.github/workflows/seo-daily-sync.yml`. It runs daily at 03:20 UTC (08:50 India time) and can also be started manually from GitHub Actions.

Configure these values before the workflow can run:
1. In Hostinger, add `SEO_CRON_SECRET` as a long, randomly generated secret. Do not commit it to GitHub or put it in frontend code.
2. In GitHub, open Settings → Secrets and variables → Actions → New repository secret. Add `SEO_CRON_SECRET` with the exact same value.
3. Add a second repository secret named `PORTAL_BASE_URL` containing the deployed backend's base URL, for example `https://your-live-portal.example` (no trailing slash). Use the actual URL of your Hostinger app.
4. Redeploy/restart the Hostinger Node.js app after adding the environment variable so the backend loads it.
5. In GitHub, open Actions → Daily SEO Search Console Sync → Run workflow to test it. Check the workflow run log for the number of clients synced and any failures.

The scheduled endpoint is protected by the shared secret and syncs only clients whose SEO setting is enabled. It stores current and previous 28-day Search Console data in the existing snapshot table. A failed client makes the workflow fail visibly, so failures are not silently reported as a successful run.

## 5. Data and security
The portal displays only Search Console data successfully returned by the API; it does not use sample SEO metrics. Credentials are read from server environment variables. Client-facing endpoints scope settings and snapshots to the authenticated client's ID, and only admins can configure entitlements or run manual syncs. Keep both `GSC_SERVICE_ACCOUNT_JSON` and `SEO_CRON_SECRET` private.
