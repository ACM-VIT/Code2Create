/// <reference types="google.accounts" />

type FedCmButtonConfiguration = google.accounts.id.IdConfiguration & {
  button_auto_select: boolean
}

export function googleFedCmConfiguration({
  clientId,
  hostedDomain,
  onCredential,
  useFedCm,
}: {
  clientId: string
  hostedDomain?: string
  onCredential: (response: google.accounts.id.CredentialResponse) => void
  useFedCm: boolean
}): FedCmButtonConfiguration {
  return {
    client_id: clientId,
    callback: onCredential,
    auto_select: false,
    button_auto_select: useFedCm,
    context: 'signin',
    itp_support: true,
    use_fedcm_for_button: useFedCm,
    ux_mode: 'popup',
    ...(hostedDomain ? { hd: hostedDomain } : {}),
  }
}

export function googleButtonConfiguration(
  width: number,
  appearance: 'light' | 'dark' = 'dark',
): google.accounts.id.GsiButtonConfiguration {
  return {
    type: 'standard',
    theme: appearance === 'light' ? 'outline' : 'filled_black',
    size: 'large',
    text: 'continue_with',
    shape: 'pill',
    logo_alignment: 'left',
    width: Math.min(400, Math.max(200, Math.floor(width))),
  }
}
