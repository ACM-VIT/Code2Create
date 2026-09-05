# Participant emails

These eight templates use the ACM-VIT layout and image assets seeded in production. `messages.json` contains the subjects and plain-text versions. The HTML uses the matching inline images in `assets/`.

The published communications policy in the ops dashboard controls delivery. Editing these files alone does not publish or send email. Import a ZIP containing the selected HTML and the contents of `assets/` through that template’s ZIP control; retain the matching subject and text, validate the communications draft, then publish it. The external pass QR is generated per participant by the delivery service; do not bundle a sample QR.

Selection is distinct from confirmed attendance. The RSVP invitation includes the actual deadline and directs the team lead to confirm or decline for the whole team. Only `offer_confirmed` states that attendance is confirmed. Rejected and waitlisted teams receive the community Discord link; attending teams receive the event Discord link. External admission-result and RSVP email suppression remains in the delivery layer.
