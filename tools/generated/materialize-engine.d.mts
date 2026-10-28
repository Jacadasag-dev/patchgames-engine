type Receipt = {
    version: 1;
    pin: string;
    engineVersion: string;
    files: Record<string, string>;
};
/** Trusted generated files accompany isolated authoring snapshots, never Git history. */
export declare function engineSourceFiles(root: string): string[];
export declare function materializeEngine(options?: {
    root?: string;
    engineRoot?: string;
    check?: boolean;
    adopt?: boolean;
}): Receipt;
export {};
