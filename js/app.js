// app.js — Main orchestrator, event wiring, first-run setup

let _currentHgvGeojson = null;
let _currentRestrictions = []; // classified restriction markers

document.addEventListener('DOMContentLoaded', () => {
    // 0. Register service worker for PWA/offline
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('./sw.js').catch(() => {});
    }

    // 1. Load saved config
    loadConfig();

    // 2. Initialize map
    initMap();

    // 3. Setup disclaimer
    setupDisclaimer();

    // 4. Check for API keys — first run flow
    if (!CONFIG.ors.apiKey) {
        showWelcomeModal();
    }

    // 5. Load Google Maps API if key exists
    if (CONFIG.google.apiKey) {
        loadGoogleMapsAPI().catch(e => console.warn('Google Maps API load:', e));
    }

    // 6. Wire event listeners
    wireSearchPanel();
    wireFavorites();
    wireSettingsModal();
    wireWelcomeModal();

    // 7. Traffic toggle
    document.getElementById('btn-traffic').addEventListener('click', toggleTrafficView);
});

// --- Search panel events ---

function wireSearchPanel() {
    const inputStart = document.getElementById('input-start');
    const inputEnd = document.getElementById('input-end');
    const btnRoute = document.getElementById('btn-route');
    const btnSwap = document.getElementById('btn-swap');
    const btnClear = document.getElementById('btn-clear');

    // Autocomplete with debounce
    const debouncedGeocode = debounce(async (inputId) => {
        const input = document.getElementById(inputId);
        const query = input.value.trim();
        if (query.length < 3) {
            hideSuggestions(inputId);
            return;
        }
        const results = await geocodeAutocomplete(query);
        showSuggestions(inputId, results);
    }, 300);

    inputStart.addEventListener('input', () => debouncedGeocode('input-start'));
    inputEnd.addEventListener('input', () => debouncedGeocode('input-end'));

    inputStart.addEventListener('blur', () => hideSuggestions('input-start'));
    inputEnd.addEventListener('blur', () => hideSuggestions('input-end'));

    // Re-trigger autocomplete on focus if there's already text
    inputStart.addEventListener('focus', () => { if (inputStart.value.length >= 3) debouncedGeocode('input-start'); });
    inputEnd.addEventListener('focus', () => { if (inputEnd.value.length >= 3) debouncedGeocode('input-end'); });

    // Plan Route
    btnRoute.addEventListener('click', onPlanRoute);

    // Swap (delegate to map.js swapPoints which handles markers + waypoints)
    btnSwap.addEventListener('click', () => swapPoints());

    // Clear
    btnClear.addEventListener('click', () => {
        clearAll();
        hideElevationProfile();
        _currentHgvGeojson = null;
        clickMode = 'start';
    });

    // Clear waypoints only
    document.getElementById('btn-clear-waypoints').addEventListener('click', () => {
        clearWaypoints();
        renumberWaypoints();
        updateClickHint();
    });
}

// --- Route planning ---

async function onPlanRoute() {
    if (!startLatLng || !endLatLng) {
        showToast('Set both start and end points.', 'warning');
        return;
    }

    if (!CONFIG.ors.apiKey) {
        showToast('Add your ORS API key in Settings first.', 'warning');
        showWelcomeModal();
        return;
    }

    showLoading('Planning RV-aware route...');
    clearRoutes();
    clearRestrictions();
    hideRouteSummary();
    _currentHgvGeojson = null;

    try {
        const viaPoints = getWaypointLatLngs();
        const { hgvResult, carResult, hgvError } = await planRoute(startLatLng, endLatLng, viaPoints);

        // Display routes on map
        if (carResult) displayRoute(carResult.geojson, 'car');
        if (hgvResult) {
            displayRoute(hgvResult.geojson, 'hgv');
            _currentHgvGeojson = hgvResult.geojson;
        }

        fitToRoutes();

        // Show summary panel
        showRouteSummary(
            hgvResult ? hgvResult : null,
            carResult ? carResult : null,
            hgvError
        );

        // Show elevation profile if available
        const elevation = hgvResult?.elevation || null;
        if (elevation) {
            showElevationProfile(elevation);
        } else {
            hideElevationProfile();
        }

        // Reverse geocode pin locations for display names
        updatePinDisplayNames();

    } catch (err) {
        console.error('Routing error:', err);

        if (err.message.includes('401') || err.message.includes('403')) {
            showToast('Invalid API key. Check Settings.', 'error');
        } else if (err.message.includes('429')) {
            showToast('Rate limit exceeded. Try again in a moment.', 'error');
        } else {
            showToast(`Routing failed: ${err.message}`, 'error');
        }
    } finally {
        hideLoading();
    }
}

