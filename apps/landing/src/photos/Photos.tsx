import { useEffect, useRef, useState } from "react";
import { RowsPhotoAlbum } from "react-photo-album";
import Lightbox from "yet-another-react-lightbox";
import Download from "yet-another-react-lightbox/plugins/download";
import { parseCatalog, photoUrl, type GalleryPhoto } from "./catalog.js";
import { downloadPhotos } from "./download.js";
import "react-photo-album/rows.css";
import "yet-another-react-lightbox/styles.css";
import "./photos.css";

const PAGE_SIZE = 60;

export default function Photos() {
  const [photos, setPhotos] = useState<GalleryPhoto[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [attempt, setAttempt] = useState(0);
  const [visible, setVisible] = useState(PAGE_SIZE);
  const [index, setIndex] = useState(-1);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [progress, setProgress] = useState<number | null>(null);
  const [downloadMessage, setDownloadMessage] = useState("");
  const downloadController = useRef<AbortController | null>(null);

  useEffect(() => () => downloadController.current?.abort(), []);

  function togglePhoto(key: string) {
    if (downloadController.current) return;
    setDownloadMessage("");
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function downloadSelection() {
    if (downloadController.current || selected.size === 0) return;
    const controller = new AbortController();
    downloadController.current = controller;
    setProgress(0);
    setDownloadMessage("");
    try {
      await downloadPhotos(
        photos.filter((photo) => selected.has(photo.key)),
        controller.signal,
        setProgress,
      );
      setDownloadMessage("Download ready");
    } catch (error) {
      setDownloadMessage(
        controller.signal.aborted ||
          (error instanceof DOMException && error.name === "AbortError")
          ? "Download cancelled"
          : error instanceof Error
            ? error.message
            : "Download failed. Please try again.",
      );
    } finally {
      controller.abort();
      downloadController.current = null;
      setProgress(null);
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    setStatus("loading");
    fetch(photoUrl("gallery/manifest.json"), { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("Photo catalog unavailable");
        const value: unknown = await response.json();
        return parseCatalog(value);
      })
      .then((catalog) => {
        setPhotos(catalog.photos);
        setStatus("ready");
      })
      .catch(() => {
        if (!controller.signal.aborted) setStatus("error");
      });
    return () => controller.abort();
  }, [attempt]);

  return (
    <div className="photos-page">
      <header className="photos-nav">
        <a href="/" className="photos-brand">
          <img src="/assets/svg/logo.svg" alt="" width="34" height="38" />
          Code2Create
        </a>
        <a href="/">
          Back to the event <span aria-hidden="true">↗</span>
        </a>
      </header>
      <main className="photos-main">
        <div className="photos-heading">
          <div>
            <h1 aria-label="Photos">
              PH<span>OTOS</span>
            </h1>
          </div>
        </div>
        {status === "loading" && (
          <p className="photos-message" role="status">
            Loading the album…
          </p>
        )}
        {status === "error" && (
          <div className="photos-message" role="alert">
            <p>The album couldn’t load. Please try again.</p>
            <button onClick={() => setAttempt((value) => value + 1)}>
              Try again
            </button>
          </div>
        )}
        {status === "ready" && photos.length === 0 && (
          <p className="photos-message">
            The photos are on their way. Check back soon.
          </p>
        )}
        {status === "ready" && photos.length > 0 && (
          <>
            <div className="photos-caption">
              <span>{photos.length.toLocaleString()} photos</span>
            </div>
            <RowsPhotoAlbum
              photos={photos.slice(0, visible).map((photo) => ({
                ...photo,
                src: photoUrl(photo.thumbnail),
                alt: photo.name,
              }))}
              targetRowHeight={260}
              spacing={8}
              onClick={({ index: clicked, photo }) =>
                selecting ? togglePhoto(photo.key) : setIndex(clicked)
              }
              componentsProps={{
                image: { loading: "lazy", decoding: "async" },
                button: ({ photo }) => ({
                  "aria-label": `${selecting ? "Select" : "View"} ${photo.name}`,
                  "aria-pressed": selecting
                    ? selected.has(photo.key)
                    : undefined,
                  "data-selecting": selecting || undefined,
                  disabled: progress !== null,
                }),
              }}
              render={{
                extras: (_, { photo }) =>
                  selecting ? (
                    <span className="photos-check" aria-hidden="true">
                      {selected.has(photo.key) ? "✓" : ""}
                    </span>
                  ) : null,
              }}
            />
            {visible < photos.length && (
              <div className="photos-more">
                <button
                  onClick={() => setVisible((value) => value + PAGE_SIZE)}
                >
                  More photos <span aria-hidden="true">↓</span>
                </button>
                <p>
                  {Math.min(visible, photos.length).toLocaleString()} of{" "}
                  {photos.length.toLocaleString()}
                </p>
              </div>
            )}
          </>
        )}
      </main>
      <footer className="photos-footer">
        <span>A little bit of Code2Create, kept forever.</span>
        <a href="https://acmvit.in">ACM-VIT ↗</a>
      </footer>
      {status === "ready" && photos.length > 0 && index < 0 && (
        <div className="photos-dock" role="region" aria-label="Photo selection">
          {downloadMessage && (
            <p className="photos-download-message" role="status">
              {downloadMessage}
            </p>
          )}
          <div className="photos-dock-controls">
            {!selecting ? (
              <button
                className="photos-dock-primary"
                onClick={() => setSelecting(true)}
              >
                <span aria-hidden="true">☑</span> Select photos
              </button>
            ) : progress !== null ? (
              <>
                <span role="status">
                  Preparing {progress} / {selected.size}
                </span>
                <button onClick={() => downloadController.current?.abort()}>
                  Cancel
                </button>
              </>
            ) : (
              <>
                <button
                  aria-label="Exit selection"
                  onClick={() => {
                    setSelecting(false);
                    setSelected(new Set());
                    setDownloadMessage("");
                  }}
                >
                  ✕
                </button>
                <span className="photos-selection-count" role="status">
                  {selected.size} selected
                </span>
                {selected.size > 0 && (
                  <button
                    onClick={() => {
                      setSelected(new Set());
                      setDownloadMessage("");
                    }}
                  >
                    Clear
                  </button>
                )}
                <button
                  className="photos-dock-primary"
                  disabled={selected.size === 0}
                  onClick={downloadSelection}
                >
                  Download ZIP <span aria-hidden="true">↓</span>
                </button>
              </>
            )}
          </div>
        </div>
      )}
      <Lightbox
        open={index >= 0}
        index={index}
        close={() => setIndex(-1)}
        plugins={[Download]}
        slides={photos.map((photo) => ({
          src: photoUrl(photo.preview),
          width: photo.width,
          height: photo.height,
          alt: photo.name,
          download: { url: photoUrl(photo.key), filename: photo.name },
        }))}
        download={{
          download: ({ slide }) => {
            if (typeof slide.download === "object")
              window.location.assign(slide.download.url);
          },
        }}
        carousel={{ finite: true }}
      />
    </div>
  );
}
