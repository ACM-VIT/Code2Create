# @code2create/trailer

A 24-second Remotion trailer for Code2Create 7.0, built from the cherry
blossom brand file. 1920x1080 at 30 fps, 720 frames.

The film is one night, four shots, one cut. It opens inside the blossom
canopy, petals letting go. It rises with the sky lanterns while "what if?"
lands beside a wish. It drops low over the water, where petals touch down
in ripples and "it works." settles. Then the camera lifts through the
petals, and a blossom-white wash covers the only cut at frame 458. The wide
shot resolves: hills, the tree, lanterns, the mark assembling facet by
facet, the wordmark cascading in, then the end card.

## Work on it

```sh
pnpm dev:trailer      # Remotion Studio at the printed port
pnpm render:trailer   # writes out/trailer.mp4
pnpm --filter @code2create/trailer render:reel   # writes out/reel.mp4, the 1080x1920 cut
```

Every beat is timed in `src/theme.ts` (`T`). Change a number there and the
whole film re-times around it.

## Music

The render ships with one whoosh at the dive and no music bed, because the
repo carries no licensed track. To add one: drop the file at
`public/music.mp3`, then add inside the root `<AbsoluteFill>` of
`src/Trailer.tsx`:

```tsx
<Audio src={staticFile("music.mp3")} volume={0.8} />
```

A track around 120 bpm fits: at 30 fps a beat is exactly 15 frames, and the
cut lands on frame 458.

## Assets

`public/` holds the brand art: the transparent blossom tree, the hills
panorama, one high-resolution petal (`petal-hero.png`, full size;
`petal.png`, downsized for the field), and a sky lantern photo. The logo and wordmark are inlined as SVG paths in
`src/components/` so each facet and glyph animates on its own beat.
