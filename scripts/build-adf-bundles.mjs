import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { format } from "prettier";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bundleVersion = "2.0.4";
const sourceDirectory = resolve(root, "bundles/adf/2.0.3");
const directory = resolve(root, `bundles/adf/${bundleVersion}`);
await mkdir(directory, { recursive: true });
const sha256 = (bytes) =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

const expression = (value) => ({ value, type: "Expression" });
const dependency = (activity) => ({
  activity,
  dependencyConditions: ["Succeeded"],
});
const policy = (secureInput = true, secureOutput = true) => ({
  timeout: "0.00:02:00",
  retry: 2,
  retryIntervalInSeconds: 10,
  secureInput,
  secureOutput,
});
const authentication = {
  type: "MSI",
  resource: expression("@pipeline().parameters.ingestronAudience"),
};
const requireSuccessfulJob = (name, dependsOn) => ({
  name,
  type: "IfCondition",
  dependsOn: [dependency(dependsOn)],
  typeProperties: {
    expression: expression(
      "@contains(createArray('succeeded', 'review_required'), variables('jobState'))",
    ),
    ifTrueActivities: [],
    ifFalseActivities: [
      {
        name: "Fail terminal Ingestron job",
        type: "Fail",
        typeProperties: {
          message: expression(
            "@concat('Ingestron job ended in terminal state: ', variables('jobState'))",
          ),
          errorCode: "INGESTRON_JOB_TERMINAL_FAILURE",
        },
      },
    ],
  },
});
const web = ({
  name,
  dependsOn = [],
  method,
  path,
  body,
  secureInput,
  secureOutput,
  contentType = "application/yaml",
}) => ({
  name,
  type: "WebActivity",
  dependsOn: dependsOn.map(dependency),
  policy: policy(secureInput, secureOutput),
  typeProperties: {
    method,
    url: expression(
      `@concat(pipeline().parameters.ingestronEndpoint, ${path})`,
    ),
    ...(body === undefined
      ? {}
      : {
          headers: { "Content-Type": contentType },
          body: expression(body),
        }),
    authentication,
    turnOffAsync: true,
  },
});

const transferReference = (activity) => ({
  referenceName: "[parameters('transferDatasetName')]",
  type: "DatasetReference",
  parameters: {
    sasUri: expression(`@activity('${activity}').output.transfer.uri`),
    namespace: expression(
      `@activity('${activity}').output.transfer.location.namespace`,
    ),
    path: expression(`@activity('${activity}').output.transfer.location.path`),
    name: expression(`@activity('${activity}').output.transfer.location.name`),
  },
});

const copyToDestination = (
  name,
  dependsOn,
  grantActivity,
  folder,
  fileName,
) => ({
  name,
  type: "Copy",
  dependsOn: [dependency(dependsOn)],
  policy: policy(true, true),
  inputs: [transferReference(grantActivity)],
  outputs: [
    {
      referenceName: "[parameters('destinationDatasetName')]",
      type: "DatasetReference",
      parameters: {
        folderPath: expression(folder),
        fileName,
      },
    },
  ],
  typeProperties: {
    source: { type: "BinarySource" },
    sink: { type: "BinarySink" },
  },
});

