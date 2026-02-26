// ui.js — DOM manipulation, panels, toasts, settings modal

// --- Toast notifications ---

function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
}

// --- Loading overlay ---

function showLoading(message = 'Planning route...') {
    document.getElementById('loading-message').textContent = message;
    document.getElementById('loading-overlay').hidden = false;
}

function hideLoading() {
    document.getElementById('loading-overlay').hidden = true;
}

// --- Route summary ---

function showRouteSummary(hgvResult, carResult, hgvError, hairpinTurns) {
    const panel = document.getElementById('route-summary');
    const content = document.getElementById('route-summary-content');
    let html = '';

    // Check if routes are identical (within 1% distance)
    const routesIdentical = hgvResult && carResult &&
        Math.abs(hgvResult.summary.distance - carResult.summary.distance) / carResult.summary.distance < 0.01;

    // Comparison cards
    html += '<div class="route-comparison">';

    if (hgvResult) {
        html += `
        <div class="route-card hgv">
            <div class="route-card-title">RV-Aware Route</div>
            <div class="route-card-value">${formatDistance(hgvResult.summary.distance)}</div>
            <div class="route-card-sub">${formatDuration(hgvResult.summary.duration)}</div>
        </div>`;
    }

    if (carResult) {
        html += `
        <div class="route-card car">
            <div class="route-card-title">Car Route</div>
            <div class="route-card-value">${formatDistance(carResult.summary.distance)}</div>
            <div class="route-card-sub">${formatDuration(carResult.summary.duration)}</div>
        </div>`;
    }

    html += '</div>';

    // Route analysis summary (when alternatives were compared)
    const analysis = hgvResult?.routeAnalysis;
    if (analysis && analysis.totalRoutes > 1) {
        const best = analysis.candidates.find(c => c.isBest);
        const avoided = analysis.candidates.filter(c => !c.isBest);
        const worstIssues = Math.max(...avoided.map(c => c.hairpinCount + c.sharpTurnCount + c.uTurnSteps));
        const bestIssues = best.hairpinCount + best.sharpTurnCount + best.uTurnSteps;

        html += `<div class="route-analysis">`;
        html += `<div class="route-analysis-header">Analyzed ${analysis.totalRoutes} routes — selected safest</div>`;
        html += `<div class="route-analysis-table">`;
        for (const c of analysis.candidates) {
            const issues = [];
            if (c.hairpinCount > 0) issues.push(`${c.hairpinCount} hairpin`);
            if (c.sharpTurnCount > 0) issues.push(`${c.sharpTurnCount} sharp`);
            if (c.uTurnSteps > 0) issues.push(`${c.uTurnSteps} U-turn`);
            if (c.steepCount > 0) issues.push(`${c.steepCount} steep`);
            const issueStr = issues.length > 0 ? issues.join(', ') : 'no issues';
            const cls = c.isBest ? 'route-alt best' : 'route-alt rejected';
            const badge = c.isBest ? '<span class="alt-badge best">SELECTED</span>' : '<span class="alt-badge">REJECTED</span>';
            html += `<div class="${cls}">${badge} Route ${c.index}: ${formatDistance(c.distance)}, ${formatDuration(c.duration)} — ${issueStr}</div>`;
        }
        html += `</div></div>`;
    }

    // HGV failure warning
    if (hgvError) {
        html += `
        <div class="warning-item danger">
            HGV route unavailable. Showing car route only. Verify road restrictions manually.
        </div>`;
    }

    // Identical routes message
    if (routesIdentical) {
        html += `
        <div class="route-identical-msg">
            No HGV-specific divergence found for this route (based on available data).
        </div>`;
    }

    // Difference (only if routes differ)
    if (hgvResult && carResult && !routesIdentical) {
        const distDiff = hgvResult.summary.distance - carResult.summary.distance;
        const timeDiff = hgvResult.summary.duration - carResult.summary.duration;
        const sign = distDiff >= 0 ? '+' : '';
        html += `
        <div class="route-diff">
            RV route is ${sign}${formatDistance(Math.abs(distDiff))} ${distDiff >= 0 ? 'longer' : 'shorter'}
            &bull; ${sign}${formatDuration(Math.abs(timeDiff))} ${timeDiff >= 0 ? 'slower' : 'faster'}
        </div>`;
    }

    // Hairpin / sharp turn warnings
    if (hairpinTurns && hairpinTurns.length > 0) {
        const hairpins = hairpinTurns.filter(t => t.type === 'hairpin');
        const sharps = hairpinTurns.filter(t => t.type === 'sharp');
        html += '<div class="hairpin-warnings">';
        if (hairpins.length > 0) {
            html += `<div class="warning-item danger"><span class="restriction-badge hairpin-badge">U-TURN</span> ${hairpins.length} hairpin/U-turn${hairpins.length > 1 ? 's' : ''} detected — may be impassable for your RV</div>`;
        }
        if (sharps.length > 0) {
            html += `<div class="warning-item caution"><span class="restriction-badge sharp-badge">SHARP</span> ${sharps.length} very sharp turn${sharps.length > 1 ? 's' : ''} detected (>120°) — use extreme caution</div>`;
        }
        html += '</div>';
    }

    // Navigate in Google Maps button
    html += `
    <button id="btn-navigate-google" class="btn btn-google-nav">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L5 12l7 10 7-10z"/></svg>
        Send RV Route to Google Maps
    </button>
    <div class="google-nav-note">Opens Google Maps with waypoints pinned to the RV-safe route</div>`;

    // Warnings placeholder (filled by restriction overlay)
    html += '<div id="restriction-warnings"></div>';

    // Load restrictions button
    html += `
    <div class="restriction-btn-row">
        <button id="btn-load-restrictions" class="btn btn-secondary">
            Load Restriction Overlay
        </button>
        <div class="quota-bar">Uses public Overpass API &mdash; for personal use</div>
    </div>`;

    // Turn-by-turn directions with early warnings
    if (hgvResult && hgvResult.steps && hgvResult.steps.length > 0) {
        const actualSteps = hgvResult.steps.filter(s => !s.isWarning);
        const warningCount = hgvResult.steps.filter(s => s.isWarning).length;
        const exitCount = hgvResult.steps.filter(s => s.isExit && !s.isWarning).length;
        let toggleLabel = `Turn-by-turn directions (${actualSteps.length} steps`;
        if (warningCount > 0) toggleLabel += `, ${warningCount} early warnings`;
        toggleLabel += ')';

        html += `<details>
            <summary class="directions-toggle">${toggleLabel}</summary>
            <ol class="directions-list">`;
        for (const step of hgvResult.steps) {
            if (step.isWarning) {
                // Early warning — rendered as a callout, not a numbered step
                const badgeClass = step.isExitWarning ? 'exit-badge' : 'lane-badge';
                const badgeText = step.isExitWarning ? 'EXIT AHEAD' : 'LANE CHANGE';
                html += `<li class="direction-warning"><span class="dir-badge ${badgeClass}">${badgeText}</span> ${escapeHtml(step.instruction)}</li>`;
            } else if (step.isExit) {
                html += `<li class="direction-exit"><span class="dir-badge exit-badge">EXIT</span> ${escapeHtml(step.instruction)} <span style="color:var(--color-text-muted)">(${formatDistance(step.distance)})</span></li>`;
            } else {
                html += `<li>${escapeHtml(step.instruction)} <span style="color:var(--color-text-muted)">(${formatDistance(step.distance)})</span></li>`;
            }
        }
        html += '</ol></details>';
    }

    // Disclaimer
    html += `<div class="disclaimer-route">RV-aware routing based on OpenStreetMap data. Always verify signage on the road.</div>`;

    content.innerHTML = html;
    panel.hidden = false;

    // On mobile/tablet, start collapsed so map stays visible
    if (window.innerWidth <= 768) {
        panel.classList.add('collapsed');
    } else {
        panel.classList.remove('collapsed');
    }

    // Toggle collapse on handle tap; panel body tap only expands when collapsed
    const handle = panel.querySelector('.panel-handle');
    if (handle) {
        handle.onclick = function (e) {
            e.stopPropagation(); // Don't let panel listener undo the toggle
            panel.classList.toggle('collapsed');
        };
    }
    // Clicking the panel body (not handle) only expands when collapsed
    panel.onclick = function (e) {
        if (panel.classList.contains('collapsed') && e.target !== handle) {
            panel.classList.remove('collapsed');
        }
    };

    // Wire restriction button
    const restrictBtn = document.getElementById('btn-load-restrictions');
    if (restrictBtn) {
        restrictBtn.addEventListener('click', onLoadRestrictions);
    }

    // Wire Google Maps navigation button
    const navBtn = document.getElementById('btn-navigate-google');
    if (navBtn) {
        navBtn.addEventListener('click', onNavigateGoogleMaps);
    }
}

