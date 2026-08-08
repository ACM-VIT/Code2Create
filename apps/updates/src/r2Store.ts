import type { ImmutableWriteResult, StoredAsset, StoredText, UpdateStore } from './store.js'

const immutableCacheControl = 'public, max-age=31536000, immutable'
const privateCacheControl = 'private, no-store'

export class R2UpdateStore implements UpdateStore {
  constructor(private readonly bucket: R2Bucket) {}

  async getAsset(key: string): Promise<StoredAsset | null> {
    const object = await this.bucket.get(assetPath(key))
    if (!object) return null

    const contentType = object.httpMetadata?.contentType
    const sha256 = object.customMetadata?.sha256
    if (!contentType || !sha256) return null

    return {
      bytes: await object.arrayBuffer(),
      contentType,
      sha256,
    }
  }

  async hasAsset(key: string): Promise<boolean> {
    const object = await this.bucket.head(assetPath(key))
    return object?.customMetadata?.sha256 === key
  }

  async putAssetIfAbsent(
    key: string,
    bytes: ArrayBuffer,
    contentType: string,
  ): Promise<ImmutableWriteResult> {
    const written = await this.bucket.put(assetPath(key), bytes, {
      onlyIf: { etagDoesNotMatch: '*' },
      httpMetadata: {
        contentType,
        cacheControl: immutableCacheControl,
      },
      customMetadata: { sha256: key },
    })
    if (written) return 'created'

    const existing = await this.bucket.head(assetPath(key))
    return existing?.customMetadata?.sha256 === key && existing.size === bytes.byteLength
      ? 'unchanged'
      : 'conflict'
  }

  async getRelease(releaseId: string): Promise<StoredText | null> {
    return this.getText(releasePath(releaseId))
  }

  async putReleaseIfAbsent(releaseId: string, body: string): Promise<ImmutableWriteResult> {
    const path = releasePath(releaseId)
    const written = await this.bucket.put(path, body, {
      onlyIf: { etagDoesNotMatch: '*' },
      httpMetadata: {
        contentType: 'application/json; charset=utf-8',
        cacheControl: privateCacheControl,
      },
    })
    if (written) return 'created'

    const existing = await this.getText(path)
    if (!existing) return 'conflict'
    return existing.body === body ? 'unchanged' : 'conflict'
  }

  async getCurrent(runtimeVersion: string): Promise<StoredText | null> {
    return this.getText(currentPath(runtimeVersion))
  }

  async putCurrent(
    runtimeVersion: string,
    body: string,
    expectedEtag: string | null,
  ): Promise<boolean> {
    const written = await this.bucket.put(currentPath(runtimeVersion), body, {
      onlyIf: expectedEtag ? { etagMatches: expectedEtag } : { etagDoesNotMatch: '*' },
      httpMetadata: {
        contentType: 'application/json; charset=utf-8',
        cacheControl: privateCacheControl,
      },
    })
    return written !== null
  }

  private async getText(path: string): Promise<StoredText | null> {
    const object = await this.bucket.get(path)
    if (!object) return null
    return {
      body: await object.text(),
      etag: object.etag,
    }
  }
}

function assetPath(key: string) {
  return `assets/${key}`
}

function releasePath(releaseId: string) {
  return `releases/${releaseId}.json`
}

function currentPath(runtimeVersion: string) {
  return `runtimes/${runtimeVersion}/current.json`
}