const activities = [
  web({
    name: "Create object scoped upload",
    method: "POST",
    path: "'/v1/uploads'",
    body: "mediaType: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    secureInput: false,
    secureOutput: true,
  }),
  {
    name: "Copy source to isolated upload",
    type: "Copy",
    dependsOn: [dependency("Create object scoped upload")],
    policy: policy(true, true),
    inputs: [
      {
        referenceName: "[parameters('sourceDatasetName')]",
        type: "DatasetReference",
      },
    ],
    outputs: [transferReference("Create object scoped upload")],
    typeProperties: {
      source: { type: "BinarySource" },
      sink: { type: "BinarySink" },
    },
  },
  web({
    name: "Complete verified upload",
    dependsOn: ["Copy source to isolated upload"],
    method: "POST",
    path: "'/v1/uploads/', activity('Create object scoped upload').output.uploadId, ':complete'",
    body: "{}",
    secureInput: true,
    secureOutput: false,
  }),
  web({
    name: "Submit minimal hosted job",
    dependsOn: ["Complete verified upload"],
    method: "POST",
    path: "'/v1/jobs'",
    body: '@concat(\'{"outcome":"workbook.to-governed-dataset","source":{"uploadId":"\', activity(\'Create object scoped upload\').output.uploadId, \'"}}\')',
    contentType: "application/json",
    secureInput: true,
    secureOutput: true,
  }),
  {
    name: "Poll hosted job",
    type: "Until",
    dependsOn: [dependency("Submit minimal hosted job")],
    typeProperties: {
      expression: expression(
        "@contains(createArray('succeeded', 'review_required', 'failed', 'cancelled', 'expired'), variables('jobState'))",
      ),
      timeout: "0.00:30:00",
      activities: [
        {
          name: "Wait before hosted status",
          type: "Wait",
          typeProperties: {
            waitTimeInSeconds: expression("@pipeline().parameters.pollSeconds"),
          },
        },
        web({
          name: "Get hosted status",
          dependsOn: ["Wait before hosted status"],
          method: "GET",
          path: "'/v1/jobs/', activity('Submit minimal hosted job').output.jobId",
          secureInput: true,
          secureOutput: true,
        }),
        {
          name: "Record hosted state",
          type: "SetVariable",
          dependsOn: [dependency("Get hosted status")],
          typeProperties: {
            variableName: "jobState",
            value: expression("@activity('Get hosted status').output.state"),
          },
        },
      ],
    },
  },
  requireSuccessfulJob("Require hosted job success", "Poll hosted job"),
  web({
    name: "Issue manifest read grant",
    dependsOn: ["Require hosted job success"],
    method: "POST",
    path: "'/v1/jobs/', activity('Submit minimal hosted job').output.jobId, '/manifest:download'",
    body: "{}",
    secureInput: true,
    secureOutput: true,
  }),
  copyToDestination(
    "Copy governed manifest home",
    "Issue manifest read grant",
    "Issue manifest read grant",
    "@concat(pipeline().parameters.destinationPath, activity('Submit minimal hosted job').output.jobId)",
    "manifest.json",
  ),
  web({
    name: "Issue accepted rows read grant",
    dependsOn: ["Copy governed manifest home"],
    method: "POST",
    path: "'/v1/jobs/', activity('Submit minimal hosted job').output.jobId, '/package/data/accepted.jsonl:download'",
    body: "{}",
    secureInput: true,
    secureOutput: true,
  }),
  copyToDestination(
    "Copy governed accepted rows home",
    "Issue accepted rows read grant",
    "Issue accepted rows read grant",
    "@concat(pipeline().parameters.destinationPath, activity('Submit minimal hosted job').output.jobId, '/data')",
    "accepted.jsonl",
  ),
  web({
    name: "Delete hosted job payloads",
    dependsOn: ["Copy governed accepted rows home"],
    method: "DELETE",
    path: "'/v1/jobs/', activity('Submit minimal hosted job').output.jobId",
    secureInput: true,
    secureOutput: true,
  }),
];

const dataset = (role) => ({
  type: "Microsoft.DataFactory/factories/datasets",
  apiVersion: "2018-06-01",
  name: `[format('{0}/{1}', parameters('factoryName'), parameters('${role}DatasetName'))]`,
  properties: {
    type: "Binary",
    linkedServiceName: {
      referenceName: `[parameters('${role}LinkedService')]`,
      type: "LinkedServiceReference",
    },
    ...(role === "source"
      ? {
          typeProperties: {
            location:
              "[if(equals(parameters('sourceStore'), 'AzureBlobFS'), variables('sourceAzureBlobFSLocation'), variables('sourceAzureBlobStorageLocation'))]",
          },
        }
      : {
          parameters: {
            folderPath: { type: "String" },
            fileName: { type: "String" },
          },
          typeProperties: {
            location:
              "[if(equals(parameters('destinationStore'), 'AzureBlobFS'), variables('destinationAzureBlobFSLocation'), variables('destinationAzureBlobStorageLocation'))]",
          },
        }),
    annotations: ["ingestron-managed", `bundle:${bundleVersion}`],
  },
});

