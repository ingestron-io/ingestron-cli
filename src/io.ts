import { CliError, redact } from "./errors.js";

export type OutputMode = "human" | "json";
export type Envelope = {
  contract: "ingestron.cli-output/v1";
  ok: boolean;
  command: string;
  result?: unknown;
  error?: { code: string; message: string; details?: Record<string, unknown> };
};

export const emit = (envelope: Envelope, mode: OutputMode): void => {
  if (mode === "json") {
    process.stdout.write(`${JSON.stringify(envelope)}\n`);
    return;
  }
  if (envelope.ok)
    process.stdout.write(
      `${redact(JSON.stringify(envelope.result, null, 2))}\n`,
    );
  else
    process.stderr.write(
      `${envelope.error?.code}: ${redact(envelope.error?.message ?? "Unknown error")}\n`,
    );
};

export const asCliError = (error: unknown): CliError =>
  error instanceof CliError
    ? error
    : new CliError(
        "INTERNAL",
        error instanceof Error ? redact(error.message) : "Unknown failure",
        10,
      );
