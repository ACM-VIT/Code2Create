import type { GalleryPhoto } from "../screens/PhotosScreen";

// Library sample photographs, only for the development screen gallery.
// https://react-photo-album.com/examples/rows
const samples = [
  {
    path: "image01.0822d131.2400x1734",
    width: 2400,
    height: 1734,
    caption: "Hiking boots",
  },
  {
    path: "image02.7561b5a4.2400x3600",
    width: 2400,
    height: 3600,
    caption: "Wildflowers by the mountain",
  },
  {
    path: "image05.9962a853.2400x3600",
    width: 2400,
    height: 3600,
    caption: "A quiet coffee",
  },
];

export const photoSamples: GalleryPhoto[] = Array.from(
  { length: 12 },
  (_, index) => {
    const sample = samples[index % samples.length];
    if (!sample) throw new Error("Missing photo fixture");
    const origin = `https://images.react-photo-album.com/hiking/${sample.path}`;
    return {
      id: `photo-fixture-${index}` as GalleryPhoto["id"],
      uploaderId: `person-fixture-${index % 2}` as GalleryPhoto["uploaderId"],
      uploaderName: index % 2 ? "Arjun" : "Meera",
      capturedAt:
        index % 4 === 3
          ? undefined
          : Date.UTC(2026, 8, 6 + (index % 3), 9, index),
      day: (["6", "7", "8", "other"] as const)[index % 4] ?? "other",
      fileName: `sample-${index + 1}.jpg`,
      caption: sample.caption,
      width: sample.width,
      height: sample.height,
      byteCount: 8_000_000,
      src: `${origin}.2400w.jpg`,
      originalUrl: `${origin}.2400w.jpg`,
      srcSet: [2400].map((width) => ({
        src: `${origin}.${width}w.jpg`,
        width,
        height: Math.round((width * sample.height) / sample.width),
      })),
    };
  },
);
