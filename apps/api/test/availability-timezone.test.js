import test from "node:test";
import assert from "node:assert/strict";

import {
  LocalTimeValidationError,
  formatInTimezone,
  zonedTimeToUtc
} from "../src/availability-timezone.js";

test("rejects nonexistent local times during DST spring-forward gap", () => {
  assert.throws(
    () => zonedTimeToUtc("2026-03-08", "02:30", "America/New_York"),
    (error) => {
      assert.ok(error instanceof LocalTimeValidationError);
      assert.equal(error.code, "NONEXISTENT_LOCAL_TIME");
      assert.deepEqual(error.details, {
        date: "2026-03-08",
        time: "02:30",
        timezone: "America/New_York"
      });
      return true;
    }
  );
});

test("uses deterministic earlier instant for ambiguous DST fall-back time", () => {
  const earlier = zonedTimeToUtc("2026-11-01", "01:30", "America/New_York");
  const later = zonedTimeToUtc("2026-11-01", "01:30", "America/New_York", { disambiguation: "later" });

  assert.equal(earlier.toISOString(), "2026-11-01T05:30:00.000Z");
  assert.equal(later.toISOString(), "2026-11-01T06:30:00.000Z");
  assert.equal(formatInTimezone(earlier, "America/New_York").slice(0, 16), "2026-11-01T01:30");
  assert.equal(formatInTimezone(later, "America/New_York").slice(0, 16), "2026-11-01T01:30");
});
