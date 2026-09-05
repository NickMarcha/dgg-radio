FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY server ./server
RUN npm run build:api

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist-server ./dist-server
# The API applies pending migrations on startup, so the SQL must ship in the
# runtime image. drizzle-orm's migrator is a runtime dependency; drizzle-kit
# (a devDependency) is only needed to *generate* migrations, not to apply them.
COPY drizzle ./drizzle
# The genre the room ships with, applied at startup. See src/server/genre.ts.
COPY data ./data
EXPOSE 8787
CMD ["node", "dist-server/index.js"]
