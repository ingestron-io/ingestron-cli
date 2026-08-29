import { spawn } from "node:child_process";
import { CliError } from "./errors.js";

const allowed = new Set([
  "import-adf",
  "extract-requirements",
  "plan",
  "diff",
  "approve",
  "export-odcs",
  "generate",
  "verify",
]);

export async function runBlueprint(
  command: string,
  args: string[],
  executable = process.env.INGESTRON_BLUEPRINT_BIN ?? "ingestron-blueprint",
): Promise<unknown> {
  if (!allowed.has(command))
    throw new CliError("USAGE", `unsupported product command ${command}`);
  if (args.some((value) => value.includes("\0")))
    throw new CliError("USAGE", "product arguments contain an invalid byte");
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(executable, [command, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: process.env.PATH ?? "" },
      shell: false,
    });
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.on("error", (error) =>
      reject(
        new CliError(
          "BLUEPRINT_UNAVAILABLE",
          `Blueprint engine is unavailable: ${error.message}`,
          3,
        ),
      ),
    );
    child.on("exit", (code) => {
      if (code !== 0)
        return reject(
          new CliError(
            "BLUEPRINT_FAILED",
            stderr.trim() || `Blueprint engine exited ${code}`,
            4,
          ),
        );
      try {
        resolve(JSON.parse(stdout.trim().split("\n").at(-1) ?? ""));
      } catch {
        reject(
          new CliError(
            "BLUEPRINT_PROTOCOL",
            "Blueprint engine returned invalid machine output",
            5,
          ),
        );
      }
    });
  });
}
