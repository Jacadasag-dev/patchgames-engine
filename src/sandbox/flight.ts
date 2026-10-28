/** Presentation-only 3D travel prediction. Seconds, world units, radians.
 * Use the actual controller's limits. This never moves physics or invents lift,
 * collisions, wind, gravity, or future player input. Also useful for swimming. */
import type { LocomotionIntent, LocomotionVector, MovementFrame, TrajectorySample } from './locomotion.ts';

export interface FlightSample extends TrajectorySample {
  direction: LocomotionVector;
  /** Predicted visual up, including a bounded turn bank. */
  up: LocomotionVector;
  pitch: number;
  bank: number;
}
export interface FlightPrediction {
  mode: 'intent' | 'observed';
  samples: FlightSample[];
  warnings: string[];
}
export interface FlightPredictionInput {
  time: number;
  position: LocomotionVector;
  velocity: LocomotionVector;
  frame: MovementFrame;
  intent?: LocomotionIntent;
  horizon?: number;
  samples?: number;
  /** Speed acceleration/braking; direction changes have a separate angular cap. */
  acceleration?: number;
  braking?: number;
  turnRate?: number;
  maxSpeed?: number;
  maxAge?: number;
  maxBankAngle?: number;
  /** Visual bank response denominator in world units / second squared.
   * Defaults to 9.81. This is not a gravity force applied to the actor. */
  bankAcceleration?: number;
}

type V = LocomotionVector;
const EPS = 1e-8;
const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
const add = (a: V, b: V): V => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const sub = (a: V, b: V): V => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const scale = (a: V, s: number): V => ({ x: a.x * s, y: a.y * s, z: a.z * s });
const dot = (a: V, b: V) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a: V, b: V): V => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const length = (a: V) => Math.hypot(a.x, a.y, a.z);
const project = (a: V, normal: V) => sub(a, scale(normal, dot(a, normal)));
function num(value: number, name: string, min: number, max: number): number {
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`Flight: invalid ${name}`);
  return value;
}
function vector(value: V, name: string): V {
  if (!value) throw new Error(`Flight: missing ${name}`);
  return { x: num(value.x, name, -1e6, 1e6), y: num(value.y, name, -1e6, 1e6), z: num(value.z, name, -1e6, 1e6) };
}
function unit(value: V, name: string): V {
  const size = length(value);
  if (size < EPS) throw new Error(`Flight: ${name} must not be zero`);
  return scale(value, 1 / size);
}
function rotate(value: V, axis: V, angle: number): V {
  return add(add(scale(value, Math.cos(angle)), scale(cross(axis, value), Math.sin(angle))), scale(axis, dot(axis, value) * (1 - Math.cos(angle))));
}
function turn(from: V, to: V, maxAngle: number, preferredUp: V): V {
  const angle = Math.acos(clamp(dot(from, to), -1, 1));
  if (angle <= maxAngle || angle < EPS) return to;
  let axis = cross(from, to);
  if (length(axis) < EPS) {
    // Exactly opposite travel has no unique shortest turn. Choose a stable axis
    // from the explicit frame, including when flying straight up or down.
    axis = project(preferredUp, from);
    if (length(axis) < EPS) axis = project(Math.abs(from.x) < .8 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 0, z: 1 }, from);
  }
  return unit(rotate(from, unit(axis, 'turn axis'), maxAngle), 'direction');
}

