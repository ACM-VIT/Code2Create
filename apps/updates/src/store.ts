export interface StoredAsset {
  bytes: ArrayBuffer
  contentType: string
  sha256: string
}

export interface StoredText {
  body: string
  etag: string
}

export type ImmutableWriteResult = 'created' | 'unchanged' | 'conflict'

export interface UpdateStore {
  getAsset(key: string): Promise<StoredAsset | null>
  hasAsset(key: string): Promise<boolean>
  putAssetIfAbsent(
    key: string,
    bytes: ArrayBuffer,
    contentType: string,
  ): Promise<ImmutableWriteResult>
  getRelease(releaseId: string): Promise<StoredText | null>
  putReleaseIfAbsent(releaseId: string, body: string): Promise<ImmutableWriteResult>
  getCurrent(runtimeVersion: string): Promise<StoredText | null>
  putCurrent(
    runtimeVersion: string,
    body: string,
    expectedEtag: string | null,
  ): Promise<boolean>
}
