import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import sharedDictionary from 'compression-dictionary-toolkit/vite';

const root = fileURLToPath(new URL('.', import.meta.url));
export default defineConfig({
    root,
    base: '/product/',
    define: { __PRODUCT_VERSION__: JSON.stringify(process.env.PRODUCT_VERSION ?? 'v1') },
    plugins: [
        sharedDictionary({
            storeDir: '../../.dictionary-store/playground-product',
            historyLimit: 3,
        }),
    ],
    build: {
        outDir: `dist/${process.env.PRODUCT_VERSION ?? 'v1'}`,
        emptyOutDir: true,
        rolldownOptions: {
            input: `${root}/src/product.js`,
            output: { entryFileNames: 'assets/product-[hash].js', assetFileNames: 'assets/product-[hash][extname]' },
        },
    },
});
