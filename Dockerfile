# One small image: Bun gateway + the static PostgREST and Supabase Auth binaries.
FROM postgrest/postgrest:v12.2.12 AS postgrest
FROM supabase/auth:v2.177.0 AS auth

FROM oven/bun:1.3.0-alpine
WORKDIR /app

COPY --from=postgrest /bin/postgrest /usr/local/bin/postgrest
COPY --from=auth /usr/local/bin/auth /usr/local/bin/auth
COPY --from=auth /usr/local/etc/auth/migrations /usr/local/etc/auth/migrations

COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile

COPY server ./server
COPY db ./db
COPY functions ./functions
COPY client ./client
COPY examples/vanilla ./examples/vanilla
COPY examples/cursors ./examples/cursors

ENV PORT=8000
EXPOSE 8000
USER bun
CMD ["bun", "run", "server/index.ts"]
