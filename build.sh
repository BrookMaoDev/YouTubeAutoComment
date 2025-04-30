#!/bin/bash

# Exit the script if any command fails
set -e

# Stop and remove all running Docker containers
CONTAINERS=$(docker ps -a -q)

if [ -n "$CONTAINERS" ]; then
	docker stop $CONTAINERS
	docker rm $CONTAINERS
fi

# Build the Docker image
docker build -t youtubeautocomment .

# Run the Docker container to test the image
docker run -p 80:80 youtubeautocomment
