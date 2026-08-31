/// <reference types="google.accounts" />

type FedCmButtonConfiguration = google.accounts.id.IdConfiguration & {
  button_auto_select: boolean
}

export function googleFedCmConfiguration({
  clientId,
  hostedDomain,
  onCredential,
}: {
  clientId: string
  hostedDomain?: string
  onCredential: (response: google.accounts.id.CredentialResponse) => void
}): FedCmButtonConfiguration {
  return {
    client_id: clientId,
    callback: onCredential,
    auto_select: false,
    button_auto_select: true,
    context: 'signin',
    itp_support: true,
    use_fedcm_for_button: true,
    ux_mode: 'popup',
    ...(hostedDomain ? { hd: hostedDomain } : {}),
  }
}

export function googleButtonConfiguration(width: number): google.accounts.id.GsiButtonConfiguration {
  return {
    type: 'standard',
    theme: 'filled_black',
    size: 'large',
    text: 'continue_with',
    shape: 'pill',
    logo_alignment: 'left',
    width: Math.min(400, Math.max(200, Math.floor(width))),
  }
}
