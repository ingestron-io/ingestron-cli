import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("ADF bundle is parseable and retries are numeric and bounded", async () => {
  const template = JSON.parse(
    await readFile("bundles/adf/1.0.0/template.json", "utf8"),
  );
  const pipeline = template.resources[0].properties;
  assert.equal(pipeline.parameters.jobYaml.type, "String");
  assert.equal(
    pipeline.parameters.ingestronEndpoint.defaultValue,
    "[parameters('endpoint')]",
  );
  const webActivities = [
    pipeline.activities[0],
    ...pipeline.activities[2].typeProperties.activities,
  ].filter((activity) => activity.type === "WebActivity");
  assert.ok(webActivities.length >= 2);
  for (const activity of webActivities) {
    assert.equal(typeof activity.policy.retry, "number");
    assert.ok(activity.policy.retry >= 0 && activity.policy.retry <= 10);
  }
});

test("v2 bundle pins all profiles and contains no ADF global dependency", async () => {
  const manifest = JSON.parse(
    await readFile("bundles/adf/2.1.0/manifest.json", "utf8"),
  );
  assert.deepEqual(Object.keys(manifest.profiles).sort(), [
    "customer-managed",
    "hosted-registered-storage",
    "hosted-transient",
  ]);
  for (const [profile, entry] of Object.entries(manifest.profiles) as [
    string,
    { template: string; templateDigest: string },
  ][]) {
    const bytes = await readFile(`bundles/adf/2.1.0/${entry.template}`);
    const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    assert.equal(entry.templateDigest, digest, profile);
    const text = bytes.toString("utf8");
    assert.doesNotMatch(text, /pipeline\(\)\.globalParameters/);
    assert.doesNotMatch(text, /func-ing-j-demoj01\.azurewebsites\.net/);
  }
});

test("transient bundle secures grants, bounds retries and deletes hosted payloads", async () => {
  const template = JSON.parse(
    await readFile("bundles/adf/2.1.0/transient-template.json", "utf8"),
  );
  const pipeline = template.resources.find((resource: { type: string }) =>
    resource.type.endsWith("/pipelines"),
  ).properties;
  const all: unknown[] = [];
  const walk = (activities: unknown[]) => {
    for (const activity of activities as Record<string, unknown>[]) {
      all.push(activity);
      const properties = activity.typeProperties as
        { activities?: unknown[] } | undefined;
      if (properties?.activities) walk(properties.activities);
    }
  };
  walk(pipeline.activities);
  const names = all.map((entry) => (entry as { name: string }).name);
  assert.ok(names.includes("Delete hosted job payloads"));
  assert.ok(!names.includes("Delete hosted upload payloads"));
  for (const activity of all as { policy?: Record<string, unknown> }[]) {
    if (!activity.policy) continue;
    assert.equal(typeof activity.policy.retry, "number");
    assert.ok(Number(activity.policy.retry) >= 0);
    assert.ok(Number(activity.policy.retry) <= 2);
  }
  const secureText = JSON.stringify(template);
  assert.match(secureText, /SecureString/);
  assert.doesNotMatch(secureText, /AccountKey|clientSecret|password/);
});

test("v2 pipelines fail ADF when a job ends unsuccessfully", async () => {
  for (const templateName of [
    "direct-template.json",
    "transient-template.json",
  ]) {
    const template = JSON.parse(
      await readFile(`bundles/adf/2.1.0/${templateName}`, "utf8"),
    );
    const pipeline = template.resources.find((resource: { type: string }) =>
      resource.type.endsWith("/pipelines"),
    ).properties;
    const gates = pipeline.activities.filter(
      (activity: { type: string }) => activity.type === "IfCondition",
    );
    assert.equal(gates.length, 1, templateName);
    const [gate] = gates;
    assert.match(
      gate.typeProperties.expression.value,
      /succeeded.*review_required/,
      templateName,
    );
    assert.equal(gate.typeProperties.ifTrueActivities.length, 0);
    assert.equal(gate.typeProperties.ifFalseActivities[0].type, "Fail");
    assert.equal(
      gate.typeProperties.ifFalseActivities[0].typeProperties.errorCode,
      "INGESTRON_JOB_TERMINAL_FAILURE",
    );
  }
});

test("v2 pipelines return one bounded durable-job result to waiting parents", async () => {
  for (const templateName of [
    "direct-template.json",
    "transient-template.json",
  ]) {
    const template = JSON.parse(
      await readFile(`bundles/adf/2.1.0/${templateName}`, "utf8"),
    );
    const pipeline = template.resources.find((resource: { type: string }) =>
      resource.type.endsWith("/pipelines"),
    ).properties;
    const returns = pipeline.activities.filter(
      (activity: { typeProperties?: { setSystemVariable?: boolean } }) =>
        activity.typeProperties?.setSystemVariable === true,
    );
    assert.equal(returns.length, 1, templateName);
    const result = returns[0].typeProperties;
    assert.equal(result.variableName, "pipelineReturnValue");
    assert.deepEqual(
      result.value.map((entry: { key: string }) => entry.key),
      ["jobId", "state", "manifestReference", "manifestDigest"],
      templateName,
    );
    const text = JSON.stringify(result);
    assert.doesNotMatch(text, /sas|token|secret|password|credential/i);
    assert.match(text, /expectedDigest/);
  }
});

