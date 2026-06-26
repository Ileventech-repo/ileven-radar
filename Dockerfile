# ---- Build stage ----
FROM node:20-slim AS build
WORKDIR /app

# Install all deps (incl. dev) for the TypeScript build.
COPY package.json package-lock.json* ./
RUN npm install

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Prune to production-only dependencies for the runtime image.
RUN npm prune --omit=dev

# ---- Runtime stage ----
FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Non-root user for safety.
RUN useradd --user-group --create-home --shell /bin/false appuser

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
# Migration .sql files are read at runtime by the migration runner.
COPY --from=build /app/src/db/migrations ./dist/db/migrations

USER appuser
EXPOSE 8080

# `npm start` runs migrations then boots the agent.
CMD ["npm", "start"]
