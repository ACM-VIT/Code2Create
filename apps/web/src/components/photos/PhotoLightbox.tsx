import { Lightbox } from "yet-another-react-lightbox";
import Zoom from "yet-another-react-lightbox/plugins/zoom";
import Fullscreen from "yet-another-react-lightbox/plugins/fullscreen";
import Counter from "yet-another-react-lightbox/plugins/counter";
import Captions from "yet-another-react-lightbox/plugins/captions";
import "yet-another-react-lightbox/styles.css";
import "yet-another-react-lightbox/plugins/captions.css";
import "yet-another-react-lightbox/plugins/counter.css";
import type { GalleryPhoto } from "../../screens/PhotosScreen";
import { photoSize } from "../../lib/photoUpload";

export default function PhotoLightbox({
  photos,
  index,
  onClose,
  onView,
  onDownload,
  downloading,
  error,
}: {
  photos: GalleryPhoto[];
  index: number;
  onClose: () => void;
  onView: (index: number) => void;
  onDownload: (photo: GalleryPhoto) => void;
  downloading: boolean;
  error: string | null;
}) {
  const current = photos[index];
  return (
    <Lightbox
      open
      index={index}
      close={onClose}
      plugins={[Zoom, Fullscreen, Counter, Captions]}
      on={{ view: ({ index: next }) => onView(next) }}
      carousel={{ preload: 1 }}
      controller={{ closeOnBackdropClick: true }}
      slides={photos.map((photo) => ({
        src: photo.originalUrl,
        width: photo.width,
        height: photo.height,
        alt: photo.caption || photo.fileName,
        title: photo.caption || photo.fileName,
        description: `${photo.width} × ${photo.height} · ${photoSize(photo.byteCount)} · Original available to download`,
        srcSet: [
          ...photo.srcSet.filter((source) => source.width < photo.width),
          { src: photo.originalUrl, width: photo.width, height: photo.height },
        ],
      }))}
      toolbar={{
        buttons: [
          <button
            key="original"
            type="button"
            className="yarl__button photo-original-button"
            disabled={downloading || !current}
            onClick={() => {
              if (current) onDownload(current);
            }}
          >
            {downloading ? "Preparing…" : "Download original"}
          </button>,
          "close",
        ],
      }}
      render={{
        controls: () =>
          error ? (
            <p className="photo-lightbox-error" role="alert">
              {error}
            </p>
          ) : null,
      }}
      styles={{ container: { backgroundColor: "rgba(12, 0, 4, 0.97)" } }}
    />
  );
}
