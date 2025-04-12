#!/bin/bash

# Exit if a command exits with a nonzero exit value
set -e

# Format code
prettier . --write
find . -type f \( -name "*.sh" -o -name "*.bash" -o -name ".gitignore" -o -name ".dockerignore" -o -name "Dockerfile" \) -exec shfmt -l -w {} \;

# Stop and remove all Docker containers
CONTAINERS=$(docker ps -a -q)

if [ ! -z "$CONTAINERS" ]; then
	docker stop ${CONTAINERS}
	docker rm ${CONTAINERS}
fi

# Build image
docker build -t youtubeautocomment:latest .

# Test image
trap '' SIGINT
set +e
docker run -p 80:80 youtubeautocomment:latest
set -e
trap - SIGINT

read -p "Do you want to proceed with pushing to DockerHub? (y/n): " answer
if [ "$answer" == "y" ]; then
	docker tag youtubeautocomment:latest brookmaodev/youtubeautocomment:latest
	docker push brookmaodev/youtubeautocomment:latest
	echo "Successfully pushed to DockerHub"
else
	echo "Push canceled"
fi
