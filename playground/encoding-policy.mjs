/** Demo-only comparison switch. It narrows candidates; it never adds client capabilities. */
export function demoDictionaryEncodings(req) {
    const mode = new URL(req.url, 'http://localhost').searchParams.get('encoding');
    return mode === 'dcb' || mode === 'dcz' ? [mode] : ['dcz', 'dcb'];
}
