import { z } from 'zod';

const vector = z.tuple([z.number().finite().min(-1000).max(1000), z.number().finite().min(-1000).max(1000), z.number().finite().min(-1000).max(1000)]);
const direction = vector.refine(value => Math.hypot(...value) > 0.0001, 'Direction must be nonzero.');
export const soundAuditionSchema = z.object({
  trajectory: z.enum(['flyby', 'approach', 'recede', 'orbit']).default('flyby'),
  perspective: z.enum(['side', 'ahead', 'behind']).default('side'),
  duration: z.number().finite().min(0.25).max(12).default(4),
  speed: z.number().finite().min(0.1).max(200).default(24),
  closestDistance: z.number().finite().min(0.25).max(100).default(3),
  loop: z.boolean().default(true),
  listener: z.object({ position: vector, forward: direction.default([0, 0, -1]), up: direction.default([0, 1, 0]) }).strict().refine(value => {
    const [a, b] = [value.forward, value.up];
    return Math.hypot(a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]) > 0.0001;
  }, 'Listener forward and up must not be parallel.').optional(),
}).strict();
export type SoundAuditionInput = z.input<typeof soundAuditionSchema>;
export type SoundAudition = z.output<typeof soundAuditionSchema>;
