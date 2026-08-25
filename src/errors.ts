export class CliError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly exitCode = 2,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export const redact = (value: string): string =>
  value
    .replace(/([?&](?:sig|token|code)=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[REDACTED]")
    .replace(
      /((?:AccountKey|SharedAccessSignature)=)[^;\s]+/gi,
      "$1[REDACTED]",
    );
