import assert from "node:assert/strict";
import test from "node:test";

import {
  maskReplayAttribute,
  maskReplayInput,
  maskReplayText,
  sanitizeTelemetryUrl,
  scrubPostHogEvent,
} from "./privacy.ts";

test("PostHog events retain diagnostic context while redacting actual PII", () => {
  const maskedEmail = "•".repeat("person@example.org".length);
  const event = scrubPostHogEvent({
    event: "$exception",
    $set: { email: "person@example.org", plan: "organizer" },
    properties: {
      token: "public-project-token",
      distinct_id: "user-1",
      c2c_surface: "operations-web",
      proposal: "A debugging workspace for student teams",
      $current_url: "https://event.example.org/admissions/j57abc123?token=secret#answer",
      $pathname: "/reviews/j57abc123",
      $exception_message: "Failure while reading a debugging workspace",
      $exception_list: [
        {
          type: "Error",
          value: "Participant person@example.org submitted 23BCE1234",
          mechanism: { type: "generic", handled: true, data: { stage: "submission" } },
          stacktrace: {
            type: "raw",
            frames: [
              {
                platform: "web:javascript",
                function: "submitApplication",
                lineno: 52,
                colno: 8,
                in_app: true,
                filename: "https://cdn.example.org/vendor/bridge.js?session=secret",
                context_line: "throw new Error(idea)",
              },
            ],
          },
        },
      ],
    },
  });

  assert.deepEqual(event, {
    event: "$exception",
    $set: { email: maskedEmail, plan: "organizer" },
    properties: {
      token: "public-project-token",
      distinct_id: "user-1",
      c2c_surface: "operations-web",
      proposal: "A debugging workspace for student teams",
      $current_url: "https://event.example.org/admissions/j57abc123",
      $pathname: "/reviews/j57abc123",
      $exception_message: "Failure while reading a debugging workspace",
      $exception_list: [
        {
          type: "Error",
          value: "Participant [redacted email] submitted [redacted registration]",
          mechanism: { type: "generic", handled: true, data: { stage: "submission" } },
          stacktrace: {
            type: "raw",
            frames: [
              {
                platform: "web:javascript",
                function: "submitApplication",
                lineno: 52,
                colno: 8,
                in_app: true,
                filename: "https://cdn.example.org/vendor/bridge.js",
                context_line: "throw new Error(idea)",
              },
            ],
          },
        },
      ],
    },
  });
});

test("PostHog filtering preserves custom properties and autocapture context", () => {
  const maskedEmail = "•".repeat("person@example.org".length);
  const event = scrubPostHogEvent({
    event: "application_opened",
    properties: {
      unknown: { nested: { answer: "A live transit visualizer" } },
      email: "person@example.org",
      "$feature/intake": "enabled",
      $active_feature_flags: ["intake", 42],
      $elements: [
        {
          tag_name: "button",
          nth_child: 2,
          classes: ["primary-button", "wide"],
          text: "Submit this idea",
          "attr__data-email": "person@example.org",
        },
      ],
    },
  });
  assert.deepEqual(event, {
    event: "application_opened",
    properties: {
      unknown: { nested: { answer: "A live transit visualizer" } },
      email: maskedEmail,
      "$feature/intake": "enabled",
      $active_feature_flags: ["intake", 42],
      $elements: [
        {
          tag_name: "button",
          nth_child: 2,
          classes: ["primary-button", "wide"],
          text: "Submit this idea",
          "attr__data-email": maskedEmail,
        },
      ],
    },
  });
});

test("known injected Android browser bridge exceptions are ignored", () => {
  const event = scrubPostHogEvent({
    event: "$exception",
    properties: {
      $exception_list: [
        {
          type: "Error",
          stacktrace: { frames: [{ function: "sendDataToNative", in_app: true }] },
        },
      ],
    },
  });
  assert.equal(event, null);
});

test("session replay payloads remain decodable after recorder masking", () => {
  const event = {
    event: "$snapshot",
    properties: {
      $snapshot_data: { type: 3, data: { source: 0 } },
      $session_id: "session-1",
    },
  };
  assert.equal(scrubPostHogEvent(event), event);
});

test("session replay keeps exact product text and layout while redacting PII", () => {
  const idea = "A debugging workspace that replays production failures.";
  assert.equal(maskReplayInput(idea), idea);
  assert.equal(maskReplayText(idea), idea);
  assert.equal(
    maskReplayText("Contact person@example.org or +91 98765 43210, 23BCE1234."),
    "Contact [redacted email] or [redacted phone], [redacted registration].",
  );
  assert.equal(maskReplayAttribute("class", "participant-card rounded"), "participant-card rounded");
  assert.match(maskReplayAttribute("data-email", "person@example.org"), /^•+$/u);
});

test("telemetry URLs keep useful paths while dropping secrets", () => {
  assert.equal(
    sanitizeTelemetryUrl("https://c2c.sh/admissions/j57abc123?token=secret#answer"),
    "https://c2c.sh/admissions/j57abc123",
  );
  assert.equal(sanitizeTelemetryUrl("https://c2c.sh/join/C2C7ABC"), "https://c2c.sh/join/:id");
  assert.equal(sanitizeTelemetryUrl("http://[broken"), "http://[broken");
});
