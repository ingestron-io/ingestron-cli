import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const files = execFileSync("git", ["ls-files"], { encoding: "utf8" })
  .trim()
  .split("\n")
  .filter(Boolean);
const patterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /AccountKey=[A-Za-z0-9+/=]{20,}/i,
  /SharedAccessSignature=sv=/i,
  /[?&]sig=[A-Za-z0-9%+/=]{20,}/i,
];
const failures = [];
for (const file of files) {
  if (file === "pnpm-lock.yaml" || file === "scripts/scan-secrets.mjs")
    continue;
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  if (patterns.some((pattern) => pattern.test(text))) failures.push(file);
}
if (failures.length) {
  console.error(`Potential secret material: ${failures.join(", ")}`);
  process.exit(1);
}
console.log(`Secret scan passed (${files.length} tracked files).`);
