import * as THREE from './three.module.js';
import { CSS3DObject, CSS3DRenderer } from './css3d.js';
import { sampleTerminalMotion, sphereLinePositions } from './terminal-motion.js?v=ae-10';

const clamp = (n, a = 0, b = 1) => Math.max(a, Math.min(b, n));
const ease = t => 1 - (1 - clamp(t)) ** 4;
const lerp = (a, b, t) => a + (b - a) * t;

export function createTerminalScene({ canvas, plane, home, dom, reduced = false }) {
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: 'low-power' });
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.5));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.VSMShadowMap;
  renderer.shadowMap.autoUpdate = false;
  renderer.shadowMap.needsUpdate = true;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene();
  const introBackground = new THREE.Color(0x070c12);
  const paperBackground = new THREE.Color(0xdce5fb);
  const nightBackground = new THREE.Color(0x080b10);
  const portalBackground = new THREE.Color();
  const htmlScene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, 1, 1, 10000);
  const css = new CSS3DRenderer({ element: dom });
  const ui = new CSS3DObject(plane);
  ui.position.z = 14;
  htmlScene.add(ui);
  const allowSpatial = !matchMedia('(pointer: coarse)').matches;
  let width = 1, height = 1, activeHeight = 1, distance = 1000, spatial = null, desktop = false, projectionStyle = '';
  const projectedPhases = new Set(['intro', 'handoff', 'assembling', 'auth-morph', 'success', 'entering']);
  let mode = 'idle', epoch = performance.now(), frame = 0, until = 0, disposed = false;
  const artController = new AbortController();
  let artDeadline = 0;
  let pointer = { x: 0, y: 0 }, drift = { x: 0, y: 0 };
  const introHome = document.getElementById('intro-assembly');
  const introElements = ['intro-left', 'intro-core', 'intro-right'].map(id => document.getElementById(id));
  const introStyles = introElements.map(el => el ? Object.fromEntries(['position', 'transform', 'display', 'width', 'height', 'pointerEvents', 'userSelect'].map(key => [key, el.style[key]])) : {});
  const introObjects = introHome && introElements.every(Boolean) ? introElements.map(el => new CSS3DObject(el)) : [];
  const introRig = new THREE.Group();
  introObjects.forEach(object => introRig.add(object));
  htmlScene.add(introRig);
  let introSpatial = null;
  function setIntroSpatial(enabled) {
    enabled = enabled && introObjects.length === 3;
    if (introSpatial === enabled) return;
    introSpatial = enabled;
    document.body.dataset.introSpatial = String(enabled);
    introRig.visible = enabled;
    introObjects.forEach((object, i) => {
      const el = object.element;
      if (enabled) {
        el.style.position = 'absolute'; el.style.width = i === 1 ? '148px' : '820px';
        el.style.height = i === 1 ? '148px' : ''; el.style.display = ''; el.style.pointerEvents = 'none';
      } else {
        introHome.appendChild(el);
        for (const [key, value] of Object.entries(introStyles[i])) el.style[key] = value;
      }
    });
  }
  const resources = [];
  const keep = resource => { resources.push(resource); return resource; };

  const ambient = new THREE.HemisphereLight(0xdfeaff, 0x243247, 2.3);
  scene.add(ambient);
  const sun = new THREE.DirectionalLight(0xffffff, 2.7);
  sun.position.set(-430, 680, 1100);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  Object.assign(sun.shadow.camera, { left: -850, right: 850, top: 700, bottom: -700, near: 1, far: 2500 });
  sun.shadow.normalBias = .7;
  sun.shadow.bias = -.00003;
  sun.shadow.radius = 4;
  sun.shadow.blurSamples = 6;
  scene.add(sun);

  const floor = new THREE.Mesh(keep(new THREE.PlaneGeometry(6000, 4000)), keep(new THREE.ShadowMaterial({ color: 0x18273b, opacity: .27 })));
  floor.position.z = -14;
  floor.receiveShadow = true;
  scene.add(floor);
  const ink = keep(new THREE.MeshStandardMaterial({ color: 0x080b10, metalness: .2, roughness: .54 }));
  const metal = keep(new THREE.MeshStandardMaterial({ color: 0x253541, metalness: .62, roughness: .3 }));
  const silver = keep(new THREE.MeshStandardMaterial({ color: 0x8294ac, metalness: .66, roughness: .25 }));
  const lamp = keep(new THREE.MeshBasicMaterial({ color: 0xe2ecff }));
  function box(w, h, d, material = ink) {
    const mesh = new THREE.Mesh(keep(new THREE.BoxGeometry(w, h, d)), material);
    mesh.castShadow = true;
    return mesh;
  }

  const anchors = new THREE.Group();
  const anchorMeshes = Array.from({ length: 4 }, () => {
    const b = box(24, 22, 14); anchors.add(b); return b;
  });
  scene.add(anchors);
  const frameGroup = new THREE.Group();
  scene.add(frameGroup);
  let frameParts = [];
  function rectFor(element) {
    let x = 0, y = 0, el = element;
    while (el && el !== plane) { x += el.offsetLeft; y += el.offsetTop; el = el.offsetParent; }
    return { x: x + element.offsetWidth / 2 - plane.offsetWidth / 2, y: plane.offsetHeight / 2 - y - element.offsetHeight / 2, w: element.offsetWidth, h: element.offsetHeight };
  }
  function rebuildFrames() {
    for (const p of frameParts) { frameGroup.remove(p); p.geometry.dispose(); }
    frameParts = [];
    for (const el of plane.querySelectorAll('.physical-frame')) {
      const r = rectFor(el);
      if (r.w < 1 || r.h < 1) continue;
      const pieces = [[r.w, 2.5, r.x, r.y + r.h / 2], [r.w, 2.5, r.x, r.y - r.h / 2], [2.5, r.h, r.x - r.w / 2, r.y], [2.5, r.h, r.x + r.w / 2, r.y]];
      for (const [w, h, x, y] of pieces) {
        const part = new THREE.Mesh(new THREE.BoxGeometry(w, h, 4), ink);
        part.position.set(x, y, 14); part.castShadow = true;
        part.userData.home = [x, y]; part.userData.index = frameParts.length;
        frameGroup.add(part); frameParts.push(part);
      }
    }
  }

  // A real lit equipment chassis sits behind the opening titles, rather than a blurred word as a backdrop.
  const rack = new THREE.Group();
  const chassis = box(850, 385, 40, metal);
  chassis.position.z = -45; rack.add(chassis);
  const inset = box(744, 284, 10, ink); inset.position.z = -18; rack.add(inset);
  for (const y of [-190, 190]) {
    const rail = box(840, 16, 27, silver); rail.position.set(0, y, -14); rack.add(rail);
    const shine = box(728, 3, 3, lamp); shine.position.set(4, y + 3, 1); rack.add(shine);
  }
  for (let i = 0; i < 16; i++) {
    const fin = box(8, 155, 19, silver); fin.position.set(-322 + i * 15, -10, 1); rack.add(fin);
  }
  for (let i = 0; i < 6; i++) {
    const cell = box(90, 13, 8, i % 3 === 0 ? lamp : silver); cell.position.set(250, -95 + i * 35, 4); rack.add(cell);
  }
  const fan = new THREE.Group();
  fan.position.set(60, 12, 16);
  for (let i = 0; i < 8; i++) {
    const blade = box(29, 100, 6, i % 3 ? silver : lamp);
    const a = i * Math.PI / 4; blade.position.set(Math.cos(a) * 48, Math.sin(a) * 48, 0); blade.rotation.z = a - .3; fan.add(blade);
  }
  const hub = new THREE.Mesh(keep(new THREE.CylinderGeometry(22, 22, 10, 24)), metal);
  hub.rotation.x = Math.PI / 2; fan.add(hub); rack.add(fan);
  // Recessed optical bay, offset face plates and diagonal light rails retain distinct depth planes.
  const opticalBay = new THREE.Group(); opticalBay.position.set(-80, 30, 55);
  for (let i = 0; i < 4; i++) {
    const plate = box(180, 30, 38, i % 2 ? metal : silver);
    plate.position.set(-190 + i * 128, 80 - i * 24, i * 16); plate.rotation.z = -.22;
    opticalBay.add(plate);
  }
  for (const side of [-1, 1]) {
    const guide = box(790, 9, 14, lamp); guide.position.set(15, side * 142, 38);
    guide.rotation.z = -.03 * side; opticalBay.add(guide);
    const housing = box(108, 230, 65, metal); housing.position.set(side * 377, 0, 4);
    housing.rotation.y = side * .12; opticalBay.add(housing);
  }
  rack.add(opticalBay);
  rack.position.set(45, -20, -260); rack.rotation.set(-.16, .27, .16); rack.scale.setScalar(1.42); rack.visible = false;
  scene.add(rack);

  const portal = new THREE.Group();
  const sphere = new THREE.IcosahedronGeometry(230, 1);
  const p = sphere.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const r = 1 + .055 * Math.sin(x * .044 + y * .053 + z * .071);
    p.setXYZ(i, x * r, y * r, z * r);
  }
  const wire = new THREE.LineSegments(keep(new THREE.WireframeGeometry(sphere)), keep(new THREE.LineBasicMaterial({ color: 0xe5ed35, transparent: true, opacity: .62 })));
  sphere.dispose();
  portal.add(wire);
  const dots = new Float32Array(480);
  for (let i = 0; i < dots.length; i += 3) {
    const n = i / 3;
    dots[i] = Math.sin(n * 73.31) * 1180;
    dots[i + 1] = Math.cos(n * 17.77) * 700;
    dots[i + 2] = Math.sin(n * 42.11) * 300 - 150;
  }
  const starsGeometry = keep(new THREE.BufferGeometry()); starsGeometry.setAttribute('position', new THREE.BufferAttribute(dots, 3));
  const stars = new THREE.Points(starsGeometry, keep(new THREE.PointsMaterial({ color: 0xd7dce8, size: 2.1, transparent: true, opacity: .42, sizeAttenuation: false })));
  portal.add(stars); portal.visible = false; scene.add(portal);
  // The original 80-face OBJ was reduced to bounded normalized edges by the offline import tool.
  // Missing optional art keeps the procedural sphere; it never holds up login or the entry deadline.
  artDeadline = setTimeout(() => artController.abort(), 2500);
  fetch('/_gate/assets/ae-sphere.json?v=ae-10', { credentials: 'omit', signal: artController.signal })
    .then(response => { if (!response.ok) throw new Error('Optional sphere unavailable'); return response.json(); })
    .then(value => {
      if (disposed) return;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(sphereLinePositions(value), 3));
      wire.geometry = keep(geometry);
      const vertices = new Map();
      for (let i = 0; i < value.positions.length; i += 3) {
        const point = value.positions.slice(i, i + 3);
        vertices.set(point.join(','), point.map(n => n * 230));
      }
      const nodeGeometry = keep(new THREE.BufferGeometry());
      nodeGeometry.setAttribute('position', new THREE.Float32BufferAttribute([...vertices.values()].flat(), 3));
      const nodes = new THREE.Points(nodeGeometry, keep(new THREE.PointsMaterial({ color: 0xe8ec5b, size: 3, transparent: true, opacity: .72, sizeAttenuation: false })));
      wire.add(nodes);
      document.body.dataset.aeModel = 'original';
      wake(300);
    }).catch(() => {}).finally(() => clearTimeout(artDeadline));
  document.body.dataset.aeModel = 'fallback';

  function setSpatial(enabled) {
    if (spatial === enabled) return;
    spatial = enabled;
    document.body.dataset.spatial = String(enabled);
    if (enabled) {
      plane.style.position = 'absolute';
      plane.style.transform = projectionStyle;
      plane.style.pointerEvents = 'auto';
      plane.style.userSelect = '';
      plane.style.margin = '0';
      dom.hidden = false;
    } else {
      const focused = plane.contains(document.activeElement) ? document.activeElement : null;
      if (plane.style.transform) projectionStyle = plane.style.transform;
      if (plane.parentNode !== home) home.appendChild(plane);
      plane.style.position = '';
      plane.style.transform = '';
      plane.style.display = '';
      plane.style.pointerEvents = '';
      plane.style.userSelect = '';
      plane.style.margin = '';
      dom.hidden = true;
      if (focused && document.activeElement !== focused) focused.focus({ preventScroll: true });
    }
  }
  function size() {
    width = innerWidth; height = innerHeight;
    activeHeight = Math.max(1, height - 2 * (document.querySelector('.bar-top')?.offsetHeight || 0));
    renderer.setSize(width, height, false); css.setSize(width, height);
    camera.aspect = width / height; camera.updateProjectionMatrix();
    distance = height * .5 / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    desktop = width > 900 && height > 620;
    document.body.dataset.depth = String(desktop);
    setSpatial(allowSpatial && desktop && projectedPhases.has(mode));
    setIntroSpatial(allowSpatial && desktop && ['intro', 'handoff'].includes(mode));
    renderer.shadowMap.enabled = desktop;
    const w = plane.offsetWidth, h = plane.offsetHeight;
    const positions = [[-w / 2 + 12, h / 2 - 11], [w / 2 - 12, h / 2 - 11], [-w / 2 - 4, -h / 2 + 11], [w / 2 + 4, -h / 2 + 11]];
    anchorMeshes.forEach((mesh, i) => { mesh.userData.home = positions[i]; mesh.position.set(...positions[i], 8); mesh.rotation.z = i % 2 ? -.015 : .02; });
    rebuildFrames();
    renderer.shadowMap.needsUpdate = true;
    wake(500);
  }
  function cameraAt(x, y, z, roll = 0) {
    camera.position.set(x, y, z); camera.lookAt(0, 0, 0); camera.rotateZ(roll);
  }
  function draw(now) {
    const seconds = (now - epoch) / 1000;
    const pose = sampleTerminalMotion(mode, seconds);
    let ongoing = pose.ongoing;
    rack.visible = mode === 'intro' || mode === 'handoff';
    portal.visible = mode === 'entering';
    floor.visible = !rack.visible && !portal.visible;
    anchors.visible = desktop && floor.visible;
    frameGroup.visible = desktop && ['assembling', 'idle', 'checking', 'error'].includes(mode) && (mode !== 'assembling' || seconds > .3);
    for (const part of frameParts) {
      const t = mode === 'assembling' ? ease((seconds - .18 - part.userData.index * .045) / .6) : 1;
      const [x, y] = part.userData.home;
      part.position.set(x + 75 * (1 - t), y + 18 * (1 - t), 14 + 100 * (1 - t));
      part.scale.set(t, t, 1);
    }
    if (mode === 'intro' || mode === 'handoff') {
      scene.background = introBackground;
      cameraAt(pose.x, pose.y, distance * pose.zoom, pose.roll);
      rack.rotation.set(-.16, .27, .16 + .018 * Math.sin(seconds * .6));
      fan.rotation.z = seconds * .18;
      const t = mode === 'handoff' ? 3.2 + seconds : seconds;
      introRig.position.set(38, 0, 105);
      introRig.rotation.set(.12, lerp(-.25, .1, ease(t / 3.4)), .2);
      introRig.scale.setScalar(Math.min(width / 1650, activeHeight / 650));
      introObjects.forEach((object, i) => {
        const arrive = ease((t - (i === 1 ? .25 : .7)) / (i === 1 ? 1.15 : 1.5));
        object.position.set((i - 1) * 490, i === 1 ? 0 : -12, (i === 1 ? 55 : 0) - (1 - arrive) * (i === 1 ? 330 : 70));
        object.rotation.set(i === 1 ? .06 : 0, i === 1 ? -.65 * (1 - arrive) : (i - 1) * .045, i === 1 ? -.1 : 0);
      });
      ui.visible = false; ongoing = mode === 'handoff' ? seconds < .7 : seconds < 3.4;
    } else if (mode === 'entering') {
      scene.background = portalBackground.copy(paperBackground).lerp(nightBackground, pose.exposure);
      cameraAt(pose.x, pose.y, distance * pose.zoom, pose.roll);
      const s = Math.min(1, width / 650, Math.max(.35, activeHeight / 520));
      portal.scale.setScalar(s);
      wire.rotation.set(.22 + seconds * .1, .25 + seconds * .28, -.12 + seconds * .055);
      wire.material.opacity = Math.min(.68, seconds * 2.5);
      ui.visible = seconds < .4;
      ui.position.z = -ease(seconds / .4) * 900;
      ui.rotation.y = -ease(seconds / .4) * .65;
      ongoing = seconds < 4;
    } else {
      scene.background = null;
      ui.visible = true; ui.position.z = 14; ui.rotation.set(0, 0, 0);
      const focus = plane.contains(document.activeElement);
      const px = reduced ? 0 : focus ? drift.x : pointer.x;
      const py = reduced ? 0 : focus ? drift.y : pointer.y;
      drift.x = lerp(drift.x, px, .1); drift.y = lerp(drift.y, py, .1);
      cameraAt(pose.x, pose.y, (distance + 14) * pose.zoom, pose.roll);
      anchorMeshes.forEach((mesh, i) => {
        const t = mode === 'assembling' ? ease((seconds - i * .095) / .6) : 1;
        const [x, y] = mesh.userData.home || [0, 0];
        const credential = mode === 'auth-morph' || mode === 'success';
        mesh.position.set(x * (credential ? lerp(1, .76, pose.card) : 1), y * (credential ? lerp(1, .86, pose.card) : 1), 8 + (1 - t) * (80 + i * 10));
        mesh.rotation.x = .12 + (1 - t) * .9;
        mesh.rotation.y = .055;
        mesh.scale.setScalar(.2 + .8 * t);
      });
      ongoing = mode === 'assembling' && seconds < 1.5;
    }
    if (mode === 'assembling') renderer.shadowMap.needsUpdate = true;
    renderer.render(scene, camera);
    if (spatial) css.render(htmlScene, camera);
    if ((ongoing || now < until) && !document.hidden && !disposed) frame = requestAnimationFrame(tick);
    else frame = 0;
  }
  function tick(now) { frame = 0; if (!disposed && !document.hidden) draw(now); }
  function wake(ms = 300) { until = Math.max(until, performance.now() + ms); if (!frame && !disposed && !document.hidden) frame = requestAnimationFrame(tick); }
  function onPointer(event) { if (event.pointerType !== 'mouse' || reduced || mode !== 'idle') return; pointer.x = event.clientX / innerWidth * 2 - 1; pointer.y = event.clientY / innerHeight * 2 - 1; wake(450); }
  function onVisibility() { if (document.hidden) { cancelAnimationFrame(frame); frame = 0; } else wake(300); }
  function onContextLost(event) { event.preventDefault(); dispose(); }
  function dispose() {
    if (disposed) return;
    disposed = true; cancelAnimationFrame(frame);
    artController.abort(); clearTimeout(artDeadline);
    window.removeEventListener('resize', size); window.removeEventListener('pointermove', onPointer);
    document.removeEventListener('visibilitychange', onVisibility); canvas.removeEventListener('webglcontextlost', onContextLost);
    setSpatial(false); setIntroSpatial(false);
    document.body.dataset.renderer = 'fallback';
    document.body.dataset.depth = 'false';
    for (const r of resources) r.dispose?.();
    for (const p of frameParts) p.geometry.dispose();
    sun.shadow.map?.dispose(); renderer.dispose();
  }
  window.addEventListener('resize', size, { passive: true });
  window.addEventListener('pointermove', onPointer, { passive: true });
  document.addEventListener('visibilitychange', onVisibility);
  canvas.addEventListener('webglcontextlost', onContextLost);
  document.body.dataset.renderer = 'webgl';
  try { size(); } catch (error) { dispose(); throw error; }
  return {
    setPhase(next, elapsed = 0) { mode = next; epoch = performance.now() - elapsed; setSpatial(allowSpatial && desktop && projectedPhases.has(mode)); setIntroSpatial(allowSpatial && desktop && ['intro', 'handoff'].includes(mode)); renderer.shadowMap.needsUpdate = true; if (next !== 'entering') ui.position.z = 14; wake(next === 'idle' ? 600 : 4200); },
    setReduced(value) { reduced = value; pointer = { x: 0, y: 0 }; wake(200); },
    dispose
  };
}
