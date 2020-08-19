FROM node:12

# Create app directory
WORKDIR /usr/src/app

# Install app dependencies
COPY package*.json ./
RUN npm ci --only=production

# Copy built app
COPY ./dist/. .

# Copy the run script
COPY ./build/run.sh .

# Run app
EXPOSE 8080
ENV NODE_ENV=production
CMD [ "./run.sh" ]
