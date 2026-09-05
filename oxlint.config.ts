import { defineConfig } from "oxlint";
import antiSlop from "ultracite/oxlint/anti-slop";
import core from "ultracite/oxlint/core";

export default defineConfig({
  extends: [core, antiSlop],
  ignorePatterns: core.ignorePatterns,
  options: {
    typeAware: true,
    typeCheck: true,
  },
  overrides: [
    {
      files: ["**/*.{test,spec}.{ts,tsx,js,jsx}"],
      rules: {
        // Native and platform modules need faithful test doubles before the module graph loads.
        "anti-slop/no-module-mocking": "off",
        // Matcher sentinels such as expect.any() are intentionally typed as any by Vitest, and test
        // fixtures intentionally retain unknown-shaped payloads so production parsers can reject them.
        "anti-slop/no-object-parameters": "off",
        "anti-slop/no-unsafe-dictionary-type": "off",
        "anti-slop/no-unknown-returns": "off",
        // Vitest's URL/body matchers intentionally exercise platform string coercion and plugin APIs.
        "import/no-named-as-default-member": "off",
        // Tests deliberately inspect required fixture members and delete keys to model malformed input.
        "typescript/no-dynamic-delete": "off",
        "typescript/no-non-null-assertion": "off",
        "typescript/no-base-to-string": "off",
        "typescript/no-unsafe-argument": "off",
        "typescript/no-unsafe-assignment": "off",
        "typescript/no-unsafe-call": "off",
        "typescript/no-unsafe-member-access": "off",
        "typescript/no-unsafe-return": "off",
        "typescript/no-unsafe-type-assertion": "off",
        // Immutable fixture state is copied inside bounded test loops for behavioral fidelity.
        "oxc/no-accumulating-spread": "off",
        // Failure-path tests deliberately verify non-Error promise rejection and throw payloads.
        "no-throw-literal": "off",
        "typescript/only-throw-error": "off",
        // Hoisted module-test setup must precede imports for the fixture to observe the mocked graph.
        "import/first": "off",
        // Default lexical ordering is the behavior under test in these fixture arrays.
        "typescript/require-array-sort-compare": "off",
      },
    },
    {
      files: ["apps/reviewer/**/*.{ts,tsx,js}"],
      rules: {
        // React Native components execute only after their module-level StyleSheet constants initialize.
        "no-use-before-define": "off",
        // Expo config plugins are CommonJS modules by contract.
        "unicorn/prefer-module": "off",
        // JavaScript config plugins rely on Expo's runtime-owned CommonJS values rather than a TS schema.
        "typescript/no-unsafe-argument": "off",
        "typescript/no-unsafe-assignment": "off",
        "typescript/no-unsafe-call": "off",
        "typescript/no-unsafe-member-access": "off",
        "typescript/no-unsafe-return": "off",
        // Expo config plugins are CommonJS modules even though Oxlint parses their declarations as script globals.
        "no-implicit-globals": "off",
      },
    },
    {
      files: ["apps/reviewer/src/lib/*.test.{ts,tsx}"],
      rules: {
        // Native-host unit tests use the pinned headless renderer to exercise real
        // hooks/subscriptions. Keep this exception scoped to its two test APIs.
        "typescript/no-deprecated": ["error", {
          allow: [{
            from: "package",
            package: "react-test-renderer",
            name: ["act", "create"],
          }],
        }],
      },
    },
    {
      files: [
        "apps/backend/convex/lib/operationsAutonomyReadFactLedger.ts",
        "apps/backend/convex/reviewPush.ts",
        "apps/intelligence/src/lib/eventCommandRegistry.ts",
        "apps/intelligence/src/lib/streamTicket.ts",
        "apps/reviewer/src/lib/encrypted-local-database.ts",
        "apps/reviewer/src/lib/pager-alarm.ts",
      ],
      rules: {
        // These private helpers return decoded/cause values only to their adjacent schema or traversal owner.
        "anti-slop/no-unknown-returns": "off",
      },
    },
    {
      files: [
        "apps/backend/convex/operationsAutonomyReadPages.ts",
        "apps/intelligence/src/lib/autonomyCloudflareArtifacts.ts",
        "apps/ops/src/screens/NoveltyConfiguration.tsx",
        "apps/reviewer/src/lib/paging-settings.ts",
      ],
      rules: {
        // SQL rows, imported corpus JSON, frozen projections, and Android intent extras are open
        // value maps at the boundary that owns their validation or hands them to the platform SDK.
        "anti-slop/no-unsafe-dictionary-type": "off",
      },
    },
    {
      files: [
        "apps/backend/convex/lib/attendancePlan.ts",
        "apps/backend/convex/lib/operationsAutonomyLedger.ts",
        "apps/reviewer/src/components/ScannerPanel.tsx",
      ],
      rules: {
        // Stable hashing/serialization intentionally accepts several unrelated, caller-owned object shapes.
        "anti-slop/no-object-parameters": "off",
      },
    },
    {
      files: ["apps/backend/convex/lib/csv.ts"],
      rules: {
        // The control-character range is the exact CSV sanitization contract.
        "no-control-regex": "off",
      },
    },
    {
      files: [
        "apps/web/src/components/portal/TreeLoader.tsx",
        "apps/web/src/components/portal/botanical.tsx",
      ],
      rules: {
        // GSAP intentionally exposes the same singleton as both its default and named export.
        "import/no-named-as-default": "off",
      },
    },
    {
      files: ["apps/backend/scripts/**/*.mjs"],
      rules: {
        // These Node test-inventory scripts are JavaScript and consume JSON/file-system metadata.
        "typescript/no-unsafe-argument": "off",
        "typescript/no-unsafe-assignment": "off",
        "typescript/no-unsafe-call": "off",
        "typescript/no-unsafe-member-access": "off",
        "typescript/no-unsafe-return": "off",
      },
    },
    {
      files: ["apps/intelligence/src/lib/boundedHttpBody.ts"],
      rules: {
        // Cloudflare's stream declarations erase the byte-chunk generic in Oxlint's combined DOM model.
        "typescript/no-unsafe-argument": "off",
        "typescript/no-unsafe-member-access": "off",
      },
    },
    {
      files: ["apps/{backend/convex,intelligence/src}/lib/boundedHttpBody.ts"],
      rules: {
        // Raw JSON is returned only to the adjacent schema-owned caller; this helper owns byte limits.
        "anti-slop/no-unknown-returns": "off",
      },
    },
    {
      files: ["apps/intelligence/src/evals/{harness,autonomy-harness,autonomy-runtime-harness}.ts"],
      rules: {
        // Evaluation harnesses deliberately capture arbitrary model/tool payloads for later scoring.
        "anti-slop/no-unsafe-dictionary-type": "off",
        "anti-slop/no-unknown-returns": "off",
        // The Node evaluation server shares a project with Cloudflare Worker globals; Oxlint merges
        // their incompatible Buffer/stream declarations even though TypeScript resolves Node here.
        "typescript/no-unsafe-argument": "off",
        "typescript/no-unsafe-assignment": "off",
        "typescript/no-unsafe-call": "off",
        "typescript/no-unsafe-member-access": "off",
        "typescript/no-unsafe-return": "off",
      },
    },
    {
      files: ["apps/intelligence/src/evals/**/*.eval.ts"],
      rules: {
        // Vitest asymmetric matcher sentinels are typed as any in evaluation suites as well.
        "typescript/no-unsafe-assignment": "off",
      },
    },
    {
      files: [
        "apps/backend/convex/figmaActions.ts",
        "apps/backend/convex/lib/figmaEvidenceBrowser.ts",
      ],
      rules: {
        // These modules own traversal and validation of Figma's open provider JSON tree.
        "anti-slop/no-unsafe-dictionary-type": "off",
      },
    },
    {
      files: ["apps/trailer/**/*.{ts,tsx}"],
      rules: {
        // Remotion exposes static, this-free easing functions specifically for callback composition.
        "typescript/unbound-method": "off",
      },
    },
    {
      files: ["packages/client-observability/src/**/*.{ts,tsx}"],
      rules: {
        // Error handlers, browser capability checks, and telemetry scrubbers own dynamic SDK input.
        "anti-slop/no-runtime-typeof": "off",
        "anti-slop/no-unknown-parameters": "off",
      },
    },
    {
      files: ["packages/client-observability/src/privacy.ts"],
      rules: {
        // PostHog properties are an open recursive value tree which this module sanitizes in place.
        "anti-slop/no-unknown-returns": "off",
        "anti-slop/no-unsafe-dictionary-type": "off",
      },
    },
    {
      files: ["packages/web-auth/src/**/*.{ts,tsx}"],
      rules: {
        // JWT decoding and browser feature detection are the owning runtime boundaries here.
        "anti-slop/no-runtime-typeof": "off",
      },
    },
    {
      files: ["packages/domain/src/{index,operationsAutonomy}.ts"],
      rules: {
        // These are intentional package entry points, not accidental application barrels.
        "oxc/no-barrel-file": "off",
      },
    },
    {
      files: ["scripts/**/*.mjs"],
      rules: {
        // These runtime scripts are JavaScript; typed unsafe-value rules require TypeScript ownership.
        "typescript/no-unsafe-argument": "off",
        "typescript/no-unsafe-assignment": "off",
        "typescript/no-unsafe-call": "off",
        "typescript/no-unsafe-member-access": "off",
        "typescript/no-unsafe-return": "off",
        "typescript/strict-boolean-expressions": "off",
      },
    },
    {
      files: ["scripts/audit-production-dependencies.mjs"],
      rules: {
        // This script owns validation of pnpm's external JSON audit response.
        "anti-slop/no-runtime-typeof": "off",
        // fail() terminates the process, so the JSON error path cannot return.
        "typescript/consistent-return": "off",
      },
    },
    {
      files: ["apps/updates/src/{boundedHttpBody,protocol}.ts"],
      rules: {
        // These helpers return decoded JSON only to the adjacent Zod-owned protocol boundary.
        "anti-slop/no-unknown-returns": "off",
      },
    },
    {
      files: ["apps/updates/scripts/publish.ts"],
      rules: {
        // CLI helpers run after module initialization; their schemas are declared before publish() executes.
        "no-use-before-define": "off",
        // The Zod-validated Expo runtimeVersion union requires a representation discriminant.
        "anti-slop/no-runtime-typeof": "off",
      },
    },
    {
      files: ["apps/updates/src/protocol.test.ts"],
      rules: {
        // node:test callbacks run after this module defines its in-memory store fixture.
        "no-use-before-define": "off",
      },
    },
    {
      files: ["apps/updates/src/{boundedHttpBody,r2Store}.ts"],
      rules: {
        // Cloudflare's DOM declarations erase the byte-stream generic at these platform boundaries.
        "typescript/no-unsafe-argument": "off",
        "typescript/no-unsafe-assignment": "off",
        "typescript/no-unsafe-member-access": "off",
      },
    },
    {
      files: ["apps/updates/scripts/**/*.ts", "apps/updates/src/protocol.test.ts"],
      rules: {
        // Oxlint conflates Node Buffer with the Worker globals in this package's dual-runtime project.
        "typescript/no-unsafe-argument": "off",
        "typescript/no-unsafe-assignment": "off",
        "typescript/no-unsafe-call": "off",
        "typescript/no-unsafe-member-access": "off",
      },
    },
    {
      files: ["apps/landing/src/**/*.{ts,tsx}"],
      rules: {
        // GSAP/browser feature checks and hot-path bitwise math are intentional animation code.
        "anti-slop/no-runtime-typeof": "off",
        complexity: ["error", 100],
        "import/no-named-as-default": "off",
        "oxc/approx-constant": "off",
        "prefer-arrow-callback": "off",
        "unicorn/prefer-at": "off",
        "unicorn/prefer-math-trunc": "off",
        "unicorn/prefer-spread": "off",
      },
    },
  ],
  rules: {
    // Conditional spreads preserve omitted-vs-undefined semantics for Convex documents and APIs.
    "anti-slop/no-conditional-empty-object-spread": "off",
    // Domain APIs and third-party contracts legitimately use names such as shape and frame.
    "anti-slop/no-shape-in-symbol-names": "off",
    // Parsing, error-normalization, and capability boundaries necessarily receive unknown values and
    // narrow their runtime representation; this syntactic rule cannot identify the owning boundary.
    "anti-slop/no-runtime-typeof": "off",
    "anti-slop/no-unknown-parameters": "off",
    // Explicit return and Record annotations are deliberate public owner contracts in this repository.
    "anti-slop/no-known-value-widening": "off",
    // The typed unsafe-assertion rules remain enabled; requiring comments on compile-time assertions
    // such as `as const`, CSS custom properties, and exhaustive-union proofs adds noise, not safety.
    "anti-slop/require-safety-comment-for-type-assertion": "off",

    // The main UI/controller functions intentionally encode product state machines; a low cyclomatic
    // threshold rewards risky fragmentation without reducing their state-space complexity.
    complexity: ["error", 300],

    // These rules fight established module structure or flag deliberate sequential/bitwise code.
    "class-methods-use-this": "off",
    "arrow-body-style": "off",
    curly: "off",
    "default-case": "off",
    "func-style": "off",
    "max-classes-per-file": "off",
    "no-empty-function": "off",
    "no-await-in-loop": "off",
    "no-bitwise": "off",
    "no-inline-comments": "off",
    "no-loop-func": "off",
    // Labels are used sparingly to leave bounded nested scans once their shared limit is reached.
    "no-labels": "off",
    "no-negated-condition": "off",
    "no-nested-ternary": "off",
    "no-shadow": "off",
    "no-void": "off",
    // ES modules finish initialization before exported React handlers or service functions execute;
    // declaration order is chosen for readability, and the temporal dead zone still protects init-time use.
    "no-use-before-define": "off",
    "prefer-destructuring": "off",
    "prefer-named-capture-group": "off",
    // Formatting and micro-syntax choices are owned by the formatter and local readability, not lint.
    "func-name-matching": "off",
    "logical-assignment-operators": "off",
    "no-plusplus": "off",
    "prefer-arrow-callback": "off",
    "prefer-exponentiation-operator": "off",
    "prefer-template": "off",
    "require-await": "off",
    "require-unicode-regexp": "off",
    "sort-keys": "off",
    "sort-vars": "off",

    // This Node rule mistakes domain helpers named `callback` and Hono middleware for Node callbacks.
    "node/callback-return": "off",

    // Promise construction and chaining are required around callbacks, lazy imports, and queues.
    "promise/avoid-new": "off",
    // React state setters and SDK hooks are callbacks by API contract, including in continuations.
    "promise/no-callback-in-promise": "off",
    "promise/param-names": "off",
    "promise/no-nesting": "off",
    "promise/prefer-await-to-callbacks": "off",
    "promise/prefer-await-to-then": "off",

    // Preserve meaningful type/API choices while retaining correctness-focused typed rules.
    // Type-only import grouping is stylistic; verbatimModuleSyntax still enforces runtime correctness.
    "typescript/consistent-type-imports": "off",
    "typescript/consistent-type-definitions": "off",
    "typescript/consistent-return": "off",
    "typescript/method-signature-style": "off",
    "typescript/no-unnecessary-boolean-literal-compare": "off",
    "typescript/no-unnecessary-type-parameters": "off",
    "typescript/parameter-properties": "off",
    "typescript/prefer-regexp-exec": "off",
    "typescript/no-confusing-void-expression": ["error", { ignoreArrowShorthand: true }],
    "typescript/no-floating-promises": [
      "error",
      {
        allowForKnownSafeCalls: [
          { from: "package", name: ["describe", "it", "test"], package: "node:test" },
          { from: "package", name: ["describe", "it", "test"], package: "vitest" },
        ],
      },
    ],
    // JSX event systems intentionally ignore handler return values; handler implementations own
    // their error reporting, while promise misuse in ordinary callbacks remains checked.
    "typescript/no-misused-promises": ["error", { checksVoidReturn: { attributes: false } }],
    // String iteration is used only for ASCII protocol checks; grapheme segmentation is irrelevant.
    "typescript/no-misused-spread": "off",
    // `void` is a valid generic result for mutation attempts and Promise.withResolvers.
    "typescript/no-invalid-void-type": "off",
    // Explicit exhaustive-union proofs and CSS property extensions can appear unnecessary to the
    // analyzer while still documenting and enforcing their owner contract.
    "typescript/no-unnecessary-type-assertion": "off",
    // Literal strings, numbers, URLSearchParams, and unreachable `never` values are intentionally
    // interpolated; no-base-to-string continues to catch accidental object coercion.
    "typescript/restrict-template-expressions": "off",
    // Several classifiers intentionally map only failure states and return undefined otherwise.
    "typescript/switch-exhaustiveness-check": "off",
    "typescript/prefer-nullish-coalescing": "off",
    "typescript/prefer-as-const": "off",
    "typescript/promise-function-async": "off",
    "typescript/return-await": ["error", "error-handling-correctness-only"],
    // Truthiness is an intentional UI/domain distinction here; coercing every condition would change
    // empty-string and zero behavior. TypeScript still checks the operands themselves.
    "typescript/strict-boolean-expressions": "off",
    // no-misused-promises retains the actionable async-callback check without rejecting every callback
    // whose declared API permits either a synchronous or asynchronous implementation.
    "typescript/strict-void-return": "off",
    // These APIs are closure-owned or documented this-free callbacks; the rule cannot prove that fact.
    "typescript/unbound-method": "off",

    // The repository intentionally uses framework filenames, explicit sentinels, and callbacks.
    "unicorn/catch-error-name": "off",
    "unicorn/consistent-function-scoping": "off",
    "unicorn/filename-case": "off",
    "unicorn/import-style": "off",
    "unicorn/empty-brace-spaces": "off",
    "unicorn/escape-case": "off",
    "unicorn/new-for-builtins": "off",
    "unicorn/no-array-for-each": "off",
    "unicorn/no-array-reduce": "off",
    "unicorn/no-array-sort": "off",
    "unicorn/no-array-reverse": "off",
    "unicorn/no-await-expression-member": "off",
    "unicorn/no-negated-condition": "off",
    "unicorn/no-nested-ternary": "off",
    "unicorn/no-lonely-if": "off",
    "unicorn/no-object-as-default-parameter": "off",
    "unicorn/no-useless-collection-argument": "off",
    "unicorn/no-useless-spread": "off",
    "unicorn/no-useless-undefined": "off",
    "unicorn/no-zero-fractions": "off",
    "unicorn/numeric-separators-style": "off",
    "unicorn/consistent-existence-index-check": "off",
    "unicorn/prefer-at": "off",
    "unicorn/prefer-code-point": "off",
    "unicorn/prefer-dom-node-dataset": "off",
    "unicorn/prefer-export-from": "off",
    "unicorn/prefer-import-meta-properties": "off",
    "unicorn/prefer-logical-operator-over-ternary": "off",
    "unicorn/prefer-math-min-max": "off",
    "unicorn/prefer-module": "off",
    "unicorn/prefer-native-coercion-functions": "off",
    "unicorn/prefer-number-properties": "off",
    "unicorn/prefer-query-selector": "off",
    "unicorn/prefer-response-static-json": "off",
    "unicorn/prefer-structured-clone": "off",
    "unicorn/prefer-string-replace-all": "off",
    "unicorn/prefer-spread": "off",
    "unicorn/prefer-set-has": "off",
    "unicorn/prefer-type-error": "off",
    "unicorn/relative-url-style": "off",
    "unicorn/prefer-ternary": "off",
    "unicorn/switch-case-braces": "off",
    "unicorn/text-encoding-identifier-case": "off",

    // These syntax preferences do not improve the ownership or safety of the modeled type.
    "import/consistent-type-specifier-style": "off",
    "typescript/array-type": "off",
    "typescript/dot-notation": "off",
    "typescript/no-inferrable-types": "off",
  },
});
