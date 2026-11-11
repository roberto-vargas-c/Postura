// Synthetic landmark sets for the "example report". They describe a made-up person
// with a slightly high right shoulder, mild forward head and one knee drifting inward.
// Coordinates are normalized to a 3:4 portrait frame.

function blank() {
  return Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 0.99 }));
}

// Front view: the person's right is on image-left.
function frontal(view) {
  const L = blank();
  const flip = view === 'front' ? 1 : -1; // person's left goes to +x on the front view
  const cx = 0.5;
  const set = (i, dxPersonLeft, y, vis = 0.99) => { L[i] = { x: cx + flip * dxPersonLeft, y, z: 0, visibility: vis }; };
  set(0, -0.004, 0.115, view === 'front' ? 0.99 : 0.2);
  set(2, 0.02, 0.105); set(5, -0.025, 0.103);
  set(7, 0.045, 0.118); set(8, -0.052, 0.113);
  set(11, 0.115, 0.215); set(12, -0.118, 0.205);
  set(13, 0.14, 0.34); set(14, -0.14, 0.33);
  set(15, 0.15, 0.45); set(16, -0.15, 0.44);
  set(23, 0.07, 0.48); set(24, -0.072, 0.476);
  set(25, 0.055, 0.68); set(26, -0.07, 0.68);
  set(27, 0.072, 0.87); set(28, -0.075, 0.87);
  set(29, 0.07, 0.895); set(30, -0.073, 0.895);
  set(31, 0.09, 0.9); set(32, -0.095, 0.9);
  return L;
}

function side() {
  const L = blank();
  // Facing image-right, left side nearest the camera.
  const s = (i, x, y, vis = 0.99) => { L[i] = { x, y, z: 0, visibility: vis }; };
  s(0, 0.585, 0.12);
  s(2, 0.57, 0.108); s(5, 0.572, 0.108, 0.4);
  s(7, 0.525, 0.115); s(8, 0.528, 0.115, 0.3);
  s(11, 0.488, 0.215); s(12, 0.492, 0.212, 0.4);
  s(13, 0.49, 0.34); s(14, 0.49, 0.34, 0.3);
  s(15, 0.5, 0.45); s(16, 0.5, 0.45, 0.3);
  s(23, 0.49, 0.48); s(24, 0.492, 0.48, 0.4);
  s(25, 0.492, 0.68); s(26, 0.494, 0.68, 0.4);
  s(27, 0.478, 0.87); s(28, 0.48, 0.87, 0.4);
  s(29, 0.462, 0.895); s(30, 0.464, 0.895, 0.4);
  s(31, 0.53, 0.9); s(32, 0.532, 0.9, 0.4);
  return L;
}

export function exampleViews() {
  return { front: frontal('front'), side: side(), back: frontal('back') };
}
