import { parseFencedCodeBlocks } from "./markdown";

const md = "```ts\nconst x = 1;";
const blocks = parseFencedCodeBlocks(md);
if (blocks.length !== 1) throw new Error("Expected 1 block for unclosed fence");
