# Builds the Website Downloader worker (the original Wget engine).
#
# THIS service must run on an always-on host (Render, Railway, Fly.io, a VPS,
# etc.) — it CANNOT run inside a Vercel serverless function, because Vercel
# Hobby has no `wget` binary, a ~10s execution ceiling, an ephemeral filesystem
# and no long-running process. The Vercel app talks to this worker through the
# authenticated proxy mounted at /api/jobs.
#
# Build:   docker build -t wd-worker -f worker/Dockerfile .
# Run:     docker run --rm -p 3200:3200 -e WORKER_API_KEY=<secret> \
#            -e WORKER_CORS_ORIGIN=https://<your-app>.vercel.app wd-worker
FROM node:20-alpine

# The download engine requires GNU Wget.
RUN apk add --no-cache wget ca-certificates

WORKDIR /app

# Install production dependencies first (better layer caching).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev || npm install --omit=dev

# Copy the application (wget engine, archiver, worker server).
COPY . .

ENV NODE_ENV=production
ENV PORT=3200
EXPOSE 3200

CMD ["node", "worker/server.js"]
