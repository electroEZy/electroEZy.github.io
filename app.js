/**
 * app.js — Electro EZY (electroezy.github.io)
 * UI logic only. All fetching is done by the Chrome extension.
 * Communicates via window.postMessage ↔ content.js ↔ background.js
 */

// ─── State ────────────────────────────────────────────────────────────────────
let allResults = [];
let currentRequestId = null;
let extensionReady = false;

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const searchForm      = document.getElementById('searchForm');
const searchInput     = document.getElementById('searchInput');
const searchBtn       = document.getElementById('searchBtn');
const loadingState    = document.getElementById('loadingState');
const resultsArea     = document.getElementById('resultsArea');
const resultsGrid     = document.getElementById('resultsGrid');
const resultsTitle    = document.getElementById('resultsTitle');
const resultsCount    = document.getElementById('resultsCount');
const statusOverlay   = document.getElementById('statusOverlay');
const statusContainer = document.getElementById('statusContainer');
const noExtBanner     = document.getElementById('noExtBanner');

// ─── Scroll buttons ───────────────────────────────────────────────────────────
document.getElementById('scrollTopBtn').addEventListener('click', () =>
    window.scrollTo({ top: 0, behavior: 'smooth' }));
document.getElementById('scrollBottomBtn').addEventListener('click', () =>
    window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }));

// ─── Extension detection ──────────────────────────────────────────────────────
// Show banner if extension hasn't replied within 1.5 s
const extDetectTimer = setTimeout(() => {
    if (!extensionReady) noExtBanner.style.display = 'flex';
}, 1500);

// ─── WooCommerce HTML parser (runs in page, has DOMParser access) ─────────────
const SITE_COLORS = {
    'Robu':              'background:#fee2e2; color:#991b1b;',
    'Evelta':            'background:#dbeafe; color:#1e40af;',
    'Ktron':             'background:#dcfce7; color:#166534;',
    'Quartz Components': 'background:#f3e8ff; color:#6b21a8;',
    'Robocraze':         'background:#ffedd5; color:#9a3412;',
    'ThinkRobotics':     'background:#ccfbf1; color:#115e59;',
    'Sharvi Electronics':'background:#e0e7ff; color:#3730a3;'
};

function parseWooHtml(htmlString, siteName, baseUrl) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(htmlString, 'text/html');
    const items = Array.from(
        doc.querySelectorAll('ul.products li.product, .wd-products-grid .product-grid-item, .products-grid .product-grid-item, .products .product')
    ).slice(0, 20);

    return items.map(p => {
        const titleEl = p.querySelector('.woocommerce-loop-product__title') || p.querySelector('h2') || p.querySelector('h3') || p.querySelector('.product-title');
        const priceEl = p.querySelector('.price');
        const imgEl   = p.querySelector('img');
        const linkEl  = p.querySelector('a.woocommerce-LoopProduct-link') || p.querySelector('a');

        const priceRaw = priceEl ? priceEl.textContent.trim() : '';
        const priceMatches = [...priceRaw.matchAll(/[\d,]+\.?\d*/g)];
        const lastMatch = priceMatches[priceMatches.length - 1];
        const priceVal = lastMatch ? parseFloat(lastMatch[0].replace(/,/g, '')) : 0;

        let link = linkEl ? linkEl.getAttribute('href') : '';
        if (link && !link.startsWith('http')) link = (baseUrl || '') + link;

        return {
            site: siteName,
            title: titleEl ? titleEl.textContent.trim() : 'Unknown',
            price: priceVal,
            price_str: priceVal > 0 ? `₹${priceVal.toFixed(2)}` : 'Check Price',
            link,
            image: imgEl ? (imgEl.getAttribute('data-src') || imgEl.getAttribute('src') || '') : ''
        };
    });
}

