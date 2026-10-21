"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const meta = require("../Backend/services/meta");

test("resolveDateRange defaults to the configured fallback", () => {
  const result = meta.resolveDateRange({});
  assert.deepEqual(result.params, { date_preset: "last_30d" });
  assert.deepEqual(result.label, { datePreset: "last_30d" });
});

test("resolveDateRange accepts an explicit valid date range", () => {
  const result = meta.resolveDateRange({ since: "2026-10-01", until: "2026-10-21" });
  assert.deepEqual(JSON.parse(result.params.time_range), {
    since: "2026-10-01",
    until: "2026-10-21"
  });
});

test("resolveDateRange rejects incomplete or reversed date ranges", () => {
  assert.throws(() => meta.resolveDateRange({ since: "2026-10-01" }), /valid YYYY-MM-DD dates/);
  assert.throws(() => meta.resolveDateRange({ since: "2026-10-22", until: "2026-10-21" }), /not be after/);
});

test("resolveDateRange rejects unsupported presets", () => {
  assert.throws(() => meta.resolveDateRange({ datePreset: "all_time" }), /datePreset must be one of/);
});

test("isValidAdAccountId only accepts Meta act_ numeric identifiers", () => {
  assert.equal(meta.isValidAdAccountId("act_123456"), true);
  assert.equal(meta.isValidAdAccountId("123456"), false);
  assert.equal(meta.isValidAdAccountId("act_abc"), false);
  assert.equal(meta.isValidAdAccountId("act_123/insights"), false);
});

test("normalizeCampaign derives metrics without inventing ROAS", () => {
  const row = meta.normalizeCampaign({
    campaign: { id: "campaign-1", name: "Test campaign", effective_status: "ACTIVE", objective: "OUTCOME_LEADS" },
    insight: {
      spend: "120.00",
      impressions: "1000",
      reach: "800",
      clicks: "50",
      ctr: "5",
      cpc: "2.4",
      cpm: "120",
      actions: [{ action_type: "lead", value: "4" }],
      purchase_roas: []
    },
    clientId: "client-1",
    adAccountId: "act_123456",
    currency: "INR",
    syncedAt: "2026-10-21T00:00:00.000Z"
  });

  assert.equal(row.client_id, "client-1");
  assert.equal(row.platform, "meta");
  assert.equal(row.spend, 120);
  assert.equal(row.leads, 4);
  assert.equal(row.cpl, 30);
  assert.equal(row.clicks, 50);
  assert.equal(row.roas, null);
  assert.equal(row.currency, "INR");
});

test("normalizeCampaign avoids double-counting overlapping lead action types", () => {
  const row = meta.normalizeCampaign({
    campaign: { id: "campaign-2", name: "Lead campaign" },
    insight: {
      spend: "100",
      actions: [
        { action_type: "lead", value: "3" },
        { action_type: "onsite_conversion.lead_grouped", value: "3" }
      ]
    },
    clientId: "client-1",
    adAccountId: "act_123456"
  });
  assert.equal(row.leads, 3);
  assert.equal(row.cpl, 100 / 3);
});
