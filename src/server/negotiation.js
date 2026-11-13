// Validate one RFC 9651 bare Item; extension values are not used for dictionary selection.
function parameterValueLength(value) {
    if (value.startsWith(':')) {
        const match = /^:([A-Za-z0-9+/]*={0,2}):/.exec(value);
        if (!match) return 0;
        try {
            atob(match[1]);
            return match[0].length;
        } catch {
            return 0;
        }
    }
    if (value.startsWith('%')) {
        const match = /^%"(?:[\x20-\x21\x23-\x24\x26-\x7e]|%[0-9a-f]{2})*"/.exec(value);
        if (!match) return 0;
        try {
            // Display Strings require lowercase escapes and valid UTF-8.
            decodeURIComponent(match[0].slice(2, -1));
            return match[0].length;
        } catch {
            return 0;
        }
    }
    if (value.startsWith('"')) return /^"(?:[\x20-\x21\x23-\x5b\x5d-\x7e]|\\["\\])*"/.exec(value)?.[0].length ?? 0;
    if (value.startsWith('?')) return /^\?[01]/.exec(value)?.[0].length ?? 0;
    if (value.startsWith('@')) return /^@-?[0-9]{1,15}/.exec(value)?.[0].length ?? 0;
    if (/^[-0-9]/.test(value)) return /^-?(?:[0-9]{1,12}\.[0-9]{1,3}|[0-9]{1,15})/.exec(value)?.[0].length ?? 0;
    return /^[A-Za-z*][!#$%&'*+.^_`|~0-9A-Za-z:/-]*/.exec(value)?.[0].length ?? 0;
}

function validParameters(value) {
    while (value.length) {
        const key = /^; *[a-z*][a-z0-9_.*-]*/.exec(value);
        if (!key) return false;
        value = value.slice(key[0].length);
        if (value.startsWith('=')) {
            value = value.slice(1);
            const length = parameterValueLength(value);
            if (!length) return false;
            value = value.slice(length);
        }
    }
    return true;
}

function trimHttpWhitespace(value) {
    // Scan each end once; an unanchored whitespace suffix regex can take quadratic time.
    let start = 0;
    let end = value.length;
    while (start < end && (value[start] === ' ' || value[start] === '\t')) start++;
    while (end > start && (value[end - 1] === ' ' || value[end - 1] === '\t')) end--;
    return value.slice(start, end);
}

export function parseAvailableDictionary(value) {
    if (typeof value !== 'string') return null;
    value = trimHttpWhitespace(value);
    const match = /^:([A-Za-z0-9+/]{43}=?):/.exec(value);
    if (!match || !validParameters(value.slice(match[0].length))) return null;
    const bytes = atob(match[1]);
    // RFC 9651 allows omitted padding and non-zero pad bits; compare the decoded digest.
    if (bytes.length !== 32) return null;
    return Array.from(bytes, (byte) => byte.charCodeAt(0).toString(16).padStart(2, '0')).join('');
}

export function encodingQuality(header, encoding) {
    if (header === undefined) return encoding === 'identity' ? 1 : 0;
    const entries = new Map();
    for (const token of String(header).split(',')) {
        // Whitespace belongs either to the ends or to a parameter, never to overlapping repetitions.
        const match = /^([\w*-]+)(?:[ \t]*;[ \t]*q[ \t]*=[ \t]*(0(?:\.\d{0,3})?|1(?:\.0{0,3})?))?$/i.exec(
            trimHttpWhitespace(token)
        );
        if (!match) continue;
        const name = match[1].toLowerCase();
        const q = match[2] === undefined ? 1 : Number(match[2]);
        entries.set(name, entries.has(name) ? Math.min(entries.get(name), q) : q);
    }
    if (entries.has(encoding)) return entries.get(encoding);
    if (encoding === 'identity') return entries.get('*') === 0 ? 0 : 1;
    // A wildcard alone is not an explicit declaration of dictionary support.
    if (encoding === 'dcz' || encoding === 'dcb') return 0;
    return entries.get('*') ?? 0;
}

export function selectRepresentation(asset, headers, allowDictionary, dictionaryEncodings = ['dcz', 'dcb']) {
    if (
        !Array.isArray(dictionaryEncodings) ||
        dictionaryEncodings.some((encoding) => !['dcz', 'dcb'].includes(encoding))
    ) {
        throw new Error('dictionaryEncodings must be an array containing only dcz and/or dcb');
    }
    const available = parseAvailableDictionary(headers['available-dictionary']);
    const candidates = Object.entries(asset.representations).map(([encoding, representation]) => ({
        encoding,
        ...representation,
    }));
    if (allowDictionary && available) {
        for (const encoding of new Set(dictionaryEncodings)) {
            const representation = asset[encoding]?.[available];
            if (representation) candidates.push({ encoding, dictionaryHash: available, ...representation });
        }
    }
    for (const candidate of candidates)
        candidate.quality = encodingQuality(headers['accept-encoding'], candidate.encoding);
    return (
        candidates
            .filter((candidate) => candidate.quality > 0)
            .sort((a, b) => b.quality - a.quality || a.bytes - b.bytes)[0] ?? null
    );
}
