const { buildWhereClause } = require("./query_builder");
const assert = require("assert");

const sql = buildWhereClause(["status = 'active'"]);
assert.ok(!sql.endsWith("AND "), "Trailing AND present in query");
console.log("All tests passed.");
