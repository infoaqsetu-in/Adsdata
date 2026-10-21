#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const ignored = new Set(["node_modules", ".git", ".next", "dist", "coverage"]);
const files = [];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!ignored.has(entry.name)) walk(path.join(dir, entry.name));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".js")) files.push(path.join(dir, entry.name));
  }
}

walk(root);
if (!files.length) {
  console.error("No JavaScript files found to check.");
  process.exit(1);
}

let failed = 0;
for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status !== 0) {
    failed++;
    console.error("\nSYNTAX ERROR:", path.relative(root, file));
    if (result.stderr) console.error(result.stderr.trim());
    if (result.stdout) console.error(result.stdout.trim());
  }
}

if (failed) {
  console.error(`\nSyntax check failed for ${failed} of ${files.length} JavaScript files.`);
  process.exit(1);
}
console.log(`JavaScript syntax check passed for ${files.length} files.`);
