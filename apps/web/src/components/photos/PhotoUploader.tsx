import { useEffect, useRef, useState } from "react";
import { useAction } from "convex/react";
import { api } from "@code2create/backend/api";
import { eventSlug } from "../../lib/config";
import { readableError } from "../../lib/errors";
import {
  photoAccept,
  photoChecksum,
  photoSize,
  uploadOriginal,
  validatePhotoFile,
} from "../../lib/photoUpload";

type UploadItem = {
  id: string;
  file: File;
  caption: string;
  preview: string;
  status: "ready" | "uploading" | "publishing" | "done" | "error";
  progress: number;
  error: string | null;
};

export function PhotoUploader({ onClose }: { onClose: () => void }) {
  const begin = useAction(api.photoActions.beginUpload);
  const finish = useAction(api.photoActions.finishUpload);
  const [items, setItems] = useState<UploadItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const previews = useRef(new Set<string>());
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    const urls = previews.current;
    return () => {
      alive.current = false;
      controller.current?.abort();
      urls.forEach(URL.revokeObjectURL);
    };
  }, []);

  function select(files: FileList | null) {
    if (!files || busy) return;
    const selected = Array.from(files);
    if (items.length + selected.length > 20) {
      setMessage("Add up to 20 photos at a time.");
      return;
    }
    const errors: string[] = [];
    const accepted = selected.flatMap((file): UploadItem[] => {
      const error = validatePhotoFile(file);
      if (error) {
        errors.push(`${file.name}: ${error}`);
        return [];
      }
      const preview = URL.createObjectURL(file);
      previews.current.add(preview);
      return [
        {
          id: crypto.randomUUID(),
          file,
          caption: "",
          preview,
          status: "ready",
          progress: 0,
          error: null,
        },
      ];
    });
    setItems((current) => [...current, ...accepted]);
    setMessage(errors.length ? errors.join(" ") : null);
  }

  function update(id: string, patch: Partial<UploadItem>) {
    if (alive.current)
      setItems((current) =>
        current.map((item) => (item.id === id ? { ...item, ...patch } : item)),
      );
  }

  async function publish() {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    const abort = new AbortController();
    controller.current = abort;
    for (const item of items.filter((entry) => entry.status !== "done")) {
      if (abort.signal.aborted) break;
      try {
        update(item.id, { status: "uploading", progress: 0, error: null });
        const sha256 = await photoChecksum(item.file);
        if (abort.signal.aborted) break;
        const ticket = await begin({
          eventSlug,
          clientOperationId: item.id,
          fileName: item.file.name,
          caption: item.caption,
          contentType: item.file.type,
          byteCount: item.file.size,
          sha256,
        });
        if (abort.signal.aborted) break;
        if (ticket.uploadUrl) {
          await uploadOriginal(
            ticket.uploadUrl,
            item.file,
            abort.signal,
            (progress) => update(item.id, { progress }),
          );
          update(item.id, { status: "publishing", progress: 100 });
          await finish({ photoId: ticket.photoId });
        }
        update(item.id, { status: "done", progress: 100 });
      } catch (error) {
        update(item.id, { status: "error", error: readableError(error) });
      }
    }
    if (alive.current) setBusy(false);
  }

  return (
    <section
      className="photo-upload rounded-petal glass"
      aria-labelledby="photo-upload-heading"
    >
      <div className="photo-upload__heading">
        <div>
          <h2 id="photo-upload-heading">Add to the album</h2>
          <p>
            Photos you publish are visible to everyone, with your name. Downloads include the
            untouched original and its metadata.
          </p>
        </div>
        <button
          type="button"
          className="photo-button photo-button--quiet"
          disabled={busy}
          onClick={onClose}
        >
          Close
        </button>
      </div>
      <label
        className={`photo-dropzone ${dragging ? "is-dragging" : ""}`}
        onDragOver={(event) => {
          event.preventDefault();
          if (!busy) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          select(event.dataTransfer.files);
        }}
      >
        <input
          type="file"
          accept={photoAccept}
          multiple
          disabled={busy}
          onChange={(event) => {
            select(event.target.files);
            event.target.value = "";
          }}
        />
        <span className="photo-dropzone__title">
          Choose photos <span>or drop them here</span>
        </span>
        <span>
          JPEG, PNG, WebP, AVIF · Up to 50 MB each · Originals kept in full
          quality
        </span>
      </label>
      {message && (
        <p role="alert" className="photo-error">
          {message}
        </p>
      )}
      {items.length > 0 && (
        <ul className="photo-upload__list">
          {items.map((item) => (
            <li key={item.id}>
              <img src={item.preview} alt="" width={64} height={64} />
              <div className="photo-upload__details">
                <div className="photo-upload__filename">
                  <strong title={item.file.name}>{item.file.name}</strong>
                  <span>{photoSize(item.file.size)}</span>
                </div>
                <input
                  aria-label={`Caption for ${item.file.name}`}
                  placeholder="Add a caption (optional)"
                  maxLength={300}
                  value={item.caption}
                  disabled={busy || item.status !== "ready"}
                  onChange={(event) =>
                    update(item.id, { caption: event.target.value })
                  }
                />
                <span role="status">
                  {item.status === "uploading"
                    ? `Uploading ${item.progress}%`
                    : item.status === "publishing"
                      ? "Checking the original…"
                      : item.status === "done"
                        ? "Published"
                        : item.status === "error"
                          ? item.error
                          : "Ready to publish"}
                </span>
                {item.status === "uploading" && (
                  <progress
                    max={100}
                    value={item.progress}
                    aria-label={`Uploading ${item.file.name}`}
                  />
                )}
              </div>
              {!busy && item.status !== "done" && (
                <button
                  type="button"
                  className="photo-button photo-button--quiet"
                  aria-label={`Remove ${item.file.name}`}
                  onClick={() => {
                    URL.revokeObjectURL(item.preview);
                    previews.current.delete(item.preview);
                    setItems((current) =>
                      current.filter((entry) => entry.id !== item.id),
                    );
                  }}
                >
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {items.some((item) => item.status !== "done") && (
        <div className="photo-upload__actions">
          <button
            type="button"
            className="photo-button photo-button--primary"
            disabled={busy}
            onClick={() => void publish()}
          >
            {busy
              ? "Publishing…"
              : items.some((item) => item.status === "error")
                ? "Retry unpublished photos"
                : "Publish photos"}
          </button>
          <span>Published photos appear in the gallery automatically.</span>
        </div>
      )}
    </section>
  );
}
