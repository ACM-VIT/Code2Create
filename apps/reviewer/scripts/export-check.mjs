import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const reviewerDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
await rm(resolve(reviewerDirectory, "dist"), { recursive: true, force: true });

await exportPlatform("ios", true);
await exportPlatform("android", false);

function exportPlatform(platform, clearCache) {
  return new Promise((resolveExport, rejectExport) => {
    const child = spawn(
      "pnpm",
      [
        "exec",
        "expo",
        "export",
        "--platform",
        platform,
        "--output-dir",
        `dist/${platform}`,
        ...(clearCache ? ["--clear"] : []),
      ],
      {
        cwd: reviewerDirectory,
        env: process.env,
        stdio: "inherit",
      },
    );
    child.once("error", rejectExport);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolveExport();
        return;
      }
      rejectExport(new Error(`Expo ${platform} export failed (${signal ?? `exit ${code}`}).`));
    });
  });
}
