import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const release = resolve(root, "release");
if (!release.startsWith(`${root}${sep}`) || !release.endsWith(`${sep}release`))
  throw new Error("Unsafe release directory");

await rm(release, { recursive: true, force: true });
await mkdir(release, { recursive: true });
const pnpmEntry = process.env.npm_execpath;
if (!pnpmEntry)
  throw new Error("Run through pnpm so the package manager is pinned");
execFileSync(
  process.execPath,
  [pnpmEntry, "pack", "--pack-destination", release],
  { cwd: root, stdio: "inherit" },
);

const archives = (await readdir(release)).filter((name) =>
  name.endsWith(".tgz"),
);
if (archives.length !== 1)
  throw new Error("Expected exactly one release archive");
const archive = archives[0];
const bytes = await readFile(resolve(release, archive));
const digest = createHash("sha256").update(bytes).digest("hex");
await writeFile(
  resolve(release, "SHA256SUMS"),
  `${digest}  ${archive}\n`,
  "utf8",
);

const commit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim();
const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const bundle = JSON.parse(
  await readFile(resolve(root, "bundles/adf/2.2.0/manifest.json"), "utf8"),
);
const azureBundles = await Promise.all(
  [
    "1.1.0",
    "1.1.1",
    "1.2.0",
    "1.2.1",
    "1.3.0",
    "1.4.0",
    "1.5.0",
    "1.6.0",
    "1.7.0",
    "1.8.0",
    "1.9.0",
  ].map(async (version) => {
    const path = resolve(
      root,
      `bundles/azure/profile-j/${version}/manifest.json`,
    );
    const bytes = await readFile(path);
    const manifest = JSON.parse(bytes.toString("utf8"));
    return {
      version,
      digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      source: manifest.source,
      applicationArtifacts: manifest.applicationArtifacts,
      files: manifest.files,
    };
  }),
);
await writeFile(
  resolve(release, "provenance.json"),
  `${JSON.stringify(
    {
      contract: "ingestron.cli-provenance/v1",
      package: pkg.name,
      version: pkg.version,
      commit,
      node: process.version,
      archive: { name: archive, digest: `sha256:${digest}` },
      adfBundle: {
        version: bundle.version,
        compatibility: bundle.compatibility,
        profiles: Object.fromEntries(
          Object.entries(bundle.profiles).map(([name, profile]) => [
            name,
            {
              template: profile.template,
              templateDigest: profile.templateDigest,
            },
          ]),
        ),
      },
      azureProfileJBundles: azureBundles,
      publicDistribution: true,
    },
    null,
    2,
  )}\n`,
  "utf8",
);
const runtime = azureBundles.at(-1).applicationArtifacts;
const sbom = {
  spdxVersion: "SPDX-2.3",
  dataLicense: "CC0-1.0",
  SPDXID: "SPDXRef-DOCUMENT",
  name: `ingestron-cli-${pkg.version}`,
  documentNamespace: `https://ingestron.io/sbom/${digest}`,
  creationInfo: {
    created: "2000-01-01T00:00:00Z",
    creators: ["Tool: ingestron-cli-release-builder"],
  },
  packages: [
    {
      SPDXID: "SPDXRef-CLI",
      name: pkg.name,
      versionInfo: pkg.version,
      downloadLocation: "NOASSERTION",
      filesAnalyzed: false,
      licenseConcluded: "Apache-2.0",
      licenseDeclared: "Apache-2.0",
      copyrightText: "Copyright 2026 the Ingestron project owner",
      checksums: [{ algorithm: "SHA256", checksumValue: digest }],
    },
    {
      SPDXID: "SPDXRef-Yaml",
      name: "yaml",
      versionInfo: pkg.dependencies.yaml,
      downloadLocation: `https://registry.npmjs.org/yaml/-/yaml-${pkg.dependencies.yaml}.tgz`,
      filesAnalyzed: false,
      licenseConcluded: "ISC",
      licenseDeclared: "ISC",
      copyrightText: "NOASSERTION",
    },
    {
      SPDXID: "SPDXRef-Functions",
      name: "Ingestron Profile J Functions",
      versionInfo: runtime.jobsFunctions.version,
      downloadLocation: runtime.jobsFunctions.downloadUrl,
      filesAnalyzed: false,
      licenseConcluded: runtime.jobsFunctions.license,
      licenseDeclared: runtime.jobsFunctions.license,
      copyrightText: "Copyright 2026 the Ingestron project owner",
      checksums: [
        { algorithm: "SHA256", checksumValue: runtime.jobsFunctions.sha256 },
      ],
    },
    {
      SPDXID: "SPDXRef-Worker",
      name: "Ingestron Profile J worker",
      versionInfo: runtime.jobsFunctions.version,
      downloadLocation: `${runtime.workerImage.registry}/${runtime.workerImage.repository}@sha256:${runtime.workerImage.sha256}`,
      filesAnalyzed: false,
      licenseConcluded: runtime.workerImage.license,
      licenseDeclared: runtime.workerImage.license,
      copyrightText: "Copyright 2026 the Ingestron project owner",
      checksums: [
        { algorithm: "SHA256", checksumValue: runtime.workerImage.sha256 },
      ],
    },
  ],
  relationships: [
    {
      spdxElementId: "SPDXRef-DOCUMENT",
      relationshipType: "DESCRIBES",
      relatedSpdxElement: "SPDXRef-CLI",
    },
    ...["SPDXRef-Yaml", "SPDXRef-Functions", "SPDXRef-Worker"].map(
      (relatedSpdxElement) => ({
        spdxElementId: "SPDXRef-CLI",
        relationshipType: "DEPENDS_ON",
        relatedSpdxElement,
      }),
    ),
  ],
  hasExtractedLicensingInfos: [
    {
      licenseId: "LicenseRef-Ingestron-Runtime-Preview-1.0",
      name: "Ingestron Runtime Preview Licence 1.0",
      extractedText: "See LICENSE-RUNTIME-PREVIEW.md in the CLI archive.",
    },
  ],
};
const sbomName = `ingestron-cli-${pkg.version}.spdx.json`;
const sbomBytes = Buffer.from(`${JSON.stringify(sbom, null, 2)}\n`);
await writeFile(resolve(release, sbomName), sbomBytes);
const provenanceBytes = await readFile(resolve(release, "provenance.json"));
await writeFile(
  resolve(release, "SHA256SUMS"),
  [
    `${digest}  ${archive}`,
    `${createHash("sha256").update(sbomBytes).digest("hex")}  ${sbomName}`,
    `${createHash("sha256").update(provenanceBytes).digest("hex")}  provenance.json`,
    "",
  ].join("\n"),
  "utf8",
);
console.log(`Built public preview candidate ${archive} (${digest}).`);