function hideRouteSummary() {
    document.getElementById('route-summary').hidden = true;
}

// --- Restriction warnings ---

function showRestrictionWarnings(warnings, showAvoidButton, roadWarnings) {
    const container = document.getElementById('restriction-warnings');
    if (!container) return;

    if (warnings.length === 0) {
        container.innerHTML = '<div class="warning-item caution">No restrictions found near this route (data may be incomplete).</div>';
        return;
    }

    const onRoute = warnings.filter(w => w.onRoute);
    const nearby = warnings.filter(w => !w.onRoute);

    let html = '<div class="warnings-section">';
    html += `<strong>${warnings.length} restriction${warnings.length > 1 ? 's' : ''} found near route:</strong>`;

    // On-route restrictions first (these are the dangerous ones)
    for (const w of onRoute.slice(0, 20)) {
        html += `<div class="warning-item danger"><span class="restriction-badge on-route">ON ROUTE</span> ${w.message}</div>`;
    }

    // Nearby restrictions (informational)
    for (const w of nearby.slice(0, 10)) {
        const dist = w.distMeters ? ` (~${w.distMeters}m away)` : '';
        html += `<div class="warning-item caution"><span class="restriction-badge nearby">NEARBY</span> ${w.message}${dist}</div>`;
    }

    if (warnings.length > 30) {
        html += `<div class="warning-item caution">...and ${warnings.length - 30} more.</div>`;
    }

    // Road classification warnings
    if (roadWarnings && roadWarnings.length > 0) {
        for (const rw of roadWarnings) {
            html += `<div class="warning-item ${rw.dangerous ? 'danger' : 'road-caution'}"><span class="restriction-badge road-warn">ROAD</span> ${rw.message}</div>`;
        }
    }

    // Avoid & Re-route button (only if on-route restrictions exist)
    if (showAvoidButton && onRoute.length > 0) {
        html += `<button id="btn-avoid-reroute" class="btn btn-danger" style="width:100%;margin-top:8px;">Avoid ${onRoute.length} Restriction${onRoute.length > 1 ? 's' : ''} &amp; Re-route</button>`;
    }

    html += '</div>';
    container.innerHTML = html;
}

