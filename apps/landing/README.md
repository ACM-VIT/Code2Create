# Code2Create landing page

The public Code2Create 7.0 landing experience. It is a Vite and React application in the Code2Create pnpm workspace.

```bash
pnpm install
pnpm --filter @code2create/landing dev
pnpm --filter @code2create/landing build
```

The page is one GSAP-driven pinned stage followed by the footer. Artwork is under `public/assets`, and the animation timeline lives under `src/journey`.
