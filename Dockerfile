# ====================================================
#                     BUILD IMAGE
# ====================================================

FROM node:20-alpine AS BUILD_IMAGE
ENV NODE_ENV=development

# Disable npm update message
RUN npm config set update-notifier false

# ====================================
# Install dependencies
# ====================================
WORKDIR /build

RUN apk add --no-cache git \
    && git config --global url."https://github.com/".insteadOf ssh://git@github.com/

COPY package*.json ./
COPY backend/package*.json backend/
COPY frontend/package*.json frontend/
RUN npm ci

# ====================================
# Copy and build
# ====================================

ENV NODE_ENV=production
ENV HEADLESS=true

# Backend must go first
COPY backend backend
RUN npm run --workspace=backend build

COPY frontend frontend
RUN npm run --workspace=frontend build
RUN mkdir -p backend/static/app/js/ && mv frontend/build/* backend/static/app/js/

# Cleanup
RUN rm -rf /build/backend/src

# ====================================
# Prune non-production dependencies
# ====================================
RUN npm prune --workspaces --omit=dev

# ====================================================
#                       APP IMAGE
# ====================================================

FROM node:20-alpine AS APP_IMAGE
ENV NODE_ENV=production
ARG PARSER_IMAGE_REF=local
ENV PARSER_IMAGE_REF=$PARSER_IMAGE_REF

# Install headless JRE, disable npm update notice.
RUN apk add --no-cache openjdk17-jre-headless \
    && npm config set update-notifier false

# ====================================
# Copy built files
# ====================================

WORKDIR /app

# Move built JS to static app
COPY --from=BUILD_IMAGE /build/backend /app

# Copy dependencies
COPY --from=BUILD_IMAGE /build/node_modules /app/node_modules

# ====================================
# Start
# ====================================

ENV PORT 80
EXPOSE 80

CMD [ "node", "build/PagasaParserWeb.js" ]