async function updatePinDisplayNames() {
    if (!CONFIG.ors.apiKey && !CONFIG.google.loaded) return;

    const inputStart = document.getElementById('input-start');
    const inputEnd = document.getElementById('input-end');

    // Only reverse geocode if the input looks like coordinates (from map click)
    if (startLatLng && /^-?\d+\.\d+,\s*-?\d+\.\d+$/.test(inputStart.value.trim())) {
        const name = await reverseGeocode(startLatLng.lat, startLatLng.lng);
        inputStart.value = name;
    }
    if (endLatLng && /^-?\d+\.\d+,\s*-?\d+\.\d+$/.test(inputEnd.value.trim())) {
        const name = await reverseGeocode(endLatLng.lat, endLatLng.lng);
        inputEnd.value = name;
    }
}

// --- Restriction overlay ---

async function onLoadRestrictions() {
    const btn = document.getElementById('btn-load-restrictions');
    if (!_currentHgvGeojson) {
        showToast('Plan a route first.', 'warning');
        return;
    }

    btn.disabled = true;
    btn.textContent = 'Loading restrictions...';

    try {
        // Run restriction query and road classification in parallel
        const [restrictionResult, roadWarnings] = await Promise.all([
            loadRestrictions(_currentHgvGeojson),
            loadRoadClassifications(_currentHgvGeojson).catch(e => { console.warn('Road class query failed:', e); return []; }),
        ]);

        const { markers, warnings } = restrictionResult;

        // Classify restrictions by distance to route
        const classified = classifyRestrictions(markers, _currentHgvGeojson);
        _currentRestrictions = classified;

        // Clear old markers
        clearRestrictions();

        // Add new markers to map
        for (const m of classified) {
            const details = `Value: ${formatRestrictionValue(m.type, m.value)}`;
            addRestrictionMarker(m.lat, m.lon, m.type, details);
        }

        // Build classified warnings with on-route / nearby labels
        const classifiedWarnings = classified.map((m, i) => ({
            ...warnings[i],
            onRoute: m.onRoute,
            distMeters: m.distMeters,
        }));

        // Show warnings in summary panel (with avoid button if on-route restrictions exist)
        const hasOnRoute = classified.some(m => m.onRoute);
        showRestrictionWarnings(classifiedWarnings, hasOnRoute, roadWarnings);

        // Wire the avoid button if it was added
        const avoidBtn = document.getElementById('btn-avoid-reroute');
        if (avoidBtn) {
            avoidBtn.addEventListener('click', onAvoidAndReroute);
        }

        if (markers.length > 0) {
            const onRouteCount = classified.filter(m => m.onRoute).length;
            let msg = `Found ${markers.length} restriction${markers.length > 1 ? 's' : ''}`;
            if (onRouteCount > 0) msg += ` (${onRouteCount} on route)`;
            showToast(msg, onRouteCount > 0 ? 'warning' : 'info');
        } else {
            showToast('No restrictions found near this route (data may be incomplete).', 'info');
        }

    } catch (e) {
        console.error('Restriction load error:', e);
        showToast('Could not load restriction data. Overpass API may be unavailable.', 'warning');
    } finally {
        btn.disabled = false;
        btn.textContent = 'Reload Restrictions';
    }
}

async function onAvoidAndReroute() {
    const onRouteRestrictions = _currentRestrictions.filter(m => m.onRoute);
    if (onRouteRestrictions.length === 0) {
        showToast('No on-route restrictions to avoid.', 'info');
        return;
    }

    // Create avoidance polygons around each on-route restriction
    const avoidPolygons = onRouteRestrictions.map(m =>
        createAvoidancePolygon(m.lat, m.lon, 200)
    );

    showLoading('Re-routing to avoid restrictions...');
    clearRoutes();
    clearRestrictions();
    hideRouteSummary();

    try {
        const viaPoints = getWaypointLatLngs();
        const { hgvResult, carResult, hgvError } = await planRoute(startLatLng, endLatLng, viaPoints, avoidPolygons);

        if (carResult) displayRoute(carResult.geojson, 'car');
        if (hgvResult) {
            displayRoute(hgvResult.geojson, 'hgv');
            _currentHgvGeojson = hgvResult.geojson;
        }

        fitToRoutes();
        showRouteSummary(
            hgvResult || null,
            carResult || null,
            hgvError
        );

        const elevation = hgvResult?.elevation || null;
        if (elevation) showElevationProfile(elevation);
        else hideElevationProfile();

        updatePinDisplayNames();

        showToast(`Re-routed avoiding ${onRouteRestrictions.length} restriction${onRouteRestrictions.length > 1 ? 's' : ''}. Check restrictions again to verify.`, 'success');
    } catch (err) {
        console.error('Avoid re-route error:', err);
        showToast(`Re-routing failed: ${err.message}`, 'error');
    } finally {
        hideLoading();
    }
}

