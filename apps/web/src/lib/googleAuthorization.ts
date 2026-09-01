export const vitStudentEmailDomain = 'vitstudent.ac.in'

const googleAccountsOrigin = 'https://accounts.google.com'

export function restrictGoogleAuthorizationToVitStudents(authorizationUrl: string) {
  const url = new URL(authorizationUrl)
  if (url.origin !== googleAccountsOrigin) {
    throw new Error('Google returned an unexpected authorization URL.')
  }
  url.searchParams.set('hd', vitStudentEmailDomain)
  return url.toString()
}
