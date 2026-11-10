// Runs one script from this folder with the arguments the Deploy workflow's "task" step was
// given, decoded from the one encoded argument Azure's CLI will pass through unchanged
// (core/task-command.ts explains why). The script's output is this job's output; its exit
// code is this job's. Run by the callmate-task job, never by hand.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decodeTaskCommand } from "../core/task-command.ts";

const encoded = process.argv[2];
if (!encoded) {
  console.error("run-task.ts needs the encoded command as its one argument");
  process.exit(2);
}

const { script, args } = decodeTaskCommand(encoded);
const file = path.join(fileURLToPath(new URL(".", import.meta.url)), `${script}.ts`);
if (!existsSync(file)) {
  console.error(`No such script: ${script}`);
  process.exit(2);
}

console.log(`Running ${script} ${args.join(" ")}`);
const child = spawnSync(process.execPath, [file, ...args], { stdio: "inherit" });
if (child.error) {
  console.error(`Couldn't start ${script}: ${child.error.message}`);
  process.exit(1);
}
process.exit(child.status ?? 1);
