import { z } from 'zod'

import {
  activationRequestSchema,
  assetKeySchema,
  currentReleaseResponseSchema,
  maximumUpdateActivationBytes,
  maximumUpdateAssetBytes,
  maximumUpdateFutureSkewMs,
  maximumUpdateReleaseBytes,
  noUpdateDirectiveSchema,
  releaseIdSchema,
  releaseRecordSchema,
  rollbackDirectiveSchema,
  runtimeVersionSchema,
  updateManifestSchema,
  updatePlatformSchema,
  type ReleaseRecord,
  type SignedPayload,
  type UpdateChannel,
  type UpdatePlatform,
} from './contracts.js'
import type { UpdateStore } from './store.js'
import {
  HttpBodyInvalidJsonError,
  HttpBodyNotJsonError,
  HttpBodyTooLargeError,
  readBoundedRequestBytes,
  readBoundedRequestJson,
} from './boundedHttpBody.js'

interface RequestContext {
  store: UpdateStore
  channel: UpdateChannel
  adminToken?: string
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export async function handleUpdateRequest(
  request: Request,
  context: RequestContext,
): Promise<Response> {
  try {
    return await routeRequest(request, context)
  } catch (error) {
    if (error instanceof HttpBodyTooLargeError) {
      return jsonResponse(413, { error: 'Payload too large.' })
    }
    if (error instanceof HttpBodyNotJsonError) {
      return jsonResponse(415, { error: 'Unsupported media type.' })
    }
    if (error instanceof HttpBodyInvalidJsonError) {
      return jsonResponse(400, { error: 'Invalid JSON.' })
    }
    if (error instanceof HttpError) return jsonResponse(error.status, { error: error.message })
    if (error instanceof z.ZodError) {
      const issue = error.issues[0]
      return jsonResponse(400, {
        error: 'Invalid request.',
        ...(issue ? { field: issue.path.join('.'), detail: issue.message } : {}),
      })
    }
    console.error('Unhandled updates service error', error)
    return jsonResponse(500, { error: 'Internal error.' })
  }
}

async function routeRequest(request: Request, context: RequestContext): Promise<Response> {
  const url = new URL(request.url)
  const segments = url.pathname.split('/').filter(Boolean)

  if (request.method === 'GET' && segments.length === 1 && segments[0] === 'health') {
    return jsonResponse(200, { service: 'code2create-updates', channel: context.channel })
  }

  if (request.method === 'GET' && segments.length === 1 && segments[0] === 'manifest') {
    return serveManifest(request, context)
  }

  if (
    (request.method === 'GET' || request.method === 'HEAD') &&
    segments.length === 2 &&
    segments[0] === 'assets'
  ) {
    return serveAsset(request.method, assetKeySchema.parse(segments[1]), context.store)
  }

  if (segments[0] !== 'admin') throw new HttpError(404, 'Not found.')
  await requireAdmin(request, context.adminToken)

  if (request.method === 'GET' && segments.length === 2 && segments[1] === 'current') {
    return getCurrentRelease(url, context.store)
  }

  if (request.method === 'PUT' && segments.length === 3 && segments[1] === 'assets') {
    return uploadAsset(request, assetKeySchema.parse(segments[2]), context.store)
  }

  if (request.method === 'PUT' && segments.length === 3 && segments[1] === 'releases') {
    return registerRelease(
      request,
      releaseIdSchema.parse(segments[2]),
      url.origin,
      context,
    )
  }

  if (request.method === 'GET' && segments.length === 3 && segments[1] === 'releases') {
    return getRelease(releaseIdSchema.parse(segments[2]), context.store)
  }

  if (
    request.method === 'POST' &&
    segments.length === 4 &&
    segments[1] === 'releases' &&
    segments[3] === 'activate'
  ) {
    return activateRelease(request, releaseIdSchema.parse(segments[2]), context)
  }

  throw new HttpError(404, 'Not found.')
}

async function serveManifest(request: Request, context: RequestContext): Promise<Response> {
  if (request.headers.get('expo-protocol-version') !== '1') {
    throw new HttpError(400, 'Expo Updates protocol version 1 is required.')
  }
  if (!request.headers.get('expo-expect-signature')) {
    throw new HttpError(400, 'A signed response is required.')
  }

  const runtimeVersion = runtimeVersionSchema.parse(request.headers.get('expo-runtime-version'))
  const platform = updatePlatformSchema.parse(request.headers.get('expo-platform'))
  const current = await context.store.getCurrent(runtimeVersion)
  if (!current) throw new HttpError(404, 'No release is published for this runtime.')

  const release = parseReleaseRecord(current.body)
  if (release.channel !== context.channel || release.runtimeVersion !== runtimeVersion) {
    throw new Error('The current release pointer is inconsistent.')
  }

  const currentUpdateId = request.headers.get('expo-current-update-id')
  if (release.kind === 'update') {
    const platformRelease = release.platforms[platform]
    return currentUpdateId === platformRelease.updateId
      ? multipartDirective(release.noUpdate)
      : multipartManifest(platformRelease.manifest)
  }

  const embeddedUpdateId = request.headers.get('expo-embedded-update-id')
  if (!embeddedUpdateId) {
    throw new HttpError(400, 'Expo-Embedded-Update-ID is required for rollback.')
  }
  return currentUpdateId === embeddedUpdateId
    ? multipartDirective(release.noUpdate)
    : multipartDirective(release.directive)
}

async function serveAsset(
  method: 'GET' | 'HEAD',
  key: string,
  store: UpdateStore,
): Promise<Response> {
  const asset = await store.getAsset(key)
  if (!asset || asset.sha256 !== key) throw new HttpError(404, 'Asset not found.')

  return new Response(method === 'HEAD' ? null : asset.body, {
    status: 200,
    headers: {
      'cache-control': 'public, max-age=31536000, immutable',
      'content-type': asset.contentType,
      etag: `"${key}"`,
      'x-content-type-options': 'nosniff',
    },
  })
}

async function uploadAsset(request: Request, key: string, store: UpdateStore): Promise<Response> {
  const contentType = request.headers.get('content-type')?.trim()
  if (!contentType || contentType.length > 120 || /[\r\n]/u.test(contentType)) {
    throw new HttpError(400, 'A valid Content-Type is required.')
  }

  const bytes = await readBoundedRequestBytes(request, maximumUpdateAssetBytes)
  const actualKey = await sha256Hex(bytes)
  if (actualKey !== key) throw new HttpError(409, 'Asset hash does not match its key.')

  const result = await store.putAssetIfAbsent(key, bytes, contentType)
  if (result === 'conflict') throw new HttpError(409, 'Asset key already contains different data.')
  return jsonResponse(result === 'created' ? 201 : 200, { asset: key, result })
}

async function registerRelease(
  request: Request,
  releaseId: string,
  requestOrigin: string,
  context: RequestContext,
): Promise<Response> {
  const release = releaseRecordSchema.parse(
    await readBoundedRequestJson(request, maximumUpdateReleaseBytes),
  )
  if (release.releaseId !== releaseId) throw new HttpError(400, 'Release ID does not match the path.')
  if (release.channel !== context.channel) throw new HttpError(400, 'Release channel is incorrect.')
  if (Date.parse(release.createdAt) > Date.now() + maximumUpdateFutureSkewMs) {
    throw new HttpError(400, 'Release creation time is too far in the future.')
  }

  await validateRelease(release, requestOrigin, context.store)
  const body = JSON.stringify(release)
  const result = await context.store.putReleaseIfAbsent(releaseId, body)
  if (result === 'conflict') throw new HttpError(409, 'Release ID already contains different data.')
  return jsonResponse(result === 'created' ? 201 : 200, { releaseId, result })
}

async function getCurrentRelease(url: URL, store: UpdateStore): Promise<Response> {
  const runtimeVersion = runtimeVersionSchema.parse(url.searchParams.get('runtimeVersion'))
  const current = await store.getCurrent(runtimeVersion)
  if (!current) {
    return jsonResponse(200, currentReleaseResponseSchema.parse({
      currentReleaseId: null,
      etag: null,
    }))
  }

  const release = parseReleaseRecord(current.body)
  return jsonResponse(200, currentReleaseResponseSchema.parse({
    currentReleaseId: release.releaseId,
    etag: current.etag,
  }))
}

async function getRelease(releaseId: string, store: UpdateStore): Promise<Response> {
  const release = await store.getRelease(releaseId)
  if (!release) throw new HttpError(404, 'Release not found.')
  return jsonResponse(200, parseReleaseRecord(release.body))
}

async function activateRelease(
  request: Request,
  releaseId: string,
  context: RequestContext,
): Promise<Response> {
  const activation = activationRequestSchema.parse(
    await readBoundedRequestJson(request, maximumUpdateActivationBytes),
  )
  const storedRelease = await context.store.getRelease(releaseId)
  if (!storedRelease) throw new HttpError(404, 'Release not found.')

  const release = parseReleaseRecord(storedRelease.body)
  if (release.channel !== context.channel) throw new Error('Stored release channel is inconsistent.')
  if (Date.parse(release.createdAt) > Date.now() + maximumUpdateFutureSkewMs) {
    throw new HttpError(409, 'Release creation time is too far in the future.')
  }

  const current = await context.store.getCurrent(release.runtimeVersion)
  const currentRelease = current ? parseReleaseRecord(current.body) : null
  const currentReleaseId = currentRelease?.releaseId ?? null
  if (activation.expectedCurrentReleaseId !== currentReleaseId) {
    throw new HttpError(409, 'The current release changed before activation.')
  }

  if (currentReleaseId === releaseId) {
    return jsonResponse(200, { releaseId, result: 'already-current' })
  }
  if (currentRelease && Date.parse(release.createdAt) <= Date.parse(currentRelease.createdAt)) {
    throw new HttpError(409, 'A release must be newer than the current release.')
  }

  const written = await context.store.putCurrent(
    release.runtimeVersion,
    storedRelease.body,
    current?.etag ?? null,
  )
  if (!written) throw new HttpError(409, 'The current release changed before activation.')
  return jsonResponse(200, { releaseId, result: 'activated' })
}

async function validateRelease(
  release: ReleaseRecord,
  requestOrigin: string,
  store: UpdateStore,
): Promise<void> {
  validateSignedPayload(release.noUpdate)
  const noUpdate = noUpdateDirectiveSchema.parse(parseJson(release.noUpdate.body))
  if (release.noUpdate.body !== JSON.stringify(noUpdate)) {
    throw new HttpError(400, 'No-update directive is not canonical JSON.')
  }

  if (release.kind === 'rollback') {
    validateSignedPayload(release.directive)
    const directive = rollbackDirectiveSchema.parse(parseJson(release.directive.body))
    if (release.directive.body !== JSON.stringify(directive)) {
      throw new HttpError(400, 'Rollback directive is not canonical JSON.')
    }
    if (directive.parameters.commitTime !== release.createdAt) {
      throw new HttpError(400, 'Rollback commit time does not match the release.')
    }
    return
  }

  const assetKeys = new Set<string>()
  validatePlatformManifest(release, 'ios', requestOrigin, assetKeys)
  validatePlatformManifest(release, 'android', requestOrigin, assetKeys)
  const availability = await Promise.all([...assetKeys].map((key) => store.hasAsset(key)))
  if (availability.some((available) => !available)) {
    throw new HttpError(409, 'Every manifest asset must be uploaded before the release.')
  }
}

function validatePlatformManifest(
  release: Extract<ReleaseRecord, { kind: 'update' }>,
  platform: UpdatePlatform,
  requestOrigin: string,
  assetKeys: Set<string>,
) {
  const platformRelease = release.platforms[platform]
  validateSignedPayload(platformRelease.manifest)
  const manifest = updateManifestSchema.parse(parseJson(platformRelease.manifest.body))
  if (platformRelease.manifest.body !== JSON.stringify(manifest)) {
    throw new HttpError(400, `${platform} manifest is not canonical JSON.`)
  }
  if (
    manifest.id !== platformRelease.updateId ||
    manifest.runtimeVersion !== release.runtimeVersion ||
    manifest.createdAt !== release.createdAt
  ) {
    throw new HttpError(400, `${platform} manifest metadata does not match the release.`)
  }

  for (const asset of [...manifest.assets, manifest.launchAsset]) {
    if (asset.hash !== hexToBase64Url(asset.key)) {
      throw new HttpError(400, `${platform} manifest contains an inconsistent asset hash.`)
    }
    const expectedUrl = new URL(`/assets/${asset.key}`, requestOrigin).href
    if (asset.url !== expectedUrl) {
      throw new HttpError(400, `${platform} manifest contains an asset from another origin.`)
    }
    assetKeys.add(asset.key)
  }
}

function validateSignedPayload(payload: SignedPayload) {
  if (!payload.signature.includes('sig=') || !payload.signature.includes('keyid="main"')) {
    throw new HttpError(400, 'Signed payload metadata is invalid.')
  }
}

function parseReleaseRecord(body: string) {
  return releaseRecordSchema.parse(parseJson(body))
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body)
  } catch {
    throw new HttpError(400, 'Invalid JSON.')
  }
}

