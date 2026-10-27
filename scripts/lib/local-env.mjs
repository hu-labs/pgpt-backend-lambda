// Local environment loader for smoke tests.
//
// Typically called by setenv.sh
//
// e.g. Usage:  ./scripts/lib/local-env.mjs .env.preview.local preview test

import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { pathToFileURL } from "node:url";

export const localKeys = [
  "AWS_REGION",
  "TEST_API_URL",
  "PUBLIC_API_URL",
  "TEST_API_KEY",
  "COGNITO_USER_POOL_ID",
  "COGNITO_CLIENT_ID",
  "COGNITO_USERNAME",
  "COGNITO_PASSWORD",
  "COGNITO_SECOND_USERNAME",
  "COGNITO_SECOND_PASSWORD",
];

export function readLocalEnv(file, environment, target) {
  if (!["preview", "production"].includes(environment))
    throw new Error("Expected preview or production environment.");
  if (!["test", "public"].includes(target))
    throw new Error("Expected test or public target.");
  const parsed = parseEnv(readFileSync(file, "utf8"));
  const result = Object.fromEntries(
    localKeys.map((key) => [key, parsed[key] ?? ""]),
  );

  for (const key of [
    target === "test" ? "TEST_API_URL" : "PUBLIC_API_URL",
    ...(target === "test" ? ["TEST_API_KEY"] : []),
  ]) {
    if (!result[key]) throw new Error(`${key} is missing from ${file}.`);
  }
  if (
    Boolean(result.COGNITO_SECOND_USERNAME) !==
    Boolean(result.COGNITO_SECOND_PASSWORD)
  )
    throw new Error("Supply both second-account fields or leave both empty.");

  return { ...result, SMOKE_ENVIRONMENT: environment, SMOKE_TARGET: target };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const values = readLocalEnv(...process.argv.slice(2));
    // NUL delimiters preserve quoted passwords without executing shell syntax.
    for (const [key, value] of Object.entries(values))
      process.stdout.write(`${key}\0${value}\0`);
  } catch (error) {
    console.error(
      error.code === "ENOENT"
        ? "Local environment file is missing. Copy .env.example to the selected .env.<environment>.local file."
        : error.message,
    );

    process.exitCode = 1;
  }
}
