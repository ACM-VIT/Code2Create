import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  useAction,
  useConvexAuth,
  usePaginatedQuery,
  useQuery,
} from "convex/react";
import { api } from "@code2create/backend/api";
import type { FunctionReturnType } from "convex/server";
import type { Code2CreateAuthClient } from "@code2create/web-auth";
import { RowsPhotoAlbum } from "react-photo-album";
import "react-photo-album/rows.css";
import { PortalScene } from "../components/portal/PortalScene";
import { OutlineHeading } from "../components/portal/OutlineHeading";
import { PhotoUploader } from "../components/photos/PhotoUploader";
import { eventSlug } from "../lib/config";
import { readableError } from "../lib/errors";
import { photoSize } from "../lib/photoUpload";
import {
  selectionMaximumBytes,
  selectionMaximumCount,
  selectionLimitMessage,
} from "../lib/photoSelection";
import "./photos.css";

const PhotoLightbox = lazy(() => import("../components/photos/PhotoLightbox"));
export type GalleryPhoto = FunctionReturnType<
  typeof api.photos.list
>["page"][number];
export type Filters = {
  day?: "6" | "7" | "8" | "other" | undefined;
  uploaderId?: GalleryPhoto["uploaderId"] | undefined;
  sort: "newest" | "oldest" | "uploader";
};
export type Facets = FunctionReturnType<typeof api.photos.facets>;
const days = ["6", "7", "8", "other"] as const;
const dayLabel = { "6": "6th", "7": "7th", "8": "8th", other: "Other" };

export function PhotosScreen({
  authClient,
  eventName,
}: {
  authClient: Code2CreateAuthClient;
  eventName: string | null;
}) {
  const [filters, setFilters] = useState<Filters>({ sort: "newest" });
  const facets = useQuery(api.photos.facets, { eventSlug });
  const download = useAction(api.photoActions.download);
  const { isAuthenticated } = useConvexAuth();
  const access = useQuery(
    api.photos.capabilities,
    isAuthenticated ? { eventSlug } : "skip",
  );
  const { results, status, loadMore } = usePaginatedQuery(
    api.photos.list,
    {
      eventSlug,
      sort: filters.sort,
      ...(filters.day ? { day: filters.day } : {}),
      ...(filters.uploaderId ? { uploaderId: filters.uploaderId } : {}),
    },
    { initialNumItems: 48 },
  );
  return (
    <PhotoGallery
      eventName={eventName}
      photos={results}
      filters={filters}
      facets={facets ?? []}
      onFiltersChange={setFilters}
      canUpload={access?.canUpload ?? false}
      signedIn={isAuthenticated}
      loading={status === "LoadingFirstPage"}
      loadingMore={status === "LoadingMore"}
      hasMore={status === "CanLoadMore"}
      onLoadMore={() => loadMore(48)}
      onSignOut={() => void authClient.signOut()}
      getDownloadUrl={(photo) => download({ photoId: photo.id })}
    />
  );
}

