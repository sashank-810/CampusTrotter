# backend/Dockerfile

FROM node:20-alpine

# 1) Set working directory inside the container
WORKDIR /app

# 2) Copy only package files first (better for caching)
COPY package*.json ./

# 3) Install prod dependencies
RUN npm install --production

# 4) Copy the rest of the backend code (including src/ and firebase JSON)
COPY . .

# 5) Environment defaults (can be overridden in App Runner)
ENV NODE_ENV=production
ENV PORT=5001

# Your Firebase service account JSON is in backend/ based on folder_plan.txt:
# midterm-transvahan-firebase-adminsdk--********.json
# Inside the container it will end up at /app/midterm-transvahan-firebase-adminsdk-********.json
ENV GOOGLE_APPLICATION_CREDENTIALS=/app/<GOOGLE_SERVICE_ACCOUNT>.json

# 6) Expose app port
EXPOSE 5001

# 7) Start the server
CMD ["node", "src/server.js"]
