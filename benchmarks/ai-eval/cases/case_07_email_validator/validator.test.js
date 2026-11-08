const { validateEmailAddress } = require("./validator");
const assert = require("assert");

assert.strictEqual(validateEmailAddress("alice+codesync@example.com"), true, "Valid plus-addressed email was rejected!");
console.log("All tests passed.");
