import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { expect, test } from "vitest";

test("CI smoke entry point runs without Cognito modules or installed dependencies", () => {
  const root = mkdtempSync(join(tmpdir(), "promptgpt-ci-smoke-"));

  try {
    mkdirSync(join(root, "scripts", "lib"), { recursive: true });
    for (const file of ["smoke-test.sh", "lib/smoke-test.mjs"]) {
      copyFileSync(join("scripts", file), join(root, "scripts", file));
    }

    const bootstrap = join(root, "mock-fetch.mjs");
    writeFileSync(
      bootstrap,
      `
      import assert from "node:assert/strict";
      const paths = [];
      globalThis.fetch = async (url, options) => {
        assert.equal(options.headers.Authorization, undefined);
        paths.push(new URL(url).pathname);
        return new Response(JSON.stringify({message: "Unauthorized"}), {
          status: 401, headers: {"Content-Type": "application/json"}
        });
      };
      process.on("beforeExit", () => assert.deepEqual(paths, ["/api/v1/chat", "/api/v1/threads"]));
    `,
    );

    const output = execFileSync(
      "bash",
      [join(root, "scripts", "smoke-test.sh")],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          NODE_OPTIONS: `--import=${pathToFileURL(bootstrap).href}`,
          SMOKE_ENVIRONMENT: "preview",
          SMOKE_TARGET: "public",
          PUBLIC_API_URL: "https://example.com/api/v1/chat",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    expect(output).toContain("Authentication boundary passed (preview/public)");
    expect(output).not.toContain("Authenticated smoke test passed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
