export interface PublicBoundaryIssue {path:string;message:string}
export function checkPublicBoundary(root:string,packagePaths?:readonly string[]):PublicBoundaryIssue[];
export function assertPublicBoundary(root:string,packagePaths?:readonly string[]):void;
