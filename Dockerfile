FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production
RUN chown node:node /app

COPY --chown=node:node package.json server.mjs index.html demo-labels.html ./
COPY --chown=node:node server ./server
COPY --chown=node:node src ./src

USER node
CMD ["node", "server.mjs"]