test("direct profiles derive a unique package path from the ADF run", async () => {
  const template = JSON.parse(
    await readFile("bundles/adf/2.1.0/direct-template.json", "utf8"),
  );
  const pipeline = template.resources.find((resource: { type: string }) =>
    resource.type.endsWith("/pipelines"),
  ).properties;
  const submit = pipeline.activities.find(
    (activity: { name: string }) => activity.name === "Submit Ingestron job",
  );
  assert.match(submit.typeProperties.body.value, /pipeline\(\)\.RunId/);
  assert.match(submit.typeProperties.body.value, /businessRunKey/);
  assert.equal(pipeline.parameters.businessRunKey.defaultValue, "");
  assert.match(submit.typeProperties.body.value, /jobYamlPrefix/);
  assert.match(submit.typeProperties.body.value, /jobYamlSuffix/);
  assert.equal(pipeline.parameters.jobYaml, undefined);
  assert.doesNotMatch(
    await readFile("examples/monthly-close.yaml", "utf8"),
    /idempotencyKey/,
  );
});

test("Azure Profile J bundles retain Azure-owned provenance and file digests", async () => {
  for (const version of ["1.1.0", "1.1.1", "1.2.0", "1.2.1"]) {
    const root = `bundles/azure/profile-j/${version}`;
    const manifest = JSON.parse(
      await readFile(`${root}/manifest.json`, "utf8"),
    );
    assert.equal(manifest.contract, "ingestron.azure-bundle/v1");
    assert.equal(manifest.bundleVersion, version);
    assert.equal(
      manifest.source.repository,
      version.startsWith("1.2.")
        ? "ingestron-io/ingestron-azure"
        : "intentlabs-dev/ingestron-azure",
    );
    assert.match(manifest.source.revision, /^[a-f0-9]{40}$/);
    assert.equal(manifest.changePolicy.deletionAllowed, false);
    for (const [fileName, entry] of Object.entries(manifest.files) as [
      string,
      { sha256: string; size: number },
    ][]) {
      const bytes = await readFile(`${root}/${fileName}`);
      assert.equal(bytes.byteLength, entry.size);
      assert.equal(
        createHash("sha256").update(bytes).digest("hex"),
        entry.sha256,
      );
    }
  }
});

test("repository is public-source ready with release-only distribution", async () => {
  const pkg = JSON.parse(await readFile("package.json", "utf8"));
  assert.equal(pkg.private, true);
  assert.ok(pkg.files.includes("dist"));
  assert.ok(pkg.files.includes("bundles"));
  assert.equal(pkg.version, "0.3.4-preview.1");
  assert.equal(pkg.license, "Apache-2.0");
  const release = await readFile(".github/workflows/release.yml", "utf8");
  assert.match(release, /gh release create/);
  assert.doesNotMatch(release, /npm publish/i);
});

test("pnpm-style forwarded separator is accepted", () => {
  const output = execFileSync(
    process.execPath,
    ["--import", "tsx", "src/cli.ts", "--", "version", "--output", "json"],
    { encoding: "utf8" },
  );
  const envelope = JSON.parse(output);
  assert.equal(envelope.ok, true);
  assert.equal(envelope.command, "version");
  assert.equal(envelope.result.version, "0.3.4-preview.1");
});

test("help does not require command options", () => {
  const output = execFileSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "src/cli.ts",
      "azure",
      "adf-config",
      "--help",
      "--output",
      "json",
    ],
    { encoding: "utf8" },
  );
  const envelope = JSON.parse(output);
  assert.equal(envelope.ok, true);
  assert.match(envelope.result.usage, /azure init\|plan/);
  assert.match(envelope.result.usage, /https:\/\/docs\.ingestron\.io/);
});

test("azure init help names the explicit subscription and required fields", () => {
  const output = execFileSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "src/cli.ts",
      "azure",
      "init",
      "--help",
      "--output",
      "json",
    ],
    { encoding: "utf8" },
  );
  const envelope = JSON.parse(output);
  assert.equal(envelope.ok, true);
  assert.match(envelope.result.usage, /--subscription <subscription-id>/);
  assert.match(envelope.result.usage, /--planned-usd <amount>/);
  assert.match(envelope.result.usage, /https:\/\/docs\.ingestron\.io/);
});
