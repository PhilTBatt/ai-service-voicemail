// Promises the code makes about files it can't import: the Azure template, the Dockerfile, the
// workflows, .env.example and the npm scripts. Each was written down in a comment somewhere
// ("the API is kept to one copy", "actions are pinned to commits"); these tests read the files
// and hold them to it, so a change to one side that forgets the other fails here, not in
// production. They only read files: nothing here touches Azure, GitHub or a database.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ALERTS } from "./alerts.ts";
import { ConfigError, loadConfig } from "./config.ts";
import { ADMIN_POOL_MAX, APP_POOL_MAX, QUEUE_POOL_MAX, WORKER_ADMIN_POOL_MAX } from "./db/pool.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8");

const bicep = read("infra/main.bicep");
const dockerfile = read("Dockerfile");
const envExample = read(".env.example");
const configSource = read("apps/api/src/config.ts");
const runbook = read("docs/RUNBOOK.md");

/** Key Vault's name for a setting ("database-url") as the setting the code reads (DATABASE_URL). */
const settingFor = (secretName: string) => secretName.toUpperCase().replaceAll("-", "_");

/** The strings in one of the template's `var name = [ ... ]` lists, in order. */
function bicepList(name: string): string[] {
  const match = new RegExp(`var ${name} = \\[([^\\]]*)\\]`).exec(bicep);
  if (!match) throw new Error(`infra/main.bicep has no list called ${name}`);
  return [...match[1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
}

/** Every setting config.ts reads, from its schema (one per line, four spaces in). */
const CONFIG_SETTINGS = [...configSource.matchAll(/^ {4}([A-Z][A-Z0-9_]*): z\b/gm)].map(
  (m) => m[1]!,
);

/** The settings .env.example documents (`NAME=` at the start of a line). */
const ENV_EXAMPLE = new Map(
  [...envExample.matchAll(/^([A-Z][A-Z0-9_]*)=(.*)$/gm)].map((m) => [m[1]!, m[2]!]),
);

/** The settings production can't start without: what loadConfig names as missing. */
function productionRequired(): string[] {
  try {
    // DATABASE_URL given, so every problem named is one of production's own.
    loadConfig({ NODE_ENV: "production", DATABASE_URL: "postgres://app@localhost/callmate" });
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    return ["DATABASE_URL", ...error.problems.map((problem) => problem.split(" ")[0]!)];
  }
  throw new Error("expected production to need settings");
}

describe("the settings the code reads", () => {
  it("found every setting in config.ts (the parse above still matches its layout)", () => {
    expect(CONFIG_SETTINGS).toContain("DATABASE_URL");
    expect(CONFIG_SETTINGS).toContain("JUDGE_SAMPLE_RATE");
    expect(CONFIG_SETTINGS.length).toBeGreaterThan(30);
  });

  it("are each documented in .env.example", () => {
    const undocumented = CONFIG_SETTINGS.filter((name) => !ENV_EXAMPLE.has(name));
    expect(undocumented).toEqual([]);
  });

  it("are each named once in .env.example", () => {
    const names = [...envExample.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]!);
    expect(names.length).toBe(new Set(names).size);
  });

  // .env.example is copied to .env and filled in by hand: a value in it would be a value Phil
  // didn't choose, or worse, a secret in git. Only the two safe defaults are written out.
  it("are each left empty in .env.example, but for the two safe defaults", () => {
    const filled = [...ENV_EXAMPLE].filter(([, value]) => value !== "");
    expect(Object.fromEntries(filled)).toEqual({
      TWILIO_PURCHASES_ENABLED: "false",
      GOCARDLESS_ENVIRONMENT: "sandbox",
    });
  });

  it("document only settings something reads (no leftovers)", () => {
    // Read by something other than config.ts: dbmate (db:migrate) and the dashboard's build.
    const elsewhere = new Set(["MIGRATION_DATABASE_URL", "CLERK_PUBLISHABLE_KEY"]);
    const unread = [...ENV_EXAMPLE.keys()].filter(
      (name) => !CONFIG_SETTINGS.includes(name) && !elsewhere.has(name),
    );
    expect(unread).toEqual([]);
    expect(read("package.json")).toContain("--env MIGRATION_DATABASE_URL");
    expect(dockerfile).toContain("ARG CLERK_PUBLISHABLE_KEY");
  });
});

describe("infra/main.bicep: the settings production gets", () => {
  const required = bicepList("requiredSecretNames");
  const plainEnv = [...bicep.matchAll(/\{ name: '([A-Z_]+)', value:/g)].map((m) => m[1]!);
  const fromAzure = new Set([...required.map(settingFor), ...plainEnv]);

  it("found the template's lists (the parse above still matches its layout)", () => {
    expect(required).toContain("database-url");
    expect(plainEnv).toEqual(
      expect.arrayContaining(["NODE_ENV", "PORT", "PUBLIC_BASE_URL", "DASHBOARD_ORIGIN"]),
    );
  });

  it("sets NODE_ENV to production for the apps", () => {
    expect(bicep).toMatch(/\{ name: 'NODE_ENV', value: 'production' \}/);
  });

  it("gives the apps every setting production refuses to start without", () => {
    const required = productionRequired();
    expect(required).toContain("RETELL_API_KEY");
    expect(required.filter((name) => !fromAzure.has(name))).toEqual([]);
  });

  it("maps every required Key Vault secret to a setting config.ts reads", () => {
    expect(required.map(settingFor).filter((name) => !CONFIG_SETTINGS.includes(name))).toEqual([]);
  });

  it("names each required secret once", () => {
    expect(required.length).toBe(new Set(required).size);
  });

  // An optional secret the runbook tells Phil to add must be one the code reads, by the name
  // the template turns it into: a typo there is a setting that silently never arrives.
  it("has the runbook's optional secrets each map to a setting config.ts reads", () => {
    const section = runbook.slice(
      runbook.indexOf("**Two that matter more"),
      runbook.indexOf("### The first release"),
    );
    const optional = [...section.matchAll(/`([a-z][a-z0-9]*(?:-[a-z0-9]+)+)`/g)]
      .map((m) => m[1]!)
      .filter((name) => !required.includes(name));
    expect(optional).toEqual(expect.arrayContaining(["alert-email", "retell-webhook-key"]));
    expect(optional.map(settingFor).filter((name) => !CONFIG_SETTINGS.includes(name))).toEqual([]);
  });

  // Every setting has a place in production: Key Vault (required or optional), the template's
  // plain settings, the image, or a default left alone on purpose. A new setting fails here
  // until someone decides which.
  it("leaves no setting without a decided source in production", () => {
    const optionalInRunbook = new Set(
      [...runbook.matchAll(/`([a-z][a-z0-9]*(?:-[a-z0-9]+)+)`/g)].map((m) => settingFor(m[1]!)),
    );
    const fromImage = [...dockerfile.matchAll(/^ENV ([A-Z_]+)=/gm)].map((m) => m[1]!);
    const defaultsKept = ["LOG_LEVEL", "OUTBOUND_ALLOWLIST", "LLM_MODEL", "JUDGE_SAMPLE_RATE"];
    const undecided = CONFIG_SETTINGS.filter(
      (name) =>
        !fromAzure.has(name) &&
        !optionalInRunbook.has(name) &&
        !fromImage.includes(name) &&
        !defaultsKept.includes(name) &&
        name !== "ALTERNATE_BASE_URL", // set by the template once the domain is bound
    );
    expect(undecided).toEqual([]);
    expect(bicep).toContain("name: 'ALTERNATE_BASE_URL'");
  });

  it("gives the database-setup job the logins setup-database-roles.ts reads", () => {
    const setup = bicepList("setupSecretNames").map(settingFor);
    const script = read("apps/api/src/scripts/setup-database-roles.ts");
    const roles = read("apps/api/src/db/azure-roles.ts");
    for (const name of setup) {
      expect(script.includes(`process.env.${name}`) || roles.includes(`"${name}"`), name).toBe(
        true,
      );
    }
  });
});

describe("infra/main.bicep: commands and files", () => {
  it("starts the worker, the jobs and the task runner from files that exist", () => {
    const files = [...bicep.matchAll(/command: \['node', '([^']+)'/g)].map((m) => m[1]!);
    expect(files).toEqual(
      expect.arrayContaining([
        "apps/api/src/worker.ts",
        "apps/api/src/scripts/setup-database-roles.ts",
        "apps/api/src/scripts/run-task.ts",
      ]),
    );
    for (const file of files) expect(existsSync(path.join(ROOT, file)), file).toBe(true);
  });

  it("migrates from the migrations folder npm run db:migrate uses", () => {
    expect(bicep).toContain("'apps/api/src/db/migrations'");
    expect(read("package.json")).toContain("--migrations-dir apps/api/src/db/migrations");
    expect(existsSync(path.join(ROOT, "apps/api/src/db/migrations"))).toBe(true);
  });

  it("probes the API at routes the API answers", () => {
    const app = read("apps/api/src/app.ts");
    const probes = [...bicep.matchAll(/httpGet: \{ path: '([^']+)'/g)].map((m) => m[1]!);
    expect(probes).toEqual(["/healthz", "/readyz"]);
    for (const probe of probes) expect(app, probe).toContain(`"${probe}"`);
  });

  it("runs Postgres 16 in Azure, as CI and local Docker do (CLAUDE.md)", () => {
    expect(bicep).toMatch(/version: '16'/);
    expect(read("docker-compose.yml")).toMatch(/image: postgres:16\b/);
    for (const workflow of ["ci.yml", "load.yml"]) {
      const images = [...read(`.github/workflows/${workflow}`).matchAll(/image: postgres:(\S+)/g)];
      expect(images.length, workflow).toBeGreaterThan(0);
      for (const [, tag] of images) expect(tag, workflow).toBe("16");
    }
  });
});

describe("the database connection budget (apps/api/src/db/pool.ts)", () => {
  // Azure's B1ms takes 35 user connections. A release runs old and new copies of the API and
  // the worker side by side, plus the migration job's one connection.
  const AZURE_B1MS_USER_CONNECTIONS = 35;
  const api = APP_POOL_MAX + ADMIN_POOL_MAX + QUEUE_POOL_MAX;
  const worker = APP_POOL_MAX + WORKER_ADMIN_POOL_MAX + QUEUE_POOL_MAX;
  // The one-off task job (deploy.yml's "task" step, the callmate-task job) runs one script
  // from apps/api/src/scripts, which makes its own pools: at most one of each.
  const task = APP_POOL_MAX + ADMIN_POOL_MAX + QUEUE_POOL_MAX;

  it("fits a release's peak within the database's limit", () => {
    const peak = 2 * (api + worker) + 1;
    expect(peak).toBeLessThanOrEqual(AZURE_B1MS_USER_CONNECTIONS);
  });

  it("matches the sums pool.ts's comment gives, so the comment stays true", () => {
    const comment = read("apps/api/src/db/pool.ts");
    expect(comment).toContain(`${APP_POOL_MAX} + ${ADMIN_POOL_MAX} + ${QUEUE_POOL_MAX} = ${api}`);
    expect(comment).toContain(
      `${APP_POOL_MAX} + ${WORKER_ADMIN_POOL_MAX} + ${QUEUE_POOL_MAX} = ${worker}`,
    );
    expect(comment).toContain(`${api + worker} in normal running`);
    expect(comment).toContain(`${2 * (api + worker)} at the peak`);
    expect(comment).toContain(`${APP_POOL_MAX} + ${ADMIN_POOL_MAX} + ${QUEUE_POOL_MAX} = ${task}`);
    expect(comment).toContain(`${api + worker + task} while a task runs`);
    expect(comment).toContain(`the peak stays ${2 * (api + worker) + 1}`);
    expect(comment).toContain(`ask for ${2 * (api + worker) + 1 + task}`);
  });

  it("counts the task job at the most any script opens: one of each pool, at its default size", () => {
    const scriptsDir = path.join(ROOT, "apps/api/src/scripts");
    for (const file of readdirSync(scriptsDir)) {
      if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
      const source = readFileSync(path.join(scriptsDir, file), "utf8");
      for (const maker of [/createPool\(/g, /createAdminPool\(/g, /startQueue\(/g]) {
        expect(source.match(maker)?.length ?? 0, `${file}: ${maker.source}`).toBeLessThanOrEqual(1);
      }
      // A size passed in would be outside the count; so would a pool made some other way.
      expect(source, file).not.toMatch(/create(Admin)?Pool\([^)]*max/);
      expect(source, file).not.toMatch(/new pg\.Pool\(/);
    }
  });

  it("fits a task alongside normal running, and never runs one during a release", () => {
    expect(api + worker + task).toBeLessThanOrEqual(AZURE_B1MS_USER_CONNECTIONS);
    // A release's peak leaves no room for a task's pools, so the two take turns, in one group.
    const deploy = read(".github/workflows/deploy.yml");
    for (const job of ["release", "task"]) {
      const block = new RegExp(`^  ${job}:\\n((?: {4}.*\\n|\\n)*)`, "m").exec(deploy)?.[1] ?? "";
      expect(block, job).toMatch(/concurrency:\n\s+group: deploy-production\n/);
    }
  });

  it("keeps the API and the worker to one copy each, which the budget assumes", () => {
    const replicas = [...bicep.matchAll(/scale: \{ minReplicas: (\d+), maxReplicas: (\d+) \}/g)];
    expect(replicas).toHaveLength(2);
    for (const [, min, max] of replicas) {
      expect(min).toBe("1"); // never scaled to zero: a call must not wait for a cold start
      expect(max).toBe("1");
    }
  });

  it("has the API and the worker build their pools at the sizes the budget counts", () => {
    const server = read("apps/api/src/server.ts");
    const workerSource = read("apps/api/src/worker.ts");
    // The app pool at its default (APP_POOL_MAX) in both: no size passed.
    expect(server).toMatch(/createPool\(config\.databaseUrl\)/);
    expect(workerSource).toMatch(/createPool\(config\.databaseUrl\)/);
    // The API's admin pool at its default (ADMIN_POOL_MAX); the worker's at its own size.
    expect(server).toMatch(/createAdminPool\(config\.adminDatabaseUrl\)/);
    expect(workerSource).toMatch(
      /createAdminPool\(config\.adminDatabaseUrl, \{ max: WORKER_ADMIN_POOL_MAX \}\)/,
    );
    // pg-boss's pool: QUEUE_POOL_MAX, set in one place.
    expect(read("apps/api/src/jobs/queue.ts")).toMatch(/max: QUEUE_POOL_MAX/);
    // Nothing else in either process makes a pool.
    expect(server.match(/create(Admin)?Pool\(/g)).toHaveLength(2);
    expect(workerSource.match(/create(Admin)?Pool\(/g)).toHaveLength(2);
  });
});

describe("Dockerfile", () => {
  const engine = /"node": "\^(\d+)\./.exec(read("package.json"))?.[1];

  it("builds and runs on the Node major package.json pins", () => {
    expect(engine).toBeDefined();
    const bases = [...dockerfile.matchAll(/^FROM node:(\d+)-/gm)].map((m) => m[1]);
    expect(bases).toHaveLength(2);
    for (const major of bases) expect(major).toBe(engine);
  });

  it("starts the API with node itself, so SIGTERM reaches it and shutdown is graceful", () => {
    expect(dockerfile).toMatch(/^CMD \["node", "apps\/api\/src\/server\.ts"\]$/m);
    expect(dockerfile).not.toMatch(/^CMD .*npm/m);
  });

  it("runs as the unprivileged node user, in production mode", () => {
    expect(dockerfile).toMatch(/^USER node$/m);
    expect(dockerfile).toMatch(/^ENV NODE_ENV=production$/m);
  });

  it("copies every workspace's package.json into both stages, or npm ci refuses the lockfile", () => {
    const workspaces = ["apps", "packages"].flatMap((dir) =>
      readdirSync(path.join(ROOT, dir))
        .filter((name) => existsSync(path.join(ROOT, dir, name, "package.json")))
        .map((name) => `${dir}/${name}`),
    );
    expect(workspaces).toEqual(expect.arrayContaining(["apps/api", "apps/web", "packages/shared"]));
    for (const workspace of workspaces) {
      const copies = dockerfile.split(`COPY ${workspace}/package.json ${workspace}/`).length - 1;
      expect(copies, workspace).toBe(2);
    }
  });

  it("serves the dashboard from where the build stage put it", () => {
    expect(dockerfile).toContain("COPY --from=build /app/apps/web/dist apps/web/dist");
    expect(dockerfile).toMatch(/^ENV DASHBOARD_DIST=\/app\/apps\/web\/dist$/m);
  });
});

describe("GitHub workflows", () => {
  const dir = path.join(ROOT, ".github/workflows");
  const workflows = readdirSync(dir)
    .filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"))
    .map((file) => ({ file, text: readFileSync(path.join(dir, file), "utf8") }));

  it("found the workflows", () => {
    expect(workflows.map((w) => w.file)).toEqual(expect.arrayContaining(["ci.yml", "deploy.yml"]));
  });

  // A tag can be moved to other code; a commit can't (ci.yml's own comment).
  it("pin every action to a full commit SHA, with the release named beside it", () => {
    let checked = 0;
    for (const { file, text } of workflows) {
      for (const [line] of text.matchAll(/^\s*-?\s*uses: .*$/gm)) {
        expect(line, file).toMatch(/uses: [\w.-]+\/[\w./-]+@[0-9a-f]{40} # v\d/);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(10);
  });

  it("each start from a read-only token", () => {
    for (const { file, text } of workflows) {
      expect(text, file).toMatch(/^permissions:\n {2}contents: read$/m);
      expect(text, file).not.toMatch(/write-all/);
    }
  });

  // pull_request_target runs with the repo's secrets on code from a fork.
  it("never run on pull_request_target", () => {
    for (const { file, text } of workflows) expect(text, file).not.toContain("pull_request_target");
  });

  // The release safety of 2026-11-11: production changes only from main, and a release that's
  // only done once the new build is the one answering, API and worker both.
  describe("deploy.yml", () => {
    const deploy = workflows.find((w) => w.file === "deploy.yml")!.text;
    /** A job's `if:` line, by the job's name. */
    const jobIf = (job: string) =>
      new RegExp(`^ {2}${job}:\\n(?: {4}#.*\\n)* {4}if: (.*)$`, "m").exec(deploy)?.[1];

    it("changes production only from main, and fails a run from anywhere else", () => {
      for (const job of ["infrastructure", "release", "task", "apply"]) {
        expect(jobIf(job), job).toMatch(/&& github\.ref == 'refs\/heads\/main'$/);
      }
      expect(jobIf("main-only")).toContain("github.ref != 'refs/heads/main'");
      expect(deploy).toMatch(/main-only:[\s\S]*?exit 1/);
    });

    it("builds the commit into the image, and waits for the API and worker to report it", () => {
      expect(deploy).toContain("APP_VERSION=${{ github.sha }}");
      expect(dockerfile).toMatch(/^ARG APP_VERSION\nENV APP_VERSION=\$\{APP_VERSION\}$/m);
      expect(deploy).toContain(`= "ready $IMAGE_TAG"`);
      expect(deploy).toContain(`= "running $IMAGE_TAG"`);
      expect(deploy).toContain("/healthz/worker");
    });
  });

  it("run their shell scripts from files that exist", () => {
    const scripts = workflows.flatMap(({ file, text }) =>
      [...text.matchAll(/(\.github\/scripts\/[\w.-]+\.sh)/g)].map((m) => ({ file, script: m[1]! })),
    );
    expect(scripts.length).toBeGreaterThan(0);
    for (const { file, script } of scripts) {
      expect(existsSync(path.join(ROOT, script)), `${file}: ${script}`).toBe(true);
    }
  });
});

/**
 * A release runs the migrations first, and the build already running keeps answering calls until
 * the new one is ready (RUNBOOK section 16, "When a release fails"): it runs against the new
 * schema for a few minutes, or for as long as the new build fails its check. So a migration only
 * adds. Taking something away (a column, a table, a function the old code calls, a column's type
 * or its nullability) goes in two releases: the first stops the code using it, a later one
 * removes it, with a `-- release-safe: <why>` line in that statement saying the code before it
 * no longer uses it. Checked statement by statement, with function bodies left out.
 */
const RELEASE_HAZARDS: [RegExp, string][] = [
  [/\bDROP (TABLE|FUNCTION|VIEW|TYPE|SCHEMA|MATERIALIZED VIEW)\b/i, "drops something"],
  [
    /\bALTER TABLE\b.*\bDROP (?!CONSTRAINT\b|DEFAULT\b|NOT NULL\b|EXPRESSION\b|IDENTITY\b)/i,
    "drops a column",
  ],
  [/\bRENAME\b/i, "renames something"],
  [/\bALTER COLUMN \S+ (SET DATA )?TYPE\b/i, "changes a column's type"],
  [/\bSET NOT NULL\b/i, "makes a column required"],
];

function releaseHazards(sql: string): string[] {
  const up = /-- migrate:up([\s\S]*?)(?:-- migrate:down|$)/.exec(sql)?.[1] ?? "";
  // Function bodies ($$ ... $$, $tag$ ... $tag$) aren't schema changes, and hold semicolons.
  const statements = up.replace(/\$(\w*)\$[\s\S]*?\$\1\$/g, "$$$$").split(";");
  const hazards: string[] = [];
  for (const statement of statements) {
    if (/^\s*-- release-safe: \S/m.test(statement)) continue;
    const code = statement.replace(/--.*$/gm, "").replace(/\s+/g, " ").trim();
    for (const [pattern, what] of RELEASE_HAZARDS) {
      if (pattern.test(code)) hazards.push(`${what}: ${code.slice(0, 100)}`);
    }
    // A new required column with no default: the running build's inserts don't fill it.
    if (/^ALTER TABLE\b/i.test(code)) {
      for (const clause of code.split(/,\s*(?=ADD\b)/i)) {
        if (/\bADD (COLUMN )?(?!CONSTRAINT\b)/i.test(clause) && /\bNOT NULL\b/i.test(clause)) {
          if (!/\bDEFAULT\b/i.test(clause)) {
            hazards.push(`adds a required column with no default: ${clause.slice(0, 100)}`);
          }
        }
      }
    }
  }
  return hazards;
}

describe("migrations: the build still running during a release keeps working", () => {
  const dir = path.join(ROOT, "apps/api/src/db/migrations");
  // Production's first release was 2026-11-10: every migration before then ran on an empty
  // database, with nothing running against it (two of them would fail these rules).
  const sinceProduction = readdirSync(dir).filter(
    (file) => file.endsWith(".sql") && file >= "20261110",
  );

  it("found the migrations since production began", () => {
    expect(sinceProduction).toContain("20261111223000_add_agent_sync_fingerprint.sql");
  });

  it.each(sinceProduction)("%s only adds", (file) => {
    expect(releaseHazards(readFileSync(path.join(dir, file), "utf8"))).toEqual([]);
  });

  it("catches each kind of change that would break the running build, and not the safe ones", () => {
    const up = (body: string) => `-- migrate:up\n${body}\n-- migrate:down\nDROP TABLE t;\n`;
    for (const unsafe of [
      "ALTER TABLE calls DROP COLUMN summary;",
      "ALTER TABLE calls DROP summary;",
      "DROP TABLE call_costs;",
      "DROP FUNCTION tenant_id_for_provider_ref(text);",
      "ALTER TABLE calls RENAME COLUMN summary TO job_summary;",
      "ALTER TABLE calls ALTER COLUMN duration_seconds TYPE bigint;",
      "ALTER TABLE calls ALTER COLUMN summary SET NOT NULL;",
      "ALTER TABLE calls ADD COLUMN source text NOT NULL;",
      "ALTER TABLE calls ADD COLUMN a integer NOT NULL DEFAULT 0, ADD COLUMN b text NOT NULL;",
    ]) {
      expect(releaseHazards(up(unsafe)), unsafe).toHaveLength(1);
    }
    for (const safe of [
      "ALTER TABLE calls ADD COLUMN a integer NOT NULL DEFAULT 0 CHECK (a >= 0), ADD COLUMN b timestamptz;",
      "CREATE TABLE t (id uuid NOT NULL, name text NOT NULL);",
      "ALTER TABLE calls ALTER COLUMN summary DROP NOT NULL;",
      "ALTER TABLE calls DROP CONSTRAINT calls_summary_check;",
      "DROP INDEX calls_open_idx;",
      "CREATE OR REPLACE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $$ BEGIN DROP TABLE x; END $$;",
      "-- release-safe: nothing reads summary since 2026-12-01\nALTER TABLE calls DROP COLUMN summary;",
    ]) {
      expect(releaseHazards(up(safe)), safe).toEqual([]);
    }
  });
});

describe("npm scripts (CLAUDE.md: they run in PowerShell and on Linux CI)", () => {
  const manifests = [
    "package.json",
    "apps/api/package.json",
    "apps/web/package.json",
    "packages/shared/package.json",
  ];
  const scripts = manifests.flatMap((file) =>
    Object.entries(
      (JSON.parse(read(file)) as { scripts?: Record<string, string> }).scripts ?? {},
    ).map(([name, command]) => ({ file, name, command })),
  );

  it("found the scripts", () => {
    expect(scripts.map((s) => s.name)).toEqual(expect.arrayContaining(["check", "test", "dev"]));
  });

  it.each([
    ["rm -rf or rm", /(^|[\s;&|])rm\s/],
    ["export", /(^|[\s;&|])export\s/],
    ["an inline VAR=value before a command", /(^|&&\s*|;\s*)[A-Z][A-Z0-9_]*=\S*\s+\S/],
    ["a $VARIABLE (cmd.exe doesn't expand it)", /\$[A-Za-z_{]/],
    ["single quotes (cmd.exe doesn't treat them as quotes)", /'/],
    ["cp or mv", /(^|[\s;&|])(cp|mv)\s/],
  ])("use no %s", (_label, pattern) => {
    const offending = scripts.filter((s) => pattern.test(s.command));
    expect(offending.map((s) => `${s.file} ${s.name}: ${s.command}`)).toEqual([]);
  });

  // CLAUDE.md rule 1: a script that touches live services is named live-*.
  it("name every script that runs a live-* file live-* too", () => {
    for (const { file, name, command } of scripts) {
      if (/\/live-[\w-]+\.ts/.test(command)) expect(name, file).toMatch(/^live-/);
    }
  });

  it("run files that exist", () => {
    for (const { file, name, command } of scripts) {
      const base = path.dirname(path.join(ROOT, file));
      for (const [target] of command.matchAll(/[\w./-]+\.ts\b/g)) {
        expect(existsSync(path.join(base, target)), `${file} ${name}: ${target}`).toBe(true);
      }
    }
  });
});

describe("alerts", () => {
  // The reverse of alerts.test.ts: an alert listed but raised nowhere is a runbook entry for
  // something that can never happen, and usually a sign the code raising it was removed.
  it("are each raised somewhere in the code, not only listed", () => {
    const sourceDir = fileURLToPath(new URL(".", import.meta.url));
    const source = readdirSync(sourceDir, { recursive: true, encoding: "utf8" })
      .filter(
        (file) =>
          file.endsWith(".ts") &&
          !file.endsWith(".test.ts") &&
          !file.includes("testing") &&
          path.basename(file) !== "alerts.ts",
      )
      .map((file) => readFileSync(path.join(sourceDir, file), "utf8"))
      .join("\n");
    const unraised = ALERTS.filter((alert) => !source.includes(`"${alert}"`));
    expect(unraised).toEqual([]);
  });
});
