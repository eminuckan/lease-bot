import test from "node:test";
import assert from "node:assert/strict";

import {
  extractVariablesFromBody,
  normalizeMessageStatus,
  parseTemplateVariables,
  renderTemplate
} from "../src/inbox-utils.js";

test("normalizes message status defaults across directions", () => {
  assert.equal(normalizeMessageStatus("inbound", {}), "new");
  assert.equal(normalizeMessageStatus("outbound", {}), "sent");
  assert.equal(normalizeMessageStatus("outbound", { reviewStatus: "draft" }), "draft");
  assert.equal(normalizeMessageStatus("outbound", { reviewStatus: "hold" }), "hold");
});

test("parses template variables from csv and array", () => {
  assert.deepEqual(parseTemplateVariables("unit,slot"), ["unit", "slot"]);
  assert.deepEqual(parseTemplateVariables(["unit", "slot", ""]), ["unit", "slot"]);
});

test("renders template with unit and slot context", () => {
  const body = "Tour for {{unit}} is available at {{slot}}.";
  assert.deepEqual(extractVariablesFromBody(body), ["unit", "slot"]);
  assert.equal(
    renderTemplate(body, {
      unit: "Atlas Apartments 4B",
      slot: "2026-02-10T17:00 America/Chicago"
    }),
    "Tour for Atlas Apartments 4B is available at 2026-02-10T17:00 America/Chicago."
  );
});
