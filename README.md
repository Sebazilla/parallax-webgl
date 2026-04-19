# Parallax Wimmelbild (Web)

Head-tracked parallax prototype that runs in the browser. Front camera feeds
MediaPipe FaceLandmarker; the face position drives an off-axis (asymmetric
frustum) projection over 16 layered PNGs rendered with Three.js.

## Run

Open `index.html` over **HTTPS** on an iPhone/Android and allow camera access.
The Mac works too for debugging.

Served directly from GitHub via [raw.githack.com](https://raw.githack.com/):

```
https://raw.githack.com/Sebazilla/parallax-webgl/main/index.html
```

## Files

- `index.html` — tap-to-start overlay + WebGL canvas.
- `main.js` — Three.js scene, MediaPipe integration, off-axis camera.
- `assets/` — 16 PNG layers (background Wimmelbild + 13 cutout objects + cat + right curtain).

## Known limits

- Assumes portrait orientation and iPhone-16-Plus-like screen geometry
  (77 × 160 mm, camera-to-screen-center ≈ 86 mm).
- Web-cam face tracking is less precise than ARKit TrueDepth — parallax jitters
  slightly more. Ambient IR / low light makes it worse.
