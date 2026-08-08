const emailPattern = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu;
const phonePattern = /(?:\+?\d[\s().-]*){8,15}/gu;
const labelledRegistrationPattern =
  /\breg(?:istration)?\s*(?:no\.?|number)?[:\s-]*[A-Z0-9-]{5,20}\b/giu;
const vitStyleRegistrationPattern = /\b\d{2}[A-Z]{2,4}\d{3,5}\b/gu;
const secretPattern = /\b(?:sk|pk|api)[-_][A-Za-z0-9_-]{12,}\b/gu;

export function redactProjectText(value: string) {
  return value
    .replace(emailPattern, "[email removed]")
    .replace(phonePattern, "[phone removed]")
    .replace(labelledRegistrationPattern, "[identifier removed]")
    .replace(vitStyleRegistrationPattern, "[identifier removed]")
    .replace(secretPattern, "[secret removed]");
}

export function containsSensitiveProjectText(value: string) {
  return redactProjectText(value) !== value;
}
