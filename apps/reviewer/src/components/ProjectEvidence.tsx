import { api } from '@code2create/backend/api'
import type { FunctionReturnType } from 'convex/server'
import { useAction } from 'convex/react'
import { useRef, useState } from 'react'
import { Image, Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'

type ReviewerNow = FunctionReturnType<typeof api.reviewer.now>
type ActiveReview = NonNullable<ReviewerNow['review']>
type GithubEvidence = ActiveReview['evidence']['github'][number]
type FigmaEvidence = ActiveReview['evidence']['figma'][number]
type GithubBrowseResult = FunctionReturnType<typeof api.reviewEvidenceActions.browseGithub>
type FigmaPreviewsResult = NonNullable<FunctionReturnType<typeof api.reviewEvidenceActions.figmaPreviews>>
type FigmaPreviewFact = FigmaPreviewsResult['facts'][number]
type FigmaBrowseResult = FunctionReturnType<typeof api.reviewEvidenceActions.browseFigma>
type FigmaActivityResult = NonNullable<FunctionReturnType<typeof api.reviewEvidenceActions.figmaActivity>>
type FigmaComparisonResult = NonNullable<FunctionReturnType<typeof api.reviewEvidenceActions.figmaComparison>>
type FigmaComparisonRow = FigmaComparisonResult['rows'][number]
type OpenedFigmaPreview = FunctionReturnType<typeof api.reviewEvidenceActions.openFigmaPreview> & {
  factId: FigmaPreviewFact['id']
}
type OpenedFigmaComparison = FunctionReturnType<typeof api.reviewEvidenceActions.openFigmaComparison> & {
  nodeId: string
}

export function ProjectEvidence({
  eventSlug,
  review,
}: {
  eventSlug: string
  review: ActiveReview
}) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Project</Text>
      <Text style={styles.idea}>{review.project.initialIdea}</Text>
      {review.project.intakeResponses.map((response) => (
        <View key={response.ordinal}>
          <Text style={styles.question}>{response.question}</Text>
          <Text style={styles.body}>{response.skipped ? 'Skipped by team' : response.answer}</Text>
        </View>
      ))}
      {review.project.latestCheckpoint ? (
        <View style={styles.evidenceCard}>
          <Text style={styles.value}>{review.project.latestCheckpoint.displayName}</Text>
          <Text style={styles.meta}>
            Submitted {formatMoment(review.project.latestCheckpoint.submittedAt)} · {review.project.latestCheckpoint.timing.replace('_', ' ')}
          </Text>
          <Text style={styles.question}>{review.project.latestCheckpoint.updateText}</Text>
          <Text style={styles.meta}>{review.project.latestCheckpoint.followUpQuestion}</Text>
          <Text style={styles.body}>{review.project.latestCheckpoint.followUpAnswer}</Text>
        </View>
      ) : (
        <Text style={styles.guidance}>No team checkpoint had been submitted when this review was fixed.</Text>
      )}
      <View style={styles.evidenceHeader}>
        <Text style={styles.sectionTitle}>Fixed evidence</Text>
        <Text style={styles.meta}>
          {review.evidence.capturedResourceCount}/{review.evidence.expectedResourceCount} captured
        </Text>
      </View>
      <Text style={styles.guidance}>
        This is checkpoint {shortId(review.evidence.id)}. Later provider changes do not alter it.
      </Text>
      {review.evidence.github.map((repository) => (
        <GithubEvidenceCard
          eventSlug={eventSlug}
          key={repository.bindingId}
          repository={repository}
          reviewSessionId={review.id}
        />
      ))}
      {review.evidence.figma.map((file) => (
        <FigmaEvidenceCard
          eventSlug={eventSlug}
          file={file}
          key={file.bindingId}
          reviewSessionId={review.id}
        />
      ))}
      {review.evidence.expectedResourceCount === 0 ? (
        <Text style={styles.body}>No repository or Figma file was connected for this checkpoint.</Text>
      ) : null}
    </View>
  )
}

function GithubEvidenceCard({
  eventSlug,
  reviewSessionId,
  repository,
}: {
  eventSlug: string
  reviewSessionId: ActiveReview['id']
  repository: GithubEvidence
}) {
  const browseGithub = useAction(api.reviewEvidenceActions.browseGithub)
  const [result, setResult] = useState<GithubBrowseResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const browse = async (path: string) => {
    if (busy || !repository.snapshot) return
    setBusy(true)
    setError(null)
    try {
      setResult(await browseGithub({
        eventSlug,
        reviewSessionId,
        bindingId: repository.bindingId,
        path,
      }))
    } catch (caught) {
      setError(errorMessage(caught, 'The pinned repository could not be opened.'))
    } finally {
      setBusy(false)
    }
  }

  const snapshot = repository.snapshot
  return (
    <View style={styles.evidenceCard}>
      <Text style={styles.value}>{repository.repositoryName}</Text>
      <Text style={styles.meta}>
        {repositoryKindName(repository.kind)} · {repository.purpose}
      </Text>
      <Text style={styles.meta}>
        {repository.trackedBranch}{repository.rootPath ? `/${repository.rootPath}` : ''} · {evidenceState(repository.stateAtCapture)}
      </Text>
      {snapshot ? (
        <>
          <Text style={styles.fact}>
            {shortSha(snapshot.headSha)} · topic {evidenceState(snapshot.topicState)} · {snapshot.completeness}
          </Text>
          <Text style={styles.meta}>
            {snapshot.commitCount} commits · +{snapshot.additions} −{snapshot.deletions} · {snapshot.changedFiles} files
          </Text>
          {snapshot.languageBytes.length > 0 ? (
            <Text style={styles.meta}>
              {snapshot.languageBytes.slice(0, 5).map((item) => item.language).join(', ')}
            </Text>
          ) : null}
          <Text style={styles.meta}>Captured {formatMoment(snapshot.capturedAt)}</Text>
          {!result ? (
            <EvidenceButton
              disabled={busy}
              label={busy ? 'Opening…' : 'Browse pinned files'}
              onPress={() => browse('')}
            />
          ) : (
            <GithubBrowser busy={busy} onBrowse={browse} result={result} />
          )}
        </>
      ) : (
        <Text style={styles.error}>No repository snapshot was available at this checkpoint.</Text>
      )}
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  )
}

