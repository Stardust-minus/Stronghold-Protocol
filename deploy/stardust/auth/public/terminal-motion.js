// Reference-guided key poses, not an interpreter for AE packed keyframes.
// Seconds are local to each gate phase; animation never owns authentication or navigation timers.
const clamp = n => Math.max(0, Math.min(1, n));
const settle = t => 1 - (1 - clamp(t)) ** 4;
const lerp = (a, b, t) => a + (b - a) * t;

export function sampleTerminalMotion(phase, elapsed = 0) {
  const seconds = Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0;
  const pose = { x: 0, y: 0, zoom: 1, roll: 0, assembly: 1, card: 1, exposure: 0, ongoing: false };
  if (phase === 'intro' || phase === 'handoff') {
    const t = settle((phase === 'handoff' ? 3.2 + seconds : seconds) / 3.4);
    pose.x = lerp(190, -15, t); pose.y = lerp(-210, 90, t);
    pose.zoom = lerp(1.24, .88, t) - (phase === 'handoff' ? .08 * settle(seconds / .7) : 0);
    pose.roll = lerp(.07, -.04, t); pose.ongoing = phase === 'handoff' ? seconds < .7 : seconds < 3.4;
  } else if (phase === 'assembling') {
    const t = settle(seconds / 1.2);
    pose.x = 40 * (1 - t); pose.y = 145 * (1 - t);
    pose.zoom = lerp(1.16, 1, t); pose.roll = .025 * (t - 1);
    pose.assembly = t; pose.ongoing = seconds < 1.24;
  } else if (phase === 'auth-morph' || phase === 'success') {
    const t = phase === 'auth-morph' ? settle(seconds / .72) : 1;
    pose.y = 20 * t; pose.card = t; pose.ongoing = seconds < 1.33;
  } else if (phase === 'entering') {
    const t = settle(seconds / 1.1);
    pose.y = lerp(20, 0, t); pose.zoom = lerp(.42, 1.04, t);
    const exposure = clamp(seconds / .7);
    pose.exposure = exposure * exposure * (3 - 2 * exposure);
    pose.ongoing = seconds < 1.5;
  }
  return pose;
}

export function sphereLinePositions(value, radius = 230) {
  if (value?.version !== 1 || !Array.isArray(value.positions) || value.positions.length < 18
    || value.positions.length > 18000 || value.positions.length % 6
    || value.positions.some(n => !Number.isFinite(n) || Math.abs(n) > 1.001)
    || !Number.isFinite(radius) || radius <= 0 || radius > 1000) throw new Error('Invalid optional sphere artwork');
  return new Float32Array(value.positions.map(n => n * radius));
}
