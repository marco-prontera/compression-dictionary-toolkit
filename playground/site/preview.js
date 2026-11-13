window.addEventListener('load', () =>
    requestAnimationFrame(() => {
        const { version, mode, run } = document.documentElement.dataset;
        try {
            if (window.demoProduct?.version !== version) throw new Error('Product JavaScript did not load');
            const cssVersion = getComputedStyle(document.documentElement).getPropertyValue('--product-version').trim();
            if (cssVersion !== JSON.stringify(version)) throw new Error('Product CSS did not load');
            const resources = [...document.querySelectorAll('[data-product]')].map((element) => {
                const url = element.src || element.href;
                const entry = performance.getEntriesByName(url).at(-1);
                if (!entry) throw new Error('Resource Timing is unavailable');
                const metric = (name) => entry.serverTiming.find((item) => item.name === name);
                return {
                    url,
                    encoding: metric('encoding')?.description ?? 'unreported',
                    dictionaryHash: metric('dictionary')?.description ?? null,
                    encodedBytes: entry.encodedBodySize,
                    decodedBytes: entry.decodedBodySize,
                    transferBytes: entry.transferSize,
                    durationMs: entry.duration,
                    ttfbMs: entry.responseStart - entry.requestStart,
                    serverMs: metric('asset')?.duration ?? null,
                };
            });
            parent.postMessage(
                { type: 'product-measurement', run, mode, version, readyMs: performance.now(), resources },
                location.origin
            );
        } catch (error) {
            parent.postMessage(
                { type: 'product-measurement', run, mode, version, error: error.message },
                location.origin
            );
        }
    })
);
