import { updateChannelSchema } from './contracts.js'
import { handleUpdateRequest } from './protocol.js'
import { R2UpdateStore } from './r2Store.js'

interface Environment {
  UPDATES: R2Bucket
  UPDATE_CHANNEL: string
  C2C_UPDATES_ADMIN_TOKEN: string
}

export default {
  fetch(request, environment) {
    const channel = updateChannelSchema.parse(environment.UPDATE_CHANNEL)
    return handleUpdateRequest(request, {
      store: new R2UpdateStore(environment.UPDATES),
      channel,
      adminToken: environment.C2C_UPDATES_ADMIN_TOKEN,
    })
  },
} satisfies ExportedHandler<Environment>
