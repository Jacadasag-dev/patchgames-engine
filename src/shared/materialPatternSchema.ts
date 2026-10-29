import {z} from 'zod';
import {parseMaterialPattern} from './materialPatterns.ts';
export const materialPatternSchema=z.unknown().transform((input,ctx)=>{
  try{return parseMaterialPattern(input);}catch(error){ctx.addIssue({code:'custom',message:String(error)});return z.NEVER;}
});