function GithubBrowser({
  busy,
  onBrowse,
  result,
}: {
  busy: boolean
  onBrowse: (path: string) => Promise<void>
  result: GithubBrowseResult
}) {
  if (result.kind === 'directory') {
    return (
      <View style={styles.browser}>
        <View style={styles.browserHeading}>
          <Text style={styles.fact}>/{result.path}</Text>
          {result.path ? (
            <Pressable accessibilityRole="button" disabled={busy} onPress={() => void onBrowse(parentPath(result.path))}>
              <Text style={styles.textButton}>Up</Text>
            </Pressable>
          ) : null}
        </View>
        {result.entries.map((entry) => (
          <Pressable
            accessibilityRole="button"
            disabled={busy}
            key={`${entry.type}:${entry.path}`}
            onPress={() => void onBrowse(entry.path)}
            style={styles.fileRow}
          >
            <Text numberOfLines={1} style={styles.fileName}>
              {entry.type === 'directory' ? '› ' : ''}{entry.name}
            </Text>
            <Text style={styles.meta}>{entry.type === 'file' ? formatBytes(entry.size) : entry.type}</Text>
          </Pressable>
        ))}
        {result.entries.length === 0 ? <Text style={styles.meta}>This directory is empty.</Text> : null}
        {result.truncated ? <Text style={styles.error}>Directory limit reached; some entries are not shown.</Text> : null}
      </View>
    )
  }
  if (result.kind === 'text_file') {
    return (
      <View style={styles.browser}>
        <View style={styles.browserHeading}>
          <Text numberOfLines={1} style={styles.fact}>{result.path}</Text>
          <Pressable accessibilityRole="button" disabled={busy} onPress={() => void onBrowse(parentPath(result.path))}>
            <Text style={styles.textButton}>Back</Text>
          </Pressable>
        </View>
        <Text style={styles.meta}>{shortSha(result.sha)} · {formatBytes(result.size)}</Text>
        <ScrollView horizontal style={styles.codeViewport}>
          <Text selectable style={styles.code}>{result.text || 'Empty file'}</Text>
        </ScrollView>
      </View>
    )
  }
  return (
    <View style={styles.browser}>
      <View style={styles.browserHeading}>
        <Text numberOfLines={1} style={styles.fact}>{result.path}</Text>
        <Pressable accessibilityRole="button" disabled={busy} onPress={() => void onBrowse(parentPath(result.path))}>
          <Text style={styles.textButton}>Back</Text>
        </Pressable>
      </View>
      <Text style={styles.meta}>{result.type} · {formatBytes(result.size)} · {evidenceState(result.reason)}</Text>
    </View>
  )
}

