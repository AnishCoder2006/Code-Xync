const { parseFencedCodeBlocks } = require("./markdown");
const assert = require("assert");

const md = "```ts\nconst x = 1;";
const blocks = parseFencedCodeBlocks(md);
assert.strictEqual(blocks.length, 1, "Expected 1 block for unclosed fence");
console.log("All tests passed.");
