import assert from 'node:assert/strict'
import test from 'node:test'

import { googleButtonConfiguration, googleFedCmConfiguration } from './google-fedcm-config.ts'

test('configures the browser-mediated Google button and VIT account hint', () => {
  const configuration = googleFedCmConfiguration({
    clientId: 'client.apps.googleusercontent.com',
    hostedDomain: 'vitstudent.ac.in',
    onCredential: () => undefined,
    useFedCm: true,
  })

  assert.equal(configuration.use_fedcm_for_button, true)
  assert.equal(configuration.button_auto_select, true)
  assert.equal(configuration.hd, 'vitstudent.ac.in')
  assert.equal(configuration.ux_mode, 'popup')
})

test('does not restrict the Google picker for external participants', () => {
  const configuration = googleFedCmConfiguration({
    clientId: 'client.apps.googleusercontent.com',
    onCredential: () => undefined,
    useFedCm: true,
  })

  assert.equal(configuration.hd, undefined)
})

test('uses the standard Google picker when FedCM is unavailable', () => {
  const configuration = googleFedCmConfiguration({
    clientId: 'client.apps.googleusercontent.com',
    hostedDomain: 'vitstudent.ac.in',
    onCredential: () => undefined,
    useFedCm: false,
  })

  assert.equal(configuration.use_fedcm_for_button, false)
  assert.equal(configuration.button_auto_select, false)
  assert.equal(configuration.hd, 'vitstudent.ac.in')
  assert.equal(configuration.ux_mode, 'popup')
})

test('keeps the rendered Google button within supported dimensions', () => {
  assert.equal(googleButtonConfiguration(160).width, 200)
  assert.equal(googleButtonConfiguration(318.9).width, 318)
  assert.equal(googleButtonConfiguration(900).width, 400)
})
