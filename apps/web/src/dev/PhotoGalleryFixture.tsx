import { useState } from "react";
import {
  PhotoGallery,
  type GalleryPhoto,
  type Filters,
  type Facets,
} from "../screens/PhotosScreen";
import { photoSamples } from "./photoSamples";

function sampleFacets(photos: GalleryPhoto[]): Facets {
  return Array.from(new Set(photos.map((photo) => photo.uploaderId))).map(
    (uploaderId) => {
      const own = photos.filter((photo) => photo.uploaderId === uploaderId);
      return {
        uploaderId,
        uploaderName: own[0]?.uploaderName ?? "Photographer",
        counts: {
          "6": own.filter((p) => p.day === "6").length,
          "7": own.filter((p) => p.day === "7").length,
          "8": own.filter((p) => p.day === "8").length,
          other: own.filter((p) => p.day === "other").length,
        },
      };
    },
  );
}

export function PhotoGalleryFixture({
  canUpload = false,
  empty = false,
}: {
  canUpload?: boolean;
  empty?: boolean;
}) {
  const [filters, setFilters] = useState<Filters>({ sort: "newest" });
  const source = empty ? [] : photoSamples;
  const photos = source
    .filter(
      (photo) =>
        (!filters.day || photo.day === filters.day) &&
        (!filters.uploaderId || photo.uploaderId === filters.uploaderId),
    )
    .sort((a, b) =>
      filters.sort === "uploader"
        ? a.uploaderName.localeCompare(b.uploaderName)
        : filters.sort === "oldest"
          ? (a.capturedAt ?? 0) - (b.capturedAt ?? 0)
          : (b.capturedAt ?? 0) - (a.capturedAt ?? 0),
    );
  return (
    <PhotoGallery
      photos={photos}
      eventName="Code2Create · preview"
      filters={filters}
      facets={sampleFacets(source)}
      onFiltersChange={setFilters}
      canUpload={canUpload}
      signedIn={canUpload}
      getDownloadUrl={async (photo) => photo.originalUrl}
    />
  );
}
