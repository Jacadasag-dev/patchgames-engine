import {z} from 'zod';
import {parseMaterialPattern} from './materialPatterns.ts';
export const materialPatternSchema=z.unknown().transform((input,ctx)=>{
  try{return parseMaterialPattern(input);}catch(error){ctx.addIssue({code:'custom',message:String(error)});return z.NEVER;}
});
/** Reuse the pattern parser's strict frame/axis/bounds contract for layer regions. */
export const materialBoundarySchema=z.unknown().transform((input,ctx)=>{
  try{return parseMaterialPattern({type:'patches',boundary:input}).boundary!;}catch(error){ctx.addIssue({code:'custom',message:String(error)});return z.NEVER;}
});
