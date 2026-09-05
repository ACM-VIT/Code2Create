import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";

// A successful Vite build does not catch a dependency calling jsxDEV in production.
for (const app of ["web", "ops"]) {
  for (const environment of ["production", "development"]) {
    test(`${app} rolling numbers render with the ${environment} React runtime`, () => {
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
        import assert from "node:assert/strict";
        import { createElement } from "react";
        import { renderToStaticMarkup } from "react-dom/server";
        import { RollingNumber, RollingText } from "@kitlangton/rolling-number/react";

        const number = renderToStaticMarkup(createElement(RollingNumber, {
          value: 1234, locales: "en-US", className: "stat", title: "Messages",
        }));
        assert.ok(number.includes('class="rn-react stat"'));
        assert.ok(number.includes('title="Messages"'));
        assert.ok(number.includes('<span class="rn-semantic">1,234</span>'));
        assert.ok(number.includes('<span class="rn-mount" aria-hidden="true"></span>'));

        const clock = renderToStaticMarkup(createElement(RollingNumber, {
          value: 9, locales: "en-US", format: { minimumIntegerDigits: 2 },
        }));
        assert.ok(clock.includes('<span class="rn-semantic">09</span>'));
        const text = renderToStaticMarkup(createElement(RollingText, { text: "Live" }));
        assert.ok(text.includes('<span class="rn-semantic">Live</span>'));
      `], {
        cwd: resolve(import.meta.dirname, "../../../", app),
        env: { ...process.env, NODE_ENV: environment },
        encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);
    });
  }
}
