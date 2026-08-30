# Delivery and acceptance

## 1. Delivery rule

Build the smallest complete workflow first. Each later slice must leave the earlier slices usable.

Use pnpm for all workspace commands. Use strict TypeScript. Do not add compatibility paths for removed product behavior.

## 2. Slice 0: production proof

Deliver these foundations:

- separate Vite participant, operations, and handbook applications;
- a separate Convex backend;
- a locally built and signed Expo reviewer application;
- Google sign-in through Better Auth;
- event, person, membership, role-label, permission-grant, and audit records;
- realtime subscriptions;
- server-time and idempotent-operation helpers;
- Cloudflare Worker boundaries;
- event-owned R2 storage for Expo Updates;
- Cloudflare Email Routing and the event-owned email Worker;
- local, staging, and production environment contracts; and
- backup and restore scripts.

Exit when one authenticated account can receive one scoped grant and perform one audited write. Another account without that grant must fail.

## 3. Slice 1: participant application

Deliver:

- VIT and external participant profiles;
- participant-policy publication and acceptance;
- team create and join;
- team leadership transfer;
- free-text proposal intake;
- two friendly AI follow-up questions;
- deterministic fallback questions;
- the live novelty number above the idea text box;
- final preview and membership lock;
- immutable proposal versions;
- lead revision before `applicationsCloseAt`;
- stale human-review and AI-output invalidation;
- human admission review;
- advisory AI admission recommendation;
- information requests;
- offers and capacity;
- selected-team communications;
- generic email delivery; and
- participant support.

Exit when two participant classes can form a valid team, transfer leadership, submit, revise before the deadline, receive a current-version human decision, and reload the same state on another device. Repeat the flow with OpenAI disabled.

## 4. Slice 2: attendance and location

Deliver:

- attendance-plan publication;
- staffed one-time venue arrival;
- VIT ID barcode enrollment and scanning from provisioned phones;
- external event-badge and dynamic portal QR;
- session entry, temporary exit, return, and final exit;
- participant and operations realtime views;
- manual correction and result review;
- emergency roll call;
- team-location QR on the team dashboard;
- organizer scan and zone/landmark mapping;
- location freeze and reasoned correction; and
- scanner offline replay for approved physical credentials.

Exit when VIT barcode and QR paths resolve to the same participant state. Confirm that attendance, team location, and reviewer presence use different credentials and commands.

## 5. Slice 3: one complete review

Deliver:

- reviewer profile and conflict records;
- panel plan and criterion coverage;
- reviewer clock-in;
- push-first page delivery;
- consented synthesized phone escalation;
- page acknowledgement;
- review-presence QR;
- review start and timer;
- pinned proposal and integration evidence;
- independent score drafts;
- score submission;
- evaluation aggregation; and
- participant review state.

Exit when one panel completes one review from call through accepted scorecards. Restart one reviewer phone during the review and recover the same server and local draft state.

## 6. Slice 4: floor operations

Deliver:

- deterministic panel routing from proposal domains and reviewer expertise;
- staff-managed panel queues;
- participant queue ranges;
- called, held, missed, and complete states;
- team-presence minimum checks;
- missing-reviewer substitution;
- push-to-call escalation;
- runner fallback;
- round pause and resume;
- floor map and team-location projection; and
- scoped operational overrides.

Exit when operations can route several teams, replace one absent reviewer, move one team location, pause new calls, resume, and complete active reviews without changing accepted evidence.

## 7. Slice 5: GitHub, Figma, and progress

Deliver:

- one team GitHub integration with several repositories;
- support for several GitHub installations and organizations;
- repository kind, purpose, Git tracked branch, optional root, and display order;
- baseline, webhook, reconciliation, and immutable checkpoints;
- Figma OAuth, file bindings, snapshots, exact-version renders, and comments;
- participant and reviewer evidence views;
- configured team progress checkpoints; and
- review-start evidence pinning.

Exit when a team connects two repositories and one Figma file. Start a review, change all providers, and verify that the active review still shows the pinned evidence.

## 8. Slice 6: judging and round close

Deliver:

- versioned rubric publication;
- criterion assignments;
- independent scorecards;
- score spread;
- corrections and voids;
- paper-review recovery;
- round close snapshot;
- JSON and CSV exports;
- independent export verification;
- round close and reopen; and
- participant feedback release.

