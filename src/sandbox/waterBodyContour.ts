/** Bounded subcell reconstruction for a free wet/dry contact. Bits 0..4 keep
 * the legacy connected-edge protocol; higher bits describe an inward rounded
 * silhouette. No accepted dry cell becomes wet, and no physics volume changes. */
const CORNER_BITS = [32, 64, 128, 256] as const;
const FREE_BITS = [512, 1024, 2048, 4096] as const;
export function waterBodyContourFlags(freeEdges: number): number {
 let flags = 0;
 for (let edge = 0; edge < 4; edge++) if (freeEdges & (1 << edge)) flags += FREE_BITS[edge];
 for (let corner = 0; corner < 4; corner++) if ((freeEdges & (1 << corner)) && (freeEdges & (1 << ((corner + 3) % 4)))) flags += CORNER_BITS[corner];
 return flags;
}
/** Signed distance in metres. A hard wall/domain boundary is never rounded or
 * feathered. Convex corners use a circular arc contained in the original cell. */
export function waterBodyContourDistance(x: number, z: number, sizeX: number, sizeZ: number, flags: number): number {
 const tolerance=Math.min(sizeX,sizeZ)*1e-5;
 if (x < -tolerance || z < -tolerance || x > sizeX+tolerance || z > sizeZ+tolerance) return -Math.max(-x, -z, x - sizeX, z - sizeZ);
 x=Math.max(0,Math.min(sizeX,x));z=Math.max(0,Math.min(sizeZ,z));flags=Math.round(flags);
 const radius = Math.min(sizeX, sizeZ) * .4;
 let distance = radius;
 const edges = [x, sizeZ - z, sizeX - x, z];
 for (let edge = 0; edge < 4; edge++) if (Math.floor(flags / FREE_BITS[edge]) % 2 >= 1) distance = Math.min(distance, edges[edge]);
 for (let corner = 0; corner < 4; corner++) if (Math.floor(flags / CORNER_BITS[corner]) % 2 >= 1) {
  const u = corner < 2 ? x : sizeX - x, v = corner === 0 || corner === 3 ? z : sizeZ - z;
  if (u < radius && v < radius) distance = Math.min(distance, radius - Math.hypot(u - radius, v - radius));
 }
 return distance;
}
/** Same footprint as the CPU helper within the cell. Rasterized triangles are
 * already clipped to their own cell: clamp float interpolation roundoff at
 * shared edges rather than turning every cell border into a discarded crack.
 * Both pool and local-water joins use the same rounded free-edge support. */
export const WATER_BODY_CONTOUR_GLSL = `
float waterContourDistance(vec2 p,vec2 size,float flags){
 p=clamp(p,vec2(0.0),size);flags=floor(flags+0.5);
 float r=min(size.x,size.y)*0.4,d=r;
 if(mod(floor(flags/512.0),2.0)>0.5)d=min(d,p.x);
 if(mod(floor(flags/1024.0),2.0)>0.5)d=min(d,size.y-p.y);
 if(mod(floor(flags/2048.0),2.0)>0.5)d=min(d,size.x-p.x);
 if(mod(floor(flags/4096.0),2.0)>0.5)d=min(d,p.y);
 for(int corner=0;corner<4;corner++){
  float bit=32.0*exp2(float(corner));
  if(mod(floor(flags/bit),2.0)>0.5){vec2 q=vec2(corner<2?p.x:size.x-p.x,(corner==0||corner==3)?p.y:size.y-p.y);if(q.x<r&&q.y<r)d=min(d,r-length(q-vec2(r)));}
 }
 return d;
}
float waterContourCoverage(vec2 p,vec2 size,float flags){return smoothstep(0.0,min(size.x,size.y)*0.035,waterContourDistance(p,size,flags));}
`;