function FigmaEvidenceCard({
  eventSlug,
  reviewSessionId,
  file,
}: {
  eventSlug: string
  reviewSessionId: ActiveReview['id']
  file: FigmaEvidence
}) {
  const loadPreviews = useAction(api.reviewEvidenceActions.figmaPreviews)
  const openPreview = useAction(api.reviewEvidenceActions.openFigmaPreview)
  const openArtifact = useAction(api.reviewEvidenceActions.openFigmaArtifact)
  const browseFigma = useAction(api.reviewEvidenceActions.browseFigma)
  const loadActivity = useAction(api.reviewEvidenceActions.figmaActivity)
  const loadComparison = useAction(api.reviewEvidenceActions.figmaComparison)
  const openComparison = useAction(api.reviewEvidenceActions.openFigmaComparison)
  const [previews, setPreviews] = useState<FigmaPreviewsResult | null>(null)
  const [openedPreview, setOpenedPreview] = useState<OpenedFigmaPreview | null>(null)
  const [layerBrowser, setLayerBrowser] = useState<FigmaBrowseResult | null>(null)
  const [activity, setActivity] = useState<FigmaActivityResult | null | undefined>(undefined)
  const [comparison, setComparison] = useState<FigmaComparisonResult | null | undefined>(undefined)
  const [openedComparison, setOpenedComparison] = useState<OpenedFigmaComparison | null>(null)
  const [selectedPageId, setSelectedPageId] = useState<string | null>(null)
  const [selectedFactId, setSelectedFactId] = useState<FigmaPreviewFact['id'] | null>(null)
  const [changedOnly, setChangedOnly] = useState(false)
  const [busy, setBusy] = useState<'previews' | 'preview' | 'layers' | 'artifact' | 'activity' | 'comparison' | 'comparison-preview' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const requestSequence = useRef(0)

  const inspect = async () => {
    if (busy || !file.snapshot?.preview) return
    const requestId = requestSequence.current + 1
    requestSequence.current = requestId
    setBusy('previews')
    setError(null)
    try {
      const result = await loadPreviews({ eventSlug, reviewSessionId, bindingId: file.bindingId })
      if (requestId !== requestSequence.current) return
      setPreviews(result)
      setOpenedPreview(null)
      const first = result?.facts.find((fact) => fact.renderState === 'available')
      const initial = first ?? result?.facts[0]
      setSelectedPageId(initial?.pageId ?? null)
      setSelectedFactId(initial?.id ?? null)
      if (first) {
        const opened = await openPreview({
          eventSlug,
          reviewSessionId,
          bindingId: file.bindingId,
          factId: first.id,
        })
        if (requestId !== requestSequence.current) return
        setOpenedPreview({ ...opened, factId: first.id })
      }
    } catch (caught) {
      if (requestId === requestSequence.current) {
        setError(errorMessage(caught, 'The rendered frames could not be loaded.'))
      }
    } finally {
      if (requestId === requestSequence.current) setBusy(null)
    }
  }

  const selectPreview = async (fact: FigmaPreviewFact) => {
    if (busy || fact.renderState !== 'available') return
    const requestId = requestSequence.current + 1
    requestSequence.current = requestId
    setSelectedPageId(fact.pageId)
    setSelectedFactId(fact.id)
    setBusy('preview')
    setError(null)
    try {
      const opened = await openPreview({
        eventSlug,
        reviewSessionId,
        bindingId: file.bindingId,
        factId: fact.id,
      })
      if (requestId !== requestSequence.current) return
      setOpenedPreview({ ...opened, factId: fact.id })
    } catch (caught) {
      if (requestId === requestSequence.current) {
        setOpenedPreview(null)
        setError(errorMessage(caught, 'That rendered frame could not be opened.'))
      }
    } finally {
      if (requestId === requestSequence.current) setBusy(null)
    }
  }

  const browseLayers = async (nodeId: string | undefined, childOffset: number) => {
    if (busy) return
    const requestId = requestSequence.current + 1
    requestSequence.current = requestId
    setBusy('layers')
    setError(null)
    try {
      const result = await browseFigma({
        eventSlug,
        reviewSessionId,
        bindingId: file.bindingId,
        childOffset,
        ...(nodeId ? { nodeId } : {}),
      })
      if (requestId !== requestSequence.current) return
      setLayerBrowser(result)
    } catch (caught) {
      if (requestId === requestSequence.current) {
        setError(errorMessage(caught, 'The fixed Figma layers could not be loaded.'))
      }
    } finally {
      if (requestId === requestSequence.current) setBusy(null)
    }
  }

  const download = async () => {
    if (busy || !file.snapshot?.hasFullArtifact) return
    const requestId = requestSequence.current + 1
    requestSequence.current = requestId
    setBusy('artifact')
    setError(null)
    try {
      const result = await openArtifact({ eventSlug, reviewSessionId, bindingId: file.bindingId })
      if (requestId !== requestSequence.current) return
      await Linking.openURL(result.url)
    } catch (caught) {
      if (requestId === requestSequence.current) {
        setError(errorMessage(caught, 'The protected Figma checkpoint could not be opened.'))
      }
    } finally {
      if (requestId === requestSequence.current) setBusy(null)
    }
  }

  const inspectActivity = async () => {
    if (busy || !file.snapshot) return
    const requestId = requestSequence.current + 1
    requestSequence.current = requestId
    setBusy('activity')
    setError(null)
    try {
      const result = await loadActivity({ eventSlug, reviewSessionId, bindingId: file.bindingId })
      if (requestId !== requestSequence.current) return
      setActivity(result)
    } catch (caught) {
      if (requestId === requestSequence.current) {
        setError(errorMessage(caught, 'The fixed Figma activity could not be loaded.'))
      }
    } finally {
      if (requestId === requestSequence.current) setBusy(null)
    }
  }

  const inspectComparison = async () => {
    if (busy || !file.snapshot) return
    const requestId = requestSequence.current + 1
    requestSequence.current = requestId
    setBusy('comparison')
    setError(null)
    try {
      const result = await loadComparison({ eventSlug, reviewSessionId, bindingId: file.bindingId })
      if (requestId !== requestSequence.current) return
      setComparison(result)
      setOpenedComparison(null)
    } catch (caught) {
      if (requestId === requestSequence.current) {
        setError(errorMessage(caught, 'The fixed Figma checkpoints could not be compared.'))
      }
    } finally {
      if (requestId === requestSequence.current) setBusy(null)
    }
  }

  const selectComparison = async (row: FigmaComparisonRow) => {
    if (busy) return
    const currentFactId = row.currentRenderState === 'available' ? row.currentFactId : undefined
    const previousFactId = row.previousRenderState === 'available' ? row.previousFactId : undefined
    if (!currentFactId && !previousFactId) return
    const requestId = requestSequence.current + 1
    requestSequence.current = requestId
    setBusy('comparison-preview')
    setError(null)
    try {
      const result = await openComparison({
        eventSlug,
        reviewSessionId,
        bindingId: file.bindingId,
        ...(currentFactId ? { currentFactId } : {}),
        ...(previousFactId ? { previousFactId } : {}),
      })
      if (requestId !== requestSequence.current) return
      setOpenedComparison({ ...result, nodeId: row.nodeId })
    } catch (caught) {
      if (requestId === requestSequence.current) {
        setOpenedComparison(null)
        setError(errorMessage(caught, 'Those fixed Figma frames could not be opened.'))
      }
    } finally {
      if (requestId === requestSequence.current) setBusy(null)
    }
  }

  const snapshot = file.snapshot
  const pages = previews ? previewPages(previews) : []
  const selectedPage = pages.find((page) => page.id === selectedPageId)
  const visibleFacts = selectedPage
    ? selectedPage.facts.filter((fact) => !changedOnly || fact.changeState === 'new' || fact.changeState === 'changed')
    : []
  const selectedFact = visibleFacts.find((fact) => fact.id === selectedFactId)
  return (
    <View style={styles.evidenceCard}>
      <Text style={styles.value}>{file.fileName}</Text>
      <Text style={styles.meta}>Figma {file.editorType} · {file.role} · {evidenceState(file.stateAtCapture)}</Text>
      {snapshot ? (
        <>
          <Text style={styles.fact}>
            Version {shortId(snapshot.providerVersionId)} · {snapshot.completeness}
          </Text>
          <Text style={styles.meta}>
            {snapshot.pageCount} pages · {snapshot.frameCount} frames · {snapshot.nodeCount} nodes
          </Text>
          <Text style={styles.meta}>
            {snapshot.componentCount} components · {snapshot.componentSetCount} component sets · {snapshot.styleCount} styles
          </Text>
          <Text style={styles.meta}>
            {snapshot.prototypeInteractionCount} prototype interactions · {snapshot.commentCount} comments · {snapshot.unresolvedCommentCount} open
          </Text>
          <Text style={styles.meta}>
            Provider touched {formatMoment(snapshot.providerLastTouchedAt)} · captured {formatMoment(snapshot.capturedAt)}
          </Text>
          {snapshot.preview ? (
            <Text style={styles.meta}>
              {snapshot.preview.availableCount}/{snapshot.preview.selectedNodeCount} frames rendered · {evidenceState(snapshot.preview.state)}
            </Text>
          ) : (
            <Text style={styles.error}>This checkpoint predates rendered frame capture.</Text>
          )}
          {snapshot.hasFullArtifact ? (
            <View style={styles.buttonRow}>
              <EvidenceButton
                disabled={busy !== null}
                label={busy === 'layers' ? 'Loading…' : layerBrowser ? 'Reload layers' : 'Browse layers'}
                onPress={() => browseLayers(undefined, 0)}
              />
              {snapshot.preview ? (
                <EvidenceButton
                  disabled={busy !== null}
                  label={busy === 'previews' ? 'Loading…' : previews ? 'Reload frames' : 'View frames'}
                  onPress={inspect}
                />
              ) : null}
              <EvidenceButton
                disabled={busy !== null}
                label={busy === 'artifact' ? 'Preparing…' : 'Raw file'}
                onPress={download}
                secondary
              />
            </View>
          ) : (
            <Text style={styles.error}>The checkpoint has metadata but no protected full-file artifact.</Text>
          )}
          <View style={styles.buttonRow}>
            <EvidenceButton
              disabled={busy !== null}
              label={busy === 'activity' ? 'Loading…' : activity === undefined ? 'Version activity' : 'Reload activity'}
              onPress={inspectActivity}
              secondary
            />
            <EvidenceButton
              disabled={busy !== null}
              label={busy === 'comparison' ? 'Comparing…' : comparison === undefined ? 'Compare checkpoint' : 'Reload comparison'}
              onPress={inspectComparison}
              secondary
            />
          </View>
          {layerBrowser ? (
            <FigmaLayerBrowser
              browser={layerBrowser}
              busy={busy !== null}
              onBrowse={browseLayers}
            />
          ) : null}
          {activity === null ? (
            <Text style={styles.meta}>This checkpoint predates detailed version and comment capture.</Text>
          ) : activity ? (
            <FigmaActivityPanel activity={activity} />
          ) : null}
          {comparison === null ? (
            <Text style={styles.meta}>There is no earlier rendered checkpoint for this file.</Text>
          ) : comparison ? (
            <FigmaComparisonPanel
              busy={busy !== null}
              comparison={comparison}
              onOpen={selectComparison}
              opened={openedComparison}
            />
          ) : null}
          {previews ? (
            <View style={styles.browser}>
              <Text style={styles.fact}>
                {previews.availableCount}/{previews.selectedNodeCount} rendered · {evidenceState(previews.state)}
              </Text>
              <View style={styles.pageList}>
                {pages.map((page) => (
                  <Pressable
                    accessibilityRole="button"
                    disabled={busy !== null}
                    key={page.id}
                    onPress={() => {
                      const first = page.facts.find((fact) => fact.renderState === 'available') ?? page.facts[0]
                      setSelectedPageId(page.id)
                      setSelectedFactId(first?.id ?? null)
                      setOpenedPreview(null)
                      if (first?.renderState === 'available') void selectPreview(first)
                    }}
                    style={[styles.pageChip, page.id === selectedPageId ? styles.pageChipSelected : null]}
                  >
                    <Text style={page.id === selectedPageId ? styles.pageChipTextSelected : styles.pageChipText}>
                      {page.name}
                    </Text>
                  </Pressable>
                ))}
              </View>
              {selectedPage ? (
                <View style={styles.previewBrowser}>
                  <View style={styles.browserHeading}>
                    <Text style={styles.meta}>
                      {changedOnly ? 'Changed frames' : 'All captured frames'}
                    </Text>
                    <Pressable
                      accessibilityRole="button"
                      disabled={busy !== null}
                      onPress={() => setChangedOnly((value) => !value)}
                    >
                      <Text style={styles.textButton}>{changedOnly ? 'Show all' : 'Changed only'}</Text>
                    </Pressable>
                  </View>
                  {selectedFact && openedPreview && openedPreview.factId === selectedFactId ? (
                    <Image
                      accessibilityLabel={openedPreview.nodeName}
                      resizeMode="contain"
                      source={{ uri: openedPreview.url }}
                      style={styles.previewImage}
                    />
                  ) : selectedFact?.renderState === 'pending' ? (
                    <Text style={styles.meta}>This frame is still rendering.</Text>
                  ) : selectedFact?.renderState === 'failed' ? (
                    <Text style={styles.error}>This frame could not be rendered. The raw checkpoint remains available.</Text>
                  ) : null}
                  <View style={styles.nodeList}>
                  {visibleFacts.map((fact) => (
                    <Pressable
                      accessibilityRole="button"
                      disabled={busy !== null || fact.renderState !== 'available'}
                      key={fact.id}
                      onPress={() => void selectPreview(fact)}
                      style={[styles.nodeRow, fact.id === selectedFactId ? styles.nodeRowSelected : null]}
                    >
                      <Text numberOfLines={1} style={styles.fileName}>{fact.nodeName}</Text>
                      <Text style={styles.meta}>
                        {evidenceState(fact.nodeType)} · {fact.descendantCount} layers · {evidenceState(fact.changeState)} · {evidenceState(fact.renderState)}
                      </Text>
                    </Pressable>
                  ))}
                  {visibleFacts.length === 0 ? (
                    <Text style={styles.meta}>No changed frame is present in this captured set.</Text>
                  ) : null}
                  </View>
                </View>
              ) : <Text style={styles.meta}>No renderable top-level frames were found.</Text>}
              {previews.truncated ? <Text style={styles.meta}>The checkpoint keeps the first 48 frames, balanced across pages.</Text> : null}
            </View>
          ) : null}
        </>
      ) : (
        <Text style={styles.error}>No Figma snapshot was available at this checkpoint.</Text>
      )}
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  )
}

