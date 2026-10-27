import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  mkdirSync,
  copyFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { expect, test } from "vitest";
import { readLocalEnv } from "./local-env.mjs";

test("dotenv passwords preserve shell metacharacters as data, and omitted values clear stale accounts", () => {
  const root = mkdtempSync(join(tmpdir(), "promptgpt-env-"));
  try {
    const file = join(root, "test.env");
    writeFileSync(
      file,
      `TEST_API_URL=https://example.com/test/chat\nTEST_API_KEY=key\nCOGNITO_PASSWORD='$(echo unsafe) # space !'\n`,
    );

    const result = readLocalEnv(file, "preview", "test");
    expect(result.COGNITO_PASSWORD).toBe("$(echo unsafe) # space !");
    expect(result.COGNITO_SECOND_USERNAME).toBe("");
    expect(result.SMOKE_ENVIRONMENT).toBe("preview");
    const raw = execFileSync(
      process.execPath,
      ["scripts/lib/local-env.mjs", file, "production", "test"],
      { encoding: "utf8" },
    );

    expect(raw.split("\0")).toContain("$(echo unsafe) # space !");
    expect(() => readLocalEnv(file, "bad", "test")).toThrow();
    expect(() => readLocalEnv(file, "preview", "bad")).toThrow();
    expect(() => readLocalEnv(file, "preview", "public")).toThrow(
      "PUBLIC_API_URL",
    );

    writeFileSync(
      file,
      "PUBLIC_API_URL=https://example.com/chat\nCOGNITO_SECOND_USERNAME=b\n",
    );

    expect(() => readLocalEnv(file, "production", "public")).toThrow(
      "both second-account fields",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sourced wrappers switch stacks, preserve literal secrets and clear state after failed loads", () => {
  const root = mkdtempSync(join(tmpdir(), "promptgpt-shell-"));
  try {
    mkdirSync(join(root, "scripts", "lib"), { recursive: true });
    for (const file of [
      "lib/local-env.mjs",
      "lib/setenv.sh",
      "setenv-preview.sh",
      "setenv-production.sh",
    ])
      copyFileSync(join("scripts", file), join(root, "scripts", file));
    writeFileSync(
      join(root, ".env.preview.local"),
      `TEST_API_URL=https://preview.example/chat\nTEST_API_KEY=key\nCOGNITO_PASSWORD='$(echo unsafe) # !'\nCOGNITO_SECOND_USERNAME=second\nCOGNITO_SECOND_PASSWORD=secret\n`,
    );

    writeFileSync(
      join(root, ".env.production.local"),
      "PUBLIC_API_URL=https://production.example/chat\n",
    );

    const output = execFileSync(
      "bash",
      [
        "-c",
        `
      source "$1/scripts/setenv-preview.sh" test >/dev/null || exit 1
      [[ "$COGNITO_PASSWORD" == '$(echo unsafe) # !' ]] || exit 2
      [[ "$COGNITO_SECOND_USERNAME" == second ]] || exit 3
      source "$1/scripts/setenv-production.sh" public >/dev/null || exit 4
      [[ "$SMOKE_ENVIRONMENT" == production && "$SMOKE_TARGET" == public ]] || exit 5
      [[ -z "$COGNITO_SECOND_USERNAME" && -z "$COGNITO_PASSWORD" && -z "$TEST_API_KEY" ]] || exit 6
      if source "$1/scripts/setenv-preview.sh" wrong 2>/dev/null; then exit 7; fi
      [[ -z "\${SMOKE_TARGET:-}" && -z "\${PUBLIC_API_URL:-}" ]] || exit 8
      echo passed
    `,
        "bash",
        root,
      ],
      { encoding: "utf8" },
    );

    expect(output.trim()).toBe("passed");
    expect(() =>
      execFileSync("bash", [join(root, "scripts/setenv-preview.sh"), "test"], {
        stdio: "pipe",
      }),
    ).toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
