FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY server.js qa-rubric.js qa-store.js skills-store.js skills-import.js ./
COPY public ./public
COPY views ./views
# Ticket QA and the Skills Matrix write their SQLite files here. Mount a volume
# on /app/data or every completed QA and skills change is lost when the
# container is replaced.
RUN mkdir -p /app/data && chown node:node /app/data
VOLUME /app/data
ENV PORT=3000
ENV QA_DB_PATH=/app/data/qa.sqlite
ENV SKILLS_DB_PATH=/app/data/skills.sqlite
EXPOSE 3000
USER node
CMD ["node", "server.js"]
