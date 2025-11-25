Docker build local

```docker
docker buildx build --platform linux/amd64,linux/arm64 \
  -t jemitoburt/jackettio:latest \
  --push \
  .
```

Docker server 

```docker
docker compose pull jackettio
docker compose up -d jackettio
docker logs -f jackettio
```