import assert from "node:assert/strict";
import test from "node:test";

import { resolvePlatformCredentials } from "../src/connectors.js";

test("credential resolution prefers persistent profile and does not require sessionRef when userDataDirRef is present", () => {
  const env = {
    SPAREROOM_RPA_PROFILE: "/tmp/fake-spareroom-profile"
    // Intentionally omit SPAREROOM_RPA_SESSION to ensure it doesn't get resolved.
  };

  const resolved = resolvePlatformCredentials(
    {
      platform: "spareroom",
      credentials: {
        userDataDirRef: "env:SPAREROOM_RPA_PROFILE",
        sessionRef: "env:SPAREROOM_RPA_SESSION"
      }
    },
    env
  );

  assert.equal(resolved.userDataDir, "/tmp/fake-spareroom-profile");
  assert.ok(!("storageState" in resolved));
  assert.ok(!("storageStatePath" in resolved));
});