// ─── Card builder ─────────────────────────────────────────────────────────────
function escapeHTML(str) {
    if (!str) return '';
    return str.toString().replace(/[&<>'"]/g, t => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[t]));
}

function buildCard(product, index) {
    const colorStyle = SITE_COLORS[product.site] || 'background:#f1f5f9; color:#334155;';
    const defaultImg = 'https://via.placeholder.com/300x300?text=No+Image';
    const card = document.createElement('div');
    card.className = 'product-card card-appear bg-white rounded-2xl overflow-hidden border border-slate-200 shadow-sm flex flex-col';
    card.innerHTML = `
        <div class="relative bg-white pt-4 px-4 h-48 flex items-center justify-center border-b border-slate-100">
            <div style="position:absolute;top:10px;right:10px;background:#1e293b;color:#fff;font-size:11px;font-weight:700;width:26px;height:26px;border-radius:50%;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 6px rgba(0,0,0,0.2);">#${index + 1}</div>
            <img src="${escapeHTML(product.image || defaultImg)}" alt="${escapeHTML(product.title)}"
                 style="max-height:100%;max-width:100%;object-fit:contain;padding:8px;"
                 onerror="this.src='${defaultImg}'">
            <span style="position:absolute;bottom:10px;left:10px;font-size:11px;font-weight:600;padding:3px 8px;border-radius:6px;${colorStyle}">${escapeHTML(product.site)}</span>
        </div>
        <div class="p-5 flex flex-col flex-grow">
            <h3 class="font-semibold text-slate-800 text-base mb-3 leading-snug flex-grow line-clamp-2" title="${escapeHTML(product.title)}">${escapeHTML(product.title)}</h3>
            <div class="flex items-center justify-between mt-2">
                <span class="text-2xl font-bold text-slate-900">${escapeHTML(product.price > 0 ? `₹${product.price.toFixed(2)}` : product.price_str)}</span>
                <a href="${escapeHTML(product.link)}" target="_blank" rel="noopener noreferrer"
                   class="bg-blue-50 hover:bg-blue-100 text-blue-700 p-2.5 rounded-lg transition-colors" title="View on store">
                    <i class="fa-solid fa-arrow-up-right-from-square"></i>
                </a>
            </div>
        </div>`;
    return card;
}

// ─── Grid re-render ───────────────────────────────────────────────────────────
function rerenderGrid() {
    resultsGrid.innerHTML = '';
    const sorted = [...allResults].sort((a, b) => (a.price || 999999) - (b.price || 999999));
    sorted.forEach((p, i) => resultsGrid.appendChild(buildCard(p, i)));
    resultsTitle.textContent = 'All Results';
    resultsCount.textContent = `${sorted.length} products found`;
    resultsArea.classList.remove('hidden');
}

// ─── Site status badge helpers ────────────────────────────────────────────────
const statusBadges = {};

function makeBadge(siteId, siteName) {
    const b = document.createElement('div');
    b.style.cssText = 'padding:3px 10px;border-radius:999px;border:1px solid rgba(255,255,255,0.18);font-size:11px;color:rgba(255,255,255,0.75);display:flex;align-items:center;gap:5px;background:rgba(255,255,255,0.08);transition:opacity 0.4s ease,transform 0.4s ease;';
    b.innerHTML = `<i class="fa-solid fa-circle-notch fa-spin" style="font-size:9px;"></i> ${escapeHTML(siteName)}`;
    statusContainer.appendChild(b);
    statusBadges[siteId] = b;
}

function badgeSuccess(siteId, siteName) {
    const b = statusBadges[siteId];
    if (!b) return;
    b.style.color = '#4ade80';
    b.style.borderColor = 'rgba(74,222,128,0.3)';
    b.style.background = 'rgba(74,222,128,0.1)';
    b.innerHTML = `<i class="fa-solid fa-check" style="font-size:9px;"></i> ${escapeHTML(siteName)}`;
    setTimeout(() => {
        b.style.opacity = '0';
        b.style.transform = 'scale(0.8)';
        setTimeout(() => { if (b.parentNode) b.remove(); }, 400);
    }, 1500);
}

function badgeFail(siteId, siteName) {
    const b = statusBadges[siteId];
    if (!b) return;
    b.style.color = '#f87171';
    b.style.borderColor = 'rgba(248,113,113,0.3)';
    b.style.background = 'rgba(248,113,113,0.1)';
    b.innerHTML = `<i class="fa-solid fa-xmark" style="font-size:9px;"></i> ${escapeHTML(siteName)}`;
}

// ─── Incoming messages from extension (via content.js) ───────────────────────
window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data?.type) return;
    const msg = event.data;

    // Extension connected
    if (msg.type === 'ELECTROEZY_READY') {
        extensionReady = true;
        clearTimeout(extDetectTimer);
        noExtBanner.style.display = 'none';
        searchInput.disabled = false;
        searchBtn.disabled = false;
        searchInput.focus();
    }

    // Ignore stale searches
    if (msg.requestId && msg.requestId !== currentRequestId) return;

    if (msg.type === 'SITE_RESULT') {
        if (msg.results && msg.results.length > 0) {
            allResults = allResults.concat(msg.results);
            rerenderGrid();
            loadingState.classList.add('hidden');
            badgeSuccess(msg.siteId, msg.siteName);
        } else {
            badgeFail(msg.siteId, msg.siteName);
        }
    }

    if (msg.type === 'SITE_HTML') {
        const results = parseWooHtml(msg.html, msg.siteName, msg.baseUrl);
        if (results.length > 0) {
            allResults = allResults.concat(results);
            rerenderGrid();
            loadingState.classList.add('hidden');
            badgeSuccess(msg.siteId, msg.siteName);
        } else {
            badgeFail(msg.siteId, msg.siteName);
        }
    }

    if (msg.type === 'SITE_ERROR') {
        badgeFail(msg.siteId, msg.siteName);
    }

    if (msg.type === 'SEARCH_DONE') {
        loadingState.classList.add('hidden');
        if (allResults.length === 0) {
            resultsTitle.textContent = 'No Results Found';
            resultsCount.textContent = '0 products';
            resultsGrid.innerHTML = `
                <div class="col-span-full text-center py-16 bg-white rounded-2xl border border-slate-200">
                    <i class="fa-solid fa-box-open text-5xl text-slate-200 mb-4"></i>
                    <p class="text-slate-400 text-lg">No results found across all retailers.</p>
                </div>`;
            resultsArea.classList.remove('hidden');
        }
        // Auto-hide status pill after a short delay
        setTimeout(() => { statusOverlay.style.display = 'none'; }, 2000);
    }
});

// ─── Search form submit ───────────────────────────────────────────────────────
searchForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const query = searchInput.value.trim();
    if (!query || !extensionReady) return;

    // Reset state
    allResults = [];
    currentRequestId = Date.now().toString();
    Object.keys(statusBadges).forEach(k => delete statusBadges[k]);

    resultsArea.classList.add('hidden');
    resultsGrid.innerHTML = '';
    loadingState.classList.remove('hidden');

    // Build status badges
    statusContainer.innerHTML = '';
    statusOverlay.style.display = 'block';
    const SITES = ['quartz','robocraze','thinkrobotics','evelta','sharvi','ktron','robu'];
    const SITE_NAMES = {
        quartz: 'Quartz', robocraze: 'Robocraze', thinkrobotics: 'ThinkRobotics',
        evelta: 'Evelta', sharvi: 'Sharvi', ktron: 'Ktron', robu: 'Robu'
    };
    SITES.forEach(id => makeBadge(id, SITE_NAMES[id]));

    // Fire!
    window.postMessage({ type: 'ELECTROEZY_SEARCH', query, requestId: currentRequestId }, '*');
});