async function requireAdmin(request: Request, adminToken?: string) {
  if (!adminToken || adminToken.length < 32) {
    throw new HttpError(503, 'Publishing is not configured.')
  }
  const provided = request.headers.get('authorization') ?? ''
  const expected = `Bearer ${adminToken}`
  if (!(await constantTimeEqual(provided, expected))) throw new HttpError(401, 'Unauthorized.')
}

async function constantTimeEqual(left: string, right: string) {
  const encoder = new TextEncoder()
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(left)),
    crypto.subtle.digest('SHA-256', encoder.encode(right)),
  ])
  const leftBytes = new Uint8Array(leftHash)
  const rightBytes = new Uint8Array(rightHash)
  let difference = 0
  for (let index = 0; index < leftBytes.length; index += 1) {
    const leftByte = leftBytes[index]
    const rightByte = rightBytes[index]
    if (leftByte === undefined || rightByte === undefined) return false
    difference |= leftByte ^ rightByte
  }
  return difference === 0
}

async function sha256Hex(bytes: ArrayBuffer) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function hexToBase64Url(hex: string) {
  const bytes = new Uint8Array(hex.length / 2)
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
  }
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

function multipartManifest(payload: SignedPayload) {
  return multipartResponse([
    {
      name: 'manifest',
      body: payload.body,
      contentType: 'application/json; charset=utf-8',
      signature: payload.signature,
    },
    {
      name: 'extensions',
      body: JSON.stringify({ assetRequestHeaders: {} }),
      contentType: 'application/json; charset=utf-8',
    },
  ])
}

function multipartDirective(payload: SignedPayload) {
  return multipartResponse([
    {
      name: 'directive',
      body: payload.body,
      contentType: 'application/json; charset=utf-8',
      signature: payload.signature,
    },
  ])
}

interface MultipartPart {
  name: string
  body: string
  contentType: string
  signature?: string
}

function multipartResponse(parts: MultipartPart[]) {
  const boundary = `expo-${crypto.randomUUID()}`
  const lines: string[] = []
  for (const part of parts) {
    lines.push(`--${boundary}`)
    lines.push(`content-disposition: form-data; name="${part.name}"`)
    lines.push(`content-type: ${part.contentType}`)
    if (part.signature) lines.push(`expo-signature: ${part.signature}`)
    lines.push('', part.body)
  }
  lines.push(`--${boundary}--`, '')

  return new Response(lines.join('\r\n'), {
    status: 200,
    headers: {
      'cache-control': 'private, no-store',
      'content-type': `multipart/mixed; boundary=${boundary}`,
      'expo-protocol-version': '1',
      'expo-sfv-version': '0',
      'x-content-type-options': 'nosniff',
    },
  })
}

function jsonResponse(status: number, value: object) {
  return Response.json(value, {
    status,
    headers: {
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    },
  })
}
