import { resolve } from "node:path";
import { stringify } from "yaml";
import { CliError } from "./errors.js";
import { isRecord, readYaml } from "./files.js";

export type ConnectionReference = {
  connection: string;
  path: string;
};

export type Recipe = {
  outcome: string;
  source: ConnectionReference;
  destination: ConnectionReference;
};

export const supportedRecipeOutcomes = [
  "workbook.to-governed-dataset",
  "landing.batch-contract-gate",
  "copy.batch-reconciliation-gate",
] as const;

const customerManagedOnlyOutcomes = new Set([
  "landing.batch-contract-gate",
  "copy.batch-reconciliation-gate",
]);

const allowedRecipeKeys = new Set(["outcome", "source", "destination"]);

function parseReference(value: unknown, field: string): ConnectionReference {
  if (!isRecord(value))
    throw new CliError("RECIPE_INVALID", `${field} must be an object`);
  for (const key of Object.keys(value))
    if (!new Set(["connection", "path"]).has(key))
      throw new CliError(
        "RECIPE_INVALID",
        `${field}.${key} is service-owned or unsupported`,
      );
  const connection = String(value.connection ?? "");
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(connection))
    throw new CliError(
      "RECIPE_INVALID",
      `${field}.connection must be a safe alias`,
    );
  const path = String(value.path ?? "");
  const segments = path.split("/");
  if (segments.at(-1) === "") segments.pop();
  if (
    !path ||
    path.length > 1024 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("\0") ||
    segments.some((segment) => !segment || segment === "..")
  )
    throw new CliError(
      "RECIPE_INVALID",
      `${field}.path must be a safe relative path`,
    );
  return { connection, path };
}

export function parseRecipe(value: unknown): Recipe {
  if (!isRecord(value))
    throw new CliError("RECIPE_INVALID", "Recipe must be an object");
  for (const key of Object.keys(value))
    if (!allowedRecipeKeys.has(key))
      throw new CliError(
        "RECIPE_INVALID",
        `${key} is service-owned or unsupported`,
      );
  const outcome = String(value.outcome ?? "");
  if (!/^[a-z][a-z0-9.-]{2,127}$/.test(outcome))
    throw new CliError("RECIPE_INVALID", "outcome must be a dotted identifier");
  if (!supportedRecipeOutcomes.includes(outcome as never))
    throw new CliError(
      "RECIPE_UNSUPPORTED",
      "Recipe outcome is unsupported in this release",
    );
  return {
    outcome,
    source: parseReference(value.source, "source"),
    destination: parseReference(value.destination, "destination"),
  };
}

export function assertRecipeProfile(recipe: Recipe, profile: string): void {
  if (
    customerManagedOnlyOutcomes.has(recipe.outcome) &&
    profile !== "customer-managed"
  ) {
    throw new CliError(
      "RECIPE_PROFILE_UNSUPPORTED",
      `${recipe.outcome} requires the customer-managed profile`,
    );
  }
}

export async function readRecipe(path: string): Promise<Recipe> {
  return parseRecipe(await readYaml(resolve(path)));
}

export function serialiseRecipe(recipe: Recipe): string {
  return stringify(recipe, { lineWidth: 0 }).trimEnd();
}

export function serialiseJobIntent(recipe: Recipe): string {
  return stringify(
    {
      outcome: recipe.outcome,
      source: recipe.source,
      destination: {
        connection: recipe.destination.connection,
        pathPrefix: recipe.destination.path,
      },
    },
    { lineWidth: 0 },
  ).trimEnd();
}
