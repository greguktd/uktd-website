/* Wrapsthetic Configurator - client-side application
   Static, dependency-free apart from the vendored three.js build used for the 3D preview.
   See configurator/README.md for configuration and the order data format. */
(function () {
    'use strict';

    // ---------------------------------------------------------------
    // Configuration (edit these for Wrapsthetic)
    // ---------------------------------------------------------------
    const CONFIG = {
        brandName: 'Wrapsthetic',                 // Company name used everywhere on the page and in order files
        websiteUrl: 'https://wrapsthetic.com',    // Main website the configurator links back to
        contactEmail: 'hello@wrapsthetic.com',    // Where fallback emails go. CONFIRM BEFORE LAUNCH.
        submitUrl: '/api/wrap-orders',            // Endpoint that receives multipart orders (see README)
        seamAllowanceCm: 1.0,                     // Extra width added to each wrap template for the overlap seam
        discBleedCm: 0.5,                         // Extra radius printed on disc templates for trimming
        previewMaxPx: 1600,                       // Preview/export image is downscaled to this on the long side
        storageKey: 'wrapsthetic.configurator.v1'
    };

    const CM_PER_IN = 2.54;
    const SCALE = 10; // SVG units per cm (so 1 unit = 1 mm)
    const INTERVALS = { cm: [2.5, 5, 10], in: [1, 2, 4] };

    // ---------------------------------------------------------------
    // DOM helpers
    // ---------------------------------------------------------------
    const $ = (sel, root) => (root || document).querySelector(sel);
    const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
    const form = $('#wrapForm');
    const status = $('#formStatus');
    const stepper = $('#stepper');
    const steps = $$('.step[data-step]', form).filter(s => s.dataset.step !== 'done');
    const reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const state = {
        current: 1,
        artwork: null,      // { file, name, type, width, height, previewDataUrl }
        flatBBox: null,     // bbox of the first template part in the flat preview, for drag-to-move
        flatView: null,     // viewBox width of the flat preview
        wheelAngle: 0,      // degrees, wheel preview spin
        three: null         // 3D preview state
    };

    // ---------------------------------------------------------------
    // Branding
    // ---------------------------------------------------------------
    $$('[data-brand-name]').forEach(el => { el.textContent = CONFIG.brandName; });
    $$('[data-brand-email]').forEach(el => { el.href = 'mailto:' + CONFIG.contactEmail; });
    $$('[data-brand-link]').forEach(el => { el.href = CONFIG.websiteUrl; });
    document.title = CONFIG.brandName + ' Configurator | Design your prosthetic wrap';

    // ---------------------------------------------------------------
    // Product and units
    // ---------------------------------------------------------------
    function productType() { return form.elements.product.value || 'prosthetic'; }
    function isDiscs() { return productType() === 'discs'; }
    function currentUnits() { return (form.elements.units.value || 'cm'); }
    function toCm(value) { const v = parseFloat(value); if (!isFinite(v)) return null; return currentUnits() === 'in' ? v * CM_PER_IN : v; }
    function fromCm(cm, units) { return (units || currentUnits()) === 'in' ? cm / CM_PER_IN : cm; }
    function round(v, dp) { const f = Math.pow(10, dp === undefined ? 1 : dp); return Math.round(v * f) / f; }
    function fmtLen(cm) { const u = currentUnits(); return round(fromCm(cm, u), u === 'in' ? 2 : 1) + ' ' + u; }
    function r2(v) { return Math.round(v * 100) / 100; }

    function populateIntervals() {
        const sel = form.elements.stationInterval;
        const u = currentUnits();
        const prev = parseFloat(sel.value);
        const prevIndex = Math.max(0, Array.from(sel.options).findIndex(o => parseFloat(o.value) === prev));
        sel.innerHTML = '';
        INTERVALS[u].forEach((v, i) => {
            const o = document.createElement('option');
            o.value = String(v);
            o.textContent = v + ' ' + u + (i === 0 ? ' (most accurate)' : i === 1 ? ' (recommended)' : ' (quick)');
            sel.appendChild(o);
        });
        sel.selectedIndex = Math.min(prevIndex, sel.options.length - 1);
    }

    let lastUnits = 'cm';
    function onUnitsChange() {
        const u = currentUnits();
        if (u === lastUnits) return;
        const factor = u === 'in' ? 1 / CM_PER_IN : CM_PER_IN;
        const dp = u === 'in' ? 2 : 1;
        ['socketLength', 'pylonLength', 'pylonCircumference', 'discDiameter', 'discHub'].forEach(name => {
            const el = form.elements[name];
            if (el && el.value !== '') el.value = round(parseFloat(el.value) * factor, dp);
        });
        $$('.station input', form).forEach(el => { if (el.value !== '') el.value = round(parseFloat(el.value) * factor, dp); });
        $$('[data-unit]').forEach(el => { el.textContent = u; });
        lastUnits = u;
        populateIntervals();
        rebuildStations(true);
        persist();
    }

    function applyProductVisibility() {
        const discs = isDiscs();
        $('#prostheticFields').hidden = discs;
        $('#discFields').hidden = !discs;
        $('#socketMeasureBlock').hidden = discs || !form.elements.wrapSocket.checked;
        $('#pylonMeasureBlock').hidden = discs || !form.elements.wrapPylon.checked;
        $('#discMeasureBlock').hidden = !discs;
        $('#intervalField').hidden = discs;
        $('#cutoutsField').hidden = discs;
        $('#modelTitle').textContent = discs ? 'On the wheel' : 'On your prosthetic';
        $('#modelHint').textContent = discs ? 'Drag the wheel to spin it.' : 'Drag to turn it around. Lighting is approximate; colours print as supplied.';
        $('#flatTitle').textContent = discs ? 'Disc template' : 'Flat wrap template';
        $('#flatHint').textContent = discs ? 'The disc laid flat. Drag the artwork to move it. The small circle is the hub.' : 'The wrap laid flat, built from your measurements. Drag the artwork to move it. The dotted line is the seam.';
        $('#spinControls').hidden = discs;
        $$('[data-step="2"] .stepper-label, [data-step="3"] .stepper-label').forEach(() => {});
    }

    // ---------------------------------------------------------------
    // Measurement stations (prosthetic socket)
    // ---------------------------------------------------------------
    function stationPositions(length, interval) {
        if (!(length > 0) || !(interval > 0)) return [];
        const positions = [];
        const n = Math.floor(length / interval + 1e-9);
        for (let i = 0; i <= n; i++) positions.push(round(i * interval, 2));
        const remainder = length - n * interval;
        if (remainder > interval * 0.25) positions.push(round(length, 2));
        else if (positions.length > 1) positions[positions.length - 1] = round(length, 2);
        else positions.push(round(length, 2));
        return positions;
    }

    function rebuildStations(convertExisting) {
        const wrap = $('#stationsWrap');
        const grid = $('#stations');
        const length = parseFloat(form.elements.socketLength.value);
        const interval = parseFloat(form.elements.stationInterval.value);
        const positions = stationPositions(length, interval);
        if (!positions.length) { wrap.hidden = true; grid.innerHTML = ''; renderPreviews(); return; }
        const currentPositions = $$('[data-station]', grid).map(i => i.dataset.pos).join('|');
        if (!convertExisting && currentPositions === positions.join('|')) { wrap.hidden = false; renderPreviews(); return; }

        const existing = $$('.station input', grid).map(i => i.value);
        grid.innerHTML = '';
        const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
        positions.forEach((pos, i) => {
            const id = 'station' + i;
            const where = i === 0 ? 'at the brim (top)' : i === positions.length - 1 ? 'at the bottom' : pos + ' ' + currentUnits() + ' down';
            const div = document.createElement('div');
            div.className = 'station';
            div.innerHTML =
                '<label for="' + id + '">' + (letters[i] || (i + 1)) + ' <span class="station-pos">' + where + '</span></label>' +
                '<div class="input-unit"><input type="number" id="' + id + '" data-station data-pos="' + pos + '" min="1" step="0.1" inputmode="decimal" required><span class="unit" data-unit>' + currentUnits() + '</span></div>' +
                '<span class="station-warn" hidden></span>';
            grid.appendChild(div);
            const input = $('input', div);
            if (existing[i] !== undefined) input.value = existing[i];
        });
        wrap.hidden = false;
        $('#stationsHint').textContent = positions.length + ' measuring points. Measure all the way around the socket at each one.';
        checkStationSanity();
        renderPreviews();
    }

    function checkStationSanity() {
        let prev = null;
        $$('[data-station]', form).forEach(input => {
            const warn = input.closest('.station').querySelector('.station-warn');
            const v = parseFloat(input.value);
            warn.hidden = true;
            if (isFinite(v) && prev !== null && isFinite(prev)) {
                const change = Math.abs(v - prev) / prev;
                if (change > 0.35) { warn.textContent = 'This is very different from the one above. Double-check it.'; warn.hidden = false; }
            }
            prev = isFinite(v) ? v : prev;
        });
    }

    function readStations() {
        return $$('[data-station]', form).map(input => ({
            position_cm: round(toCm(input.dataset.pos) || 0, 2),
            circumference_cm: round(toCm(input.value) || 0, 2)
        })).filter(s => s.circumference_cm > 0);
    }

    function readMeasurements() {
        const f = form.elements;
        const base = { entered_in: currentUnits(), product: productType(), cutouts: f.cutouts.value.trim(), notes: f.measureNotes.value.trim() };
        if (isDiscs()) {
            base.discs = {
                diameter_cm: round(toCm(f.discDiameter.value) || 0, 2),
                hub_cm: round(toCm(f.discHub.value) || 0, 2),
                quantity: parseInt(f.discQuantity.value, 10) || 2,
                mirrored: f.discMirror.value === 'mirrored',
                wheelSize: f.wheelSize.value
            };
            base.socket = null; base.pylon = null;
            return base;
        }
        base.socket = f.wrapSocket.checked ? {
            length_cm: round(toCm(f.socketLength.value) || 0, 2),
            interval_cm: round(toCm(f.stationInterval.value) || 0, 2),
            stations: readStations()
        } : null;
        base.pylon = f.wrapPylon.checked ? {
            length_cm: round(toCm(f.pylonLength.value) || 0, 2),
            circumference_cm: round(toCm(f.pylonCircumference.value) || 0, 2)
        } : null;
        base.discs = null;
        return base;
    }

    // ---------------------------------------------------------------
    // Geometry
    // ---------------------------------------------------------------
    function socketGeometry(socket) {
        if (!socket || !socket.stations || socket.stations.length < 2) return null;
        const seam = CONFIG.seamAllowanceCm;
        const stations = socket.stations.slice().sort((a, b) => a.position_cm - b.position_cm);
        const maxWidth = Math.max.apply(null, stations.map(s => s.circumference_cm + seam));
        const height = stations[stations.length - 1].position_cm;
        return { stations, seam, maxWidth, height };
    }
    function circumferenceAt(geo, pos) {
        const st = geo.stations;
        if (pos <= st[0].position_cm) return st[0].circumference_cm;
        for (let i = 1; i < st.length; i++) {
            if (pos <= st[i].position_cm) {
                const a = st[i - 1], b = st[i];
                const t = (pos - a.position_cm) / Math.max(1e-6, b.position_cm - a.position_cm);
                return a.circumference_cm + t * (b.circumference_cm - a.circumference_cm);
            }
        }
        return st[st.length - 1].circumference_cm;
    }
    function discGeometry(discs) {
        if (!discs || !(discs.diameter_cm > 0)) return null;
        return { radius: discs.diameter_cm / 2, hub: Math.max(0, Math.min(discs.hub_cm || 0, discs.diameter_cm - 2)) / 2, quantity: Math.max(1, discs.quantity || 1), mirrored: !!discs.mirrored };
    }

    function smoothPath(leftPts, rightPts) {
        const seg = (p0, p1, p2, p3) => {
            const c1x = p1[0] + (p2[0] - p0[0]) / 6, c1y = p1[1] + (p2[1] - p0[1]) / 6;
            const c2x = p2[0] - (p3[0] - p1[0]) / 6, c2y = p2[1] - (p3[1] - p1[1]) / 6;
            return ' C' + r2(c1x) + ',' + r2(c1y) + ' ' + r2(c2x) + ',' + r2(c2y) + ' ' + r2(p2[0]) + ',' + r2(p2[1]);
        };
        const side = (arr) => { let s = ''; for (let i = 0; i < arr.length - 1; i++) { s += seg(arr[Math.max(0, i - 1)], arr[i], arr[i + 1], arr[Math.min(arr.length - 1, i + 2)]); } return s; };
        return 'M' + r2(leftPts[0][0]) + ',' + r2(leftPts[0][1]) + side(leftPts) + ' L' + r2(rightPts[0][0]) + ',' + r2(rightPts[0][1]) + side(rightPts) + ' Z';
    }
    function flatOutline(geo, cx, top) {
        const left = geo.stations.map(s => [cx - (s.circumference_cm + geo.seam) / 2 * SCALE, top + s.position_cm * SCALE]);
        const right = geo.stations.slice().reverse().map(s => [cx + (s.circumference_cm + geo.seam) / 2 * SCALE, top + s.position_cm * SCALE]);
        return smoothPath(left, right);
    }
    function silhouetteOutline(geo, cx, top) {
        const left = geo.stations.map(s => [cx - s.circumference_cm / (2 * Math.PI) * SCALE, top + s.position_cm * SCALE]);
        const right = geo.stations.slice().reverse().map(s => [cx + s.circumference_cm / (2 * Math.PI) * SCALE, top + s.position_cm * SCALE]);
        return smoothPath(left, right);
    }

    // ---------------------------------------------------------------
    // Artwork placement
    // ---------------------------------------------------------------
    function readPlacement() {
        return {
            fit: form.elements.fit.value,
            scale: parseInt(form.elements.artScale.value, 10),
            offsetX: parseInt(form.elements.artOffsetX.value, 10),
            offsetY: parseInt(form.elements.artOffsetY.value, 10),
            rotation: parseInt(form.elements.artRotation.value, 10),
            background: form.elements.artBackground.value
        };
    }

    function artworkGroup(bbox, idSuffix, mirrored) {
        // SVG markup painting the artwork over {x,y,w,h} per the user's placement.
        const art = state.artwork;
        const p = readPlacement();
        let inner = '<rect x="' + bbox.x + '" y="' + bbox.y + '" width="' + bbox.w + '" height="' + bbox.h + '" fill="' + p.background + '"/>';
        if (!art) return inner;
        const cx = bbox.x + bbox.w / 2, cy = bbox.y + bbox.h / 2;
        const s = p.scale / 100;
        const tx = p.offsetX / 100 * bbox.w / 2, ty = p.offsetY / 100 * bbox.h / 2;
        const transform = 'translate(' + r2(cx + tx) + ',' + r2(cy + ty) + ') rotate(' + p.rotation + ') scale(' + s + ') translate(' + r2(-cx) + ',' + r2(-cy) + ')';
        let art_markup = '';
        if (p.fit === 'tile') {
            const tileW = bbox.w / 3, tileH = tileW * art.height / art.width;
            const pid = 'tile' + idSuffix;
            art_markup = '<defs><pattern id="' + pid + '" patternUnits="userSpaceOnUse" x="' + bbox.x + '" y="' + bbox.y + '" width="' + r2(tileW) + '" height="' + r2(tileH) + '" patternTransform="' + transform + '">' +
                '<image href="' + art.previewDataUrl + '" width="' + r2(tileW) + '" height="' + r2(tileH) + '" preserveAspectRatio="none"/></pattern></defs>' +
                '<rect x="' + (bbox.x - bbox.w) + '" y="' + (bbox.y - bbox.h) + '" width="' + bbox.w * 3 + '" height="' + bbox.h * 3 + '" fill="url(#' + pid + ')"/>';
        } else {
            const par = p.fit === 'cover' ? 'xMidYMid slice' : 'xMidYMid meet';
            art_markup = '<image href="' + art.previewDataUrl + '" x="' + bbox.x + '" y="' + bbox.y + '" width="' + bbox.w + '" height="' + bbox.h + '" preserveAspectRatio="' + par + '" transform="' + transform + '"/>';
        }
        if (mirrored) art_markup = '<g transform="translate(' + r2(2 * cx) + ',0) scale(-1,1)">' + art_markup + '</g>';
        return inner + art_markup;
    }

    // ---------------------------------------------------------------
    // Templates: prosthetic wrap (flat) and wheel discs
    // ---------------------------------------------------------------
    const FONT = 'Roboto, Arial, sans-serif';

    function buildFlatSvg(opts) {
        const m = readMeasurements();
        const geo = socketGeometry(m.socket);
        const pylon = m.pylon && m.pylon.length_cm > 0 && m.pylon.circumference_cm > 0 ? m.pylon : null;
        if (!geo && !pylon) return null;
        const forExport = !!(opts && opts.forExport);
        const margin = forExport ? 8 * SCALE : 1.5 * SCALE;
        const gap = 3 * SCALE;
        const labelCol = forExport ? 9 * SCALE : 0;
        let x = margin, parts = '', defs = '', totalH = 0, firstBBox = null;
        const uid = (opts && opts.id) || 'f';

        if (geo) {
            const w = geo.maxWidth * SCALE, h = geo.height * SCALE;
            const cx = x + labelCol + w / 2;
            const bbox = { x: x + labelCol, y: margin, w: w, h: h };
            firstBBox = bbox;
            const d = flatOutline(geo, cx, margin);
            defs += '<clipPath id="clipSocket' + uid + '"><path d="' + d + '"/></clipPath>';
            parts += '<g clip-path="url(#clipSocket' + uid + ')">' + artworkGroup(bbox, 'S' + uid) + '</g>';
            parts += '<path d="' + d + '" fill="none" stroke="#111" stroke-width="' + (forExport ? 2 : 3) + '"/>';
            parts += '<line x1="' + r2(cx - w / 2 + geo.seam * SCALE) + '" y1="' + margin + '" x2="' + r2(cx - w / 2 + geo.seam * SCALE) + '" y2="' + r2(margin + h) + '" stroke="#111" stroke-dasharray="6 6" stroke-width="2" opacity="0.6"/>';
            if (forExport) {
                parts += '<text x="' + bbox.x + '" y="' + (margin - 6 * SCALE) + '" font-family="' + FONT + '" font-size="' + (4 * SCALE) + '" font-weight="700" fill="#111">Socket wrap (' + geo.height + ' cm tall, max ' + round(geo.maxWidth, 1) + ' cm wide incl. ' + geo.seam + ' cm seam)</text>';
                geo.stations.forEach((s, i) => {
                    const y = margin + s.position_cm * SCALE;
                    parts += '<line x1="' + x + '" y1="' + y + '" x2="' + r2(cx - (s.circumference_cm + geo.seam) / 2 * SCALE) + '" y2="' + y + '" stroke="#6fa32b" stroke-width="1" stroke-dasharray="3 3"/>';
                    parts += '<text x="' + x + '" y="' + (y - 4) + '" font-family="' + FONT + '" font-size="' + (2.6 * SCALE) + '" fill="#3f5038">' + String.fromCharCode(65 + i) + ' ' + s.position_cm + ' cm: ' + s.circumference_cm + ' cm around</text>';
                });
            }
            x += labelCol + w + gap;
            totalH = Math.max(totalH, h);
        }
        if (pylon) {
            const w = (pylon.circumference_cm + CONFIG.seamAllowanceCm) * SCALE, h = pylon.length_cm * SCALE;
            const bbox = { x: x, y: margin, w: w, h: h };
            if (!firstBBox) firstBBox = bbox;
            defs += '<clipPath id="clipPylon' + uid + '"><rect x="' + x + '" y="' + margin + '" width="' + r2(w) + '" height="' + r2(h) + '"/></clipPath>';
            parts += '<g clip-path="url(#clipPylon' + uid + ')">' + artworkGroup(bbox, 'P' + uid) + '</g>';
            parts += '<rect x="' + x + '" y="' + margin + '" width="' + r2(w) + '" height="' + r2(h) + '" fill="none" stroke="#111" stroke-width="' + (forExport ? 2 : 3) + '"/>';
            parts += '<line x1="' + r2(x + CONFIG.seamAllowanceCm * SCALE) + '" y1="' + margin + '" x2="' + r2(x + CONFIG.seamAllowanceCm * SCALE) + '" y2="' + r2(margin + h) + '" stroke="#111" stroke-dasharray="6 6" stroke-width="2" opacity="0.6"/>';
            if (forExport) parts += '<text x="' + x + '" y="' + (margin - 6 * SCALE) + '" font-family="' + FONT + '" font-size="' + (4 * SCALE) + '" font-weight="700" fill="#111">Pylon wrap (' + pylon.length_cm + ' cm x ' + round(pylon.circumference_cm + CONFIG.seamAllowanceCm, 1) + ' cm incl. seam)</text>';
            x += w + gap;
            totalH = Math.max(totalH, h);
        }
        const totalW = x - gap + margin, totalHeight = totalH + margin * 2;
        if (forExport) parts += scaleBar(margin, totalHeight - margin / 2);
        if (!forExport) { state.flatBBox = firstBBox; state.flatView = totalW; }
        return svgDoc(totalW, totalHeight, defs, parts, forExport, 'Flat wrap template');
    }

    function buildDiscSvg(opts) {
        const m = readMeasurements();
        const geo = discGeometry(m.discs);
        if (!geo) return null;
        const forExport = !!(opts && opts.forExport);
        const uid = (opts && opts.id) || 'd';
        const margin = forExport ? 6 * SCALE : 1.5 * SCALE;
        const gap = 3 * SCALE;
        const R = (geo.radius + (forExport ? CONFIG.discBleedCm : 0)) * SCALE;
        const count = forExport ? geo.quantity : 1;
        let parts = '', defs = '';
        for (let i = 0; i < count; i++) {
            const cx = margin + R + i * (2 * R + gap), cy = margin + R;
            const bbox = { x: cx - R, y: cy - R, w: 2 * R, h: 2 * R };
            if (i === 0 && !forExport) { state.flatBBox = bbox; }
            const mirrored = geo.mirrored && i === 1;
            defs += '<clipPath id="clipDisc' + uid + i + '"><circle cx="' + r2(cx) + '" cy="' + r2(cy) + '" r="' + r2(R) + '"/></clipPath>';
            parts += '<g clip-path="url(#clipDisc' + uid + i + ')">' + artworkGroup(bbox, 'D' + uid + i, mirrored) + '</g>';
            parts += '<circle cx="' + r2(cx) + '" cy="' + r2(cy) + '" r="' + r2(R) + '" fill="none" stroke="#111" stroke-width="' + (forExport ? 2 : 3) + '"/>';
            if (forExport && CONFIG.discBleedCm > 0) parts += '<circle cx="' + r2(cx) + '" cy="' + r2(cy) + '" r="' + r2(geo.radius * SCALE) + '" fill="none" stroke="#111" stroke-width="1.5" stroke-dasharray="6 6"/>';
            if (geo.hub > 0) parts += '<circle cx="' + r2(cx) + '" cy="' + r2(cy) + '" r="' + r2(geo.hub * SCALE) + '" fill="' + (forExport ? '#fff' : 'rgba(255,255,255,0.85)') + '" stroke="#111" stroke-width="2" stroke-dasharray="' + (forExport ? '6 6' : '0') + '"/>';
            // Centre cross for alignment
            parts += '<path d="M' + r2(cx - 1.5 * SCALE) + ',' + r2(cy) + 'h' + (3 * SCALE) + 'M' + r2(cx) + ',' + r2(cy - 1.5 * SCALE) + 'v' + (3 * SCALE) + '" stroke="#111" stroke-width="1.5"/>';
            if (forExport) {
                [[0, -1], [1, 0], [0, 1], [-1, 0]].forEach(d => { parts += '<line x1="' + r2(cx + d[0] * (R - 1.2 * SCALE)) + '" y1="' + r2(cy + d[1] * (R - 1.2 * SCALE)) + '" x2="' + r2(cx + d[0] * (R + 1.2 * SCALE)) + '" y2="' + r2(cy + d[1] * (R + 1.2 * SCALE)) + '" stroke="#111" stroke-width="1.5"/>'; });
                parts += '<text x="' + r2(cx - R) + '" y="' + (margin - 2.5 * SCALE) + '" font-family="' + FONT + '" font-size="' + (3.6 * SCALE) + '" font-weight="700" fill="#111">Wheel disc ' + (i + 1) + (mirrored ? ' (mirrored)' : '') + ': ' + (geo.radius * 2) + ' cm diameter' + (CONFIG.discBleedCm ? ' + ' + CONFIG.discBleedCm + ' cm bleed' : '') + (geo.hub ? ', hub ' + (geo.hub * 2) + ' cm' : '') + '</text>';
            }
        }
        const totalW = margin * 2 + count * 2 * R + (count - 1) * gap, totalH = margin * 2 + 2 * R;
        if (forExport) parts += scaleBar(margin, totalH - margin / 2);
        if (!forExport) state.flatView = totalW;
        return svgDoc(totalW, totalH, defs, parts, forExport, 'Wheel disc template');
    }

    function scaleBar(x, y) {
        return '<line x1="' + x + '" y1="' + y + '" x2="' + (x + 10 * SCALE) + '" y2="' + y + '" stroke="#111" stroke-width="3"/>' +
            '<text x="' + x + '" y="' + (y - 8) + '" font-family="' + FONT + '" font-size="' + (3 * SCALE) + '" fill="#111">10 cm (1 SVG unit = 1 mm, print at 100%)</text>';
    }
    function svgDoc(w, h, defs, parts, forExport, label) {
        const sizeAttrs = forExport ? ' width="' + r2(w) + 'mm" height="' + r2(h) + 'mm"' : '';
        return '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ' + r2(w) + ' ' + r2(h) + '"' + sizeAttrs + ' role="img" aria-label="' + label + '">' +
            (forExport ? '<rect width="100%" height="100%" fill="#fff"/>' : '') + '<defs>' + defs + '</defs>' + parts + '</svg>';
    }
    function buildTemplateSvg(opts) { return isDiscs() ? buildDiscSvg(opts) : buildFlatSvg(opts); }

    // ---------------------------------------------------------------
    // Static previews: limb silhouette (fallback) and wheel
    // ---------------------------------------------------------------
    function buildLimbSvg(uid) {
        uid = uid || 'l';
        const m = readMeasurements();
        const geo = socketGeometry(m.socket);
        if (!geo) return null;
        const pylon = m.pylon;
        const margin = 2 * SCALE;
        const maxR = Math.max.apply(null, geo.stations.map(s => s.circumference_cm / (2 * Math.PI))) * SCALE;
        const pylonH = (pylon && pylon.length_cm > 0 ? pylon.length_cm : 12) * SCALE;
        const pylonW = (pylon && pylon.circumference_cm > 0 ? pylon.circumference_cm / Math.PI : 3.2) * SCALE;
        const W = maxR * 2 + margin * 2, H = geo.height * SCALE + pylonH + margin * 2;
        const cx = W / 2;
        const d = silhouetteOutline(geo, cx, margin);
        const flatW = geo.maxWidth * SCALE;
        const bbox = { x: cx - flatW / 2, y: margin, w: flatW, h: geo.height * SCALE };
        const squeeze = 2 / Math.PI;
        let svg = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ' + r2(W) + ' ' + r2(H) + '" role="img" aria-label="Preview of the wrap on the limb"><defs>' +
            '<clipPath id="clipLimb' + uid + '"><path d="' + d + '"/></clipPath>' +
            '<linearGradient id="shade' + uid + '" x1="0" x2="1"><stop offset="0" stop-color="#000" stop-opacity="0.35"/><stop offset="0.25" stop-color="#fff" stop-opacity="0.05"/><stop offset="0.5" stop-color="#fff" stop-opacity="0.18"/><stop offset="0.8" stop-color="#000" stop-opacity="0.1"/><stop offset="1" stop-color="#000" stop-opacity="0.45"/></linearGradient></defs>';
        svg += '<g clip-path="url(#clipLimb' + uid + ')"><g transform="translate(' + r2(cx) + ',0) scale(' + r2(squeeze) + ',1) translate(' + r2(-cx) + ',0)">' + artworkGroup(bbox, 'L' + uid) + '</g><path d="' + d + '" fill="url(#shade' + uid + ')"/></g>';
        svg += '<path d="' + d + '" fill="none" stroke="#111" stroke-width="2.5"/>';
        const py = margin + geo.height * SCALE;
        const pbox = { x: cx - pylonW / 2, y: py, w: pylonW, h: pylonH };
        if (pylon && pylon.length_cm > 0) {
            svg += '<defs><clipPath id="clipLimbPylon' + uid + '"><rect x="' + r2(pbox.x) + '" y="' + py + '" width="' + r2(pylonW) + '" height="' + r2(pylonH) + '" rx="' + r2(pylonW / 6) + '"/></clipPath></defs>' +
                '<g clip-path="url(#clipLimbPylon' + uid + ')"><g transform="translate(' + r2(cx) + ',0) scale(' + r2(squeeze) + ',1) translate(' + r2(-cx) + ',0)">' +
                artworkGroup({ x: cx - (pylon.circumference_cm + CONFIG.seamAllowanceCm) * SCALE / 2, y: py, w: (pylon.circumference_cm + CONFIG.seamAllowanceCm) * SCALE, h: pylonH }, 'LP' + uid) +
                '</g><rect x="' + r2(pbox.x) + '" y="' + py + '" width="' + r2(pylonW) + '" height="' + r2(pylonH) + '" fill="url(#shade' + uid + ')"/></g>';
        } else {
            svg += '<rect x="' + r2(pbox.x) + '" y="' + py + '" width="' + r2(pylonW) + '" height="' + r2(pylonH) + '" rx="' + r2(pylonW / 6) + '" fill="#3a3f48"/>';
        }
        svg += '<rect x="' + r2(pbox.x) + '" y="' + py + '" width="' + r2(pylonW) + '" height="' + r2(pylonH) + '" rx="' + r2(pylonW / 6) + '" fill="none" stroke="#111" stroke-width="2"/></svg>';
        return svg;
    }

    function buildWheelSvg(uid, angle) {
        uid = uid || 'w';
        const m = readMeasurements();
        const geo = discGeometry(m.discs);
        if (!geo) return null;
        const R = geo.radius * SCALE;
        const tyre = R * 1.16, pushRim = R * 1.28, pad = 2 * SCALE;
        const W = pushRim * 2 + pad * 2, H = W;
        const cx = W / 2, cy = H / 2;
        const bbox = { x: cx - R, y: cy - R, w: 2 * R, h: 2 * R };
        const a = angle || 0;
        let svg = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ' + r2(W) + ' ' + r2(H) + '" role="img" aria-label="Preview of the disc on a wheelchair wheel"><defs>' +
            '<clipPath id="clipWheel' + uid + '"><circle cx="' + r2(cx) + '" cy="' + r2(cy) + '" r="' + r2(R) + '"/></clipPath>' +
            '<radialGradient id="tyreShade' + uid + '" cx="0.35" cy="0.3" r="0.8"><stop offset="0" stop-color="#4b5058"/><stop offset="1" stop-color="#1c1f24"/></radialGradient>' +
            '<radialGradient id="discShade' + uid + '" cx="0.4" cy="0.35" r="0.75"><stop offset="0" stop-color="#fff" stop-opacity="0.18"/><stop offset="0.7" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.22"/></radialGradient>' +
            '</defs>';
        svg += '<circle cx="' + r2(cx) + '" cy="' + r2(cy) + '" r="' + r2(pushRim) + '" fill="none" stroke="#9aa0a8" stroke-width="' + r2(0.7 * SCALE) + '"/>';
        svg += '<circle cx="' + r2(cx) + '" cy="' + r2(cy) + '" r="' + r2(tyre) + '" fill="url(#tyreShade' + uid + ')"/>';
        svg += '<circle cx="' + r2(cx) + '" cy="' + r2(cy) + '" r="' + r2(R * 1.04) + '" fill="#c7cbd1"/>';
        svg += '<g clip-path="url(#clipWheel' + uid + ')"><g transform="rotate(' + r2(a) + ' ' + r2(cx) + ' ' + r2(cy) + ')">' + artworkGroup(bbox, 'W' + uid) + '</g><circle cx="' + r2(cx) + '" cy="' + r2(cy) + '" r="' + r2(R) + '" fill="url(#discShade' + uid + ')"/></g>';
        svg += '<circle cx="' + r2(cx) + '" cy="' + r2(cy) + '" r="' + r2(R) + '" fill="none" stroke="#111" stroke-width="1.5" opacity="0.6"/>';
        const hubR = Math.max(geo.hub, 1.5) * SCALE;
        svg += '<circle cx="' + r2(cx) + '" cy="' + r2(cy) + '" r="' + r2(hubR) + '" fill="#2b2f36" stroke="#9aa0a8" stroke-width="2"/><circle cx="' + r2(cx) + '" cy="' + r2(cy) + '" r="' + r2(hubR * 0.45) + '" fill="#6b7078"/>';
        svg += '</svg>';
        return svg;
    }

    // ---------------------------------------------------------------
    // 3D preview (three.js, vendored). Falls back to the silhouette SVG.
    // ---------------------------------------------------------------
    function threeAvailable() {
        if (!window.THREE) return false;
        try { const c = document.createElement('canvas'); return !!(c.getContext('webgl') || c.getContext('experimental-webgl')); } catch (e) { return false; }
    }

    function initThree(container) {
        if (state.three) return state.three;
        if (!threeAvailable()) return null;
        const T = window.THREE;
        let renderer;
        try { renderer = new T.WebGLRenderer({ antialias: true, alpha: true }); } catch (e) { return null; }
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        renderer.outputEncoding = T.sRGBEncoding;
        const scene = new T.Scene();
        const camera = new T.PerspectiveCamera(32, 1, 1, 1000);
        scene.add(new T.HemisphereLight(0xffffff, 0x8a9a7a, 0.9));
        const key = new T.DirectionalLight(0xffffff, 0.75); key.position.set(40, 80, 60); scene.add(key);
        const fill = new T.DirectionalLight(0xffffff, 0.3); fill.position.set(-60, 20, -40); scene.add(fill);
        const group = new T.Group(); scene.add(group);
        const t = { T, renderer, scene, camera, group, rotation: 0, spinning: false, dragging: false, raf: 0, textures: {}, container };
        container.innerHTML = '';
        container.appendChild(renderer.domElement);
        renderer.domElement.className = 'three-canvas';
        renderer.domElement.setAttribute('aria-label', 'Interactive 3D preview of the wrap on your prosthetic. Drag to turn.');
        renderer.domElement.setAttribute('role', 'img');

        const resize = () => {
            const w = Math.max(200, container.clientWidth);
            const h = Math.round(Math.min(520, Math.max(260, w * 1.05)));
            renderer.setSize(w, h, false);
            renderer.domElement.style.width = w + 'px'; renderer.domElement.style.height = h + 'px';
            camera.aspect = w / h; camera.updateProjectionMatrix();
            threeRender();
        };
        if (window.ResizeObserver) new ResizeObserver(resize).observe(container); else window.addEventListener('resize', resize);
        t.resize = resize;

        // Drag to turn (mouse, touch, pen)
        let lastX = 0;
        const el = renderer.domElement;
        el.addEventListener('pointerdown', e => { t.dragging = true; lastX = e.clientX; el.setPointerCapture(e.pointerId); stopSpin(); });
        el.addEventListener('pointermove', e => { if (!t.dragging) return; const dx = e.clientX - lastX; lastX = e.clientX; t.rotation += dx * 0.012; syncTurnSlider(); threeRender(); });
        const end = () => { t.dragging = false; };
        el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
        state.three = t;
        resize();
        return t;
    }

    function syncTurnSlider() {
        const t = state.three; if (!t) return;
        const deg = ((t.rotation * 180 / Math.PI) % 360 + 360) % 360;
        form.elements.turn.value = Math.round(deg);
        $('#turnOut').textContent = Math.round(deg) + '°';
    }
    function stopSpin() { const t = state.three; if (!t) return; t.spinning = false; form.elements.spin.checked = false; if (t.raf) { cancelAnimationFrame(t.raf); t.raf = 0; } }
    function startSpin() {
        const t = state.three; if (!t) return;
        t.spinning = true;
        const tick = () => { if (!t.spinning) return; t.rotation += 0.012; syncTurnSlider(); threeRender(); t.raf = requestAnimationFrame(tick); };
        if (!t.raf) t.raf = requestAnimationFrame(tick);
    }
    function threeRender() {
        const t = state.three; if (!t) return;
        t.group.rotation.y = t.rotation;
        t.renderer.render(t.scene, t.camera);
    }

    function rasterizeSvg(svg, width, height) {
        // Draws an SVG string onto a canvas. Returns a promise of the canvas.
        return new Promise((resolve, reject) => {
            const img = new Image();
            const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
            img.onload = () => { const c = document.createElement('canvas'); c.width = width; c.height = height; c.getContext('2d').drawImage(img, 0, 0, width, height); URL.revokeObjectURL(url); resolve(c); };
            img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('svg raster')); };
            img.src = url;
        });
    }

    let textureJob = 0;
    function buildThreeModel() {
        const t = state.three; if (!t) return;
        const T = t.T;
        const m = readMeasurements();
        const geo = socketGeometry(m.socket);
        const pylon = m.pylon && m.pylon.length_cm > 0 ? m.pylon : null;
        while (t.group.children.length) { const c = t.group.children.pop(); if (c.geometry) c.geometry.dispose(); }
        if (!geo && !pylon) { threeRender(); return; }
        const finish = form.elements.finish.value;
        const roughness = finish === 'gloss' ? 0.25 : finish === 'satin' ? 0.5 : 0.85;
        const limb = form.elements.limbType.value;
        const isLeg = limb === 'transtibial' || limb === 'transfemoral' || limb === '' || limb === 'other';
        const socketH = geo ? geo.height : 0;
        const pylonLen = pylon ? pylon.length_cm : (isLeg ? 12 : 8);
        const pylonR = pylon ? pylon.circumference_cm / (2 * Math.PI) : 1.6;
        const footH = isLeg ? 7 : 0;
        const total = socketH + pylonLen + footH;
        // Coordinates: y up, 0 at bottom of foot/pylon.
        const job = ++textureJob;
        const mat = (map) => new T.MeshStandardMaterial({ map: map || null, color: map ? 0xffffff : 0xdddddd, roughness, metalness: 0.05 });

        if (geo) {
            const pts = [];
            const n = 48;
            for (let i = 0; i <= n; i++) {
                const pos = geo.height * (1 - i / n); // from bottom (pos = height) to top (pos = 0)
                const r = circumferenceAt(geo, pos) / (2 * Math.PI);
                pts.push(new T.Vector2(Math.max(0.3, r), footH + pylonLen + (geo.height - pos)));
            }
            const lathe = new T.LatheGeometry(pts, 96);
            const socketMesh = new T.Mesh(lathe, mat(null));
            socketMesh.name = 'socket';
            t.group.add(socketMesh);
            // Top rim: a thin dark ring so the open socket reads correctly
            const topR = circumferenceAt(geo, 0) / (2 * Math.PI);
            const rim = new T.Mesh(new T.TorusGeometry(topR, 0.25, 8, 64), new T.MeshStandardMaterial({ color: 0x222222, roughness: 0.6 }));
            rim.rotation.x = Math.PI / 2; rim.position.y = footH + pylonLen + geo.height; t.group.add(rim);
            // Texture: rectified flat artwork
            const flatW = geo.maxWidth * SCALE, flatH = geo.height * SCALE;
            const bbox = { x: 0, y: 0, w: flatW, h: flatH };
            const svg = svgDoc(flatW, flatH, '', artworkGroup(bbox, 'T'), false, 'texture').replace('<svg ', '<svg width="' + Math.round(flatW) + '" height="' + Math.round(flatH) + '" ');
            const RW = 1024, RH = Math.min(1024, Math.max(256, Math.round(1024 * flatH / flatW)));
            rasterizeSvg(svg, RW, RH).then(raster => {
                if (job !== textureJob) return;
                const tex = document.createElement('canvas'); tex.width = 1024; tex.height = 1024;
                const ctx = tex.getContext('2d');
                for (let y = 0; y < 1024; y++) {
                    const pos = geo.height * y / 1023;
                    const c = circumferenceAt(geo, pos);
                    const sw = c / geo.maxWidth * RW, sx = (RW - sw) / 2, sy = y / 1024 * RH;
                    ctx.drawImage(raster, sx, sy, Math.max(1, sw), Math.max(1, RH / 1024), 0, y, 1024, 1);
                }
                const map = new T.CanvasTexture(tex);
                map.encoding = T.sRGBEncoding; map.anisotropy = 4; map.wrapS = T.RepeatWrapping;
                socketMesh.material = mat(map);
                threeRender();
            }).catch(() => {});
        }
        // Pylon
        const cyl = new T.Mesh(new T.CylinderGeometry(pylonR, pylonR, pylonLen, 48, 1, false), pylon ? mat(null) : new T.MeshStandardMaterial({ color: 0x2b2f36, roughness: 0.5, metalness: 0.3 }));
        cyl.position.y = footH + pylonLen / 2; t.group.add(cyl);
        if (pylon) {
            const w = (pylon.circumference_cm + CONFIG.seamAllowanceCm) * SCALE, h = pylon.length_cm * SCALE;
            const svg = svgDoc(w, h, '', artworkGroup({ x: 0, y: 0, w, h }, 'TP'), false, 'texture').replace('<svg ', '<svg width="' + Math.round(w) + '" height="' + Math.round(h) + '" ');
            rasterizeSvg(svg, 512, Math.min(1024, Math.max(128, Math.round(512 * h / w)))).then(raster => {
                if (job !== textureJob) return;
                const map = new T.CanvasTexture(raster); map.encoding = T.sRGBEncoding; map.anisotropy = 4;
                cyl.material = mat(map); threeRender();
            }).catch(() => {});
        }
        if (isLeg) {
            const foot = new T.Mesh(new T.BoxGeometry(9, footH * 0.6, 24), new T.MeshStandardMaterial({ color: 0x3a3f48, roughness: 0.7 }));
            foot.position.set(0, footH * 0.3, -6); t.group.add(foot);
            const ankle = new T.Mesh(new T.CylinderGeometry(2.2, 2.6, footH * 0.5, 24), new T.MeshStandardMaterial({ color: 0x2b2f36, roughness: 0.6 }));
            ankle.position.y = footH * 0.75; t.group.add(ankle);
        }
        t.group.position.y = -total / 2;
        t.rotation = t.rotation || Math.PI; // start showing the centre of the flat wrap
        const maxR = Math.max(geo ? Math.max.apply(null, geo.stations.map(s => s.circumference_cm)) / (2 * Math.PI) : 0, pylonR, isLeg ? 12 : 0);
        const dist = Math.max(total, maxR * 2.2) * 1.9 + 10;
        t.camera.position.set(0, total * 0.08, dist);
        t.camera.lookAt(0, 0, 0);
        syncTurnSlider();
        threeRender();
    }

    // ---------------------------------------------------------------
    // Preview rendering
    // ---------------------------------------------------------------
    let previewRaf = 0;
    function renderPreviews() {
        if (previewRaf) return;
        previewRaf = requestAnimationFrame(() => { previewRaf = 0; renderPreviewsNow(); });
    }
    function renderPreviewsNow() {
        const flat = buildTemplateSvg({ id: 'p' });
        const flatStage = $('#flatStage'), modelStage = $('#modelStage'), hint = $('#previewHint');
        flatStage.innerHTML = flat || '<p class="preview-empty">Add your measurements in step 3 to see the template.</p>';
        if (isDiscs()) {
            stopSpin();
            const wheel = buildWheelSvg('p', state.wheelAngle);
            modelStage.innerHTML = wheel || '<p class="preview-empty">Enter the disc size in step 3 for this preview.</p>';
            modelStage.classList.remove('is-3d');
        } else if (steps[3].classList.contains('is-active') && initThree(modelStage)) {
            modelStage.classList.add('is-3d');
            buildThreeModel();
        } else {
            const limb = buildLimbSvg('p');
            modelStage.innerHTML = limb || '<p class="preview-empty">Socket measurements needed for this preview.</p>';
            modelStage.classList.remove('is-3d');
        }
        if (!flat) hint.textContent = 'Enter your measurements in step 3 to see the template shape.';
        else if (!state.artwork) hint.textContent = 'Template ready. Upload an image to see it on the wrap.';
        else hint.textContent = 'Drag the artwork on the template to move it, or use the sliders. ' + CONFIG.brandName + ' sees exactly this placement.';
    }

    function loadArtwork(file) {
        if (!file) return;
        if (!/^image\/(png|jpeg|webp|svg\+xml)$/.test(file.type)) {
            setStatus('That file type isn\'t supported. Please use a PNG, JPEG, WebP or SVG image.', 'error');
            return;
        }
        setStatus('Loading your artwork…', 'info');
        const reader = new FileReader();
        reader.onload = () => {
            const img = new Image();
            img.onload = () => {
                let previewDataUrl = reader.result;
                let w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
                if (file.type !== 'image/svg+xml' && Math.max(w, h) > CONFIG.previewMaxPx) {
                    const k = CONFIG.previewMaxPx / Math.max(w, h);
                    const canvas = document.createElement('canvas');
                    canvas.width = Math.round(w * k); canvas.height = Math.round(h * k);
                    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
                    previewDataUrl = canvas.toDataURL(file.type === 'image/png' ? 'image/png' : 'image/jpeg', 0.9);
                }
                state.artwork = { file, name: file.name, type: file.type, size: file.size, width: w, height: h, previewDataUrl };
                $('#artworkFileName').textContent = file.name + ' · ' + w + ' × ' + h + ' px' + (Math.max(w, h) < 1500 && file.type !== 'image/svg+xml' ? ' (a larger image would print sharper)' : '');
                clearStatus();
                renderPreviews();
            };
            img.onerror = () => setStatus('We couldn\'t read that image. Try saving it as a PNG or JPEG and uploading again.', 'error');
            img.src = reader.result;
        };
        reader.onerror = () => setStatus('We couldn\'t read that file.', 'error');
        reader.readAsDataURL(file);
    }

    // Drag the artwork on the flat template to move it
    function attachFlatDrag() {
        const stage = $('#flatStage');
        let dragging = false, lastX = 0, lastY = 0;
        stage.addEventListener('pointerdown', e => {
            if (!state.artwork || !state.flatBBox) return;
            dragging = true; lastX = e.clientX; lastY = e.clientY; stage.setPointerCapture(e.pointerId); stage.classList.add('is-dragging'); e.preventDefault();
        });
        stage.addEventListener('pointermove', e => {
            if (!dragging) return;
            const svg = stage.querySelector('svg'); if (!svg) return;
            const rect = svg.getBoundingClientRect();
            const vb = (svg.getAttribute('viewBox') || '').split(/\s+/).map(parseFloat);
            const viewW = vb.length === 4 ? vb[2] : state.flatView;
            if (!rect.width || !viewW) return;
            const unitsPerPx = viewW / rect.width;
            const dx = (e.clientX - lastX) * unitsPerPx, dy = (e.clientY - lastY) * unitsPerPx;
            lastX = e.clientX; lastY = e.clientY;
            const ox = form.elements.artOffsetX, oy = form.elements.artOffsetY;
            ox.value = Math.max(-100, Math.min(100, parseFloat(ox.value) + dx / (state.flatBBox.w / 2) * 100));
            oy.value = Math.max(-100, Math.min(100, parseFloat(oy.value) + dy / (state.flatBBox.h / 2) * 100));
            $('#artOffsetXOut').textContent = Math.round(ox.value); $('#artOffsetYOut').textContent = Math.round(oy.value);
            renderPreviews();
        });
        const end = () => { if (dragging) { dragging = false; stage.classList.remove('is-dragging'); persist(); } };
        stage.addEventListener('pointerup', end); stage.addEventListener('pointercancel', end);
    }

    // Spin the wheel preview by dragging
    function attachWheelDrag() {
        const stage = $('#modelStage');
        let dragging = false, lastAngle = 0;
        const angleAt = e => { const r = stage.getBoundingClientRect(); return Math.atan2(e.clientY - (r.top + r.height / 2), e.clientX - (r.left + r.width / 2)) * 180 / Math.PI; };
        stage.addEventListener('pointerdown', e => { if (!isDiscs()) return; dragging = true; lastAngle = angleAt(e); stage.setPointerCapture(e.pointerId); e.preventDefault(); });
        stage.addEventListener('pointermove', e => { if (!dragging) return; const a = angleAt(e); state.wheelAngle += a - lastAngle; lastAngle = a; renderPreviews(); });
        const end = () => { dragging = false; };
        stage.addEventListener('pointerup', end); stage.addEventListener('pointercancel', end);
    }

    // ---------------------------------------------------------------
    // Order data
    // ---------------------------------------------------------------
    function buildOrder() {
        const f = form.elements;
        const m = readMeasurements();
        const geo = socketGeometry(m.socket);
        const dg = discGeometry(m.discs);
        return {
            schema: 'wrapsthetic.wrap-order',
            version: 2,
            createdAt: new Date().toISOString(),
            company: CONFIG.brandName,
            product: productType(),
            customer: {
                name: f.customerName.value.trim(), email: f.customerEmail.value.trim(), phone: f.customerPhone.value.trim(),
                postcode: f.customerPostcode.value.trim(), address: f.customerAddress.value.trim(), notes: f.customerNotes.value.trim()
            },
            prosthetic: isDiscs() ? null : {
                type: f.limbType.value, side: f.side.value, wrapSocket: f.wrapSocket.checked, wrapPylon: f.wrapPylon.checked,
                socketMaterial: f.socketMaterial.value, description: f.prostheticNotes.value.trim()
            },
            wheelchair: isDiscs() ? { wheelSize: f.wheelSize.value, quantity: parseInt(f.discQuantity.value, 10) || 2, mirrored: f.discMirror.value === 'mirrored', description: f.wheelchairNotes.value.trim() } : null,
            measurements: m,
            template: {
                seamAllowance_cm: CONFIG.seamAllowanceCm,
                discBleed_cm: CONFIG.discBleedCm,
                socket: geo ? { height_cm: geo.height, maxWidth_cm: round(geo.maxWidth, 2) } : null,
                pylon: m.pylon ? { height_cm: m.pylon.length_cm, width_cm: round(m.pylon.circumference_cm + CONFIG.seamAllowanceCm, 2) } : null,
                discs: dg ? { diameter_cm: dg.radius * 2, cut_diameter_cm: round(dg.radius * 2 + CONFIG.discBleedCm * 2, 2), hub_cm: dg.hub * 2, quantity: dg.quantity, mirrored: dg.mirrored } : null,
                note: 'Wrap widths are circumference plus seam allowance; the flat outline is a straight development. Disc templates include the bleed. Final fitting by Wrapsthetic.'
            },
            artwork: {
                fileName: state.artwork ? state.artwork.name : null, mimeType: state.artwork ? state.artwork.type : null, bytes: state.artwork ? state.artwork.size : null,
                width_px: state.artwork ? state.artwork.width : null, height_px: state.artwork ? state.artwork.height : null,
                finish: f.finish.value, placement: readPlacement(), notes: f.artworkNotes.value.trim()
            }
        };
    }

    const LIMB_LABELS = { transtibial: 'Below knee (transtibial)', transfemoral: 'Above knee (transfemoral)', transradial: 'Below elbow (transradial)', transhumeral: 'Above elbow (transhumeral)', other: 'Other' };
    const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

    function renderReview() {
        const o = buildOrder();
        const dl = pairs => '<dl>' + pairs.filter(p => p[1]).map(p => '<dt>' + esc(p[0]) + '</dt><dd>' + esc(p[1]) + '</dd>').join('') + '</dl>';
        const u = currentUnits();
        const len = cm => esc(fmtLen(cm));
        let html = '';
        html += '<div class="review-card"><h4>About you <button type="button" data-goto="1">Edit</button></h4>' +
            dl([['Name', o.customer.name], ['Email', o.customer.email], ['Phone', o.customer.phone], ['Postcode', o.customer.postcode], ['Address', o.customer.address], ['Notes', o.customer.notes]]) + '</div>';
        if (o.product === 'discs') {
            html += '<div class="review-card"><h4>Wheelchair wheel discs <button type="button" data-goto="2">Edit</button></h4>' +
                dl([['Wheel size', o.wheelchair.wheelSize], ['Quantity', o.wheelchair.quantity === 1 ? 'One disc' : 'A pair'], ['Pair layout', o.wheelchair.quantity > 1 ? (o.wheelchair.mirrored ? 'Mirrored, so both wheels read the same way from outside' : 'Identical') : ''], ['Description', o.wheelchair.description]]) + '</div>';
            html += '<div class="review-card"><h4>Measurements (' + esc(u) + ') <button type="button" data-goto="3">Edit</button></h4>' +
                dl([['Disc diameter', len(o.measurements.discs.diameter_cm)], ['Hub clearance', o.measurements.discs.hub_cm ? len(o.measurements.discs.hub_cm) : 'none'], ['Shape notes', o.measurements.notes]]) + '</div>';
        } else {
            html += '<div class="review-card"><h4>Your prosthetic <button type="button" data-goto="2">Edit</button></h4>' +
                dl([['Type', LIMB_LABELS[o.prosthetic.type] || ''], ['Side', o.prosthetic.side], ['Wrapping', [o.prosthetic.wrapSocket ? 'socket' : '', o.prosthetic.wrapPylon ? 'pylon' : ''].filter(Boolean).join(' and ')], ['Socket surface', o.prosthetic.socketMaterial], ['Description', o.prosthetic.description]]) + '</div>';
            let meas = '';
            if (o.measurements.socket) {
                meas += '<p><strong>Socket length:</strong> ' + len(o.measurements.socket.length_cm) + '</p>';
                meas += '<table class="review-table"><thead><tr><th>Point</th><th>From brim</th><th>All the way around</th></tr></thead><tbody>' +
                    o.measurements.socket.stations.map((s, i) => '<tr><td>' + String.fromCharCode(65 + i) + '</td><td>' + len(s.position_cm) + '</td><td>' + len(s.circumference_cm) + '</td></tr>').join('') + '</tbody></table>';
            }
            if (o.measurements.pylon) meas += '<p style="margin-top:0.75rem"><strong>Pylon:</strong> ' + len(o.measurements.pylon.length_cm) + ' long, ' + len(o.measurements.pylon.circumference_cm) + ' around</p>';
            meas += dl([['Leave clear', o.measurements.cutouts], ['Shape notes', o.measurements.notes]]);
            html += '<div class="review-card"><h4>Measurements (' + esc(u) + ') <button type="button" data-goto="3">Edit</button></h4>' + meas + '</div>';
        }
        const flat = buildTemplateSvg({ id: 'r' });
        const model = o.product === 'discs' ? buildWheelSvg('r', state.wheelAngle) : buildLimbSvg('r');
        html += '<div class="review-card"><h4>Artwork <button type="button" data-goto="4">Edit</button></h4>' +
            dl([['File', o.artwork.fileName || 'No artwork uploaded yet. ' + CONFIG.brandName + ' will get in touch about your design.'], ['Finish', o.artwork.finish], ['Layout', o.artwork.placement.fit + ', ' + o.artwork.placement.scale + '% size, rotated ' + o.artwork.placement.rotation + '°'], ['Notes', o.artwork.notes]]) +
            (flat ? '<div class="review-preview"><div>' + flat + '</div><div>' + (model || '') + '</div></div>' : '') + '</div>';
        $('#reviewSummary').innerHTML = html;
    }

    // ---------------------------------------------------------------
    // Order pack (zip, no dependencies)
    // ---------------------------------------------------------------
    const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
    function crc32(bytes) { let c = 0xFFFFFFFF; for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
    function makeZip(files) {
        const enc = new TextEncoder();
        const now = new Date();
        const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
        const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
        const locals = [], centrals = [];
        let offset = 0;
        files.forEach(f => {
            const name = enc.encode(f.name), data = f.data, crc = crc32(data);
            const lh = new DataView(new ArrayBuffer(30));
            lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
            lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true); lh.setUint32(14, crc, true);
            lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true); lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
            locals.push(new Uint8Array(lh.buffer), name, data);
            const ch = new DataView(new ArrayBuffer(46));
            ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true);
            ch.setUint16(12, dosTime, true); ch.setUint16(14, dosDate, true); ch.setUint32(16, crc, true);
            ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true); ch.setUint16(28, name.length, true);
            ch.setUint16(30, 0, true); ch.setUint16(32, 0, true); ch.setUint16(34, 0, true); ch.setUint16(36, 0, true); ch.setUint32(38, 0, true); ch.setUint32(42, offset, true);
            centrals.push(new Uint8Array(ch.buffer), name);
            offset += 30 + name.length + data.length;
        });
        const cdSize = centrals.reduce((n, a) => n + a.length, 0);
        const eocd = new DataView(new ArrayBuffer(22));
        eocd.setUint32(0, 0x06054b50, true); eocd.setUint16(4, 0, true); eocd.setUint16(6, 0, true);
        eocd.setUint16(8, files.length, true); eocd.setUint16(10, files.length, true); eocd.setUint32(12, cdSize, true); eocd.setUint32(16, offset, true); eocd.setUint16(20, 0, true);
        return new Blob(locals.concat(centrals, [new Uint8Array(eocd.buffer)]), { type: 'application/zip' });
    }

    function safeName(s) { return (s || 'wrap').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'wrap'; }

    function orderSheetHtml(order) {
        let product;
        if (order.product === 'discs') {
            const d = order.measurements.discs;
            product = '<h2>Wheelchair wheel discs</h2><p>Wheel size: ' + esc(order.wheelchair.wheelSize || 'not given') + '. Quantity: ' + order.wheelchair.quantity + (order.wheelchair.quantity > 1 ? (order.wheelchair.mirrored ? ' (mirrored pair)' : ' (identical pair)') : '') + '. ' + esc(order.wheelchair.description) + '</p>' +
                '<h2>Measurements (cm; customer entered in ' + esc(order.measurements.entered_in) + ')</h2><p>Disc diameter ' + d.diameter_cm + ' cm' + (d.hub_cm ? ', hub clearance ' + d.hub_cm + ' cm' : '') + '. Cut diameter including bleed: ' + order.template.discs.cut_diameter_cm + ' cm.</p>';
        } else {
            const rows = (order.measurements.socket ? order.measurements.socket.stations : []).map((s, i) => '<tr><td>' + String.fromCharCode(65 + i) + '</td><td>' + s.position_cm + ' cm</td><td>' + s.circumference_cm + ' cm</td></tr>').join('');
            product = '<h2>Prosthetic</h2><p>' + esc(LIMB_LABELS[order.prosthetic.type] || order.prosthetic.type) + ', ' + esc(order.prosthetic.side) + ' side. Wrap: ' + (order.prosthetic.wrapSocket ? 'socket ' : '') + (order.prosthetic.wrapPylon ? 'pylon' : '') + '. Surface: ' + esc(order.prosthetic.socketMaterial || 'not given') + '. ' + esc(order.prosthetic.description) + '</p>' +
                '<h2>Measurements (all in cm; customer entered in ' + esc(order.measurements.entered_in) + ')</h2>' +
                (order.measurements.socket ? '<p>Socket length ' + order.measurements.socket.length_cm + ' cm, measured every ' + order.measurements.socket.interval_cm + ' cm.</p><table><tr><th>Point</th><th>From brim</th><th>Circumference</th></tr>' + rows + '</table>' : '<p>Socket not being wrapped.</p>') +
                (order.measurements.pylon ? '<p>Pylon: ' + order.measurements.pylon.length_cm + ' cm long, ' + order.measurements.pylon.circumference_cm + ' cm circumference.</p>' : '') +
                '<p><strong>Leave clear:</strong> ' + esc(order.measurements.cutouts || 'nothing noted') + '</p>';
        }
        return '<!DOCTYPE html><html lang="en-GB"><head><meta charset="utf-8"><title>Wrap order - ' + esc(order.customer.name) + '</title>' +
            '<style>body{font-family:Roboto,Arial,sans-serif;max-width:800px;margin:2rem auto;padding:0 1rem;color:#111}table{border-collapse:collapse}td,th{border:1px solid #999;padding:4px 10px;text-align:left}h2{margin-top:1.5rem}</style></head><body>' +
            '<h1>Wrap order</h1><p>' + esc(order.company) + ' · created ' + esc(order.createdAt) + '</p>' +
            '<h2>Customer</h2><p>' + esc(order.customer.name) + '<br>' + esc(order.customer.email) + '<br>' + esc(order.customer.phone) + '<br>' + esc(order.customer.address).replace(/\n/g, '<br>') + ' ' + esc(order.customer.postcode) + '</p><p>' + esc(order.customer.notes) + '</p>' +
            product + '<p><strong>Shape notes:</strong> ' + esc(order.measurements.notes || 'none') + '</p>' +
            '<h2>Artwork</h2><p>' + esc(order.artwork.fileName || 'No artwork supplied') + '. Finish: ' + esc(order.artwork.finish) + '. Layout: ' + esc(order.artwork.placement.fit) + ', ' + order.artwork.placement.scale + '% size, offset ' + order.artwork.placement.offsetX + '/' + order.artwork.placement.offsetY + ', rotated ' + order.artwork.placement.rotation + '°, background ' + esc(order.artwork.placement.background) + '.</p><p>' + esc(order.artwork.notes) + '</p>' +
            '<p>See template.svg (true scale, 1 unit = 1 mm) and the original artwork file in this pack.</p></body></html>';
    }

    async function buildPack() {
        const order = buildOrder();
        const enc = new TextEncoder();
        const files = [
            { name: 'order.json', data: enc.encode(JSON.stringify(order, null, 2)) },
            { name: 'order-sheet.html', data: enc.encode(orderSheetHtml(order)) }
        ];
        const svg = buildTemplateSvg({ forExport: true, id: 'x' });
        if (svg) files.push({ name: 'template.svg', data: enc.encode(svg) });
        if (state.artwork) {
            const buf = new Uint8Array(await state.artwork.file.arrayBuffer());
            const ext = state.artwork.name.includes('.') ? state.artwork.name.slice(state.artwork.name.lastIndexOf('.')) : '';
            files.push({ name: 'artwork-original' + ext, data: buf });
        }
        return { order, blob: makeZip(files), svg };
    }

    async function downloadPack() {
        const { order, blob } = await buildPack();
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'wrap-order-' + safeName(order.customer.name) + '-' + order.createdAt.slice(0, 10) + '.zip';
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    }

    // ---------------------------------------------------------------
    // Submit
    // ---------------------------------------------------------------
    async function submitOrder() {
        const btn = $('#submitOrder');
        btn.disabled = true; btn.textContent = 'Sending…';
        setStatus('Sending your wrap request…', 'info');
        try {
            const { order, blob, svg } = await buildPack();
            const fd = new FormData();
            fd.append('order', JSON.stringify(order));
            if (svg) fd.append('template', new Blob([svg], { type: 'image/svg+xml' }), 'template.svg');
            if (state.artwork) fd.append('artwork', state.artwork.file, state.artwork.name);
            fd.append('pack', blob, 'order-pack.zip');
            const res = await fetch(CONFIG.submitUrl, { method: 'POST', body: fd });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            let ref = '';
            try { const j = await res.json(); ref = j.reference || j.id || ''; } catch (e) { /* non-JSON response is fine */ }
            showDone('We\'ve sent everything to ' + CONFIG.brandName + (ref ? ' (reference ' + ref + ')' : '') + '. You\'ll get a confirmation at ' + order.customer.email + ' and we\'ll be in touch to confirm your wrap.');
            clearPersisted();
        } catch (err) {
            const order = buildOrder();
            const subject = encodeURIComponent('Wrap request from ' + order.customer.name);
            const body = encodeURIComponent('Hi,\n\nPlease find my wrap order pack attached (downloaded from the ' + CONFIG.brandName + ' configurator).\n\nName: ' + order.customer.name + '\nPhone: ' + order.customer.phone + '\n\nThanks!');
            setStatus('We couldn\'t reach ' + CONFIG.brandName + '\'s server just now. Please download your order pack below and email it to ' + CONFIG.contactEmail + '. Nothing you entered has been lost.', 'error');
            status.innerHTML += ' <a href="mailto:' + CONFIG.contactEmail + '?subject=' + subject + '&body=' + body + '">Open an email to ' + CONFIG.brandName + '</a>.';
        } finally {
            btn.disabled = false; btn.innerHTML = 'Send to&nbsp;' + esc(CONFIG.brandName);
        }
    }

    function showDone(message) {
        steps.forEach(s => s.classList.remove('is-active'));
        stepper.hidden = true;
        clearStatus();
        $('#doneMessage').textContent = message;
        $('#doneStep').hidden = false;
        $('#doneStep').classList.add('is-active');
        $('#doneStep h3').setAttribute('tabindex', '-1');
        $('#doneStep h3').focus();
    }

    // ---------------------------------------------------------------
    // Wizard navigation and validation
    // ---------------------------------------------------------------
    function setStatus(msg, kind) { status.textContent = msg; status.className = 'status is-' + kind; }
    function clearStatus() { status.textContent = ''; status.className = 'status'; }

    function fieldError(el, msg) {
        const field = el.closest('.field') || el.closest('.station') || el.parentElement;
        let err = field.querySelector('.field-error');
        if (msg) {
            if (!err) { err = document.createElement('p'); err.className = 'field-error'; field.appendChild(err); }
            err.textContent = msg; field.classList.add('has-error'); el.setAttribute('aria-invalid', 'true');
        } else {
            if (err) err.remove(); field.classList.remove('has-error'); el.removeAttribute('aria-invalid');
        }
    }

    function validateStep(n) {
        const f = form.elements;
        const errors = [];
        const need = (el, ok, msg) => { fieldError(el, ok ? '' : msg); if (!ok) errors.push(el); };
        const inches = currentUnits() === 'in';
        if (n === 1) {
            need(f.customerName, f.customerName.value.trim().length > 1, 'Please tell us your name.');
            need(f.customerEmail, /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.customerEmail.value.trim()), 'Please enter a valid email address so we can reply.');
        }
        if (n === 2) {
            need(f.product[0], !!f.product.value, 'Please choose what you\'d like wrapped.');
            if (!isDiscs()) {
                need(f.limbType[0], !!f.limbType.value, 'Please choose the type of prosthetic.');
                need(f.side[0], !!f.side.value, 'Please choose a side.');
                need(f.wrapSocket, f.wrapSocket.checked || f.wrapPylon.checked, 'Choose at least one thing to wrap.');
            } else { fieldError(f.limbType[0], ''); fieldError(f.side[0], ''); fieldError(f.wrapSocket, ''); }
        }
        if (n === 3) {
            if (isDiscs()) {
                const D = parseFloat(f.discDiameter.value), minD = inches ? 8 : 20, maxD = inches ? 32 : 80;
                need(f.discDiameter, isFinite(D) && D >= minD && D <= maxD, 'Please enter the disc diameter (between ' + minD + ' and ' + maxD + ' ' + currentUnits() + ').');
                const H = f.discHub.value === '' ? 0 : parseFloat(f.discHub.value);
                need(f.discHub, isFinite(H) && H >= 0 && (!isFinite(D) || H < D / 2), 'The hub clearance must be smaller than half the disc.');
            } else {
                if (f.wrapSocket.checked) {
                    const L = parseFloat(f.socketLength.value), minL = inches ? 2 : 5, maxL = inches ? 30 : 75;
                    need(f.socketLength, isFinite(L) && L >= minL && L <= maxL, 'Please enter the socket length (between ' + minL + ' and ' + maxL + ' ' + currentUnits() + ').');
                    $$('[data-station]', form).forEach(input => {
                        const v = parseFloat(input.value), minC = inches ? 3 : 8, maxC = inches ? 40 : 100;
                        need(input, isFinite(v) && v >= minC && v <= maxC, 'Needed (' + minC + ' to ' + maxC + ' ' + currentUnits() + ').');
                    });
                }
                if (f.wrapPylon.checked) {
                    need(f.pylonLength, parseFloat(f.pylonLength.value) > 0, 'Please enter the pylon length to wrap.');
                    need(f.pylonCircumference, parseFloat(f.pylonCircumference.value) > 0, 'Please enter the distance around the pylon.');
                }
            }
        }
        if (n === 5) need(f.consent, f.consent.checked, 'Please tick the box so we can process your order.');
        const li = $('.stepper li[data-step="' + n + '"]');
        li.classList.toggle('has-error', errors.length > 0);
        if (errors.length) {
            setStatus('Please check the highlighted fields before continuing.', 'error');
            errors[0].focus();
            return false;
        }
        li.classList.add('is-complete');
        clearStatus();
        return true;
    }

    function goTo(n, skipValidation) {
        n = Math.max(1, Math.min(5, n));
        if (!skipValidation && n > state.current) {
            for (let i = state.current; i < n; i++) { if (!validateStep(i)) { if (i !== state.current) showStep(i); return; } }
        }
        showStep(n);
    }

    function showStep(n) {
        state.current = n;
        steps.forEach(s => s.classList.toggle('is-active', parseInt(s.dataset.step, 10) === n));
        $$('li', stepper).forEach(li => li.classList.toggle('is-current', parseInt(li.dataset.step, 10) === n));
        applyProductVisibility();
        if (n === 3) rebuildStations();
        if (n === 4) { renderPreviews(); if (state.three) state.three.resize(); }
        if (n !== 4) stopSpin();
        if (n === 5) renderReview();
        const heading = $('.step.is-active legend h3');
        if (heading) { heading.setAttribute('tabindex', '-1'); heading.focus({ preventScroll: true }); }
        const top = $('#designer').getBoundingClientRect().top + window.pageYOffset - 16;
        window.scrollTo({ top, behavior: reducedMotion ? 'auto' : 'smooth' });
        persist();
    }

    // ---------------------------------------------------------------
    // Persistence (form fields only; artwork must be re-uploaded)
    // ---------------------------------------------------------------
    function persist() {
        try {
            const data = { step: state.current, units: currentUnits(), fields: {}, stations: $$('[data-station]', form).map(i => i.value) };
            Array.from(form.elements).forEach(el => {
                if (!el.name || el.type === 'file' || el.dataset.station !== undefined || el.name === 'turn' || el.name === 'spin') return;
                if (el.type === 'checkbox') data.fields[el.name] = el.checked;
                else if (el.type === 'radio') { if (el.checked) data.fields[el.name] = el.value; }
                else data.fields[el.name] = el.value;
            });
            localStorage.setItem(CONFIG.storageKey, JSON.stringify(data));
        } catch (e) { /* storage unavailable: fine */ }
    }
    function restore() {
        let data = null;
        try { data = JSON.parse(localStorage.getItem(CONFIG.storageKey) || 'null'); } catch (e) { return; }
        if (!data || !data.fields) return;
        Object.keys(data.fields).forEach(name => {
            const el = form.elements[name];
            if (!el) return;
            const v = data.fields[name];
            if (el instanceof RadioNodeList) { el.value = v; }
            else if (el.type === 'checkbox') el.checked = !!v;
            else if (el.type !== 'file') el.value = v;
        });
        if (data.units === 'in') { lastUnits = 'in'; $$('[data-unit]').forEach(el => { el.textContent = 'in'; }); }
        populateIntervals();
        if (data.fields.stationInterval) form.elements.stationInterval.value = data.fields.stationInterval;
        rebuildStations();
        $$('[data-station]', form).forEach((i, idx) => { if (data.stations && data.stations[idx] !== undefined) i.value = data.stations[idx]; });
        if (Object.keys(data.fields).some(k => data.fields[k])) setStatus('Welcome back. We restored what you entered last time. If you uploaded artwork, please choose the file again in step 4.', 'info');
        if (data.step > 1) showStep(data.step);
    }
    function clearPersisted() { try { localStorage.removeItem(CONFIG.storageKey); } catch (e) { /* ignore */ } }

    // ---------------------------------------------------------------
    // Wiring
    // ---------------------------------------------------------------
    populateIntervals();

    form.addEventListener('click', e => {
        const t = e.target.closest('button');
        if (!t) return;
        if (t.hasAttribute('data-next')) goTo(state.current + 1);
        else if (t.hasAttribute('data-prev')) goTo(state.current - 1, true);
        else if (t.dataset.goto) goTo(parseInt(t.dataset.goto, 10), true);
    });
    stepper.addEventListener('click', e => { const b = e.target.closest('[data-goto]'); if (b) goTo(parseInt(b.dataset.goto, 10)); });

    form.addEventListener('submit', e => { e.preventDefault(); if (validateStep(5)) submitOrder(); });
    $('#downloadPack').addEventListener('click', downloadPack);
    $('#downloadPackDone').addEventListener('click', downloadPack);
    $('#printOrder').addEventListener('click', () => { renderReview(); window.print(); });
    $('#startAgain').addEventListener('click', () => { clearPersisted(); window.location.reload(); });

    $$('input[name="product"]', form).forEach(r => r.addEventListener('change', () => { applyProductVisibility(); renderPreviews(); }));
    form.elements.socketLength.addEventListener('input', () => rebuildStations());
    form.elements.stationInterval.addEventListener('change', () => rebuildStations());
    $$('input[name="units"]', form).forEach(r => r.addEventListener('change', onUnitsChange));
    form.elements.wrapPylon.addEventListener('change', () => { applyProductVisibility(); renderPreviews(); });
    form.elements.wrapSocket.addEventListener('change', () => { applyProductVisibility(); renderPreviews(); });
    $('#stations').addEventListener('input', () => { checkStationSanity(); renderPreviews(); });
    ['pylonLength', 'pylonCircumference', 'discDiameter', 'discHub'].forEach(n => form.elements[n].addEventListener('input', renderPreviews));
    $$('input[name="discMirror"], input[name="discQuantity"], input[name="limbType"]', form).forEach(r => r.addEventListener('change', renderPreviews));

    // Artwork controls
    const artFile = $('#artworkFile'), dropzone = $('#dropzone');
    artFile.addEventListener('change', () => loadArtwork(artFile.files[0]));
    ['dragenter', 'dragover'].forEach(ev => dropzone.addEventListener(ev, e => { e.preventDefault(); dropzone.classList.add('is-over'); }));
    ['dragleave', 'drop'].forEach(ev => dropzone.addEventListener(ev, e => { e.preventDefault(); dropzone.classList.remove('is-over'); }));
    dropzone.addEventListener('drop', e => { const f = e.dataTransfer.files && e.dataTransfer.files[0]; if (f) loadArtwork(f); });

    const sliders = { artScale: v => v + '%', artOffsetX: v => v, artOffsetY: v => v, artRotation: v => v + '°' };
    Object.keys(sliders).forEach(name => {
        const el = form.elements[name], out = $('#' + name + 'Out');
        const update = () => { out.textContent = sliders[name](el.value); };
        el.addEventListener('input', () => { update(); renderPreviews(); });
        update();
    });
    $$('input[name="fit"], input[name="finish"]', form).forEach(r => r.addEventListener('change', renderPreviews));
    form.elements.artBackground.addEventListener('input', renderPreviews);
    $('#resetArt').addEventListener('click', () => {
        form.elements.artScale.value = 100; form.elements.artOffsetX.value = 0; form.elements.artOffsetY.value = 0; form.elements.artRotation.value = 0;
        Object.keys(sliders).forEach(name => { $('#' + name + 'Out').textContent = sliders[name](form.elements[name].value); });
        state.wheelAngle = 0;
        renderPreviews(); persist();
    });
    form.elements.turn.addEventListener('input', () => { $('#turnOut').textContent = form.elements.turn.value + '°'; if (state.three) { stopSpin(); state.three.rotation = parseFloat(form.elements.turn.value) * Math.PI / 180; threeRender(); } });
    $('#turnOut').textContent = form.elements.turn.value + '°';
    form.elements.spin.addEventListener('change', () => { if (form.elements.spin.checked) startSpin(); else stopSpin(); });
    attachFlatDrag();
    attachWheelDrag();

    form.addEventListener('input', persist);
    form.addEventListener('change', persist);

    applyProductVisibility();
    restore();
    renderPreviews();
})();
