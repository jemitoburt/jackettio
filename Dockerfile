FROM node:20-slim

# Install git for cloning repository
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /home/node/app && chown -R node:node /home/node/app \
  && mkdir -p /data && chown -R node:node /data

WORKDIR /home/node/app

# Clone repository (use build arg for branch/tag if needed)
ARG GIT_REPO=https://github.com/jemitoburt/jackettio.git
ARG GIT_BRANCH=master

# Clone repo as root first, then change ownership
USER root
RUN git clone --depth 1 --branch ${GIT_BRANCH} ${GIT_REPO} /tmp/repo \
  && cp -r /tmp/repo/src /home/node/app/src \
  && cp /tmp/repo/package*.json /home/node/app/ \
  && rm -rf /tmp/repo \
  && chown -R node:node /home/node/app

USER node

RUN npm install

EXPOSE 4000

CMD [ "node", "src/index.js" ]