const parameters = Object.fromEntries(
  [
    "factoryName",
    "pipelineName",
    "endpoint",
    "audience",
    "sourceLinkedService",
    "sourceStore",
    "sourceNamespace",
    "sourceFolder",
    "sourceFile",
    "destinationLinkedService",
    "destinationStore",
    "destinationNamespace",
    "destinationPath",
    "transferLinkedServiceName",
    "sourceDatasetName",
    "destinationDatasetName",
    "transferDatasetName",
  ].map((name) => [name, { type: "string" }]),
);

const transient = {
  $schema:
    "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
  contentVersion: `${bundleVersion}.0`,
  parameters,
  variables: {
    sourceAzureBlobStorageLocation: {
      type: "AzureBlobStorageLocation",
      container: "[parameters('sourceNamespace')]",
      folderPath: "[parameters('sourceFolder')]",
      fileName: "[parameters('sourceFile')]",
    },
    sourceAzureBlobFSLocation: {
      type: "AzureBlobFSLocation",
      fileSystem: "[parameters('sourceNamespace')]",
      folderPath: "[parameters('sourceFolder')]",
      fileName: "[parameters('sourceFile')]",
    },
    destinationAzureBlobStorageLocation: {
      type: "AzureBlobStorageLocation",
      container: "[parameters('destinationNamespace')]",
      folderPath: expression("@dataset().folderPath"),
      fileName: expression("@dataset().fileName"),
    },
    destinationAzureBlobFSLocation: {
      type: "AzureBlobFSLocation",
      fileSystem: "[parameters('destinationNamespace')]",
      folderPath: expression("@dataset().folderPath"),
      fileName: expression("@dataset().fileName"),
    },
  },
  resources: [
    {
      type: "Microsoft.DataFactory/factories/linkedservices",
      apiVersion: "2018-06-01",
      name: "[format('{0}/{1}', parameters('factoryName'), parameters('transferLinkedServiceName'))]",
      properties: {
        type: "AzureBlobStorage",
        parameters: { sasUri: { type: "SecureString" } },
        typeProperties: {
          sasUri: {
            type: "SecureString",
            value: "@{linkedService().sasUri}",
          },
        },
        annotations: ["ingestron-managed", `bundle:${bundleVersion}`],
      },
    },
    dataset("source"),
    dataset("destination"),
    {
      type: "Microsoft.DataFactory/factories/datasets",
      apiVersion: "2018-06-01",
      name: "[format('{0}/{1}', parameters('factoryName'), parameters('transferDatasetName'))]",
      dependsOn: [
        "[resourceId('Microsoft.DataFactory/factories/linkedservices', parameters('factoryName'), parameters('transferLinkedServiceName'))]",
      ],
      properties: {
        type: "Binary",
        linkedServiceName: {
          referenceName: "[parameters('transferLinkedServiceName')]",
          type: "LinkedServiceReference",
          parameters: { sasUri: expression("@dataset().sasUri") },
        },
        parameters: {
          sasUri: { type: "String" },
          namespace: { type: "String" },
          path: { type: "String" },
          name: { type: "String" },
        },
        typeProperties: {
          location: {
            type: "AzureBlobStorageLocation",
            container: expression("@dataset().namespace"),
            folderPath: expression("@dataset().path"),
            fileName: expression("@dataset().name"),
          },
        },
        annotations: ["ingestron-managed", `bundle:${bundleVersion}`],
      },
    },
    {
      type: "Microsoft.DataFactory/factories/pipelines",
      apiVersion: "2018-06-01",
      name: "[format('{0}/{1}', parameters('factoryName'), parameters('pipelineName'))]",
      dependsOn: [
        "[resourceId('Microsoft.DataFactory/factories/datasets', parameters('factoryName'), parameters('sourceDatasetName'))]",
        "[resourceId('Microsoft.DataFactory/factories/datasets', parameters('factoryName'), parameters('destinationDatasetName'))]",
        "[resourceId('Microsoft.DataFactory/factories/datasets', parameters('factoryName'), parameters('transferDatasetName'))]",
      ],
      properties: {
        description:
          "Ingestron-managed transient transfer pipeline. Object-scoped grants are consumed inside secure activities and customer outputs are copied home before deletion.",
        parameters: {
          ingestronEndpoint: {
            type: "String",
            defaultValue: "[parameters('endpoint')]",
          },
          ingestronAudience: {
            type: "String",
            defaultValue: "[parameters('audience')]",
          },
          destinationPath: {
            type: "String",
            defaultValue: "[parameters('destinationPath')]",
          },
          pollSeconds: { type: "Int", defaultValue: 5 },
        },
        variables: {
          jobState: { type: "String", defaultValue: "queued" },
        },
        activities,
        annotations: [
          "ingestron-managed",
          `bundle:${bundleVersion}`,
          "profile:hosted-transient",
        ],
      },
    },
  ],
};