// --- Autocomplete suggestions ---

// Track whether mouse is over a suggestion list (prevents blur from hiding it)
let _suggestionMouseDown = false;

function showSuggestions(inputId, results) {
    const listId = inputId === 'input-start' ? 'suggestions-start' : 'suggestions-end';
    const list = document.getElementById(listId);

    if (!results || results.length === 0) {
        list.hidden = true;
        return;
    }

    list.innerHTML = results.map((r, i) =>
        `<div class="suggestion-item" data-index="${i}">${escapeHtml(r.label)}</div>`
    ).join('');
    list.hidden = false;

    // Use mousedown (fires before blur) so selection works reliably
    list.querySelectorAll('.suggestion-item').forEach(item => {
        item.addEventListener('mousedown', async (e) => {
            e.preventDefault(); // Prevent blur from firing
            _suggestionMouseDown = true;

            const idx = parseInt(item.dataset.index, 10);
            const result = results[idx];
            const input = document.getElementById(inputId);
            input.value = result.label;
            list.hidden = true;

            let lat = result.lat;
            let lon = result.lon;

            // Google results need Place ID resolution to get lat/lng
            if (result.source === 'google' && result.placeId && !lat) {
                try {
                    const resolved = await resolvePlaceId(result.placeId);
                    lat = resolved.lat;
                    lon = resolved.lon;
                    if (resolved.formattedAddress) input.value = resolved.formattedAddress;
                } catch (err) {
                    console.error('Place ID resolution failed:', err);
                    showToast('Could not resolve address location.', 'error');
                    _suggestionMouseDown = false;
                    return;
                }
            }

            const latlng = L.latLng(lat, lon);
            if (inputId === 'input-start') {
                setStartPoint(latlng);
                clickMode = 'end';
            } else {
                setEndPoint(latlng);
                clickMode = 'start';
            }
            updateClickHint();

            // Auto-zoom to the selected pin
            if (startLatLng && endLatLng) {
                map.fitBounds(L.latLngBounds(startLatLng, endLatLng).pad(0.2));
            } else {
                map.setView(latlng, 15);
            }

            _suggestionMouseDown = false;
        });
    });
}