// --- Google Maps deep link ---

function onNavigateGoogleMaps() {
    if (!startLatLng || !endLatLng) {
        showToast('Set start and end points first.', 'warning');
        return;
    }

    // Google Maps directions URL:
    // https://www.google.com/maps/dir/?api=1&origin=LAT,LNG&destination=LAT,LNG&waypoints=LAT,LNG|LAT,LNG&travelmode=driving
    //
    // To make Google follow our RV-safe route instead of its own car route,
    // we sample waypoints along the HGV route geometry. Google Maps supports
    // up to ~9 intermediate waypoints via URL — we pick strategic points
    // to pin the route to our corridor.

    const origin = `${startLatLng.lat},${startLatLng.lng}`;
    const destination = `${endLatLng.lat},${endLatLng.lng}`;

    let url = `https://www.google.com/maps/dir/?api=1&origin=${origin}&destination=${destination}&travelmode=driving`;

    // Build waypoints: user-placed waypoints + sampled route geometry points
    const routeWaypoints = sampleRouteWaypoints(_currentHgvGeojson, 9);
    if (routeWaypoints.length > 0) {
        const wpStr = routeWaypoints.map(wp => `${wp.lat},${wp.lng}`).join('|');
        url += `&waypoints=${wpStr}`;
    }

    window.open(url, '_blank');
}

// Sample up to maxPoints waypoints along the HGV route to force Google Maps
// to follow the same corridor. Prioritizes turns/direction changes over
// straight highway segments.
function sampleRouteWaypoints(geojson, maxPoints) {
    if (!geojson) return getWaypointLatLngs(); // fallback to user waypoints only

    const coords = getRouteCoordinates(geojson);
    if (coords.length < 3) return getWaypointLatLngs();

    // Include user-placed waypoints first (they're intentional stops)
    const userWps = getWaypointLatLngs();
    const reservedForRoute = maxPoints - userWps.length;
    if (reservedForRoute <= 0) return userWps.slice(0, maxPoints);

    // Calculate total route distance
    let totalDist = 0;
    for (let i = 1; i < coords.length; i++) {
        totalDist += L.latLng(coords[i][1], coords[i][0])
            .distanceTo(L.latLng(coords[i - 1][1], coords[i - 1][0]));
    }

    // Sample at even distance intervals along the route
    const interval = totalDist / (reservedForRoute + 1);
    const sampled = [];
    let cumDist = 0;
    let nextSampleAt = interval;

    for (let i = 1; i < coords.length && sampled.length < reservedForRoute; i++) {
        const segDist = L.latLng(coords[i][1], coords[i][0])
            .distanceTo(L.latLng(coords[i - 1][1], coords[i - 1][0]));
        cumDist += segDist;

        if (cumDist >= nextSampleAt) {
            // Don't sample too close to start or end (within 500m)
            if (cumDist > 500 && cumDist < totalDist - 500) {
                sampled.push({ lat: coords[i][1], lng: coords[i][0] });
            }
            nextSampleAt += interval;
        }
    }

    // Merge: user waypoints inserted at correct positions among sampled points
    // For simplicity, put user waypoints first, then route samples
    // Google Maps will visit them in order
    return [...userWps, ...sampled].slice(0, maxPoints);
}

function formatRestrictionValue(type, value) {
    switch (type) {
        case 'height': return formatHeight(value);
        case 'weight': case 'axleload': return formatWeight(value);
        case 'length': return formatLength(value);
        default: return String(value);
    }
}

// --- Favorites ---

function wireFavorites() {
    document.getElementById('btn-save-location').addEventListener('click', onSaveLocation);
    document.getElementById('btn-show-favorites').addEventListener('click', toggleFavorites);
    document.getElementById('btn-close-favorites').addEventListener('click', () => {
        document.getElementById('favorites-bar').hidden = true;
    });
}

function getFavorites() {
    return loadSetting('favorites', []);
}

function saveFavorites(favs) {
    saveSetting('favorites', favs);
}