const transientBytes = Buffer.from(
  await format(JSON.stringify(transient), { parser: "json" }),
);
await writeFile(resolve(directory, "transient-template.json"), transientBytes);
const direct = JSON.parse(
  await readFile(resolve(sourceDirectory, "direct-template.json"), "utf8"),
);
direct.contentVersion = `${bundleVersion}.0`;
delete direct.parameters.recipeYaml;
direct.parameters.recipeYamlPrefix = { type: "secureString" };
direct.parameters.recipeYamlSuffix = { type: "secureString" };
const directPipeline = direct.resources.find((resource) =>
  resource.type.endsWith("/pipelines"),
);
if (!directPipeline) throw new Error("Direct ADF bundle has no pipeline.");
delete directPipeline.properties.parameters.jobYaml;
directPipeline.properties.parameters.jobYamlPrefix = {
  type: "String",
  defaultValue: "[parameters('recipeYamlPrefix')]",
};
directPipeline.properties.parameters.jobYamlSuffix = {
  type: "String",
  defaultValue: "[parameters('recipeYamlSuffix')]",
};
const directSubmit = directPipeline.properties.activities.find(
  (activity) => activity.name === "Submit Ingestron job",
);
if (!directSubmit) throw new Error("Direct ADF bundle has no submit activity.");
directSubmit.typeProperties.body = expression(
  "@concat(pipeline().parameters.jobYamlPrefix, pipeline().RunId, pipeline().parameters.jobYamlSuffix)",
);
directPipeline.properties.activities =
  directPipeline.properties.activities.filter(
    (activity) => activity.name !== "Require job success",
  );
directPipeline.properties.activities.push(
  requireSuccessfulJob("Require job success", "Poll bounded job"),
);
directPipeline.properties.annotations =
  directPipeline.properties.annotations.map((annotation) =>
    annotation.startsWith("bundle:") ? `bundle:${bundleVersion}` : annotation,
  );
const directBytes = Buffer.from(
  await format(JSON.stringify(direct), { parser: "json" }),
);
await writeFile(resolve(directory, "direct-template.json"), directBytes);
const manifestPath = resolve(directory, "manifest.json");
const manifest = JSON.parse(
  await readFile(resolve(sourceDirectory, "manifest.json"), "utf8"),
);
manifest.version = bundleVersion;
const directDigest = sha256(directBytes);
for (const profile of ["hosted-registered-storage", "customer-managed"])
  manifest.profiles[profile].templateDigest = directDigest;
manifest.profiles["hosted-transient"] = {
  template: "transient-template.json",
  templateDigest: sha256(transientBytes),
  ownedResourceTypes: [
    "Microsoft.DataFactory/factories/pipelines",
    "Microsoft.DataFactory/factories/linkedservices",
    "Microsoft.DataFactory/factories/datasets",
  ],
};
await writeFile(
  manifestPath,
  await format(JSON.stringify(manifest), { parser: "json" }),
);
console.log(
  JSON.stringify({
    version: manifest.version,
    directDigest,
    transientDigest: sha256(transientBytes),
  }),
);