function hideSuggestions(inputId) {
    const listId = inputId === 'input-start' ? 'suggestions-start' : 'suggestions-end';
    // Delay to let mousedown on suggestion fire first
    setTimeout(() => {
        if (!_suggestionMouseDown) {
            document.getElementById(listId).hidden = true;
        }
    }, 300);
}

// --- Settings modal ---

function showSettingsModal() {
    populateSettingsForm();
    document.getElementById('settings-modal').hidden = false;
}

function hideSettingsModal() {
    document.getElementById('settings-modal').hidden = true;
}

function showWelcomeModal() {
    document.getElementById('welcome-modal').hidden = false;
}

function hideWelcomeModal() {
    document.getElementById('welcome-modal').hidden = true;
}

function populateSettingsForm() {
    document.getElementById('input-google-key').value = CONFIG.google.apiKey || '';
    document.getElementById('input-api-key').value = CONFIG.ors.apiKey || '';
    document.getElementById('input-safety-buffer').checked = CONFIG.safetyBuffer.enabled;
    document.getElementById('input-overpass-url').value = CONFIG.overpass.baseUrl;
    document.getElementById('input-tile-url').value = CONFIG.map.tileUrl;

    updateUnitToggle();
    populateVehicleFields();
}

function populateVehicleFields() {
    const isImperial = CONFIG.units === 'imperial';

    setFieldValue('input-height',
        isImperial ? metersToFeet(CONFIG.vehicle.height) : CONFIG.vehicle.height,
        isImperial ? 1 : 2);
    setFieldValue('input-weight',
        isImperial ? Math.round(tonsToLbs(CONFIG.vehicle.weight)) : CONFIG.vehicle.weight,
        isImperial ? 0 : 1);
    setFieldValue('input-length',
        isImperial ? metersToFeet(CONFIG.vehicle.length) : CONFIG.vehicle.length,
        isImperial ? 1 : 1);
    setFieldValue('input-width',
        isImperial ? metersToFeet(CONFIG.vehicle.width) : CONFIG.vehicle.width,
        isImperial ? 1 : 1);
    setFieldValue('input-axleload',
        isImperial ? Math.round(tonsToLbs(CONFIG.vehicle.axleload)) : CONFIG.vehicle.axleload,
        isImperial ? 0 : 1);

    // Unit labels
    const unitH = isImperial ? 'ft' : 'm';
    const unitW = isImperial ? 'lbs' : 't';
    const unitL = isImperial ? 'ft' : 'm';
    document.getElementById('unit-height').textContent = unitH;
    document.getElementById('unit-weight').textContent = unitW;
    document.getElementById('unit-length').textContent = unitL;
    document.getElementById('unit-width').textContent = unitL;
    document.getElementById('unit-axleload').textContent = unitW;

    // Conversion hints
    updateConversionHints();
}

