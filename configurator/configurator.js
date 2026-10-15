/* Wrapsthetic Configurator - client-side application
   Static, dependency-free. See configurator/README.md for configuration and the order data format. */
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
        seamAllowanceCm: 1.0,                     // Extra width added to each template for the overlap seam
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

    const state = {
        current: 1,
        artwork: null,   // { file, name, type, width, height, previewDataUrl }
        visited: new Set([1])
    };

    // ---------------------------------------------------------------
    // Branding
    // ---------------------------------------------------------------
    $$('[data-brand-name]').forEach(el => { el.textContent = CONFIG.brandName; });
    $$('[data-brand-email]').forEach(el => { el.href = 'mailto:' + CONFIG.contactEmail; });
    $$('[data-brand-link]').forEach(el => { el.href = CONFIG.websiteUrl; });
    document.title = CONFIG.brandName + ' Configurator | Design your prosthetic wrap';

    // ---------------------------------------------------------------
    // Units
    // ---------------------------------------------------------------
    function currentUnits() { return (form.elements.units.value || 'cm'); }
    function toCm(value) { const v = parseFloat(value); if (!isFinite(v)) return null; return currentUnits() === 'in' ? v * CM_PER_IN : v; }
    function fromCm(cm, units) { return (units || currentUnits()) === 'in' ? cm / CM_PER_IN : cm; }
    function round(v, dp) { const f = Math.pow(10, dp === undefined ? 1 : dp); return Math.round(v * f) / f; }
    function fmtLen(cm) {
        const u = currentUnits();
        return round(fromCm(cm, u), u === 'in' ? 2 : 1) + ' ' + u;
    }

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
        ['socketLength', 'pylonLength', 'pylonCircumference'].forEach(name => {
            const el = form.elements[name];
            if (el.value !== '') el.value = round(parseFloat(el.value) * factor, dp);
        });
        $$('.station input', form).forEach(el => { if (el.value !== '') el.value = round(parseFloat(el.value) * factor, dp); });
        $$('[data-unit]').forEach(el => { el.textContent = u; });
        lastUnits = u;
        populateIntervals();
        rebuildStations(true);
        persist();
    }

    // ---------------------------------------------------------------
    // Measurement stations
    // ---------------------------------------------------------------
    function stationPositions(length, interval) {
        // Positions in display units from the brim (0) to the bottom (length).
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

        // Preserve values already typed, by index.
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
        const inputs = $$('[data-station]', form);
        let prev = null;
        inputs.forEach(input => {
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
        // Returns [{position_cm, circumference_cm}] sorted from brim down.
        return $$('[data-station]', form).map(input => ({
            position_cm: round(toCm(input.dataset.pos) || 0, 2),
            circumference_cm: round(toCm(input.value) || 0, 2)
        })).filter(s => s.circumference_cm > 0);
    }

    function readMeasurements() {
        const wrapSocket = form.elements.wrapSocket.checked;
        const wrapPylon = form.elements.wrapPylon.checked;
        const socket = wrapSocket ? {
            length_cm: round(toCm(form.elements.socketLength.value) || 0, 2),
            interval_cm: round(toCm(form.elements.stationInterval.value) || 0, 2),
            stations: readStations()
        } : null;
        const pylon = wrapPylon ? {
            length_cm: round(toCm(form.elements.pylonLength.value) || 0, 2),
            circumference_cm: round(toCm(form.elements.pylonCircumference.value) || 0, 2)
        } : null;
        return { entered_in: currentUnits(), socket, pylon, cutouts: form.elements.cutouts.value.trim(), notes: form.elements.measureNotes.value.trim() };
    }

    // ---------------------------------------------------------------
    // Geometry: flat template and silhouette
    // ---------------------------------------------------------------
    function socketGeometry(socket) {
        if (!socket || !socket.stations || socket.stations.length < 2) return null;
        const seam = CONFIG.seamAllowanceCm;
        const stations = socket.stations.slice().sort((a, b) => a.position_cm - b.position_cm);
        const maxWidth = Math.max.apply(null, stations.map(s => s.circumference_cm + seam));
        const height = stations[stations.length - 1].position_cm;
        return { stations, seam, maxWidth, height };
    }

    function smoothPath(leftPts, rightPts) {
        // Closed outline through left side (top to bottom) and right side (bottom to top) using Catmull-Rom smoothing.
        const pts = leftPts.concat(rightPts);
        if (pts.length < 3) return '';
        let d = 'M' + pts[0][0] + ',' + pts[0][1];
        const seg = (p0, p1, p2, p3) => {
            const c1x = p1[0] + (p2[0] - p0[0]) / 6, c1y = p1[1] + (p2[1] - p0[1]) / 6;
            const c2x = p2[0] - (p3[0] - p1[0]) / 6, c2y = p2[1] - (p3[1] - p1[1]) / 6;
            return ' C' + r2(c1x) + ',' + r2(c1y) + ' ' + r2(c2x) + ',' + r2(c2y) + ' ' + r2(p2[0]) + ',' + r2(p2[1]);
        };
        // Smooth each side separately so the top and bottom edges stay straight.
        const side = (arr) => {
            let s = '';
            for (let i = 0; i < arr.length - 1; i++) {
                const p0 = arr[Math.max(0, i - 1)], p1 = arr[i], p2 = arr[i + 1], p3 = arr[Math.min(arr.length - 1, i + 2)];
                s += seg(p0, p1, p2, p3);
            }
            return s;
        };
        d += side(leftPts);
        d += ' L' + r2(rightPts[0][0]) + ',' + r2(rightPts[0][1]);
        d += side(rightPts);
        d += ' Z';
        return d;
    }
    function r2(v) { return Math.round(v * 100) / 100; }

    function flatOutline(geo, cx) {
        const left = geo.stations.map(s => [cx - (s.circumference_cm + geo.seam) / 2 * SCALE, s.position_cm * SCALE]);
        const right = geo.stations.slice().reverse().map(s => [cx + (s.circumference_cm + geo.seam) / 2 * SCALE, s.position_cm * SCALE]);
        return smoothPath(left, right);
    }

    function silhouetteOutline(geo, cx) {
        const left = geo.stations.map(s => [cx - s.circumference_cm / (2 * Math.PI) * SCALE, s.position_cm * SCALE]);
        const right = geo.stations.slice().reverse().map(s => [cx + s.circumference_cm / (2 * Math.PI) * SCALE, s.position_cm * SCALE]);
        return smoothPath(left, right);
    }

    // ---------------------------------------------------------------
    // Artwork
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

    function artworkGroup(bbox, idSuffix) {
        // Returns SVG markup that paints the artwork over the bounding box {x,y,w,h} per the user's placement.
        const art = state.artwork;
        const p = readPlacement();
        let inner = '<rect x="' + bbox.x + '" y="' + bbox.y + '" width="' + bbox.w + '" height="' + bbox.h + '" fill="' + p.background + '"/>';
        if (!art) return inner;
        const cx = bbox.x + bbox.w / 2, cy = bbox.y + bbox.h / 2;
        const s = p.scale / 100;
        const tx = p.offsetX / 100 * bbox.w / 2, ty = p.offsetY / 100 * bbox.h / 2;
        const transform = 'translate(' + r2(cx + tx) + ',' + r2(cy + ty) + ') rotate(' + p.rotation + ') scale(' + s + ') translate(' + r2(-cx) + ',' + r2(-cy) + ')';
        if (p.fit === 'tile') {
            const tileW = bbox.w / 3, tileH = tileW * art.height / art.width;
            const pid = 'tile' + idSuffix;
            inner += '<defs><pattern id="' + pid + '" patternUnits="userSpaceOnUse" x="' + bbox.x + '" y="' + bbox.y + '" width="' + r2(tileW) + '" height="' + r2(tileH) + '" patternTransform="' + transform + '">' +
                '<image href="' + art.previewDataUrl + '" width="' + r2(tileW) + '" height="' + r2(tileH) + '" preserveAspectRatio="none"/></pattern></defs>' +
                '<rect x="' + (bbox.x - bbox.w) + '" y="' + (bbox.y - bbox.h) + '" width="' + bbox.w * 3 + '" height="' + bbox.h * 3 + '" fill="url(#' + pid + ')"/>';
        } else {
            const par = p.fit === 'cover' ? 'xMidYMid slice' : 'xMidYMid meet';
            inner += '<image href="' + art.previewDataUrl + '" x="' + bbox.x + '" y="' + bbox.y + '" width="' + bbox.w + '" height="' + bbox.h + '" preserveAspectRatio="' + par + '" transform="' + transform + '"/>';
        }
        return inner;
    }

    function buildFlatSvg(opts) {
        // opts.forExport: true for the real-scale file sent to Wrapsthetic (labels, scale bar, mm units).
        const m = readMeasurements();
        const geo = socketGeometry(m.socket);
        const pylon = m.pylon && m.pylon.length_cm > 0 && m.pylon.circumference_cm > 0 ? m.pylon : null;
        if (!geo && !pylon) return null;
        const forExport = !!(opts && opts.forExport);
        const margin = forExport ? 8 * SCALE : 1.5 * SCALE;
        const gap = 3 * SCALE;
        const labelCol = forExport ? 9 * SCALE : 0;
        let x = margin;
        let parts = '';
        let defs = '';
        let totalH = 0;
        const uid = (opts && opts.id) || 'f';

        if (geo) {
            const w = geo.maxWidth * SCALE, h = geo.height * SCALE;
            const cx = x + labelCol + w / 2;
            const bbox = { x: x + labelCol, y: margin, w: w, h: h };
            const d = flatOutline(geo, cx).replace(/(\d),(-?[\d.]+)/g, (s, a, b) => a + ',' + r2(parseFloat(b) + margin));
            defs += '<clipPath id="clipSocket' + uid + '"><path d="' + d + '"/></clipPath>';
            parts += '<g clip-path="url(#clipSocket' + uid + ')">' + artworkGroup(bbox, 'S' + uid) + '</g>';
            parts += '<path d="' + d + '" fill="none" stroke="#111" stroke-width="' + (forExport ? 2 : 3) + '"/>';
            // Seam line (left edge offset by the seam allowance) as a dotted guide.
            parts += '<line x1="' + r2(cx - w / 2 + geo.seam * SCALE) + '" y1="' + margin + '" x2="' + r2(cx - w / 2 + geo.seam * SCALE) + '" y2="' + r2(margin + h) + '" stroke="#111" stroke-dasharray="6 6" stroke-width="2" opacity="0.6"/>';
            if (forExport) {
                parts += '<text x="' + bbox.x + '" y="' + (margin - 6 * SCALE) + '" font-family="Roboto, Arial, sans-serif" font-size="' + (4 * SCALE) + '" font-weight="700" fill="#111">Socket wrap (' + geo.height + ' cm tall, max ' + round(geo.maxWidth, 1) + ' cm wide incl. ' + geo.seam + ' cm seam)</text>';
                geo.stations.forEach((s, i) => {
                    const y = margin + s.position_cm * SCALE;
                    parts += '<line x1="' + x + '" y1="' + y + '" x2="' + r2(cx - (s.circumference_cm + geo.seam) / 2 * SCALE) + '" y2="' + y + '" stroke="#c2410c" stroke-width="1" stroke-dasharray="3 3"/>';
                    parts += '<text x="' + x + '" y="' + (y - 4) + '" font-family="Roboto, Arial, sans-serif" font-size="' + (2.6 * SCALE) + '" fill="#c2410c">' + String.fromCharCode(65 + i) + ' ' + s.position_cm + ' cm: ' + s.circumference_cm + ' cm around</text>';
                });
            }
            x += labelCol + w + gap;
            totalH = Math.max(totalH, h);
        }
        if (pylon) {
            const w = (pylon.circumference_cm + CONFIG.seamAllowanceCm) * SCALE, h = pylon.length_cm * SCALE;
            const bbox = { x: x, y: margin, w: w, h: h };
            defs += '<clipPath id="clipPylon' + uid + '"><rect x="' + x + '" y="' + margin + '" width="' + r2(w) + '" height="' + r2(h) + '"/></clipPath>';
            parts += '<g clip-path="url(#clipPylon' + uid + ')">' + artworkGroup(bbox, 'P' + uid) + '</g>';
            parts += '<rect x="' + x + '" y="' + margin + '" width="' + r2(w) + '" height="' + r2(h) + '" fill="none" stroke="#111" stroke-width="' + (forExport ? 2 : 3) + '"/>';
            parts += '<line x1="' + r2(x + CONFIG.seamAllowanceCm * SCALE) + '" y1="' + margin + '" x2="' + r2(x + CONFIG.seamAllowanceCm * SCALE) + '" y2="' + r2(margin + h) + '" stroke="#111" stroke-dasharray="6 6" stroke-width="2" opacity="0.6"/>';
            if (forExport) {
                parts += '<text x="' + x + '" y="' + (margin - 6 * SCALE) + '" font-family="Roboto, Arial, sans-serif" font-size="' + (4 * SCALE) + '" font-weight="700" fill="#111">Pylon wrap (' + pylon.length_cm + ' cm x ' + round(pylon.circumference_cm + CONFIG.seamAllowanceCm, 1) + ' cm incl. seam)</text>';
            }
            x += w + gap;
            totalH = Math.max(totalH, h);
        }
        let totalW = x - gap + margin;
        let totalHeight = totalH + margin * 2;
        if (forExport) {
            // 10 cm scale bar.
            const y = totalHeight - margin / 2;
            parts += '<line x1="' + margin + '" y1="' + y + '" x2="' + (margin + 10 * SCALE) + '" y2="' + y + '" stroke="#111" stroke-width="3"/>' +
                '<text x="' + margin + '" y="' + (y - 8) + '" font-family="Roboto, Arial, sans-serif" font-size="' + (3 * SCALE) + '" fill="#111">10 cm (1 SVG unit = 1 mm, print at 100%)</text>';
        }
        const sizeAttrs = forExport ? ' width="' + r2(totalW) + 'mm" height="' + r2(totalHeight) + 'mm"' : '';
        return '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ' + r2(totalW) + ' ' + r2(totalHeight) + '"' + sizeAttrs + ' role="img" aria-label="Flat wrap template">' +
            (forExport ? '<rect width="100%" height="100%" fill="#fff"/>' : '') + '<defs>' + defs + '</defs>' + parts + '</svg>';
    }

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
        const d = silhouetteOutline(geo, cx).replace(/(\d),(-?[\d.]+)/g, (s, a, b) => a + ',' + r2(parseFloat(b) + margin));
        const flatW = geo.maxWidth * SCALE;
        const bbox = { x: cx - flatW / 2, y: margin, w: flatW, h: geo.height * SCALE };
        const squeeze = 2 / Math.PI; // front view shows the central half of the wrap, foreshortened
        let svg = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ' + r2(W) + ' ' + r2(H) + '" role="img" aria-label="Preview of the wrap on the limb"><defs>' +
            '<clipPath id="clipLimb' + uid + '"><path d="' + d + '"/></clipPath>' +
            '<linearGradient id="shade' + uid + '" x1="0" x2="1"><stop offset="0" stop-color="#000" stop-opacity="0.35"/><stop offset="0.25" stop-color="#fff" stop-opacity="0.05"/><stop offset="0.5" stop-color="#fff" stop-opacity="0.18"/><stop offset="0.8" stop-color="#000" stop-opacity="0.1"/><stop offset="1" stop-color="#000" stop-opacity="0.45"/></linearGradient>' +
            '</defs>';
        svg += '<g clip-path="url(#clipLimb' + uid + ')"><g transform="translate(' + r2(cx) + ',0) scale(' + r2(squeeze) + ',1) translate(' + r2(-cx) + ',0)">' + artworkGroup(bbox, 'L' + uid) + '</g>' +
            '<path d="' + d + '" fill="url(#shade' + uid + ')"/></g>';
        svg += '<path d="' + d + '" fill="none" stroke="#111" stroke-width="2.5"/>';
        // Pylon
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
        svg += '<rect x="' + r2(pbox.x) + '" y="' + py + '" width="' + r2(pylonW) + '" height="' + r2(pylonH) + '" rx="' + r2(pylonW / 6) + '" fill="none" stroke="#111" stroke-width="2"/>';
        svg += '</svg>';
        return svg;
    }

    function renderPreviews() {
        const flat = buildFlatSvg({ id: 'p' });
        const limb = buildLimbSvg('p');
        const flatStage = $('#flatStage'), limbStage = $('#limbStage'), hint = $('#previewHint');
        flatStage.innerHTML = flat || '<p class="preview-empty">Add your measurements in step 3 to see the template.</p>';
        limbStage.innerHTML = limb || '<p class="preview-empty">Socket measurements needed for this preview.</p>';
        if (!flat) hint.textContent = 'Enter your socket measurements in step 3 to see the template shape.';
        else if (!state.artwork) hint.textContent = 'Template ready. Upload an image to see it on the wrap.';
        else hint.textContent = 'Use the sliders to position your artwork. ' + CONFIG.brandName + ' sees exactly this placement.';
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

    // ---------------------------------------------------------------
    // Order data
    // ---------------------------------------------------------------
    function buildOrder() {
        const f = form.elements;
        const m = readMeasurements();
        const geo = socketGeometry(m.socket);
        return {
            schema: 'wrapsthetic.wrap-order',
            version: 1,
            createdAt: new Date().toISOString(),
            company: CONFIG.brandName,
            customer: {
                name: f.customerName.value.trim(),
                email: f.customerEmail.value.trim(),
                phone: f.customerPhone.value.trim(),
                postcode: f.customerPostcode.value.trim(),
                address: f.customerAddress.value.trim(),
                notes: f.customerNotes.value.trim()
            },
            prosthetic: {
                type: f.limbType.value,
                side: f.side.value,
                wrapSocket: f.wrapSocket.checked,
                wrapPylon: f.wrapPylon.checked,
                socketMaterial: f.socketMaterial.value,
                description: f.prostheticNotes.value.trim()
            },
            measurements: m,
            template: {
                seamAllowance_cm: CONFIG.seamAllowanceCm,
                socket: geo ? { height_cm: geo.height, maxWidth_cm: round(geo.maxWidth, 2) } : null,
                pylon: m.pylon ? { height_cm: m.pylon.length_cm, width_cm: round(m.pylon.circumference_cm + CONFIG.seamAllowanceCm, 2) } : null,
                note: 'Widths are circumference plus seam allowance. Flat outline is a straight development; final fitting by Wrapsthetic.'
            },
            artwork: state.artwork ? {
                fileName: state.artwork.name, mimeType: state.artwork.type, bytes: state.artwork.size,
                width_px: state.artwork.width, height_px: state.artwork.height,
                finish: f.finish.value, placement: readPlacement(), notes: f.artworkNotes.value.trim()
            } : { fileName: null, finish: f.finish.value, placement: readPlacement(), notes: f.artworkNotes.value.trim() }
        };
    }

    const LIMB_LABELS = { transtibial: 'Below knee (transtibial)', transfemoral: 'Above knee (transfemoral)', transradial: 'Below elbow (transradial)', transhumeral: 'Above elbow (transhumeral)', other: 'Other' };

    function renderReview() {
        const o = buildOrder();
        const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
        const dl = pairs => '<dl>' + pairs.filter(p => p[1]).map(p => '<dt>' + esc(p[0]) + '</dt><dd>' + esc(p[1]) + '</dd>').join('') + '</dl>';
        const u = currentUnits();
        const len = cm => esc(fmtLen(cm));
        let html = '';
        html += '<div class="review-card"><h4>About you <button type="button" data-goto="1">Edit</button></h4>' +
            dl([['Name', o.customer.name], ['Email', o.customer.email], ['Phone', o.customer.phone], ['Postcode', o.customer.postcode], ['Address', o.customer.address], ['Notes', o.customer.notes]]) + '</div>';
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
        const flat = buildFlatSvg({ id: 'r' });
        const limb = buildLimbSvg('r');
        html += '<div class="review-card"><h4>Artwork <button type="button" data-goto="4">Edit</button></h4>' +
            dl([['File', o.artwork.fileName || 'No artwork uploaded yet. ' + CONFIG.brandName + ' will get in touch about your design.'], ['Finish', o.artwork.finish], ['Layout', o.artwork.placement.fit + ', ' + o.artwork.placement.scale + '% size, rotated ' + o.artwork.placement.rotation + '°'], ['Notes', o.artwork.notes]]) +
            (flat ? '<div class="review-preview"><div>' + flat + '</div><div>' + (limb || '') + '</div></div>' : '') + '</div>';
        $('#reviewSummary').innerHTML = html;
    }

    // ---------------------------------------------------------------
    // Order pack (zip, no dependencies)
    // ---------------------------------------------------------------
    const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
    function crc32(bytes) { let c = 0xFFFFFFFF; for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
    function makeZip(files) {
        // files: [{name, data: Uint8Array}] -> Blob (store method)
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
        const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
        const rows = (order.measurements.socket ? order.measurements.socket.stations : []).map((s, i) => '<tr><td>' + String.fromCharCode(65 + i) + '</td><td>' + s.position_cm + ' cm</td><td>' + s.circumference_cm + ' cm</td></tr>').join('');
        return '<!DOCTYPE html><html lang="en-GB"><head><meta charset="utf-8"><title>Wrap order - ' + esc(order.customer.name) + '</title>' +
            '<style>body{font-family:Roboto,Arial,sans-serif;max-width:800px;margin:2rem auto;padding:0 1rem;color:#111}table{border-collapse:collapse}td,th{border:1px solid #999;padding:4px 10px;text-align:left}h2{margin-top:1.5rem}</style></head><body>' +
            '<h1>Wrap order</h1><p>' + esc(order.company) + ' · created ' + esc(order.createdAt) + '</p>' +
            '<h2>Customer</h2><p>' + esc(order.customer.name) + '<br>' + esc(order.customer.email) + '<br>' + esc(order.customer.phone) + '<br>' + esc(order.customer.address).replace(/\n/g, '<br>') + ' ' + esc(order.customer.postcode) + '</p><p>' + esc(order.customer.notes) + '</p>' +
            '<h2>Prosthetic</h2><p>' + esc(LIMB_LABELS[order.prosthetic.type] || order.prosthetic.type) + ', ' + esc(order.prosthetic.side) + ' side. Wrap: ' + (order.prosthetic.wrapSocket ? 'socket ' : '') + (order.prosthetic.wrapPylon ? 'pylon' : '') + '. Surface: ' + esc(order.prosthetic.socketMaterial || 'not given') + '. ' + esc(order.prosthetic.description) + '</p>' +
            '<h2>Measurements (all in cm; customer entered in ' + esc(order.measurements.entered_in) + ')</h2>' +
            (order.measurements.socket ? '<p>Socket length ' + order.measurements.socket.length_cm + ' cm, measured every ' + order.measurements.socket.interval_cm + ' cm.</p><table><tr><th>Point</th><th>From brim</th><th>Circumference</th></tr>' + rows + '</table>' : '<p>Socket not being wrapped.</p>') +
            (order.measurements.pylon ? '<p>Pylon: ' + order.measurements.pylon.length_cm + ' cm long, ' + order.measurements.pylon.circumference_cm + ' cm circumference.</p>' : '') +
            '<p><strong>Leave clear:</strong> ' + esc(order.measurements.cutouts || 'nothing noted') + '</p><p><strong>Shape notes:</strong> ' + esc(order.measurements.notes || 'none') + '</p>' +
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
        const svg = buildFlatSvg({ forExport: true, id: 'x' });
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
            btn.disabled = false; btn.innerHTML = 'Send to ' + CONFIG.brandName;
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
        if (n === 1) {
            need(f.customerName, f.customerName.value.trim().length > 1, 'Please tell us your name.');
            need(f.customerEmail, /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.customerEmail.value.trim()), 'Please enter a valid email address so we can reply.');
        }
        if (n === 2) {
            need(f.limbType[0], !!f.limbType.value, 'Please choose the type of prosthetic.');
            need(f.side[0], !!f.side.value, 'Please choose a side.');
            need(f.wrapSocket, f.wrapSocket.checked || f.wrapPylon.checked, 'Choose at least one thing to wrap.');
        }
        if (n === 3) {
            if (f.wrapSocket.checked) {
                const L = parseFloat(f.socketLength.value);
                const minL = currentUnits() === 'in' ? 2 : 5, maxL = currentUnits() === 'in' ? 30 : 75;
                need(f.socketLength, isFinite(L) && L >= minL && L <= maxL, 'Please enter the socket length (between ' + minL + ' and ' + maxL + ' ' + currentUnits() + ').');
                $$('[data-station]', form).forEach(input => {
                    const v = parseFloat(input.value);
                    const minC = currentUnits() === 'in' ? 3 : 8, maxC = currentUnits() === 'in' ? 40 : 100;
                    need(input, isFinite(v) && v >= minC && v <= maxC, 'Needed (' + minC + ' to ' + maxC + ' ' + currentUnits() + ').');
                });
            }
            if (f.wrapPylon.checked) {
                need(f.pylonLength, parseFloat(f.pylonLength.value) > 0, 'Please enter the pylon length to wrap.');
                need(f.pylonCircumference, parseFloat(f.pylonCircumference.value) > 0, 'Please enter the distance around the pylon.');
            }
        }
        if (n === 5) {
            need(f.consent, f.consent.checked, 'Please tick the box so we can process your order.');
        }
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
        state.visited.add(n);
        steps.forEach(s => s.classList.toggle('is-active', parseInt(s.dataset.step, 10) === n));
        $$('li', stepper).forEach(li => li.classList.toggle('is-current', parseInt(li.dataset.step, 10) === n));
        if (n === 3) { $('#pylonMeasureBlock').hidden = !form.elements.wrapPylon.checked; $('#socketMeasureBlock').hidden = !form.elements.wrapSocket.checked; rebuildStations(); }
        if (n === 4) renderPreviews();
        if (n === 5) renderReview();
        const heading = $('.step.is-active legend h3');
        if (heading) { heading.setAttribute('tabindex', '-1'); heading.focus({ preventScroll: true }); }
        const top = $('#designer').getBoundingClientRect().top + window.pageYOffset - 72;
        window.scrollTo({ top, behavior: 'smooth' });
        persist();
    }

    // ---------------------------------------------------------------
    // Persistence (form fields only; artwork must be re-uploaded)
    // ---------------------------------------------------------------
    function persist() {
        try {
            const data = { step: state.current, units: currentUnits(), fields: {}, stations: $$('[data-station]', form).map(i => i.value) };
            Array.from(form.elements).forEach(el => {
                if (!el.name || el.type === 'file' || el.dataset.station !== undefined) return;
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
    stepper.addEventListener('click', e => {
        const b = e.target.closest('[data-goto]');
        if (b) goTo(parseInt(b.dataset.goto, 10));
    });

    form.addEventListener('submit', e => { e.preventDefault(); if (validateStep(5)) submitOrder(); });
    $('#downloadPack').addEventListener('click', downloadPack);
    $('#downloadPackDone').addEventListener('click', downloadPack);
    $('#printOrder').addEventListener('click', () => { renderReview(); window.print(); });
    $('#startAgain').addEventListener('click', () => { clearPersisted(); window.location.reload(); });

    form.elements.socketLength.addEventListener('input', () => rebuildStations());
    form.elements.stationInterval.addEventListener('change', () => rebuildStations());
    $$('input[name="units"]', form).forEach(r => r.addEventListener('change', onUnitsChange));
    form.elements.wrapPylon.addEventListener('change', () => { $('#pylonMeasureBlock').hidden = !form.elements.wrapPylon.checked; renderPreviews(); });
    form.elements.wrapSocket.addEventListener('change', () => { $('#socketMeasureBlock').hidden = !form.elements.wrapSocket.checked; renderPreviews(); });
    $('#stations').addEventListener('input', () => { checkStationSanity(); renderPreviews(); });
    ['pylonLength', 'pylonCircumference'].forEach(n => form.elements[n].addEventListener('input', renderPreviews));

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
    $$('input[name="fit"]', form).forEach(r => r.addEventListener('change', renderPreviews));
    form.elements.artBackground.addEventListener('input', renderPreviews);
    $('#resetArt').addEventListener('click', () => {
        form.elements.artScale.value = 100; form.elements.artOffsetX.value = 0; form.elements.artOffsetY.value = 0; form.elements.artRotation.value = 0;
        Object.keys(sliders).forEach(name => { $('#' + name + 'Out').textContent = sliders[name](form.elements[name].value); });
        renderPreviews(); persist();
    });

    form.addEventListener('input', persist);
    form.addEventListener('change', persist);

    restore();
    renderPreviews();
})();
