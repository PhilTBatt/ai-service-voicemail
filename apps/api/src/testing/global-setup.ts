import { execFileSync } from "node:child_process";
import { resolveBinary } from "dbmate";
import { TEST_MIGRATION_DATABASE_URL } from "./databases.ts";

/** Runs once before any test: brings the test database's schema up to date, as the owner. */
export default function setup(): void {
  try {
    execFileSync(
      resolveBinary(),
      [
        "--url",
        TEST_MIGRATION_DATABASE_URL,
        "--migrations-dir",
        "apps/api/src/db/migrations",
        "--no-dump-schema",
        "up",
      ],
      { stdio: "pipe" },
    );
  } catch (error) {
    const output = (error as { stderr?: Buffer }).stderr?.toString().trim();
    throw new Error(
      `Couldn't migrate the test database. Is it running? Start it with: npm run db:up\n${output ?? ""}`,
      { cause: error },
    );
  }
}
