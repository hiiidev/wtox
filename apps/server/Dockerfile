FROM node:24-bookworm-slim
WORKDIR /app
COPY --chown=node:node apps/server/src ./apps/server/src
COPY --chown=node:node packages/protocol/src ./packages/protocol/src
RUN mkdir -p /data && chown node:node /data
ENV HOST=0.0.0.0 PORT=8787 WTOX_DATA_DIR=/data NODE_ENV=production
USER node
EXPOSE 8787
CMD ["node", "--experimental-strip-types", "apps/server/src/index.ts"]
