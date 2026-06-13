#!/bin/bash

VERSION_NO_V=$(echo $RELEASE_VERSION | sed 's/^v//')
export VERSION_NO_V

(
    echo "## Release $RELEASE_VERSION"
    echo ""
    echo "New version has been released!"
    echo ""
    echo "### Changes"
    echo ""
    git log --pretty=format:"* %s" $(git describe --tags --abbrev=0 HEAD^ 2>/dev/null || git rev-list --max-parents=0 HEAD)..HEAD
    echo ""
) > release.md
