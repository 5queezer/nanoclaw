#!/bin/bash
# Build the NanoClaw agent container image

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

IMAGE_NAME="nanoclaw-agent"
TAG="${1:-latest}"
CONTAINER_RUNTIME="${CONTAINER_RUNTIME:-docker}"

echo "Building NanoClaw agent container image..."
echo "Image: ${IMAGE_NAME}:${TAG}"

# Copy himalaya binary into build context (statically linked, safe to embed)
HIMALAYA_BIN="$(command -v himalaya 2>/dev/null || true)"
if [ -n "$HIMALAYA_BIN" ]; then
  cp "$HIMALAYA_BIN" "$SCRIPT_DIR/himalaya"
  echo "Included himalaya binary from $HIMALAYA_BIN"
fi

${CONTAINER_RUNTIME} build -t "${IMAGE_NAME}:${TAG}" .

# Clean up temporary copy
rm -f "$SCRIPT_DIR/himalaya"

echo ""
echo "Build complete!"
echo "Image: ${IMAGE_NAME}:${TAG}"
echo ""
echo "Test with:"
echo "  echo '{\"prompt\":\"What is 2+2?\",\"groupFolder\":\"test\",\"chatJid\":\"test@g.us\",\"isMain\":false}' | ${CONTAINER_RUNTIME} run -i ${IMAGE_NAME}:${TAG}"