export function predictFlight(input: FlightPredictionInput): FlightPrediction {
  const time = num(input.time, 'time', -1e12, 1e12);
  let position = vector(input.position, 'position'), velocity = vector(input.velocity, 'velocity');
  const up = unit(vector(input.frame?.up, 'frame.up'), 'frame.up');
  const forward = unit(vector(input.frame?.forward, 'frame.forward'), 'frame.forward');
  // Forward may point vertically: construct the missing reference from any
  // nonparallel axis instead of rejecting a legitimate climb or dive.
  let right = cross(up, forward);
  if (length(right) < EPS) right = cross(Math.abs(forward.x) < .8 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 0, z: 1 }, forward);
  right = unit(right, 'frame.right');
  const horizon = num(input.horizon ?? .6, 'horizon', 0, 3);
  const count = num(input.samples ?? 6, 'samples', 1, 16);
  if (!Number.isInteger(count)) throw new Error('Flight: samples must be an integer');
  const acceleration = num(input.acceleration ?? 12, 'acceleration', 0, 1e4);
  const braking = num(input.braking ?? 16, 'braking', 0, 1e4);
  const turnRate = num(input.turnRate ?? Math.PI, 'turnRate', 0, Math.PI * 32);
  const maxSpeed = num(input.maxSpeed ?? 12, 'maxSpeed', 0, 1e4);
  const maxAge = num(input.maxAge ?? .25, 'maxAge', 0, 10);
  const maxBank = num(input.maxBankAngle ?? Math.PI / 3, 'maxBankAngle', 0, Math.PI / 2);
  const bankAcceleration = num(input.bankAcceleration ?? 9.81, 'bankAcceleration', .001, 1e4);
  const intended = input.intent ? vector(input.intent.velocity, 'intent.velocity') : { x: 0, y: 0, z: 0 };
  const age = input.intent ? time - num(input.intent.observedAt ?? time, 'intent.observedAt', -1e12, 1e12) : Infinity;
  const current = !!input.intent && age >= -EPS && age <= maxAge;
  const mode = current ? 'intent' : 'observed';
  const warnings = ['collisions-not-predicted', 'aerodynamics-not-simulated'];
  if (!input.intent) warnings.push('intent-missing');
  else if (!current) warnings.push('intent-stale');
  if (length(velocity) > maxSpeed + EPS) warnings.push('observed-speed-exceeds-limit');
  const desiredSpeed = Math.min(length(intended), maxSpeed);
  const desiredDirection = length(intended) > EPS ? unit(intended, 'intent') : forward;
  let direction = length(velocity) > EPS ? unit(velocity, 'velocity') : forward;
  let visualUp = project(up, direction);
  if (length(visualUp) < EPS) visualUp = cross(direction, right);
  visualUp = unit(visualUp, 'visual up');
  let elapsed = 0, bank = 0;
  const samples: FlightSample[] = [];
  for (let index = 0; index < count; index++) {
    const sampleTime = horizon * (index + 1) / count;
    while (sampleTime - elapsed > EPS) {
      const delta = Math.min(1 / 60, sampleTime - elapsed);
      let next = velocity;
      if (current) {
        const speed = length(velocity), rate = desiredSpeed < speed ? braking : acceleration;
        const nextSpeed = speed + clamp(desiredSpeed - speed, -rate * delta, rate * delta);
        if (desiredSpeed > EPS) direction = speed > EPS ? turn(direction, desiredDirection, turnRate * delta, up) : desiredDirection;
        next = scale(direction, nextSpeed);
        const turnRight = cross(up, direction);
        bank = length(turnRight) > EPS ? clamp(-Math.atan2(dot(scale(sub(next, velocity), 1 / delta), unit(turnRight, 'turn right')), bankAcceleration), -maxBank, maxBank) : 0;
      }
      position = add(position, scale(add(velocity, next), delta / 2));
      velocity = next;
      const nextUp = project(up, direction);
      // Parallel transport near a vertical heading avoids a zero or flipped up.
      let candidateUp = length(nextUp) > .01 ? nextUp : project(visualUp, direction);
      if (length(candidateUp) < EPS) candidateUp = project(Math.abs(direction.x) < .8 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 0, z: 1 }, direction);
      candidateUp = unit(candidateUp, 'visual up');
      if (dot(candidateUp, visualUp) < 0) candidateUp = scale(candidateUp, -1);
      visualUp = candidateUp;
      elapsed += delta;
    }
    samples.push({ time: sampleTime, position: { ...position }, velocity: { ...velocity }, direction: { ...direction },
      up: rotate(visualUp, direction, bank), pitch: Math.asin(clamp(dot(direction, up), -1, 1)), bank });
  }
  return { mode, samples, warnings };
}
