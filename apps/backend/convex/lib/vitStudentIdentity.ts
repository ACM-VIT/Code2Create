export const vitStudentEmailDomain = "vitstudent.ac.in";
export const vitInstitutionName = "Vellore Institute of Technology";

export function isApprovedVitStudentIdentity(args: {
  verifiedEmail: string;
  hostedDomain?: string;
  allowedDomains: readonly string[];
}) {
  const email = args.verifiedEmail.trim().toLowerCase();
  const hostedDomain = args.hostedDomain?.trim().toLowerCase();
  return (
    email.endsWith(`@${vitStudentEmailDomain}`) &&
    hostedDomain === vitStudentEmailDomain &&
    args.allowedDomains.some(
      (domain) => domain.trim().toLowerCase() === vitStudentEmailDomain,
    )
  );
}