function FigmaActivityPanel({ activity }: { activity: FigmaActivityResult }) {
  const [versionLimit, setVersionLimit] = useState(8)
  const [commentLimit, setCommentLimit] = useState(12)
  const visibleVersions = activity.versions.slice(0, versionLimit)
  const visibleComments = activity.comments.slice(0, commentLimit)
  return (
    <View style={styles.browser}>
      <View style={styles.browserHeading}>
        <Text style={styles.fact}>Version activity</Text>
        <Text style={styles.meta}>
          {activity.versionsComplete
            ? `${activity.capturedVersionCount}/${activity.versionCount} captured`
            : `${activity.capturedVersionCount} shown · at least ${activity.versionCount} observed`}
        </Text>
      </View>
      {visibleVersions.map((version) => (
        <View key={version.versionId} style={styles.activityRow}>
          <Text style={styles.fileName}>{version.label.trim() || 'Saved version'}</Text>
          <Text style={styles.meta}>{version.userHandle || 'Unknown Figma user'} · {formatMoment(version.providerCreatedAt)}</Text>
          {version.description ? (
            <Text selectable style={styles.fact}>{version.description}{version.descriptionTruncated ? '…' : ''}</Text>
          ) : null}
        </View>
      ))}
      {visibleVersions.length === 0 ? <Text style={styles.meta}>No named versions were present.</Text> : null}
      {versionLimit < activity.versions.length ? (
        <Pressable accessibilityRole="button" onPress={() => setVersionLimit((value) => value + 12)}>
          <Text style={styles.textButton}>Show more versions</Text>
        </Pressable>
      ) : null}
      {!activity.versionsComplete ? (
        <Text style={styles.meta}>The provider history exceeded the bounded checkpoint capture.</Text>
      ) : null}

      <View style={styles.browserHeading}>
        <Text style={styles.fact}>Comments</Text>
        <Text style={styles.meta}>
          {activity.capturedCommentCount}/{activity.commentCount} captured · {activity.unresolvedThreadCount} open · {activity.resolvedThreadCount} resolved · {activity.replyCount} replies
        </Text>
      </View>
      {visibleComments.map((comment) => (
        <View key={comment.commentId} style={styles.activityRow}>
          <Text style={styles.meta}>
            {comment.parentCommentId ? 'Reply' : comment.resolvedAt ? 'Resolved thread' : 'Open thread'} · {comment.userHandle || 'Unknown Figma user'} · {formatMoment(comment.providerCreatedAt)}
          </Text>
          <Text selectable style={styles.fact}>{comment.message || 'Empty comment'}{comment.messageTruncated ? '…' : ''}</Text>
          {comment.reactionCount > 0 ? <Text style={styles.meta}>{comment.reactionCount} reactions</Text> : null}
        </View>
      ))}
      {visibleComments.length === 0 ? <Text style={styles.meta}>No comments were present.</Text> : null}
      {commentLimit < activity.comments.length ? (
        <Pressable accessibilityRole="button" onPress={() => setCommentLimit((value) => value + 20)}>
          <Text style={styles.textButton}>Show more comments</Text>
        </Pressable>
      ) : null}
      {!activity.commentsComplete ? (
        <Text style={styles.meta}>The comment history exceeded the bounded checkpoint capture.</Text>
      ) : null}
      <Text style={styles.guidance}>This is observed collaboration context, not authorship or effort scoring.</Text>
    </View>
  )
}

