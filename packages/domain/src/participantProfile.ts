const whitespace = /\s+/gu;
const phoneFormatting = /[\s().-]+/gu;
const unicodeLetter = /\p{L}/gu;
const obviousPhoneSequences = new Set(["0123456789", "1234567890", "9876543210", "0987654321"]);

/** Product switches that must agree in the participant UI and backend. */
export const participantProfileCodeConfiguration: Readonly<{
  phoneVerificationEnabled: boolean;
}> = {
  phoneVerificationEnabled: true,
};

export function normalizeParticipantName(value: string) {
  return value.trim().replace(whitespace, " ");
}

export function participantNameValidationError(value: string) {
  const normalized = normalizeParticipantName(value);
  if (normalized.length < 2) return "Enter your name as it should appear for the event.";
  if (normalized.length > 100) return "Keep the name under 100 characters.";
  if (normalized.includes("@") || /https?:\/\//iu.test(normalized)) {
    return "Enter a name, not an email address or link.";
  }
  if ((normalized.match(unicodeLetter) ?? []).length < 2) {
    return "Enter a name with at least two letters.";
  }
  return null;
}

export function normalizeParticipantPhone(value: string) {
  const compact = value.trim().replace(phoneFormatting, "");
  if (/^[6-9]\d{9}$/u.test(compact)) return `+91${compact}`;
  return compact;
}

export function participantPhoneValidationError(value: string) {
  const normalized = normalizeParticipantPhone(value);
  if (!/^\+?\d+$/u.test(normalized)) {
    return "Use only digits, spaces, brackets, hyphens, and an optional leading +.";
  }
  const digits = normalized.replace("+", "");
  if (digits.length < 10 || digits.length > 15) {
    return "Enter a real phone number with 10 to 15 digits.";
  }
  if (/^(\d)\1+$/u.test(digits) || obviousPhoneSequences.has(digits)) {
    return "Enter a real phone number, not a placeholder.";
  }
  if (digits.startsWith("0")) return "Include the country code instead of a leading zero.";
  if (!normalized.startsWith("+") && !/^[6-9]\d{9}$/u.test(normalized)) {
    return "Enter a 10-digit Indian mobile number or include the country code.";
  }
  if (digits.startsWith("91") && digits.length === 12 && !/^[6-9]/u.test(digits.slice(2))) {
    return "Enter a valid Indian mobile number.";
  }
  return null;
}
