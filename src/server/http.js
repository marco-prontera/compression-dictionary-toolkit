export const vary = 'Accept-Encoding, Available-Dictionary, Sec-Fetch-Site, Sec-Fetch-Mode';

export function unsafePath(decoded) {
    return (
        decoded.startsWith('//') ||
        // eslint-disable-next-line no-control-regex -- Reject controls and Windows separators in decoded paths.
        /[\\\x00-\x1f]/.test(decoded) ||
        decoded.split('/').some((part) => part === '.' || part === '..')
    );
}

export function etagMatches(header, tag) {
    if (!header) return false;
    return String(header)
        .split(',')
        .some((part) => part.trim() === '*' || part.trim().replace(/^W\//, '') === tag);
}

/** Advertise the decoded response itself only when it is the registered current base. */
export function dictionaryAdvertisement(asset, dictionary) {
    if (asset.dictionaryDelivery === 'asset') {
        if (!dictionary || dictionary.hash !== asset.hash || dictionary.bytes !== asset.bytes) {
            throw new Error('Asset dictionary does not match the response bytes');
        }
        return ['Use-As-Dictionary', `match="${dictionary.match}", id="${dictionary.id}", type=raw`];
    }
    return ['Link', `<${asset.dictionaryUrl}>; rel="compression-dictionary"`];
}