function updateConversionHints() {
    const isImperial = CONFIG.units === 'imperial';
    const h = parseFloat(document.getElementById('input-height').value) || 0;
    const w = parseFloat(document.getElementById('input-weight').value) || 0;
    const l = parseFloat(document.getElementById('input-length').value) || 0;
    const wd = parseFloat(document.getElementById('input-width').value) || 0;
    const a = parseFloat(document.getElementById('input-axleload').value) || 0;

    if (isImperial) {
        document.getElementById('hint-height').textContent = `(${feetToMeters(h).toFixed(2)} m)`;
        document.getElementById('hint-weight').textContent = `(${lbsToTons(w).toFixed(1)} t)`;
        document.getElementById('hint-length').textContent = `(${feetToMeters(l).toFixed(1)} m)`;
        document.getElementById('hint-width').textContent = `(${feetToMeters(wd).toFixed(1)} m)`;
        document.getElementById('hint-axleload').textContent = `(${lbsToTons(a).toFixed(1)} t)`;
    } else {
        document.getElementById('hint-height').textContent = `(${metersToFeet(h).toFixed(1)} ft)`;
        document.getElementById('hint-weight').textContent = `(${Math.round(tonsToLbs(w))} lbs)`;
        document.getElementById('hint-length').textContent = `(${metersToFeet(l).toFixed(1)} ft)`;
        document.getElementById('hint-width').textContent = `(${metersToFeet(wd).toFixed(1)} ft)`;
        document.getElementById('hint-axleload').textContent = `(${Math.round(tonsToLbs(a))} lbs)`;
    }
}

function setFieldValue(id, value, decimals) {
    document.getElementById(id).value = typeof value === 'number' ? value.toFixed(decimals) : value;
}

function updateUnitToggle() {
    const impBtn = document.getElementById('btn-unit-imperial');
    const metBtn = document.getElementById('btn-unit-metric');
    impBtn.classList.toggle('active', CONFIG.units === 'imperial');
    metBtn.classList.toggle('active', CONFIG.units === 'metric');
}

function readSettingsFromForm() {
    const isImperial = CONFIG.units === 'imperial';

    CONFIG.google.apiKey = document.getElementById('input-google-key').value.trim();
    CONFIG.ors.apiKey = document.getElementById('input-api-key').value.trim();

    const h = parseFloat(document.getElementById('input-height').value) || 0;
    const w = parseFloat(document.getElementById('input-weight').value) || 0;
    const l = parseFloat(document.getElementById('input-length').value) || 0;
    const wd = parseFloat(document.getElementById('input-width').value) || 0;
    const a = parseFloat(document.getElementById('input-axleload').value) || 0;

    CONFIG.vehicle.height = isImperial ? feetToMeters(h) : h;
    CONFIG.vehicle.weight = isImperial ? lbsToTons(w) : w;
    CONFIG.vehicle.length = isImperial ? feetToMeters(l) : l;
    CONFIG.vehicle.width = isImperial ? feetToMeters(wd) : wd;
    CONFIG.vehicle.axleload = isImperial ? lbsToTons(a) : a;

    CONFIG.safetyBuffer.enabled = document.getElementById('input-safety-buffer').checked;
    CONFIG.overpass.baseUrl = document.getElementById('input-overpass-url').value.trim() || 'https://overpass-api.de/api/interpreter';
    CONFIG.map.tileUrl = document.getElementById('input-tile-url').value.trim() || 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
}

// --- Disclaimer ---

function setupDisclaimer() {
    const dismissed = loadSetting('disclaimer-dismissed', false);
    const bar = document.getElementById('disclaimer');
    if (dismissed) {
        bar.style.display = 'none';
        return;
    }
    bar.querySelector('.disclaimer-close').addEventListener('click', () => {
        bar.style.display = 'none';
        saveSetting('disclaimer-dismissed', true);
    });
}

// --- Elevation profile ---

let _elevationMarker = null; // hover marker on map

