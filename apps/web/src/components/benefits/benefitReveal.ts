const storagePrefix = "c2c:benefit-revealed:";

/** Presentation only: neither codes nor vendor redemption status are stored here. */
export function hasRevealedBenefit(grantId: string): boolean {
  try {
    return sessionStorage.getItem(`${storagePrefix}${grantId}`) === "1";
  } catch {
    return false;
  }
}

export function rememberBenefitReveal(grantId: string): void {
  try {
    sessionStorage.setItem(`${storagePrefix}${grantId}`, "1");
  } catch {
    // Restricted browser storage must not block access to a granted benefit.
  }
}
