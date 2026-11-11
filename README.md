# Postura

Guided body-alignment scan in the browser. Three photos (front, side, back) go through
MediaPipe Pose on the device; the app scores six regions: head and neck, shoulders,
torso and spine, hips and pelvis, knees, feet and balance. Not a medical device.

## 3D video scan (in the app)
Prop the phone up 2.5 to 3 m away and record a 20 to 30 s video while turning once on the spot in an
A-pose. scanvideo.js samples about 72 frames, gets a body outline (segmentation mask) and joints for
each, works out the turn angle of every frame from the torso width (narrowest = side on, widest =
front or back), and carves a 1 cm voxel grid with all the outlines (visual hull). The hull is meshed
with surface nets, smoothed, coloured from the video and passed to the 3D pipeline below. Height is
needed for scale. Known limits: hollows such as between the arms and chest are filled in (chest
girth reads high), the camera is treated as orthographic (about 4% short in height on tests), and so
far it has only been tested on simulated turn-arounds.

## 3D scan import
Import a mesh (OBJ, GLB, PLY, STL) from a scanning app such as Scaniverse, Polycam or KIRI Engine.
scan3d.js finds units, up axis, floor patch and facing direction, squares the stance on the grid,
renders four orthographic views to locate joints with the pose model, then slices the mesh:
horizontal cross-sections (head to ankles, left/right legs separated), a side section through the
pelvis and a front section through the hips. metrics3d.js turns that into region scores (rotation,
twist, tilt, back curve depths, girths and left/right differences, centre of mass vs plumb line).
report3d.js draws the 3D viewer, posture grid sections and measurements, and compares with the
previous 3D scan. mannequin.js builds the procedural sample body used by the example report.

## Accounts (email and password)
The person icon in the header opens sign-in. Accounts use Postura's own Firebase project
(postura-1c2aa): Firebase Authentication with email and password, and Cloud Firestore in eur3
(Europe). Scan results sync to users/{uid}/scans/{id}, one JSON string per scan. Photos never
leave the phone: account.js removes the images before syncing. firestore.rules lets each person
read, write and delete only their own scans. Accounts switch off inside an iframe, on plain http
(other than localhost), or when firebase-config.js is null. To allow a new web address, add it in
Firebase > Authentication > Settings > Authorized domains.

## Run locally
    sh build.sh                    # writes index.html from app.html
    python3 -m http.server 8000   # then open http://localhost:8000
Live camera guidance needs https or localhost. On a phone, host it over https
(e.g. GitHub Pages, Netlify) to get the live camera; otherwise "Take photo" works everywhere.

## Files
- app.html: page body and styles (build.sh wraps it into index.html with the icons and manifest)
- icons/, manifest.webmanifest: app icon (sliced-disc mark), favicon, home-screen and maskable icons
- app.js: guided capture flow, live camera cues, report, history (localStorage)
- metrics.js: all alignment maths and thresholds (pure, runs in Node)
- example.js: synthetic landmarks for the example report
- scanvideo.js: turn-around video to 3D body (visual hull)
- scan3d.js, metrics3d.js, report3d.js, mannequin.js: 3D scan pipeline, metrics, report, sample body
- account.js, firebase-config.js, firestore.rules: accounts, scan sync and database rules
- vendor/firebase: Firebase JS SDK compat builds (app, auth, firestore)
- vendor/three: three.js r160 (module build and the loaders/controls used)
- vendor/, wasm/, models/: MediaPipe Tasks Vision 0.10.14 and pose_landmarker_full (models/*.task.wasm is the .task file, renamed so static hosts serve it)

## Third-party code
- three.js r160, MIT licence, (c) three.js authors: https://github.com/mrdoob/three.js
- MediaPipe Tasks Vision 0.10.14 and the Pose Landmarker model, Apache 2.0, (c) Google: https://github.com/google-ai-edge/mediapipe
- Firebase JS SDK, Apache 2.0, (c) Google: https://github.com/firebase/firebase-js-sdk
