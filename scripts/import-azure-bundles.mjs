#!/usr/bin/env node

import { cp, mkdir, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const sourceRoot = resolve(
  process.env.INGESTRON_AZURE_BUNDLE_SOURCE ??
    resolve(root, "../ingestron-azure/build/customer-bundle/profile-j"),
);
const targetRoot = resolve(root, "bundles/azure/profile-j");
const versions = ["1.1.0", "1.1.1"];

for (const version of versions) {
  const source = resolve(sourceRoot, version);
  const manifest = JSON.parse(
    await readFile(resolve(source, "manifest.json"), "utf8"),
  );
  if (
    manifest.contract !== "ingestron.azure-bundle/v1" ||
    manifest.bundleVersion !== version ||
    manifest.source?.repository !== "intentlabs-dev/ingestron-azure"
  ) {
    throw new Error(`Refusing incompatible Azure bundle ${version}.`);
  }
  const target = resolve(targetRoot, version);
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  await cp(source, target, { recursive: true });
  console.log(
    `Imported Azure bundle ${version} from ${manifest.source.revision}.`,
  );
}