function FigmaComparisonPanel({
  comparison,
  opened,
  busy,
  onOpen,
}: {
  comparison: FigmaComparisonResult
  opened: OpenedFigmaComparison | null
  busy: boolean
  onOpen: (row: FigmaComparisonRow) => Promise<void>
}) {
  const [changedOnly, setChangedOnly] = useState(true)
  const visibleRows = comparison.rows.filter((row) => !changedOnly || row.state !== 'unchanged')
  const selected = opened ? comparison.rows.find((row) => row.nodeId === opened.nodeId) : undefined
  return (
    <View style={styles.browser}>
      <View style={styles.browserHeading}>
        <View style={styles.browserTitle}>
          <Text style={styles.fact}>Checkpoint comparison</Text>
          <Text style={styles.meta}>
            {formatMoment(comparison.previous.capturedAt)} → {formatMoment(comparison.current.capturedAt)}
          </Text>
        </View>
        <Pressable accessibilityRole="button" disabled={busy} onPress={() => setChangedOnly((value) => !value)}>
          <Text style={styles.textButton}>{changedOnly ? 'Show all' : 'Changes only'}</Text>
        </Pressable>
      </View>
      <Text style={styles.meta}>
        {comparison.counts.changed} changed · {comparison.counts.added} added · {comparison.counts.removed} removed
        {comparison.counts.uncertain > 0 ? ` · ${comparison.counts.uncertain} outside a complete set` : ''}
      </Text>
      {selected && opened ? (
        <View style={styles.comparisonImages}>
          <ComparisonImage label="Earlier" preview={opened.previous} fallback={selected.previousRenderState} />
          <ComparisonImage label="Pinned" preview={opened.current} fallback={selected.currentRenderState} />
        </View>
      ) : null}
      <View style={styles.nodeList}>
        {visibleRows.map((row) => {
          const canOpen = row.currentRenderState === 'available' || row.previousRenderState === 'available'
          return (
            <Pressable
              accessibilityRole="button"
              disabled={busy || !canOpen}
              key={row.nodeId}
              onPress={() => void onOpen(row)}
              style={[styles.nodeRow, opened?.nodeId === row.nodeId ? styles.nodeRowSelected : null, !canOpen ? styles.disabled : null]}
            >
              <Text numberOfLines={1} style={styles.fileName}>{row.nodeName}</Text>
              <Text style={styles.meta}>{row.pageName} · {evidenceState(row.nodeType)} · {evidenceState(row.state)}</Text>
            </Pressable>
          )
        })}
        {visibleRows.length === 0 ? <Text style={styles.meta}>No changed frame was captured between these checkpoints.</Text> : null}
      </View>
      {(comparison.current.truncated || comparison.previous.truncated) && comparison.counts.uncertain > 0 ? (
        <Text style={styles.meta}>Missing rows are not called added or removed when either bounded frame set was truncated.</Text>
      ) : null}
    </View>
  )
}

