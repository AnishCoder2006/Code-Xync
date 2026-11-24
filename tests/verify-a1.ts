/**
 * A1 checks, re-runnable:
 *  1. services/sync/src imports nothing from services/api (and no relative path leaves the package).
 *  2. services/sync/prisma/schema.prisma is identical to prisma/schema.prisma.
 *  3. ProjectFile fields in schema.prisma, and the migration SQL that creates them.
 *  4. A scratch database built ONLY by `prisma migrate deploy` matches schema.prisma
 *     (`prisma migrate diff --exit-code` = 0), i.e. migrate (not just db push) captures it.
 *
 *   npx tsx tests/verify-a1.ts
 */
import { execSync } from "child_process";
import fs from "fs";
import path from "path";

const ROOT = path.resolve(__dirname, "..");
const run = (cmd: string, env: NodeJS.ProcessEnv = process.env) =>
  execSync(cmd, { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] }).toString();
const checks: Array<[boolean, string]> = [];

// 1
const offenders: string[] = [];
const walk = (d: string) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.ts$/.test(e.name)) {
      fs.readFileSync(p, "utf8").split("\n").forEach((line, i) => {
        if (/from\s+["'](\.\.\/){2,}|services\/api|@codesync\/api/.test(line) && /import|require/.test(line))
          offenders.push(`${path.relative(ROOT, p)}:${i + 1}: ${line.trim()}`);
      });
    }
  }
};
walk(path.join(ROOT, "services/sync/src"));
console.log(`[1] imports leaving services/sync or touching services/api: ${offenders.length ? offenders.join("; ") : "none"}`);
checks.push([offenders.length === 0, "services/sync imports nothing from services/api"]);

// 2
const same = fs.readFileSync(path.join(ROOT, "prisma/schema.prisma")).equals(fs.readFileSync(path.join(ROOT, "services/sync/prisma/schema.prisma")));
console.log(`[2] services/sync/prisma/schema.prisma identical to prisma/schema.prisma: ${same}`);
checks.push([same, "sync service has its own (identical) schema copy for its own Prisma client"]);

// 3
const schema = fs.readFileSync(path.join(ROOT, "prisma/schema.prisma"), "utf8");
const model = /model ProjectFile \{[\s\S]*?\n\}/.exec(schema)?.[0] ?? "(missing)";
console.log(`[3] schema.prisma:\n${model}`);
const migDir = path.join(ROOT, "prisma/migrations");
const migs = fs.readdirSync(migDir).filter((d) => fs.existsSync(path.join(migDir, d, "migration.sql"))).sort();
for (const m of migs) {
  const sql = fs.readFileSync(path.join(migDir, m, "migration.sql"), "utf8");
  const pf = /CREATE TABLE "ProjectFile"[\s\S]*?\);/.exec(sql);
  if (pf) console.log(`    ${m}/migration.sql:\n${pf[0]}`);
}
console.log(`    migrations: ${migs.join(", ")}`);

// 4
const scratch = "codesync_a1_verify";
const url = `postgresql://postgres:postgres@localhost:5432/${scratch}`;
run(`docker exec docker-postgres-1 psql -U postgres -c "DROP DATABASE IF EXISTS ${scratch}" -c "CREATE DATABASE ${scratch}"`);
const env = { ...process.env, DATABASE_URL: url, DIRECT_URL: url };
try {
  const deploy = run("npx prisma migrate deploy", env);
  console.log(`[4] migrate deploy on empty scratch DB:\n${deploy.split("\n").filter((l) => /migration|applied|└─/.test(l)).join("\n")}`);
  let diffExit = 0;
  try {
    execSync("npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code", { cwd: ROOT, env, stdio: "ignore" });
  } catch (e: any) {
    diffExit = e.status ?? 1;
  }
  const script = run("npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script", env)
    .split("\n").filter((l) => !/Loaded Prisma config/.test(l)).join("\n").trim();
  console.log(`    migrate diff (migrations-only DB -> schema.prisma) exit code: ${diffExit}; script: ${script || "(empty)"}`);
  checks.push([diffExit === 0, "a database built only from prisma migrations matches schema.prisma"]);
  const cols = run(
    `docker exec docker-postgres-1 psql -U postgres -d ${scratch} -tAc "select string_agg(column_name||' '||data_type, ', ' order by ordinal_position) from information_schema.columns where table_name='ProjectFile'"`
  ).trim();
  console.log(`    ProjectFile columns in the migrations-only DB: ${cols}`);
} finally {
  run(`docker exec docker-postgres-1 psql -U postgres -c "DROP DATABASE IF EXISTS ${scratch}"`);
}

console.log("");
for (const [ok, label] of checks) console.log(`${ok ? "PASS" : "FAIL"}: ${label}`);
process.exit(checks.every(([ok]) => ok) ? 0 : 1);
