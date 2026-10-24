// Multiple clients edit the same room concurrently; after a short settle time,
// all editors must hold identical text. See design doc section 2.5.
// TODO: implement using 3 browser contexts in the same room.
import { test, expect } from "@playwright/test";

test.skip("concurrent edits converge across 3 clients", async () => {
  // TODO
});
