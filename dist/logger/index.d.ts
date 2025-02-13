/**
 * Lazy-initialized singleton logger instance.
 */
export declare const logger: any;
export declare const log: {
    info: (msg: string, ...args: any[]) => Promise<void>;
    error: (msg: string, ...args: any[]) => Promise<void>;
    warn: (msg: string, ...args: any[]) => Promise<void>;
    debug: (msg: string, ...args: any[]) => Promise<void>;
};
