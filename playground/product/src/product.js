import { catalog, headline } from '../.generated/catalog.js';
import '../.generated/theme.css';
import './product.css';

const root = document.querySelector('#product');
const heading = document.createElement('header');
const brand = document.createElement('span');
brand.className = 'brand';
brand.textContent = 'ATLAS / THE PRODUCT';
const title = document.createElement('h1');
title.textContent = headline;
heading.append(brand, title);
const grid = document.createElement('div');
grid.className = 'catalog';
for (const item of catalog.slice(7, 10)) {
    const card = document.createElement('article');
    const picture = document.createElement('div');
    picture.className = 'product-picture';
    picture.textContent = ['◒', '▱', '▥'][item.id % 3];
    const category = document.createElement('small');
    category.textContent = item.category;
    const name = document.createElement('h2');
    name.textContent = item.label;
    const price = document.createElement('p');
    price.textContent = new Intl.NumberFormat('en', { style: 'currency', currency: 'EUR' }).format(item.price);
    card.append(picture, category, name, price);
    grid.append(card);
}
const footer = document.createElement('footer');
footer.textContent = `Product ${__PRODUCT_VERSION__} · ${catalog.length} catalog entries · JS + CSS`;
root.replaceChildren(heading, grid, footer);
window.demoProduct = { version: __PRODUCT_VERSION__, items: catalog.length, sample: catalog[7] };
