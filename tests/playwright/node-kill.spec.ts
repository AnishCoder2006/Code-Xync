// Kill one sync-service node mid-session; remaining clients keep working and converge.
// See design doc section 2.5.
import { test, expect } from "@playwright/test";

test.skip("clients recover when a sync node is killed", async () => {
  // TODO
});
