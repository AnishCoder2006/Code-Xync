import { buildWhereClause } from "./query_builder";

const sql = buildWhereClause(["status = 'active'"]);
if (sql.endsWith("AND ")) throw new Error("Trailing AND present in query");
