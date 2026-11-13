export interface Representation {
    file: string;
    bytes: number;
    hash: string;
}
export interface Asset extends Representation {
    key: string;
    url: string;
    contentType: string;
    cacheControl: string;
    dictionaryUrl: string;
    dictionaryHash: string;
    dictionaryPolicy: 'stable' | 'rolling';
    dictionaryDelivery: 'asset' | 'separate';
    dictionaryEpoch?: string;
    representations: Record<'identity' | 'br' | 'gzip', Representation>;
    dcz: Record<string, Representation & { dictionaryUrl: string }>;
    dcb: Record<string, Representation & { dictionaryUrl: string }>;
}
export interface PublishedDictionary extends Representation {
    key: string;
    match: string;
    id: string;
    cacheControl: string;
}
export interface Manifest {
    schemaVersion: 1;
    assets: Record<string, Asset>;
    dictionaries: Record<string, PublishedDictionary>;
}
export interface EdgeManifest extends Manifest {
    kind: 'shared-dict-release';
    releaseId: string;
    staticFiles: Record<string, Representation & { contentType: string; cacheControl: string }>;
}