Exit when the export reproduces every selected result from immutable inputs. A different authorized person must verify the files before close.

## 9. Slice 7: reliability and rehearsal

Deliver:

- health projections;
- incident records;
- manual-mode approval;
- emergency packs;
- backup and restore;
- recovery rehearsal;
- release checks;
- device fleet checks;
- provider failure checks; and
- one stored rehearsal run with named owners and final sign-off.

Exit when all required scenarios pass against staging and the production-shaped device fleet.

## 10. Slice 8: Synesthesia

Deliver:

- music catalog tracks;
- published ambience windows;
- participant request, vote, and report;
- moderation;
- one-playing invariant;
- playback acknowledgement; and
- participant music-access suspension.

Exit when duplicate music-track requests converge, votes remain person-scoped, and music state cannot affect another product domain.

## 11. Slice 9: bounded intelligence

Deliver:

- a separate Cloudflare intelligence Worker;
- signed purpose-specific ingress;
- redacted and paginated reads;
- durable run identity and continuation;
- source-linked observations and recommendations;
- sanitized lifecycle views;
- human approval through ordinary commands;
- permission and owner revocation;
- kill switch and durable abort; and
- retention cleanup.

Exit when the Worker can create a cited operations brief or recommendation but cannot call a consequential event mutation.

## 12. Environments

| Environment | Purpose |
| --- | --- |
| Local | Fast development with local services and safe fixtures |
| Staging | Production-shaped provider, device, load, and recovery checks |
| Production | The live event |

Do not share secrets, provider applications, callback URLs, buckets, domains, or databases across environments.

The release ID must appear in each client and audit record where it helps incident response.

## 13. Automated checks

### Domain and backend

Test:

- role labels do not imply permissions;
- grants enforce person, event, resource, and validity scope;
- bundle application creates explicit grants;
- concurrent grant and revoke behavior;
- participant policy acceptance;
- one-team membership;
- one-lead invariant;
- accepted leadership transfer;
- membership lock;
- proposal revision before the deadline;
- rejection at or after the deadline;
- immutable proposal versions;
- stale review and AI invalidation;
- one-to-two-question limit;
- deterministic AI fallback;
- stale novelty rejection;
- no novelty use in admission or judging;
- human control of admission;
- capacity reservation;
- attendance state transitions;
- QR-type isolation;
- location-claim and correction races;
- reviewer-page and call races;
- review start;
- score idempotency;
- round close completeness;
- export reproduction;
- support isolation; and
- Synesthesia isolation.

### Web

Test:

- Google entry and return routes;
- participant class fields;
- realtime team updates;
- leadership transfer;
- free-text proposal flow;
- two follow-up questions, including the required third total question;
- novelty number position above the idea box;
- no novelty label, theme, or prompt;
- final membership-lock preview;
- proposal revision and deadline state;
- admission state;
- GitHub multi-repository management;
- Figma file management;
- attendance status and QR;
- team-location QR;
- queue state;
- support; and
- responsive and keyboard use.

### Reviewer app

Test:

- sign-in and device registration;
- minimum-build check;
- clock-in;
- push receipt;
- consented call escalation;
- page acknowledgement and expiry;
- camera and manual-code paths;
- attendance and review-presence credential isolation;
- score draft recovery;
- offline conflict resolution;
- current review evidence;
- support; and
- update-manifest verification.

### Integration

Test:

- Google callbacks;
- OpenAI success, refusal, invalid output, timeout, rate limit, stale output, and disabled mode;
- Cloudflare email send and provider events;
- APNs and FCM token rejection;
- outbound-call dispatch, callback order, duplication, retry, cancellation, and consent revocation;
- GitHub App installation, multi-repository webhook, reconciliation, and access loss;
- Figma PKCE, token refresh, webhook, exact-version capture, and render failure;
- private-object access;
- Expo Update manifest, runtime compatibility, signature, rollback, and asset hash; and
- intelligence signatures, revocation, continuation, and abort.

## 14. Load checks

The first load run uses:

- 1,200 live clients;
- 60 attendance scans per second;
- 300 reconnects around a round start;
- 60 concurrent reviews;
- 150 operational writes per minute;
- simultaneous GitHub and Figma provider work;
- push and phone escalation bursts; and
- a full attendance-session open and close.