function showElevationProfile(elevation) {
    const container = document.getElementById('elevation-container');
    if (!elevation || !elevation.points || elevation.points.length < 2) {
        container.hidden = true;
        return;
    }

    container.hidden = false;

    // Stats
    const stats = document.getElementById('elevation-stats');
    const minFt = CONFIG.units === 'imperial' ? Math.round(metersToFeet(elevation.minEle)) : Math.round(elevation.minEle);
    const maxFt = CONFIG.units === 'imperial' ? Math.round(metersToFeet(elevation.maxEle)) : Math.round(elevation.maxEle);
    const ascFt = CONFIG.units === 'imperial' ? Math.round(metersToFeet(elevation.totalAscent)) : Math.round(elevation.totalAscent);
    const descFt = CONFIG.units === 'imperial' ? Math.round(metersToFeet(elevation.totalDescent)) : Math.round(elevation.totalDescent);
    const unit = CONFIG.units === 'imperial' ? 'ft' : 'm';
    stats.textContent = `${minFt}–${maxFt} ${unit}  |  ↑${ascFt} ${unit}  ↓${descFt} ${unit}`;

    // Grade warnings
    const warningsEl = document.getElementById('elevation-warnings');
    const steepCount = elevation.steepSegments.length;
    if (steepCount > 0) {
        const maxGrade = Math.max(...elevation.steepSegments.map(s => Math.abs(s.grade)));
        warningsEl.innerHTML = `<div class="warning-item danger"><span class="restriction-badge grade-badge">GRADE</span> ${steepCount} steep segment${steepCount > 1 ? 's' : ''} (max ${maxGrade.toFixed(1)}%) — use low gear, watch brakes</div>`;
    } else {
        warningsEl.innerHTML = '';
    }

    // Draw chart
    drawElevationChart(elevation);
}

function hideElevationProfile() {
    document.getElementById('elevation-container').hidden = true;
    if (_elevationMarker) {
        map.removeLayer(_elevationMarker);
        _elevationMarker = null;
    }
}

function drawElevationChart(elevation) {
    const canvas = document.getElementById('elevation-canvas');
    const wrap = canvas.parentElement;

    // Size canvas to container width
    const dpr = window.devicePixelRatio || 1;
    const cssWidth = wrap.clientWidth || 600;
    const cssHeight = 140;
    canvas.style.width = cssWidth + 'px';
    canvas.style.height = cssHeight + 'px';
    canvas.width = cssWidth * dpr;
    canvas.height = cssHeight * dpr;

    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    const pad = { top: 10, right: 10, bottom: 28, left: 50 };
    const w = cssWidth - pad.left - pad.right;
    const h = cssHeight - pad.top - pad.bottom;

    // Clear
    ctx.clearRect(0, 0, cssWidth, cssHeight);

    const { points, grades, minEle, maxEle, totalDist } = elevation;
    const eleRange = maxEle - minEle || 1;

    // Helper: map data to pixel coords
    const xScale = (dist) => pad.left + (dist / totalDist) * w;
    const yScale = (ele) => pad.top + h - ((ele - minEle) / eleRange) * h;

    // Draw steep grade fills first (behind the line)
    for (const g of grades) {
        if (!g.steep) continue;
        const x1 = xScale(g.fromDist);
        const x2 = xScale(g.toDist);
        ctx.fillStyle = 'rgba(220, 38, 38, 0.15)';
        ctx.fillRect(x1, pad.top, x2 - x1, h);
    }

    // Draw fill under elevation line
    ctx.beginPath();
    ctx.moveTo(xScale(points[0].dist), yScale(points[0].ele));
    for (let i = 1; i < points.length; i++) {
        ctx.lineTo(xScale(points[i].dist), yScale(points[i].ele));
    }
    ctx.lineTo(xScale(points[points.length - 1].dist), pad.top + h);
    ctx.lineTo(xScale(points[0].dist), pad.top + h);
    ctx.closePath();
    ctx.fillStyle = 'rgba(37, 99, 235, 0.15)';
    ctx.fill();

    // Draw elevation line — color by grade
    ctx.lineWidth = 2;
    for (const g of grades) {
        ctx.beginPath();
        ctx.strokeStyle = g.steep ? '#dc2626' : '#2563eb';
        // Find points in this grade segment
        let started = false;
        for (const p of points) {
            if (p.dist >= g.fromDist && p.dist <= g.toDist) {
                if (!started) { ctx.moveTo(xScale(p.dist), yScale(p.ele)); started = true; }
                else ctx.lineTo(xScale(p.dist), yScale(p.ele));
            }
        }
        ctx.stroke();
    }

    // Y-axis labels
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--color-text-muted').trim() || '#6b7280';
    ctx.font = '11px -apple-system, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    const yTicks = 4;
    for (let i = 0; i <= yTicks; i++) {
        const ele = minEle + (eleRange * i) / yTicks;
        const y = yScale(ele);
        const label = CONFIG.units === 'imperial' ? Math.round(metersToFeet(ele)) : Math.round(ele);
        ctx.fillText(label, pad.left - 6, y);
        // Grid line
        ctx.beginPath();
        ctx.strokeStyle = 'rgba(128,128,128,0.15)';
        ctx.lineWidth = 1;
        ctx.moveTo(pad.left, y);
        ctx.lineTo(pad.left + w, y);
        ctx.stroke();
    }

    // X-axis labels
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const xTicks = Math.min(5, Math.floor(w / 80));
    for (let i = 0; i <= xTicks; i++) {
        const dist = (totalDist * i) / xTicks;
        const x = xScale(dist);
        ctx.fillText(formatDistance(dist), x, pad.top + h + 6);
    }

    // Interactive hover
    canvas.onmousemove = (e) => onElevationHover(e, elevation, cssWidth, cssHeight, pad, w, h);
    canvas.onmouseleave = () => {
        document.getElementById('elevation-tooltip').hidden = true;
        if (_elevationMarker) { map.removeLayer(_elevationMarker); _elevationMarker = null; }
    };
}

