export const PHOTO_BUCKET =
  "https://code2create-photos-963957629631.s3.ap-south-1.amazonaws.com";

export interface GalleryPhoto {
  key: string;
  preview: string;
  thumbnail: string;
  name: string;
  width: number;
  height: number;
}

export interface PhotoCatalog {
  photos: GalleryPhoto[];
}

export function photoUrl(key: string): string {
  return `${PHOTO_BUCKET}/${key.split("/").map(encodeURIComponent).join("/")}`;
}

export function parseCatalog(value: unknown): PhotoCatalog {
  if (
    typeof value !== "object" ||
    value === null ||
    !("photos" in value) ||
    !Array.isArray(value.photos)
  ) {
    throw new Error("Invalid photo catalog");
  }
  const photos = value.photos.map((photo: unknown): GalleryPhoto => {
    if (
      typeof photo !== "object" ||
      photo === null ||
      !("key" in photo) ||
      typeof photo.key !== "string" ||
      !photo.key.startsWith("originals/") ||
      !("preview" in photo) ||
      typeof photo.preview !== "string" ||
      !photo.preview.startsWith("previews/") ||
      !("thumbnail" in photo) ||
      typeof photo.thumbnail !== "string" ||
      !photo.thumbnail.startsWith("previews/") ||
      !("name" in photo) ||
      typeof photo.name !== "string" ||
      !("width" in photo) ||
      typeof photo.width !== "number" ||
      !Number.isFinite(photo.width) ||
      photo.width <= 0 ||
      !("height" in photo) ||
      typeof photo.height !== "number" ||
      !Number.isFinite(photo.height) ||
      photo.height <= 0
    ) {
      throw new Error("Invalid photo in catalog");
    }
    return {
      key: photo.key,
      preview: photo.preview,
      thumbnail: photo.thumbnail,
      name: photo.name,
      width: photo.width,
      height: photo.height,
    };
  });
  return { photos };
}