function onSaveLocation() {
    if (!startLatLng && !endLatLng) {
        showToast('Set a start or end point first.', 'warning');
        return;
    }

    const locations = [];
    if (startLatLng) {
        locations.push({
            name: document.getElementById('input-start').value || 'Start',
            lat: startLatLng.lat,
            lng: startLatLng.lng,
        });
    }
    if (endLatLng) {
        locations.push({
            name: document.getElementById('input-end').value || 'Destination',
            lat: endLatLng.lat,
            lng: endLatLng.lng,
        });
    }

    const favs = getFavorites();
    let added = 0;
    for (const loc of locations) {
        // Don't add duplicates (same name or very close coordinates)
        const exists = favs.some(f =>
            f.name === loc.name ||
            (Math.abs(f.lat - loc.lat) < 0.0001 && Math.abs(f.lng - loc.lng) < 0.0001)
        );
        if (!exists) {
            favs.push(loc);
            added++;
        }
    }
    saveFavorites(favs);

    if (added > 0) {
        showToast(`Saved ${added} location${added > 1 ? 's' : ''}.`, 'success');
    } else {
        showToast('Location(s) already saved.', 'info');
    }
    renderFavorites();
}

function toggleFavorites() {
    const bar = document.getElementById('favorites-bar');
    bar.hidden = !bar.hidden;
    if (!bar.hidden) renderFavorites();
}

function renderFavorites() {
    const list = document.getElementById('favorites-list');
    const favs = getFavorites();

    if (favs.length === 0) {
        list.innerHTML = '<div style="font-size:13px;color:var(--color-text-muted);padding:8px 0;">No saved locations yet.</div>';
        document.getElementById('favorites-bar').hidden = false;
        return;
    }

    list.innerHTML = favs.map((f, i) => `
        <div class="favorite-item" data-index="${i}">
            <span class="fav-name" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</span>
            <span class="fav-use" data-action="start" data-index="${i}">Set A</span>
            <span class="fav-use" data-action="end" data-index="${i}">Set B</span>
            <button class="fav-delete" data-action="delete" data-index="${i}" title="Remove">&times;</button>
        </div>
    `).join('');

    list.querySelectorAll('[data-action]').forEach(el => {
        el.addEventListener('click', (e) => {
            e.stopPropagation();
            const idx = parseInt(el.dataset.index, 10);
            const action = el.dataset.action;
            const fav = favs[idx];
            if (!fav) return;

            if (action === 'delete') {
                favs.splice(idx, 1);
                saveFavorites(favs);
                renderFavorites();
                showToast('Removed.', 'info');
            } else if (action === 'start') {
                const latlng = L.latLng(fav.lat, fav.lng);
                setStartPoint(latlng);
                document.getElementById('input-start').value = fav.name;
                clickMode = 'end';
                updateClickHint();
            } else if (action === 'end') {
                const latlng = L.latLng(fav.lat, fav.lng);
                setEndPoint(latlng);
                document.getElementById('input-end').value = fav.name;
                clickMode = 'start';
                updateClickHint();
            }
        });
    });
}

// --- Settings modal ---

function wireSettingsModal() {
    document.getElementById('btn-settings').addEventListener('click', showSettingsModal);
    document.getElementById('btn-close-settings').addEventListener('click', hideSettingsModal);
    document.getElementById('btn-save-settings').addEventListener('click', onSaveSettings);
    document.getElementById('btn-reset-settings').addEventListener('click', onResetSettings);
    document.getElementById('btn-test-key').addEventListener('click', () => onTestOrsKey('input-api-key', 'key-status'));
    document.getElementById('btn-test-google').addEventListener('click', () => onTestGoogleKey('input-google-key', 'google-key-status'));

    // Unit toggle
    document.getElementById('btn-unit-imperial').addEventListener('click', () => {
        CONFIG.units = 'imperial';
        updateUnitToggle();
        populateVehicleFields();
    });
    document.getElementById('btn-unit-metric').addEventListener('click', () => {
        CONFIG.units = 'metric';
        updateUnitToggle();
        populateVehicleFields();
    });

    // Live conversion hints
    ['input-height', 'input-weight', 'input-length', 'input-width', 'input-axleload'].forEach(id => {
        document.getElementById(id).addEventListener('input', updateConversionHints);
    });

    // Share settings link
    document.getElementById('btn-share-settings').addEventListener('click', onShareSettings);

    // Close on backdrop click
    document.getElementById('settings-modal').addEventListener('click', (e) => {
        if (e.target.id === 'settings-modal') hideSettingsModal();
    });
}