export function PhotoGallery({
  photos,
  filters,
  facets,
  eventName,
  onFiltersChange,
  canUpload,
  signedIn,
  loading = false,
  loadingMore = false,
  hasMore = false,
  onLoadMore,
  onSignOut,
  getDownloadUrl,
}: {
  photos: GalleryPhoto[];
  eventName: string | null;
  filters: Filters;
  facets: Facets;
  onFiltersChange: (filters: Filters) => void;
  canUpload: boolean;
  signedIn: boolean;
  loading?: boolean;
  loadingMore?: boolean;
  hasMore?: boolean;
  onLoadMore?: () => void;
  onSignOut?: () => void;
  getDownloadUrl: (photo: GalleryPhoto) => Promise<string>;
}) {
  const [uploading, setUploading] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [density, setDensity] = useState<"comfortable" | "compact">(
    "comfortable",
  );
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Map<string, GalleryPhoto>>(
    new Map(),
  );
  const [archiveProgress, setArchiveProgress] = useState<number | null>(null);
  const archiveAbort = useRef<AbortController | null>(null);
  useEffect(() => () => archiveAbort.current?.abort(), []);
  const openIndex = photos.findIndex((photo) => photo.id === openId);
  const selectedBytes = Array.from(selected.values()).reduce(
    (sum, photo) => sum + photo.byteCount,
    0,
  );
  const relevantFacets = facets.filter(
    (facet) => !filters.uploaderId || facet.uploaderId === filters.uploaderId,
  );
  const countDay = (day?: Filters["day"]) =>
    relevantFacets.reduce(
      (sum, facet) =>
        sum +
        (day
          ? facet.counts[day]
          : Object.values(facet.counts).reduce((a, b) => a + b, 0)),
      0,
    );

  function changeFilters(next: Filters) {
    onFiltersChange(next);
    setOpenId(null);
  }
  function toggleSelected(photo: GalleryPhoto) {
    if (selected.has(photo.id)) {
      setSelected((current) => {
        const next = new Map(current);
        next.delete(photo.id);
        return next;
      });
      return;
    }
    if (
      selected.size >= selectionMaximumCount ||
      selectedBytes + photo.byteCount > selectionMaximumBytes
    ) {
      setDownloadError(selectionLimitMessage);
      return;
    }
    setSelected((current) => new Map(current).set(photo.id, photo));
  }
  function selectLoaded() {
    const next = new Map(selected);
    let bytes = selectedBytes;
    for (const photo of photos) {
      if (next.has(photo.id)) continue;
      if (
        next.size >= selectionMaximumCount ||
        bytes + photo.byteCount > selectionMaximumBytes
      )
        break;
      next.set(photo.id, photo);
      bytes += photo.byteCount;
    }
    setSelected(next);
    if (photos.some((photo) => !next.has(photo.id)))
      setDownloadError(`Selected as many as fit. ${selectionLimitMessage}`);
  }
  async function saveOriginal(photo: GalleryPhoto) {
    if (downloading) return;
    setDownloading(true);
    setDownloadError(null);
    try {
      const url = await getDownloadUrl(photo);
      const link = document.createElement("a");
      link.href = url;
      link.download = photo.fileName;
      document.body.append(link);
      link.click();
      link.remove();
    } catch (error) {
      setDownloadError(readableError(error));
    } finally {
      setDownloading(false);
    }
  }
  async function saveSelected() {
    if (archiveProgress !== null || !selected.size) return;
    const controller = new AbortController();
    archiveAbort.current = controller;
    setArchiveProgress(0);
    setDownloadError(null);
    try {
      const { downloadPhotoArchive } = await import("../lib/photoDownload");
      const blob = await downloadPhotoArchive(
        Array.from(selected.values()),
        getDownloadUrl,
        controller.signal,
        setArchiveProgress,
      );
      controller.signal.throwIfAborted();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "code2create-photos.zip";
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (error) {
      if (!controller.signal.aborted) setDownloadError(readableError(error));
    } finally {
      setArchiveProgress(null);
      archiveAbort.current = null;
    }
  }

  return (
    <PortalScene
      tree="left"
      {...(signedIn && onSignOut ? { onSignOut } : {})}
      header={
        !signedIn ? (
          <Link className="photo-button" to="/">
            Sign in
          </Link>
        ) : undefined
      }
      nav={
        <nav className="photo-navigation" aria-label="Gallery navigation">
          <Link to="/">Home</Link>
          <Link to="/showcase">Projects</Link>
          <Link to="/photos" aria-current="page">
            Photos
          </Link>
        </nav>
      }
    >
      <div className="photo-gallery">
        <header className="showcase-heading photo-gallery__heading">
          <div>
            <OutlineHeading word="photos" />
            <p>The people, the late nights, the little moments.</p>
          </div>
          {canUpload && (
            <button
              type="button"
              className="photo-button photo-button--primary"
              onClick={() => setUploading(true)}
            >
              ＋ Add photos
            </button>
          )}
        </header>
        {uploading && canUpload && (
          <PhotoUploader onClose={() => setUploading(false)} />
        )}
        <div className="photo-gallery__controls">
          <div className="photo-filters">
            <div
              className="photo-filter-row"
              role="group"
              aria-label="Capture day"
            >
              <span className="photo-filter-label">Taken on</span>
              <button
                type="button"
                className="photo-chip"
                aria-pressed={!filters.day}
                onClick={() => changeFilters({ ...filters, day: undefined })}
              >
                All <span>{countDay()}</span>
              </button>
              {days.map((day) => (
                <button
                  key={day}
                  type="button"
                  className="photo-chip"
                  aria-pressed={filters.day === day}
                  onClick={() => changeFilters({ ...filters, day })}
                >
                  {dayLabel[day]} <span>{countDay(day)}</span>
                </button>
              ))}
            </div>
            <div
              className="photo-filter-row"
              role="group"
              aria-label="Photographer"
            >
              <span className="photo-filter-label">Uploaded by</span>
              <button
                type="button"
                className="photo-chip"
                aria-pressed={!filters.uploaderId}
                onClick={() =>
                  changeFilters({ ...filters, uploaderId: undefined })
                }
              >
                Everyone
              </button>
              {facets.map((facet) => (
                <button
                  key={facet.uploaderId}
                  type="button"
                  className="photo-chip"
                  aria-pressed={filters.uploaderId === facet.uploaderId}
                  onClick={() =>
                    changeFilters({ ...filters, uploaderId: facet.uploaderId })
                  }
                >
                  {facet.uploaderName}{" "}
                  <span>
                    {filters.day
                      ? facet.counts[filters.day]
                      : Object.values(facet.counts).reduce((a, b) => a + b, 0)}
                  </span>
                </button>
              ))}
            </div>
            <p className="photo-filter-note">
              Capture dates use India time. Missing dates and photos outside the
              event days are under Other.
            </p>
          </div>
          <div className="photo-gallery__toolbar">
            <p>
              {loading
                ? "Opening the album…"
                : `${countDay(filters.day)} photos`}
            </p>
            <label className="photo-sort">
              Sort{" "}
              <select
                aria-label="Sort photos"
                value={filters.sort}
                onChange={(event) => {
                  const sort = event.target.value;
                  if (
                    sort === "newest" ||
                    sort === "oldest" ||
                    sort === "uploader"
                  )
                    changeFilters({ ...filters, sort });
                }}
              >
                <option value="newest">Taken: newest first</option>
                <option value="oldest">Taken: oldest first</option>
                <option value="uploader">Photographer A–Z</option>
              </select>
            </label>
            <button
              type="button"
              className="photo-button"
              aria-pressed={selecting}
              disabled={archiveProgress !== null}
              onClick={() => setSelecting(!selecting)}
            >
              {selecting ? "Done selecting" : "Select photos"}
            </button>
            <div className="photo-density" role="group" aria-label="Photo size">
              {(["comfortable", "compact"] as const).map((value) => (
                <button
                  type="button"
                  key={value}
                  aria-pressed={density === value}
                  onClick={() => setDensity(value)}
                >
                  {value === "comfortable" ? "Comfortable" : "Compact"}
                </button>
              ))}
            </div>
          </div>
        </div>
        {(selecting || selected.size > 0) && (
          <div className="photo-selection" aria-label="Selected photos">
            <span role="status">
              {selected.size} selected · {photoSize(selectedBytes)}
            </span>
            <button
              type="button"
              className="photo-button"
              disabled={archiveProgress !== null}
              onClick={selectLoaded}
            >
              Select loaded photos
            </button>
            <button
              type="button"
              className="photo-button"
              disabled={archiveProgress !== null || !selected.size}
              onClick={() => setSelected(new Map())}
            >
              Clear
            </button>
            <button
              type="button"
              className="photo-button photo-button--primary"
              disabled={archiveProgress !== null || !selected.size}
              onClick={() => void saveSelected()}
            >
              {archiveProgress === null
                ? "Download selected (.zip)"
                : `Downloading ${archiveProgress}/${selected.size}…`}
            </button>
            {archiveProgress !== null && (
              <button
                type="button"
                className="photo-button"
                onClick={() => archiveAbort.current?.abort()}
              >
                Cancel download
              </button>
            )}
            <small>
              Full-quality originals · Up to {selectionMaximumCount} photos /{" "}
              {photoSize(selectionMaximumBytes)} per ZIP. Selection stays when
              filters change.
            </small>
          </div>
        )}
        {downloadError && (
          <p className="photo-error" role="alert">
            {downloadError}
          </p>
        )}
        {loading ? (
          <div
            className="photo-skeleton"
            aria-label="Loading photos"
            role="status"
          >
            {Array.from({ length: 8 }, (_, index) => (
              <div key={index} />
            ))}
          </div>
        ) : photos.length === 0 ? (
          <div className="photo-empty">
            <h2>
              {filters.day || filters.uploaderId
                ? "No photos match these filters."
                : "A little quiet before the memories."}
            </h2>
            <p>
              {filters.day || filters.uploaderId
                ? "Try another day or photographer."
                : canUpload
                  ? "Add the first photos and bring the album to life."
                  : "Event photos will appear here. Everyone can browse and download them."}
            </p>
          </div>
        ) : (
          <RowsPhotoAlbum
            photos={photos.map((photo) => ({
              ...photo,
              key: photo.id,
              alt: photo.caption || photo.fileName,
              label: `${selecting ? (selected.has(photo.id) ? "Deselect" : "Select") : "View"} ${photo.caption || photo.fileName}`,
            }))}
            spacing={density === "compact" ? 6 : 10}
            targetRowHeight={(width) =>
              width < 600
                ? density === "compact"
                  ? 110
                  : 170
                : density === "compact"
                  ? 180
                  : 270
            }
            rowConstraints={{
              singleRowMaxHeight: density === "compact" ? 220 : 360,
            }}
            onClick={({ photo }) => {
              setDownloadError(null);
              if (selecting) {
                if (archiveProgress === null) toggleSelected(photo);
              } else setOpenId(photo.id);
            }}
            render={{
              button: (props, { photo }) => (
                <button
                  {...props}
                  aria-pressed={selecting ? selected.has(photo.id) : undefined}
                  className={`${props.className ?? ""} photo-tile ${selected.has(photo.id) ? "is-selected" : ""}`}
                />
              ),
              extras: (_, { photo }) => (
                <>
                  <span className="photo-tile__credit">
                    {photo.uploaderName}
                  </span>
                  {(selecting || selected.has(photo.id)) && (
                    <span className="photo-tile__check" aria-hidden="true">
                      {selected.has(photo.id) ? "✓" : ""}
                    </span>
                  )}
                </>
              ),
              image: (props, { index }) => (
                <img
                  {...props}
                  loading={index < 4 ? "eager" : "lazy"}
                  decoding="async"
                />
              ),
            }}
          />
        )}
        {(hasMore || loadingMore) && (
          <div className="photo-gallery__more">
            <button
              type="button"
              className="photo-button"
              disabled={loadingMore}
              onClick={onLoadMore}
            >
              {loadingMore ? "Loading more…" : "More memories"}
            </button>
          </div>
        )}
        <footer className="photo-gallery__footer">
          <span>Made together. Kept forever.</span>
          {eventName && <span>{eventName}</span>}
        </footer>
      </div>
      {openIndex >= 0 && (
        <Suspense
          fallback={
            <div className="photo-opening" role="status">
              Opening photo…
              <button type="button" onClick={() => setOpenId(null)}>
                Cancel
              </button>
            </div>
          }
        >
          <PhotoLightbox
            photos={photos}
            index={openIndex}
            onClose={() => setOpenId(null)}
            onView={(index) => setOpenId(photos[index]?.id ?? null)}
            onDownload={(photo) => void saveOriginal(photo)}
            downloading={downloading}
            error={downloadError}
          />
        </Suspense>
      )}
    </PortalScene>
  );
}
