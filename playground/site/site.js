const status = document.querySelector('#status');
const loadButton = document.querySelector('#load-product');
const encoding = document.querySelector('#encoding');
const exportButton = document.querySelector('#export');
const measurements = [];
let backendVersion;
let loadedVersion;
let visit = 0;

const bytes = (value) => (value < 1024 ? `${value} B` : `${(value / 1024).toFixed(2)} KB`);
const ms = (value) => `${value.toFixed(1)} ms`;
const total = (result, field) => result.resources.reduce((sum, resource) => sum + resource[field], 0);
const setBusy = (busy) => {
    for (const button of document.querySelectorAll('#versions button, #load-product, #encoding'))
        button.disabled = busy;
    exportButton.disabled = busy || measurements.length === 0;
};
async function state() {
    const response = await fetch('/api/state', { cache: 'no-store' });
    if (!response.ok) throw new Error('Cannot read the backend state');
    return response.json();
}
function showBackend(version) {
    backendVersion = version;
    document.querySelector('#active-version').textContent = version;
    for (const button of document.querySelectorAll('#versions button')) {
        button.setAttribute('aria-pressed', String(button.dataset.version === version));
    }
}
async function publish(version) {
    setBusy(true);
    try {
        const response = await fetch('/api/version', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ version }),
        });
        if (!response.ok) throw new Error(`Version switch failed: HTTP ${response.status}`);
        showBackend((await response.json()).activeVersion);
        status.textContent = `Backend now serves ${backendVersion}. The product previews still show ${loadedVersion ?? 'no version'}. Load the product to make the next visit.`;
    } catch (error) {
        status.textContent = error.message;
    } finally {
        setBusy(false);
    }
}
function loadPreview(mode, run, version, format) {
    return new Promise((resolve, reject) => {
        const frame = document.createElement('iframe');
        frame.title = `Atlas ${version} — ${mode === 'shared' ? 'with' : 'without'} shared dictionary`;
        const cleanup = () => {
            clearTimeout(timeout);
            window.removeEventListener('message', receive);
        };
        const receive = (event) => {
            const data = event.data;
            if (
                event.origin !== location.origin ||
                event.source !== frame.contentWindow ||
                data?.type !== 'product-measurement' ||
                data.run !== run ||
                data.mode !== mode
            )
                return;
            cleanup();
            if (data.error) reject(new Error(data.error));
            else if (data.version !== version) reject(new Error('The backend returned a different product version'));
            else resolve(data);
        };
        const timeout = setTimeout(() => {
            cleanup();
            reject(new Error('Product load timed out. Check the Network panel and retry.'));
        }, 45000);
        window.addEventListener('message', receive);
        const query = new URLSearchParams({ mode, run, version, encoding: format });
        frame.src = `/preview?${query}`;
        document.querySelector(`#${mode}-preview`).replaceChildren(frame);
    });
}
function row(values) {
    const element = document.createElement('tr');
    for (const value of values) {
        const cell = document.createElement('td');
        cell.textContent = value;
        element.append(cell);
    }
    return element;
}
function display(sample) {
    const { shared, baseline } = sample;
    for (const [mode, result] of Object.entries({ shared, baseline })) {
        document.querySelector(`#${mode}-bytes`).textContent = bytes(total(result, 'encodedBytes'));
        document.querySelector(`#${mode}-ready`).textContent = ms(result.readyMs);
        document.querySelector(`#${mode}-encoding`).textContent = [
            ...new Set(result.resources.map((r) => r.encoding)),
        ].join(' + ');
    }
    const ordinary = total(baseline, 'encodedBytes');
    const saving = ordinary - total(shared, 'encodedBytes');
    const percent = ordinary ? (100 * saving) / ordinary : 0;
    document.querySelector('#saving').textContent = `${percent.toFixed(1)}%`;
    const delta = baseline.readyMs - shared.readyMs;
    document.querySelector('#comparison-note').textContent =
        `${bytes(Math.abs(saving))} ${saving >= 0 ? 'fewer' : 'more'} JS/CSS body bytes. With dictionary, the product was ready ${ms(Math.abs(delta))} ${delta >= 0 ? 'sooner' : 'later'} in this pair. These are observed timings, not a guaranteed speedup.`;
    const requests = document.querySelector('#requests');
    requests.replaceChildren();
    for (const [mode, result] of Object.entries({ shared, baseline })) {
        for (const resource of result.resources) {
            const name = new URL(resource.url).pathname.endsWith('.css') ? 'CSS' : 'JS';
            const item = row([
                `${mode === 'shared' ? 'With' : 'Without'} dictionary / ${name}`,
                resource.encoding,
                resource.dictionaryHash?.slice(0, 10) ?? 'None',
                bytes(resource.encodedBytes),
                bytes(resource.decodedBytes),
                ms(resource.durationMs),
                resource.serverMs === null ? '—' : ms(resource.serverMs),
            ]);
            item.title = resource.url;
            requests.append(item);
        }
    }
    document
        .querySelector('#history')
        .prepend(
            row([
                sample.visit,
                sample.version,
                bytes(total(shared, 'encodedBytes')),
                bytes(ordinary),
                `${percent.toFixed(1)}%`,
                ms(shared.readyMs),
                ms(baseline.readyMs),
            ])
        );
    const history = document.querySelector('#history');
    while (history.children.length > 30) history.lastElementChild.remove();
    document.querySelector('#history-count').textContent = measurements.length;
}
async function loadProduct() {
    setBusy(true);
    try {
        const current = await state();
        showBackend(current.activeVersion);
        const version = current.activeVersion;
        const run = crypto.randomUUID();
        const format = encoding.value;
        const order = ++visit % 2 ? ['shared', 'baseline'] : ['baseline', 'shared'];
        const sample = { visit, run, version, format, order, measuredAt: new Date().toISOString() };
        for (const mode of order) {
            status.textContent = `Loading ${version}: ${mode === 'shared' ? 'with' : 'without'} shared dictionary…`;
            sample[mode] = await loadPreview(mode, run, version, format);
        }
        measurements.push(sample);
        if (measurements.length > 30) measurements.shift();
        display(sample);
        loadedVersion = version;
        document.querySelector('#loaded-version').textContent = `Both previews loaded ${version}`;
        const used = sample.shared.resources.some((r) => r.dictionaryHash);
        status.textContent = used
            ? `${version} loaded using a retained base. Publish another version to compare an update, or load again to observe a warm repeat.`
            : `${version} loaded through ordinary compression. Its shared responses may now become dictionaries for a later visit.`;
    } catch (error) {
        status.textContent = error.message;
    } finally {
        setBusy(false);
    }
}
loadButton.addEventListener('click', loadProduct);
exportButton.addEventListener('click', () => {
    const report = {
        userAgent: navigator.userAgent,
        notes: 'Sequential pairs, alternating order; fresh request queries retain dictionary storage. Timings include browser/server work and do not isolate decompression. Up to 30 recent visits.',
        measurements,
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'compression-dictionary-measurements.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
});
try {
    const current = await state();
    for (const version of current.versions) {
        const button = document.createElement('button');
        button.textContent = version;
        button.dataset.version = version;
        button.addEventListener('click', () => publish(version));
        document.querySelector('#versions').append(button);
    }
    showBackend(current.activeVersion);
    await loadProduct();
} catch (error) {
    status.textContent = error.message;
}
