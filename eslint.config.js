import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import prettier from 'eslint-config-prettier/flat';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
    globalIgnores([
        '**/node_modules/**',
        '**/.dictionary-store/**',
        '**/.cert/**',
        'playground/product/dist/**',
        'playground/product/.generated/**',
        '**/test-results/**',
        '**/release/**',
        '**/.wrangler/**',
        '**/.tools/**',
        'learning/**',
        'docs/deploy/**',
    ]),
    {
        files: ['**/*.{js,mjs,cjs}'],
        extends: [js.configs.recommended],
    },
    {
        files: ['**/*.{ts,mts,cts}'],
        extends: [js.configs.recommended, tseslint.configs.recommended],
    },
    {
        files: ['**/*.{js,mjs,cjs,ts,mts,cts}'],
        ignores: [
            'playground/product/src/**',
            'playground/site/**/*.js',
            'src/server/edge.*',
            'src/server/{negotiation,http}.*',
        ],
        languageOptions: { globals: globals.node },
    },
    {
        files: ['playground/product/src/**/*.js', 'playground/site/**/*.js', 'scripts/browser-test.mjs'],
        languageOptions: { globals: globals.browser },
    },
    {
        files: ['playground/product/src/**/*.js'],
        languageOptions: { globals: { __PRODUCT_VERSION__: 'readonly' } },
    },
    {
        files: ['src/server/edge.*', 'src/server/{negotiation,http}.*'],
        languageOptions: { globals: globals.worker },
    },
    prettier
);
