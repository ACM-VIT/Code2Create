import { useEffect, useState } from "react";
import { RowsPhotoAlbum } from "react-photo-album";
import Lightbox from "yet-another-react-lightbox";
import Download from "yet-another-react-lightbox/plugins/download";
import { parseCatalog, photoUrl, type GalleryPhoto } from "./catalog.js";
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
            <p className="photos-eyebrow">Code2Create / The album</p>
            <h1 aria-label="Photos">
              PH<span>OTOS</span>
            </h1>
          </div>
          <p>
            The people, the late nights, the little moments.
            <br />
            Find yours. Keep it.
          </p>
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
              <span>Open a photo to view or download the original</span>
            </div>
            <RowsPhotoAlbum
              photos={photos
                .slice(0, visible)
                .map((photo) => ({
                  ...photo,
                  src: photoUrl(photo.thumbnail),
                  alt: photo.name,
                }))}
              targetRowHeight={260}
              spacing={8}
              onClick={({ index: selected }) => setIndex(selected)}
              componentsProps={{
                image: { loading: "lazy", decoding: "async" },
                button: ({ photo }) => ({ "aria-label": `View ${photo.name}` }),
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
