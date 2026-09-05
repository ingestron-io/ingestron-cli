/** Machine interfaces owned by the CLI, independent of its distribution version. */
export const compilerProtocol = {
  contract: "ingestron.compiler-protocol/v1",
  commandResults: {
    "project inspect-standards": "ingestron.standards-catalogue/v1",
    "project bind-standard": "ingestron.standards-binding/v1",
    "project draft-discovery": "ingestron.discovery-draft/v1",
    "project import-discovery": "ingestron.discovery-import/v1",
    "project resolve": "ingestron.contract-base-resolution/v1",
    "project validate": "ingestron.project-validation/v1",
    "gen plan": "ingestron.generation-plan/v1",
    "gen build": "ingestron.generated-project/v1",
    "gen verify": "ingestron.generated-project-verification/v1",
    "deploy plan": "ingestron.deployment-handoff/v1",
  },
} as const;
