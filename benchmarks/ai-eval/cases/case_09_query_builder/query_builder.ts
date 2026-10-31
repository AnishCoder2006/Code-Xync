export function sanitizeIdentifier(id: string): string {
    return id.replace(/[^a-zA-Z0-9_]/g, "");
}

export function buildWhereClause(clauses: string[]): string {
    if (!clauses || clauses.length === 0) return "";
    let sql = "WHERE ";
    // BUG: join with AND + trailing AND
    for (const c of clauses) {
        sql += c + " AND ";
    }
    return sql;
}

export function buildSelect(table: string, fields: string[]): string {
    return `SELECT ${fields.join(", ")} FROM ${table}`;
}