function onElevationHover(e, elevation, cssWidth, cssHeight, pad, w, h) {
    const rect = e.target.getBoundingClientRect();
    const mx = e.clientX - rect.left;

    if (mx < pad.left || mx > pad.left + w) {
        document.getElementById('elevation-tooltip').hidden = true;
        return;
    }

    const distRatio = (mx - pad.left) / w;
    const dist = distRatio * elevation.totalDist;

    // Find closest point
    let closest = elevation.points[0];
    let minDiff = Infinity;
    for (const p of elevation.points) {
        const diff = Math.abs(p.dist - dist);
        if (diff < minDiff) { minDiff = diff; closest = p; }
    }

    // Find current grade
    let grade = 0;
    for (const g of elevation.grades) {
        if (dist >= g.fromDist && dist <= g.toDist) { grade = g.grade; break; }
    }

    const eleDisplay = CONFIG.units === 'imperial' ? `${Math.round(metersToFeet(closest.ele))} ft` : `${Math.round(closest.ele)} m`;
    const gradeDisplay = `${grade >= 0 ? '+' : ''}${grade.toFixed(1)}%`;
    const distDisplay = formatDistance(closest.dist);

    const tooltip = document.getElementById('elevation-tooltip');
    tooltip.hidden = false;
    tooltip.textContent = `${eleDisplay} | ${gradeDisplay} | ${distDisplay}`;
    tooltip.style.left = `${mx}px`;

    // Show marker on map
    if (_elevationMarker) map.removeLayer(_elevationMarker);
    _elevationMarker = L.circleMarker([closest.lat, closest.lon], {
        radius: 6, color: '#2563eb', fillColor: '#fff', fillOpacity: 1, weight: 2,
    }).addTo(map);
}

// --- Helpers ---

// --- Search panel minimize/expand ---

function minimizeSearchPanel() {
    const panel = document.getElementById('search-panel');
    const barText = document.getElementById('route-bar-text');
    const startVal = document.getElementById('input-start').value || 'Start';
    const endVal = document.getElementById('input-end').value || 'End';

    // Truncate display names
    const maxLen = 25;
    const startShort = startVal.length > maxLen ? startVal.slice(0, maxLen) + '...' : startVal;
    const endShort = endVal.length > maxLen ? endVal.slice(0, maxLen) + '...' : endVal;

    barText.innerHTML = `<span class="bar-label start">A</span> ${escapeHtml(startShort)} <span class="bar-arrow">&rarr;</span> <span class="bar-label end">B</span> ${escapeHtml(endShort)}`;
    panel.classList.add('minimized');
}

function expandSearchPanel() {
    document.getElementById('search-panel').classList.remove('minimized');
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}
