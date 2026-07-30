# Reliability, safety, and audit

## 1. Reliability objective

Venue connectivity may be unstable. The system must prefer an honest blocked state over false success, and protected drafts over silent loss.

## 2. Source of truth

- The server is authoritative for identity, assignments, active review leases, submitted scores, queue order, and round state.
- Clients may hold cached context and protected drafts.
- Every mutation carries an idempotency key and expected entity version.
- Every accepted mutation returns a durable receipt.
- Conflicting versions are surfaced; last-write-wins is prohibited for outcome-affecting records.

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

- Verified identity is required for all non-public actions.
- Privileged roles require stronger authentication.
- Sessions are device-bound where practical and revocable centrally.
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
- Recovery point and recovery time objectives are set before architecture approval.
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