function onShareSettings() {
    const status = document.getElementById('share-status');
    const url = generateShareUrl();
    navigator.clipboard.writeText(url).then(() => {
        status.textContent = 'Link copied! Open it on your phone to import settings.';
        status.style.color = 'var(--color-success)';
    }).catch(() => {
        // Fallback: show URL for manual copy
        status.innerHTML = `<input type="text" value="${url}" style="width:100%;font-size:12px;" onclick="this.select()">`;
    });
}

async function onSaveSettings() {
    readSettingsFromForm();
    saveConfig();
    hideSettingsModal();
    updateTileLayer();
    // Load Google Maps API if key was just added
    if (CONFIG.google.apiKey && !CONFIG.google.loaded) {
        try { await loadGoogleMapsAPI(); } catch (e) { console.warn('Google Maps API load failed:', e); }
    }
    showToast('Settings saved.', 'success');
}

function onResetSettings() {
    CONFIG.vehicle.height = 3.96;
    CONFIG.vehicle.weight = 8.165;
    CONFIG.vehicle.length = 10.4;
    CONFIG.vehicle.width = 2.6;
    CONFIG.vehicle.axleload = 5.0;
    CONFIG.safetyBuffer.enabled = true;
    CONFIG.units = 'imperial';
    CONFIG.overpass.baseUrl = 'https://overpass-api.de/api/interpreter';
    CONFIG.map.tileUrl = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
    populateSettingsForm();
    showToast('Reset to defaults.', 'info');
}

async function onTestOrsKey(inputId, statusId) {
    const input = document.getElementById(inputId);
    const status = document.getElementById(statusId);
    const key = input.value.trim();

    if (!key) { status.textContent = 'Enter a key first.'; status.style.color = 'var(--color-danger)'; return false; }
    status.textContent = 'Testing...'; status.style.color = 'var(--color-text-muted)';

    const valid = await testApiKey(key);
    status.textContent = valid ? 'Key is valid!' : 'Key test failed. Check the key.';
    status.style.color = valid ? 'var(--color-success)' : 'var(--color-danger)';
    return valid;
}

async function onTestGoogleKey(inputId, statusId) {
    const input = document.getElementById(inputId);
    const status = document.getElementById(statusId);
    const key = input.value.trim();

    if (!key) { status.textContent = 'Enter a key first.'; status.style.color = 'var(--color-danger)'; return false; }
    status.textContent = 'Testing...'; status.style.color = 'var(--color-text-muted)';

    const valid = await testGoogleKey(key);
    status.textContent = valid ? 'Key is valid!' : 'Key test failed. Ensure Places API & Geocoding API are enabled.';
    status.style.color = valid ? 'var(--color-success)' : 'var(--color-danger)';
    return valid;
}

// --- Welcome modal ---

function wireWelcomeModal() {
    const btnTestGoogle = document.getElementById('btn-welcome-test-google');
    const btnTestOrs = document.getElementById('btn-welcome-test');
    const btnSave = document.getElementById('btn-welcome-save');
    const inputGoogle = document.getElementById('input-welcome-google');
    const inputOrs = document.getElementById('input-welcome-key');

    let googleValid = false;
    let orsValid = false;

    function updateSaveBtn() {
        // ORS is required, Google is optional (but recommended)
        btnSave.disabled = !orsValid;
    }

    btnTestGoogle.addEventListener('click', async () => {
        googleValid = await onTestGoogleKey('input-welcome-google', 'welcome-google-status');
        updateSaveBtn();
    });

    btnTestOrs.addEventListener('click', async () => {
        orsValid = await onTestOrsKey('input-welcome-key', 'welcome-key-status');
        updateSaveBtn();
    });

    inputGoogle.addEventListener('input', () => { googleValid = false; updateSaveBtn(); });
    inputOrs.addEventListener('input', () => { orsValid = false; updateSaveBtn(); });

    btnSave.addEventListener('click', async () => {
        const orsKey = inputOrs.value.trim();
        const googleKey = inputGoogle.value.trim();
        if (!orsKey) return;

        CONFIG.ors.apiKey = orsKey;
        if (googleKey) CONFIG.google.apiKey = googleKey;
        saveConfig();

        // Load Google Maps API if key provided
        if (googleKey) {
            try { await loadGoogleMapsAPI(); } catch (e) { console.warn('Google load failed:', e); }
        }

        hideWelcomeModal();
        showToast('Keys saved. You\'re ready to plan routes!', 'success');
    });
}
