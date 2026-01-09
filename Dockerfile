# Simple production image for the Logic Slack Bot
# Builds TypeScript at image build time and runs the compiled JS.

FROM node:20-alpine AS build
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

RUN npm run build


FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist

# Slack will call /slack/events on this port (usually via a reverse proxy / LB)
ENV PORT=3000
EXPOSE 3000

CMD ["node", "dist/index.js"]
