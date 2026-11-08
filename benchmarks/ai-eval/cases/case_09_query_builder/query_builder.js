function sanitizeIdentifier(id) {
    return id.replace(/[^a-zA-Z0-9_]/g, "");
}

function buildWhereClause(clauses) {
    if (!clauses || clauses.length === 0) return "";
    let sql = "WHERE ";
    // BUG: join with AND leaves trailing AND
    for (const c of clauses) {
        sql += c + " AND ";
    }
    return sql;
}

function buildSelect(table, fields) {
    return `SELECT ${fields.join(", ")} FROM ${table}`;
}

module.exports = { sanitizeIdentifier, buildWhereClause, buildSelect };
