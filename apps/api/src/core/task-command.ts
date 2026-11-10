// A script's command line, carried through Azure's CLI (BUILD_PLAN Step 8, the Deploy
// workflow's "task" step). `az containerapp job start --args` takes the arguments as a list,
// but anything in that list starting with "--" is read as one of az's own options, so
// "--email x --role admin" never reaches the script. The workflow encodes the whole line
// (base64url: letters, digits, "-" and "_", never a leading "-"), and scripts/run-task.ts
// decodes it in the container and runs the script named.

/** Script names are file names under apps/api/src/scripts, so only this shape is allowed. */
const SCRIPT_NAME = /^[a-z0-9][a-z0-9-]*$/;

export interface TaskCommand {
  /** The script's name without ".ts": "invite-user". */
  script: string;
  args: string[];
}

export function encodeTaskCommand(line: string): string {
  return Buffer.from(line, "utf8").toString("base64url");
}

/**
 * The script and its arguments from the encoded line. Arguments are split on whitespace:
 * none of the scripts take one with a space in it, and a quoted one would only be the start
 * of a shell. Refuses an empty line or a script name that isn't a plain file name.
 */
export function decodeTaskCommand(encoded: string): TaskCommand {
  const line = Buffer.from(encoded, "base64url").toString("utf8");
  const [script, ...args] = line
    .trim()
    .split(/\s+/)
    .filter((word) => word !== "");
  if (!script) throw new Error("No script named: the command is empty");
  if (!SCRIPT_NAME.test(script)) {
    throw new Error(`"${script}" isn't a script name (letters, digits and hyphens, no path)`);
  }
  return { script, args };
}