function ComparisonImage({
  label,
  preview,
  fallback,
}: {
  label: string
  preview: OpenedFigmaComparison['current']
  fallback: FigmaComparisonRow['currentRenderState']
}) {
  return (
    <View style={styles.comparisonImageColumn}>
      <Text style={styles.meta}>{label}</Text>
      {preview ? (
        <Image
          accessibilityLabel={`${label} ${preview.nodeName}`}
          resizeMode="contain"
          source={{ uri: preview.url }}
          style={styles.comparisonImage}
        />
      ) : (
        <View style={styles.comparisonPlaceholder}>
          <Text style={styles.meta}>{fallback ? evidenceState(fallback) : 'Not present'}</Text>
        </View>
      )}
    </View>
  )
}

function FigmaLayerBrowser({
  browser,
  busy,
  onBrowse,
}: {
  browser: FigmaBrowseResult
  busy: boolean
  onBrowse: (nodeId: string | undefined, childOffset: number) => Promise<void>
}) {
  const parent = browser.breadcrumbs.at(-2)
  const propertyRows = figmaPropertyRows(browser.current)
  const firstChild = browser.totalChildren === 0 ? 0 : browser.childOffset + 1
  const lastChild = browser.childOffset + browser.children.length
  return (
    <View style={styles.browser}>
      <View style={styles.browserHeading}>
        <View style={styles.browserTitle}>
          <Text numberOfLines={1} style={styles.fact}>{browser.current.name}</Text>
          <Text style={styles.meta}>{evidenceState(browser.current.type)}</Text>
        </View>
        {parent ? (
          <Pressable
            accessibilityRole="button"
            disabled={busy}
            onPress={() => void onBrowse(parent.id, 0)}
          >
            <Text style={styles.textButton}>Up</Text>
          </Pressable>
        ) : null}
      </View>
      <Text numberOfLines={2} style={styles.meta}>
        {browser.breadcrumbsTruncated ? '… / ' : ''}
        {browser.breadcrumbs.map((item) => item.name).join(' / ')}
      </Text>
      {browser.current.textPreview ? (
        <Text selectable style={styles.layerText}>
          {browser.current.textPreview}{browser.current.textPreviewTruncated ? '…' : ''}
        </Text>
      ) : null}
      {propertyRows.length > 0 ? (
        <View style={styles.propertyList}>
          {propertyRows.map((property) => (
            <View key={property.label} style={styles.propertyRow}>
              <Text style={styles.meta}>{property.label}</Text>
              <Text style={styles.fact}>{property.value}</Text>
            </View>
          ))}
        </View>
      ) : null}
      {browser.current.component ? (
        <View style={styles.layerBlock}>
          <Text style={styles.meta}>Component</Text>
          <Text style={styles.fact}>{browser.current.component.name ?? browser.current.component.nodeId}</Text>
          {browser.current.component.description ? (
            <Text style={styles.meta}>{browser.current.component.description}</Text>
          ) : null}
          {browser.current.component.remote !== undefined ? (
            <Text style={styles.meta}>
              {browser.current.component.remote ? 'Remote component' : 'Local component'}
            </Text>
          ) : null}
        </View>
      ) : null}
      {browser.current.styleReferences.length > 0 ? (
        <View style={styles.layerBlock}>
          <Text style={styles.meta}>Styles</Text>
          {browser.current.styleReferences.map((style) => (
            <Text key={`${style.kind}:${style.styleId}`} style={styles.fact}>
              {evidenceState(style.kind)} · {shortId(style.styleId)}
            </Text>
          ))}
        </View>
      ) : null}
      {browser.flowStartingPoints.length > 0 ? (
        <View style={styles.layerBlock}>
          <Text style={styles.meta}>Prototype starts</Text>
          {browser.flowStartingPoints.map((point) => (
            <Text key={`${point.nodeId}:${point.name}`} style={styles.fact}>
              {point.name} → {shortId(point.nodeId)}
            </Text>
          ))}
          {browser.flowStartingPointsTruncated ? <Text style={styles.meta}>More starts are stored in the raw file.</Text> : null}
        </View>
      ) : null}
      {browser.interactions.length > 0 ? (
        <View style={styles.layerBlock}>
          <Text style={styles.meta}>Prototype interactions</Text>
          {browser.interactions.map((interaction, index) => (
            <Text key={`${interaction.trigger}:${interaction.action}:${index}`} style={styles.fact}>
              {evidenceState(interaction.trigger)} → {evidenceState(interaction.navigation ?? interaction.action)}
              {interaction.destinationNodeId ? ` · ${shortId(interaction.destinationNodeId)}` : ''}
            </Text>
          ))}
          {browser.interactionsTruncated ? <Text style={styles.meta}>More interactions are stored in the raw file.</Text> : null}
        </View>
      ) : null}
      <View style={styles.browserHeading}>
        <Text style={styles.meta}>Layers</Text>
        <Text style={styles.meta}>{firstChild}–{lastChild} of {browser.totalChildren}</Text>
      </View>
      <View style={styles.nodeList}>
        {browser.children.map((child) => (
          <Pressable
            accessibilityRole="button"
            disabled={busy}
            key={child.id}
            onPress={() => void onBrowse(child.id, 0)}
            style={styles.nodeRow}
          >
            <Text numberOfLines={1} style={styles.fileName}>
              {child.childCount > 0 ? '› ' : ''}{child.name}
            </Text>
            <Text numberOfLines={1} style={styles.meta}>
              {evidenceState(child.type)}
              {child.width !== undefined && child.height !== undefined
                ? ` · ${formatMeasurement(child.width)} × ${formatMeasurement(child.height)}`
                : ''}
              {child.layoutMode ? ` · ${evidenceState(child.layoutMode)}` : ''}
              {child.interactionCount > 0 ? ` · ${child.interactionCount} interactions` : ''}
            </Text>
          </Pressable>
        ))}
        {browser.children.length === 0 ? <Text style={styles.meta}>No child layers.</Text> : null}
      </View>
      {browser.previousOffset !== undefined || browser.nextOffset !== undefined ? (
        <View style={styles.paginationRow}>
          {browser.previousOffset !== undefined ? (
            <Pressable
              accessibilityRole="button"
              disabled={busy}
              onPress={() => void onBrowse(browser.current.id, browser.previousOffset ?? 0)}
            >
              <Text style={styles.textButton}>Previous</Text>
            </Pressable>
          ) : <View />}
          {browser.nextOffset !== undefined ? (
            <Pressable
              accessibilityRole="button"
              disabled={busy}
              onPress={() => void onBrowse(browser.current.id, browser.nextOffset ?? 0)}
            >
              <Text style={styles.textButton}>Next</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      <Text style={styles.meta}>Fixed version {shortId(browser.providerVersionId)}</Text>
    </View>
  )
}

function figmaPropertyRows(node: FigmaBrowseResult['current']) {
  const rows: { label: string; value: string }[] = []
  if (node.width !== undefined && node.height !== undefined) {
    rows.push({ label: 'Size', value: `${formatMeasurement(node.width)} × ${formatMeasurement(node.height)}` })
  }
  if (node.x !== undefined && node.y !== undefined) {
    rows.push({ label: 'Position', value: `${formatMeasurement(node.x)}, ${formatMeasurement(node.y)}` })
  }
  if (node.layoutMode) rows.push({ label: 'Layout', value: evidenceState(node.layoutMode) })
  if (node.horizontalSizing || node.verticalSizing) {
    rows.push({
      label: 'Sizing',
      value: [node.horizontalSizing, node.verticalSizing].filter(Boolean).map((value) => evidenceState(value ?? '')).join(' × '),
    })
  }
  if (node.primaryAxisAlignment || node.counterAxisAlignment) {
    rows.push({
      label: 'Alignment',
      value: [node.primaryAxisAlignment, node.counterAxisAlignment].filter(Boolean).map((value) => evidenceState(value ?? '')).join(' / '),
    })
  }
  if (node.itemSpacing !== undefined) rows.push({ label: 'Gap', value: formatMeasurement(node.itemSpacing) })
  if (
    node.paddingTop !== undefined || node.paddingRight !== undefined ||
    node.paddingBottom !== undefined || node.paddingLeft !== undefined
  ) {
    rows.push({
      label: 'Padding',
      value: [node.paddingTop, node.paddingRight, node.paddingBottom, node.paddingLeft]
        .map((value) => formatMeasurement(value ?? 0))
        .join(' '),
    })
  }
  if (node.horizontalConstraint || node.verticalConstraint) {
    rows.push({
      label: 'Constraints',
      value: [node.horizontalConstraint, node.verticalConstraint].filter(Boolean).map((value) => evidenceState(value ?? '')).join(' / '),
    })
  }
  if (node.opacity !== undefined && node.opacity !== 1) {
    rows.push({ label: 'Opacity', value: `${Math.round(node.opacity * 100)}%` })
  }
  if (node.blendMode) rows.push({ label: 'Blend', value: evidenceState(node.blendMode) })
  if (node.cornerRadius !== undefined) rows.push({ label: 'Radius', value: formatMeasurement(node.cornerRadius) })
  if (node.strokeWeight !== undefined) rows.push({ label: 'Stroke', value: formatMeasurement(node.strokeWeight) })
  if (node.fillCount + node.strokeCount + node.effectCount > 0) {
    rows.push({
      label: 'Appearance',
      value: `${node.fillCount} fills · ${node.strokeCount} strokes · ${node.effectCount} effects`,
    })
  }
  if (node.annotationCount > 0) rows.push({ label: 'Annotations', value: String(node.annotationCount) })
  if (node.locked) rows.push({ label: 'Locked', value: 'Yes' })
  if (!node.visible) rows.push({ label: 'Visible', value: 'No' })
  return rows
}

function previewPages(previews: FigmaPreviewsResult) {
  const pages: { id: string; name: string; facts: FigmaPreviewFact[] }[] = []
  for (const fact of previews.facts) {
    const page = pages.find((candidate) => candidate.id === fact.pageId)
    if (page) page.facts.push(fact)
    else pages.push({ id: fact.pageId, name: fact.pageName, facts: [fact] })
  }
  return pages
}

function EvidenceButton({
  label,
  onPress,
  disabled,
  secondary = false,
}: {
  label: string
  onPress: () => void | Promise<void>
  disabled: boolean
  secondary?: boolean
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={[
        styles.button,
        secondary ? styles.secondaryButton : null,
        disabled ? styles.disabled : null,
      ]}
    >
      <Text style={[styles.buttonText, secondary ? styles.secondaryButtonText : null]}>{label}</Text>
    </Pressable>
  )
}

function parentPath(path: string) {
  const segments = path.split('/').filter(Boolean)
  segments.pop()
  return segments.join('/')
}

function repositoryKindName(value: GithubEvidence['kind']) {
  if (value === 'full_product') return 'Full product'
  if (value === 'frontend') return 'Frontend'
  if (value === 'backend_api') return 'Backend API'
  if (value === 'mobile_app') return 'Mobile app'
  if (value === 'desktop_app') return 'Desktop app'
  if (value === 'ai_ml') return 'AI / ML'
  if (value === 'data_pipeline') return 'Data pipeline'
  if (value === 'hardware_firmware') return 'Hardware / firmware'
  if (value === 'infrastructure') return 'Infrastructure'
  if (value === 'library_sdk') return 'Library / SDK'
  if (value === 'docs_research') return 'Docs / research'
  return 'Other'
}

function shortSha(value: string) {
  return value.slice(0, 8)
}

function shortId(value: string) {
  return value.length > 12 ? `${value.slice(0, 8)}…` : value
}

function formatMoment(value: number) {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(value)
}

function formatBytes(value: number) {
  if (value < 1_024) return `${value} B`
  if (value < 1_024 * 1_024) return `${Math.ceil(value / 1_024)} KB`
  return `${(value / (1_024 * 1_024)).toFixed(1)} MB`
}

function formatMeasurement(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}

function evidenceState(value: string) {
  return value.toLowerCase().replaceAll('_', ' ')
}

function errorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message.trim()) return error.message
  return fallback
}

const styles = StyleSheet.create({
  section: { gap: 12, paddingTop: 8 },
  sectionTitle: { color: '#f1eee8', fontSize: 19, lineHeight: 25 },
  idea: { color: '#e3dfd7', fontSize: 18, lineHeight: 26 },
  question: { color: '#c9c4bb', fontSize: 14, lineHeight: 21, marginTop: 8 },
  body: { color: '#aaa69f', fontSize: 15, lineHeight: 22 },
  guidance: { color: '#827e77', fontSize: 13, lineHeight: 19 },
  meta: { color: '#77736d', fontSize: 13, lineHeight: 18 },
  value: { color: '#f1eee8', fontSize: 16, lineHeight: 22 },
  fact: { color: '#c9c4bb', fontSize: 14, lineHeight: 20 },
  error: { color: '#e3a4a4', fontSize: 13, lineHeight: 19 },
  evidenceHeader: {
    marginTop: 14,
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: 12,
  },
  evidenceCard: { borderTopWidth: 1, borderTopColor: '#2c2a27', paddingTop: 12, gap: 5 },
  browser: { marginTop: 7, gap: 8, borderWidth: 1, borderColor: '#2c2a27', borderRadius: 6, padding: 10 },
  browserHeading: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12 },
  browserTitle: { flex: 1, gap: 1 },
  fileRow: { minHeight: 38, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, borderTopWidth: 1, borderTopColor: '#242321' },
  fileName: { color: '#c9c4bb', fontSize: 13, lineHeight: 18, flexShrink: 1 },
  textButton: { color: '#aaa69f', fontSize: 13, textDecorationLine: 'underline' },
  codeViewport: { maxHeight: 360, backgroundColor: '#070706', borderRadius: 4, padding: 10 },
  code: { color: '#d8d3ca', fontFamily: 'monospace', fontSize: 12, lineHeight: 18 },
  buttonRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 5 },
  button: { minHeight: 40, borderRadius: 6, backgroundColor: '#eee9e0', justifyContent: 'center', alignItems: 'center', paddingHorizontal: 12, alignSelf: 'flex-start', marginTop: 5 },
  buttonText: { color: '#11110f', fontSize: 13, fontWeight: '600' },
  secondaryButton: { backgroundColor: 'transparent', borderWidth: 1, borderColor: '#3a3733' },
  secondaryButtonText: { color: '#f1eee8' },
  disabled: { opacity: 0.5 },
  pageList: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  pageChip: { borderWidth: 1, borderColor: '#34322f', borderRadius: 5, paddingHorizontal: 9, paddingVertical: 6 },
  pageChipSelected: { backgroundColor: '#eee9e0', borderColor: '#eee9e0' },
  pageChipText: { color: '#aaa69f', fontSize: 12 },
  pageChipTextSelected: { color: '#11110f', fontSize: 12, fontWeight: '600' },
  previewBrowser: { gap: 10 },
  previewImage: { width: '100%', height: 320, backgroundColor: '#070706', borderRadius: 4 },
  nodeList: { gap: 2 },
  nodeRow: { minHeight: 48, borderTopWidth: 1, borderTopColor: '#242321', justifyContent: 'center', paddingHorizontal: 6 },
  nodeRowSelected: { backgroundColor: '#1b1a18' },
  activityRow: { gap: 2, borderTopWidth: 1, borderTopColor: '#242321', paddingTop: 8, paddingBottom: 3 },
  comparisonImages: { flexDirection: 'row', gap: 8 },
  comparisonImageColumn: { flex: 1, gap: 4 },
  comparisonImage: { width: '100%', height: 220, backgroundColor: '#070706', borderRadius: 4 },
  comparisonPlaceholder: { height: 220, backgroundColor: '#0b0b0a', borderRadius: 4, alignItems: 'center', justifyContent: 'center', padding: 12 },
  layerText: { color: '#c9c4bb', fontSize: 13, lineHeight: 19, backgroundColor: '#0b0b0a', padding: 8, borderRadius: 4 },
  propertyList: { borderTopWidth: 1, borderTopColor: '#242321' },
  propertyRow: { minHeight: 34, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, borderBottomWidth: 1, borderBottomColor: '#242321' },
  layerBlock: { gap: 3, borderTopWidth: 1, borderTopColor: '#242321', paddingTop: 8 },
  paginationRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
})
