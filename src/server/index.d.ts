import type { IncomingHttpHeaders, IncomingMessage, RequestListener, Server } from 'node:http';
import type { Http2SecureServer, SecureServerOptions } from 'node:http2';
import type { Asset, Representation } from '../shared/types.js';
export type DictionaryEncoding = 'dcz' | 'dcb';
export interface ServerOptions {
    root?: string | (() => string | Promise<string>);
    base?: string;
    allowInsecureLocalhost?: boolean;
    /** Expose server handling duration, encoding, and selected base through Server-Timing. */
    serverTiming?: boolean;
    dictionaryEncodings?: DictionaryEncoding[] | ((req: IncomingMessage) => DictionaryEncoding[]);
    logger?: (entry: {
        method?: string;
        url?: string;
        status: number;
        encoding?: string;
        dictionaryHash?: string;
        bytes?: number;
        error?: string;
    }) => void;
}
export function createRequestHandler(options?: ServerOptions): RequestListener;
export function createDictionaryServer(
    options?: ServerOptions & { tls?: SecureServerOptions }
): Server | Http2SecureServer;
export function parseAvailableDictionary(value: string | string[] | undefined): string | null;
export function encodingQuality(header: string | undefined, encoding: string): number;
export function selectRepresentation(
    asset: Asset,
    headers: IncomingHttpHeaders,
    allowDictionary: boolean,
    dictionaryEncodings?: DictionaryEncoding[]
): (Representation & { encoding: string; quality: number; dictionaryHash?: string }) | null;
