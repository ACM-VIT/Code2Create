FROM node@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e

ENV NODE_ENV=production
WORKDIR /workspace

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches patches
COPY apps/discord/package.json apps/discord/package.json
COPY packages/domain/package.json packages/domain/package.json
RUN pnpm install --frozen-lockfile --prod --filter @code2create/discord...

COPY apps/discord/src apps/discord/src
COPY packages/domain/src packages/domain/src

USER node
EXPOSE 8080
CMD ["pnpm", "--filter", "@code2create/discord", "start"]
