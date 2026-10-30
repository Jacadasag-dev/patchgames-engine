import * as THREE from 'three';
import type {TerrainManifest} from './terrain.ts';

export interface TerrainLodLevel {
  readonly stride:number;
  readonly geometry:THREE.BufferGeometry;
  readonly triangles:number;
  /** Conservative vertical/vertex-color feature error in local metres. */
  readonly errorMeters:number;
}
export interface TerrainLodGeometry {
  readonly levels:readonly TerrainLodLevel[];
  readonly sourceTriangles:number;
  dispose():void;
}
interface Point {col:number;row:number;height:number;color:readonly[number,number,number]}
interface Cell {left:number;right:number;top:number;bottom:number;polygon:Point[];center:Point;boundary:boolean}

/** Generate visual detail levels from one accepted heightfield. All levels retain
 * every source boundary vertex, so neighboring chunks can choose independently
 * without skirts, cracks, or changing the authoritative height/collision data. */
export function createTerrainLodGeometry(manifest:TerrainManifest,maxLevels=5):TerrainLodGeometry{
  const {columns,rows,bounds}=manifest;
  if(!Number.isInteger(columns)||!Number.isInteger(rows)||columns<1||rows<1||columns>256||rows>256
    ||manifest.heights.length!==(columns+1)*(rows+1)||manifest.colors.length!==manifest.heights.length
    ||!manifest.heights.every(Number.isFinite)||!Number.isFinite(bounds.width)||!Number.isFinite(bounds.depth)||bounds.width<=0||bounds.depth<=0
    ||!Number.isInteger(maxLevels)||maxLevels<1||maxLevels>5)throw Error('Terrain LOD requires a valid 1–256 cell heightfield and 1–5 levels.');
  const originX=manifest.origin?.x??0,originZ=manifest.origin?.z??0,index=(col:number,row:number)=>col*(rows+1)+row;
  const height=(col:number,row:number)=>{
    const c=Math.min(columns-1,Math.floor(col)),r=Math.min(rows-1,Math.floor(row)),u=col-c,v=row-r;
    const a=manifest.heights[index(c,r)],b=manifest.heights[index(c+1,r)],d=manifest.heights[index(c+1,r+1)],e=manifest.heights[index(c,r+1)];
    return u+v<=1?a+(b-a)*u+(e-a)*v:d+(e-d)*(1-u)+(b-d)*(1-v);
  };
  const colorCache=new Map<number,readonly[number,number,number]>(),pointCache=new Map<string,Point>();
  const sourceColor=(col:number,row:number)=>{const hex=manifest.colors[index(col,row)];let color=colorCache.get(hex);if(!color){const value=new THREE.Color(hex);color=[value.r,value.g,value.b];colorCache.set(hex,color);}return color;};
  const point=(col:number,row:number):Point=>{const key=col+','+row,previous=pointCache.get(key);if(previous)return previous;
    const c=Math.min(columns-1,Math.floor(col)),r=Math.min(rows-1,Math.floor(row)),u=col-c,v=row-r,a=sourceColor(c,r),b=sourceColor(c+1,r),d=sourceColor(c+1,r+1),e=sourceColor(c,r+1);
    const color=a.map((value,i)=>u+v<=1?value+(b[i]-value)*u+(e[i]-value)*v:d[i]+(e[i]-d[i])*(1-u)+(b[i]-d[i])*(1-v)) as [number,number,number],result={col,row,height:height(col,row),color};pointCache.set(key,result);return result;
  };
  const sourceNormals=new THREE.Float32BufferAttribute(new Float32Array(manifest.heights.length*3),3);
  const fullPositions=new Float32Array(manifest.heights.length*3),fullIndices:number[]=[];
  for(let c=0;c<=columns;c++)for(let r=0;r<=rows;r++)fullPositions.set([originX+(c/columns-.5)*bounds.width,height(c,r),originZ+(r/rows-.5)*bounds.depth],index(c,r)*3);
  for(let c=0;c<columns;c++)for(let r=0;r<rows;r++){const a=index(c,r),b=index(c+1,r),e=a+1,d=b+1;fullIndices.push(a,e,b,d,b,e);}
  const full=new THREE.BufferGeometry();full.setAttribute('position',new THREE.BufferAttribute(fullPositions,3));full.setIndex(fullIndices);full.computeVertexNormals();
  sourceNormals.copy(full.getAttribute('normal') as THREE.BufferAttribute);
  const levelData:{stride:number;geometry:THREE.BufferGeometry;triangles:number;errorMeters:number;cells:Cell[]}[]=[];
  for(let level=0,stride=1;level<maxLevels;level++,stride*=2){
    const positions:number[]=[],colors:number[]=[],uvs:number[]=[],normals:number[]=[],indices:number[]=[],vertices=new Map<string,number>(),cells:Cell[]=[];
    const vertex=(p:Point)=>{const key=p.col+','+p.row,existing=vertices.get(key);if(existing!==undefined)return existing;
      const i=positions.length/3,x=originX+(p.col/columns-.5)*bounds.width,z=originZ+(p.row/rows-.5)*bounds.depth;
      positions.push(x,p.height,z);uvs.push(x,z);
      const nearest=index(Math.round(p.col),Math.round(p.row));colors.push(...p.color);
      normals.push(sourceNormals.getX(nearest),sourceNormals.getY(nearest),sourceNormals.getZ(nearest));vertices.set(key,i);return i;
    };
    let errorMeters=0;
    for(let left=0;left<columns;left+=stride)for(let top=0;top<rows;top+=stride){
      const right=Math.min(columns,left+stride),bottom=Math.min(rows,top+stride),boundary=stride>1&&(left===0||top===0||right===columns||bottom===rows);
      const polygon:Point[]=[];
      // Counter-clockwise in X/Z gives +Y-facing triangle winding.
      polygon.push(point(left,top));
      if(left===0&&boundary)for(let r=top+1;r<bottom;r++)polygon.push(point(left,r));
      polygon.push(point(left,bottom));
      if(bottom===rows&&boundary)for(let c=left+1;c<right;c++)polygon.push(point(c,bottom));
      polygon.push(point(right,bottom));
      if(right===columns&&boundary)for(let r=bottom-1;r>top;r--)polygon.push(point(right,r));
      polygon.push(point(right,top));
      if(top===0&&boundary)for(let c=right-1;c>left;c--)polygon.push(point(c,top));
      const center=point((left+right)/2,(top+bottom)/2),cell={left,right,top,bottom,polygon,center,boundary};cells.push(cell);
      if(boundary){const centerIndex=vertex(center);for(let i=0;i<polygon.length;i++)indices.push(centerIndex,vertex(polygon[i]),vertex(polygon[(i+1)%polygon.length]));}
      else {const [a,e,d,b]=polygon.map(vertex);indices.push(a,e,b,d,b,e);}
      // Every coarsened triangle is a convex combination of source samples.
      // The full cell's source range therefore bounds its vertical deviation,
      // including intersections between the fine and coarse triangulations.
      if(stride>1){let min=Infinity,max=-Infinity,colorChanged=false;for(let c=left;c<=right;c++)for(let r=top;r<=bottom;r++){
        const h=height(c,r);min=Math.min(min,h);max=Math.max(max,h);
        if(!colorChanged){const expected=sourceColor(c,r);for(let channel=0;channel<3;channel++)if(Math.abs(expected[channel]-sampleCell(cell,c,r,channel))>1/255){colorChanged=true;break;}}
      }errorMeters=Math.max(errorMeters,max-min,colorChanged?Math.hypot((right-left)*bounds.width/columns,(bottom-top)*bounds.depth/rows):0);}
    }
    const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));geometry.setAttribute('color',new THREE.Float32BufferAttribute(colors,3));geometry.setAttribute('uv',new THREE.Float32BufferAttribute(uvs,2));geometry.setAttribute('normal',new THREE.Float32BufferAttribute(normals,3));geometry.setIndex(indices);geometry.computeBoundingSphere();geometry.computeBoundingBox();
    errorMeters=Math.max(errorMeters,levelData.at(-1)?.errorMeters??0);levelData.push({stride,geometry,triangles:indices.length/3,errorMeters,cells});
    if(Math.ceil(columns/stride)<=1&&Math.ceil(rows/stride)<=1)break;
  }
  full.dispose();
  // Fine vertices morph onto the next coarse triangle surface before switching
  // topology. Boundary deltas stay exactly zero for every neighboring LOD.
  for(let i=0;i<levelData.length;i++){
    const source=levelData[i],target=levelData[Math.min(i+1,levelData.length-1)],positions=source.geometry.getAttribute('position'),deltas=new Float32Array(positions.count),lookup=new Map(target.cells.map(cell=>[cell.left+','+cell.top,cell]));
    for(let j=0;j<positions.count;j++){
      const col=(positions.getX(j)-originX)/bounds.width*columns+columns/2,row=(positions.getZ(j)-originZ)/bounds.depth*rows+rows/2;
      if(col<=1e-5||row<=1e-5||col>=columns-1e-5||row>=rows-1e-5)continue;
      const left=Math.min(Math.floor(col/target.stride)*target.stride,Math.floor((columns-1)/target.stride)*target.stride),top=Math.min(Math.floor(row/target.stride)*target.stride,Math.floor((rows-1)/target.stride)*target.stride);
      const cell=lookup.get(left+','+top)!;
      deltas[j]=sampleCell(cell,col,row)-positions.getY(j);
    }
    source.geometry.setAttribute('terrainLodDelta',new THREE.BufferAttribute(deltas,1));
  }
  let disposed=false;
  return{levels:levelData.map(({cells:_cells,...level})=>level),sourceTriangles:columns*rows*2,dispose(){if(disposed)return;disposed=true;for(const level of levelData)level.geometry.dispose();}};
}

function triangleHeight(a:Point,b:Point,c:Point,x:number,z:number,channel=-1):number|undefined{
  const denominator=(b.row-c.row)*(a.col-c.col)+(c.col-b.col)*(a.row-c.row);
  const u=((b.row-c.row)*(x-c.col)+(c.col-b.col)*(z-c.row))/denominator,v=((c.row-a.row)*(x-c.col)+(a.col-c.col)*(z-c.row))/denominator,w=1-u-v;
  const value=(p:Point)=>channel<0?p.height:p.color[channel];return u>=-1e-5&&v>=-1e-5&&w>=-1e-5?value(a)*u+value(b)*v+value(c)*w:undefined;
}
function sampleCell(cell:Cell,col:number,row:number,channel=-1):number{
  const p=cell.polygon;
  if(!cell.boundary)return triangleHeight(p[0],p[1],p[3],col,row,channel)??triangleHeight(p[2],p[3],p[1],col,row,channel)!;
  for(let i=0;i<p.length;i++){const height=triangleHeight(cell.center,p[i],p[(i+1)%p.length],col,row,channel);if(height!==undefined)return height;}
  throw Error('Terrain LOD morph point lies outside the prepared surface.');
}
