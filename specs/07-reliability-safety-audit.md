# Reliability, safety, and audit

## 1. Reliability objective

Venue connectivity may be unstable. The system must prefer an honest blocked state over false success, and protected drafts over silent loss.

## 2. Source of truth

- Convex is authoritative for application users, assignments, active review leases, submitted scores, queue order, configuration, and round state. Clerk is authoritative for authentication sessions and linked Google login identity.
- Clients may hold cached context and protected drafts.
- Every outcome-affecting mutation carries `clientMutationId`, device ID, expected entity/configuration version, and lease epoch where applicable.
- A mutation atomically updates authoritative documents, stores a command receipt, emits domain/audit events, and creates any required notification-outbox record.
- Every accepted mutation returns a durable receipt that can be queried after an ambiguous network failure.
- Conflicting versions are surfaced; last-write-wins is prohibited for outcome-affecting records.
- Convex reactive queries distribute the resulting committed snapshot to authorised clients. WebSockets are a delivery mechanism, not a second state layer.

## 3. Connectivity classes

| State | Expected behaviour |
| --- | --- |
| Healthy | Normal live operation |
| Degraded | Cache reads, retry writes, warn user, preserve order |
| Offline | Allow safe drafts; block authority-requiring transitions |
| Incident mode | Execute an explicitly activated fallback runbook |

Bluetooth/peer-to-peer relay is a deferred architecture exploration, not a product requirement.

## 4. Data protection

- Encrypt data in transit and at rest.
- Store the minimum personal data required.
- Separate public project fields from restricted identity and review data.
- Never place personal data or durable credentials in QR payloads.
- Secrets and repository credentials must not be collected in project answers.
- Restrict exports and watermark sensitive ones with actor/time.
- Define retention periods for registrations, raw reviews, audit logs, and media before launch.
- Provide an approved redaction/erasure workflow that preserves outcome integrity where legally required.

## 5. Authentication and sessions

- Verified Google identity through Clerk is required for all non-public actions.
- VIT-student provisioning validates the Google OIDC `hd` claim against configured VIT student Workspace domains. Email suffix alone is forbidden as an eligibility check.
- Google `sub`/Clerk subject anchors identity; email is a mutable verified attribute.
- Account class and authorization role are separate. Privileged grants originate from approved rosters/invitations.
- Privileged roles require recent re-verification for defined high-risk commands.
- Sessions are device-bound where practical and revocable centrally through Clerk plus application device/grant state.
- Lost devices can be invalidated without deleting submitted records.
- Role/permission changes take effect promptly.
- Rate limits and abuse protection apply to sign-in, QR, queue, voting, and admin commands.

## 6. QR safety

- QR references are signed and short-lived.
- A QR is scoped to team, round, and intended action.
- Reuse outside its scope fails visibly.
- Manual fallback requires staff verification and produces an audit event.
- Scanning never auto-submits a score or privileged action.

## 7. Data integrity

Invariant checks run continuously:

- one active team per participant;
- one active table assignment per team;
- one active queue entry per team/round;
- one active review session per team/round;
- no reviewer assigned through an active conflict;
- all required criteria covered before completion;
- all active scores reference a valid session and grant;
- round-close disposition for every eligible team.

Violations create critical alerts and freeze only the affected workflow where possible.

## 8. Backup and recovery

- Outcome-affecting records have durable primary storage and independent backup.
- Production Convex backups/exports and round-boundary signed snapshots are stored outside the live application deployment.
- Working objectives are RPO ≤ 5 minutes during active rounds and RTO ≤ 30 minutes for core review operations; rehearsals must prove or revise them before launch.
- Backups are tested, not merely configured.
- The event team performs a restore drill using representative review records.
- Export snapshots are generated at round boundaries.
- Paper/manual fallback forms, if approved, have unique identifiers and a controlled reconciliation process.

## 9. Observability

Monitor:

- request success and latency
- notification delivery/acknowledgement
- sync backlog and oldest unsynced draft
- duplicate/idempotency conflicts
- active review lease age
- queue transition delay
- panel completion
- reviewer app version
- failed QR scans
- administrator command failure
- audit pipeline health
- reactive subscription disconnect/reconnect rate
- command-to-observer propagation latency
- Clerk/Google authentication and VIT-classification failures
- notification outbox age, Expo tickets, receipts, and disabled tokens

Alerts state impact, affected scope, runbook, and owner.

## 10. Incident handling

Severity examples:

- **SEV-1**: widespread inability to start/submit reviews; data-integrity threat
- **SEV-2**: multiple panels/teams affected with workaround
- **SEV-3**: isolated workflow failure

Incident roles:

- incident commander
- technical lead
- review operations lead
- communications lead
- scribe

The incident commander can activate degraded mode. Recovery requires reconciliation before normal operation resumes.

## 11. Accessibility and inclusion

- Participant and staff experiences support keyboard, screen readers, zoom, and reduced motion.
- Status never relies on colour alone.
- Content uses clear language and avoids unexplained internal terms.
- Manual alternatives exist for camera/QR limitations.
- Notification patterns support visual/haptic alternatives.
- Accessibility needs can influence panel/table logistics without exposing medical details.

## 12. Misuse and safety

- Participants can report harassment, unsafe conduct, or review-process issues.
- Safety escalation is separate from ordinary technical help.
- Reviewers can flag prohibited or harmful project content without placing sensitive detail in broad notes.
- Synesthesia has duplicate, explicit-content, spam, and moderator controls.
- Privileged actions and exports are monitored for abuse.

## 13. Launch gates

- Threat model reviewed
- Permission matrix tested
- Data retention approved
- Backup restore passed
- Venue load test passed
- Notification test passed on supported devices
- Degraded-mode drill passed
- Audit completeness verified
- Accessibility review passed
- Incident roster and communications ready
- Google OAuth production credentials and redirect allowlists verified
- `vitstudent.ac.in` hosted-domain verification tested with valid and invalid accounts
- Clerk grant revocation propagated to Convex authorization tests
- Separate production/staging Convex, Clerk, Vercel, and EAS configuration confirmed
