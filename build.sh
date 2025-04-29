#!/bin/bash

# Exit if a command exits with a nonzero exit value
set -e

# Stop and remove all Docker containers
CONTAINERS=$(docker ps -a -q)

if [ ! -z "$CONTAINERS" ]; then
	docker stop ${CONTAINERS}
	docker rm ${CONTAINERS}
fi

# Build image
docker build -t youtubeautocomment .

# Test image
docker run -p 80:80 youtubeautocomment