The final load run uses registered counts and the published schedule.

The test must measure mutation latency, subscription delay, scan queue age, page-to-acknowledgement time, call escalation time, provider work age, and error rate.

## 15. Required rehearsal scenarios

The stored rehearsal must include these cases:

1. A VIT participant scans a valid existing ID barcode.
2. An external participant scans a valid event QR.
3. Two phones scan the same participant at the same time.
4. A scan arrives while a session closes.
5. A scanner loses connection and replays approved physical-credential events.
6. A portal QR is presented while the scanner is offline.
7. A participant exits and returns several times.
8. A participant disputes a finalized attendance result.
9. Two organizers scan one team-location QR.
10. A team moves after the location freeze.
11. Two participants join the last team place.
12. Leadership transfer races a member exit.
13. Final submission races a membership change.
14. A lead revises a submitted proposal.
15. A revision races a human review.
16. A revision races AI completion.
17. A revision reaches the application deadline.
18. OpenAI refuses a follow-up request.
19. A stale novelty request finishes after the idea changes.
20. Novelty is unavailable during submission.
21. AI admission is unavailable during human review.
22. A human clears or overrides the AI recommendation.
23. A reviewer denies notification permission.
24. Push delivery fails.
25. A reviewer has not consented to phone calls.
26. A consented reviewer receives push and then a call.
27. The reviewer acknowledges while the call worker claims the job.
28. The call provider sends duplicate and out-of-order events.
29. The reviewer does not respond and the next candidate is paged.
30. A runner completes the fallback.
31. Two substitutes accept one seat.
32. A reviewer scans the wrong review-presence QR.
33. Two operators start one review.
34. A reviewer app crashes with unsaved local work.
35. A score response is lost after server acceptance.
36. A round pauses while a call or start is pending.
37. A panel has missing criterion coverage.
38. A score correction arrives near its deadline.
39. A paper review is entered and independently verified.
40. A round export fails and is retried.
41. A different person verifies and closes the round.
42. The round reopens and creates a later export revision.
43. A team connects repositories from two GitHub installations.
44. Two devices reorder repositories concurrently.
45. GitHub sends duplicate and out-of-order pushes.
46. One repository loses access while another remains healthy.
47. Figma metadata and full content disagree temporarily.
48. A Figma preview fails while the raw snapshot remains valid.
49. Provider evidence changes after review start.
50. A support owner has no read grant.
51. A support reply races a staff state change.
52. A permission is revoked during a protected command.
53. A device uses an old Expo runtime.
54. An update asset has the wrong hash.
55. Email delivery has an unknown provider result.
56. A Synesthesia music request is duplicated.
57. Two operators try to start different music tracks.
58. Convex is unavailable during active reviews.
59. The venue loses primary internet access.
60. A backup is restored to staging.
61. An intelligence run loses authority while active.
62. A separate authorized person signs the completed rehearsal.

## 16. Training

### External Judge

Training covers sign-in, clock-in, pages, call consent, review-presence scan, evidence, score draft recovery, submission, conflict reporting, and support.

### SC and JC

Training covers only the granted workspaces. Typical topics are attendance scanning, team-location mapping, queue work, runner response, support, verification, and Synesthesia operations.

### Board and Supreme

Training covers policy publication, permissions, admission decisions, protected corrections, incident control, exports, release gates, and audit.

## 17. Freeze and launch

Before launch:

- publish all event policies;
- freeze the authoritative application deadline;
- verify Google, GitHub, Figma, OpenAI, push, outbound call, email, Cloudflare, R2, and Convex production settings;
- build and sign the reviewer app locally;
- publish the approved Expo runtime and update;
- register and test the full device fleet;
- complete load checks;
- complete backup restore;
- complete all rehearsal scenarios;
- record all workstream owners;
- obtain the separate final sign-off; and
- prepare the rollback and incident pack.

## 18. Definition of done

A slice is done when:

- the user workflow works end to end;
- authorization is person-scoped and tested;
- writes are idempotent where retries are possible;
- shared mutable state uses optimistic versions;
- accepted state reaches clients in realtime;
- failure and recovery behavior are visible;
- audit records identify the actor and authorizing grant;
- production environment and secret contracts exist;
- automated checks pass;
- staging rehearsal passes; and
- the handbook contains no obsolete path.
