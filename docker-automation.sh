#!/bin/bash

# Exit if a command exits with a nonzero exit value
set -e

# Format code
prettier . --write

# Build image
docker build -t youtubeautocomment:crud .

# Test image
set +e
docker run -p 80:80 youtubeautocomment:crud
set -e

read -p "Do you want to proceed with pushing to DockerHub? (y/n): " answer
if [ "$answer" == "y" ]; then
    docker tag youtubeautocomment:crud brookmaodev/youtubeautocomment:crud
    docker push brookmaodev/youtubeautocomment:crud
    echo "Successfully pushed to DockerHub"
else
    echo "Push canceled"
fi
