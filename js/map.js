// map.js — Leaflet map initialization, route layers, markers, waypoints

let map = null;
let tileLayer = null;
let startMarker = null;
let endMarker = null;
let hgvRouteLayer = null;
let carRouteLayer = null;
let restrictionLayer = null;

// State
let startLatLng = null;
let endLatLng = null;
let waypoints = []; // Array of {latlng, marker} for intermediate stops
let clickMode = 'start'; // 'start', 'end', or 'waypoint'

function initMap() {
    map = L.map('map', {
        center: CONFIG.map.defaultCenter,
        zoom: CONFIG.map.defaultZoom,
        zoomControl: true,
        attributionControl: true,
    });

    tileLayer = L.tileLayer(CONFIG.map.tileUrl, {
        attribution: CONFIG.map.tileAttribution,
        maxZoom: CONFIG.map.maxZoom,
    }).addTo(map);

    map.invalidateSize();
    map.on('click', onMapClick);
    restrictionLayer = L.layerGroup().addTo(map);
}

function updateTileLayer() {
    if (tileLayer) map.removeLayer(tileLayer);
    tileLayer = L.tileLayer(CONFIG.map.tileUrl, {
        attribution: CONFIG.map.tileAttribution,
        maxZoom: CONFIG.map.maxZoom,
    }).addTo(map);
}

function onMapClick(e) {
    if (clickMode === 'start') {
        setStartPoint(e.latlng);
        clickMode = 'end';
    } else if (clickMode === 'end') {
        setEndPoint(e.latlng);
        clickMode = 'waypoint'; // After both set, clicks add waypoints
    } else {
        // Waypoint mode: add intermediate stops
        addWaypoint(e.latlng);
    }
    updateClickHint();
    updateRouteButton();
}

function updateClickHint() {
    const hint = document.getElementById('click-hint');
    if (!startLatLng && !endLatLng) {
        hint.textContent = 'Click the map to set start (A) and end (B) points';
    } else if (startLatLng && !endLatLng) {
        hint.textContent = 'Now click to set the destination (B)';
    } else if (startLatLng && endLatLng) {
        hint.textContent = waypoints.length > 0
            ? `${waypoints.length} waypoint${waypoints.length > 1 ? 's' : ''} added. Click map to add more, or drag to adjust.`
            : 'Click map to add waypoints for the route. Drag any marker to adjust.';
    }
}

function createMarkerIcon(type, label) {
    const clsMap = { start: 'marker-start', end: 'marker-end', waypoint: 'marker-waypoint' };
    const labelMap = { start: 'A', end: 'B' };
    return L.divIcon({
        className: '',
        html: `<div class="marker-icon ${clsMap[type] || 'marker-waypoint'}">${label || labelMap[type] || ''}</div>`,
        iconSize: [32, 32],
        iconAnchor: [16, 16],
    });
}

function setStartPoint(latlng) {
    startLatLng = latlng;
    if (startMarker) {
        startMarker.setLatLng(latlng);
    } else {
        startMarker = L.marker(latlng, {
            icon: createMarkerIcon('start'),
            draggable: true,
        }).addTo(map);
        startMarker.bindTooltip('Drag to adjust start point', { direction: 'top', opacity: 0.8 });
        startMarker.on('dragend', function () {
            startLatLng = startMarker.getLatLng();
            updateInputFromMarker('start', startLatLng);
            updateRouteButton();
        });
    }
    updateRouteButton();
}

function setEndPoint(latlng) {
    endLatLng = latlng;
    if (endMarker) {
        endMarker.setLatLng(latlng);
    } else {
        endMarker = L.marker(latlng, {
            icon: createMarkerIcon('end'),
            draggable: true,
        }).addTo(map);
        endMarker.bindTooltip('Drag to adjust destination', { direction: 'top', opacity: 0.8 });
        endMarker.on('dragend', function () {
            endLatLng = endMarker.getLatLng();
            updateInputFromMarker('end', endLatLng);
            updateRouteButton();
        });
    }
    updateRouteButton();
}

// --- Waypoints ---

function addWaypoint(latlng, index) {
    const idx = (index !== undefined) ? index : waypoints.length;
    const num = idx + 1;

    const marker = L.marker(latlng, {
        icon: createMarkerIcon('waypoint', num),
        draggable: true,
    }).addTo(map);

    marker.bindTooltip('Drag to move. Click to remove.', { direction: 'top', opacity: 0.8 });

    const wp = { latlng, marker };

    marker.on('dragend', function () {
        wp.latlng = marker.getLatLng();
    });

    // Click to remove waypoint
    marker.on('click', function (e) {
        L.DomEvent.stopPropagation(e); // Don't trigger map click
        removeWaypoint(wp);
    });

    if (index !== undefined) {
        waypoints.splice(index, 0, wp);
    } else {
        waypoints.push(wp);
    }

    renumberWaypoints();
    updateClickHint();
    showToast(`Waypoint ${num} added. Click it to remove.`, 'info');
}

function removeWaypoint(wp) {
    const idx = waypoints.indexOf(wp);
    if (idx === -1) return;
    map.removeLayer(wp.marker);
    waypoints.splice(idx, 1);
    renumberWaypoints();
    updateClickHint();
    showToast('Waypoint removed.', 'info');
}

function renumberWaypoints() {
    waypoints.forEach((wp, i) => {
        wp.marker.setIcon(createMarkerIcon('waypoint', i + 1));
    });
    // Update UI counter
    const info = document.getElementById('waypoint-info');
    const count = document.getElementById('waypoint-count');
    if (waypoints.length > 0) {
        info.hidden = false;
        count.textContent = `${waypoints.length} waypoint${waypoints.length > 1 ? 's' : ''}`;
    } else {
        info.hidden = true;
    }
}

function clearWaypoints() {
    for (const wp of waypoints) {
        map.removeLayer(wp.marker);
    }
    waypoints = [];
}

function getWaypointLatLngs() {
    return waypoints.map(wp => wp.latlng);
}

// --- Input sync ---

function updateInputFromMarker(type, latlng) {
    const input = document.getElementById(type === 'start' ? 'input-start' : 'input-end');
    input.value = `${latlng.lat.toFixed(5)}, ${latlng.lng.toFixed(5)}`;
}

function swapPoints() {
    const tmpStart = startLatLng;
    const tmpEnd = endLatLng;
    const tmpStartVal = document.getElementById('input-start').value;
    const tmpEndVal = document.getElementById('input-end').value;

    // Clear both
    clearStartPoint();
    clearEndPoint();

    // Set swapped
    if (tmpEnd) setStartPoint(tmpEnd);
    if (tmpStart) setEndPoint(tmpStart);

    document.getElementById('input-start').value = tmpEndVal;
    document.getElementById('input-end').value = tmpStartVal;

    // Reverse waypoints order too
    waypoints.reverse();
    renumberWaypoints();

    updateClickHint();
    updateRouteButton();
}

// --- Clear ---

function clearStartPoint() {
    if (startMarker) { map.removeLayer(startMarker); startMarker = null; }
    startLatLng = null;
}

function clearEndPoint() {
    if (endMarker) { map.removeLayer(endMarker); endMarker = null; }
    endLatLng = null;
}

function clearRoutes() {
    if (hgvRouteLayer) { map.removeLayer(hgvRouteLayer); hgvRouteLayer = null; }
    if (carRouteLayer) { map.removeLayer(carRouteLayer); carRouteLayer = null; }
}

function clearRestrictions() {
    if (restrictionLayer) restrictionLayer.clearLayers();
}

function clearAll() {
    clearStartPoint();
    clearEndPoint();
    clearWaypoints();
    clearRoutes();
    clearRestrictions();
    document.getElementById('input-start').value = '';
    document.getElementById('input-end').value = '';
    document.getElementById('route-summary').hidden = true;
    clickMode = 'start';
    updateClickHint();
    updateRouteButton();
}

// --- Route display ---

function displayRoute(geojson, type) {
    const isHgv = type === 'hgv';
    const style = {
        color: isHgv ? '#2563eb' : '#9ca3af',
        weight: isHgv ? 6 : 4,
        opacity: isHgv ? 0.8 : 0.5,
        dashArray: isHgv ? null : '8,8',
    };

    const layer = L.geoJSON(geojson, { style: () => style });

    if (isHgv) {
        if (hgvRouteLayer) map.removeLayer(hgvRouteLayer);
        hgvRouteLayer = layer;
        layer.addTo(map);
        if (carRouteLayer) carRouteLayer.bringToBack();
    } else {
        if (carRouteLayer) map.removeLayer(carRouteLayer);
        carRouteLayer = layer;
        layer.addTo(map);
        layer.bringToBack();
    }

    return layer;
}

function fitToRoutes() {
    const layers = [];
    if (hgvRouteLayer) layers.push(hgvRouteLayer);
    if (carRouteLayer) layers.push(carRouteLayer);
    if (layers.length === 0) return;
    const group = L.featureGroup(layers);
    map.fitBounds(group.getBounds().pad(0.1));
}

function getRouteBounds() {
    if (hgvRouteLayer) return hgvRouteLayer.getBounds();
    if (carRouteLayer) return carRouteLayer.getBounds();
    return null;
}

function addRestrictionMarker(lat, lon, type, details) {
    const clsMap = {
        height: 'restriction-height',
        weight: 'restriction-weight',
        length: 'restriction-length',
        axleload: 'restriction-axleload',
    };
    const labelMap = { height: 'H', weight: 'W', length: 'L', axleload: 'A' };

    const icon = L.divIcon({
        className: '',
        html: `<div class="restriction-marker ${clsMap[type] || ''}">${labelMap[type] || '?'}</div>`,
        iconSize: [26, 26],
        iconAnchor: [13, 13],
    });

    const marker = L.marker([lat, lon], { icon }).bindPopup(
        `<strong>${type.charAt(0).toUpperCase() + type.slice(1)} Restriction</strong><br>${details}`
    );
    restrictionLayer.addLayer(marker);
}

function updateRouteButton() {
    const btn = document.getElementById('btn-route');
    btn.disabled = !(startLatLng && endLatLng);
}

// --- Google Maps Traffic Layer ---

let _googleMap = null;
let _googleTrafficLayer = null;
let _googleRoutePolylines = [];
let _googleRestrictionMarkers = [];
let _trafficMode = false;

function toggleTrafficView() {
    if (!CONFIG.google.loaded || !window.google?.maps) {
        showToast('Google Maps API required. Add your Google API key in Settings.', 'warning');
        return;
    }

    _trafficMode = !_trafficMode;
    const leafletDiv = document.getElementById('map');
    const googleDiv = document.getElementById('google-map');
    const btn = document.getElementById('btn-traffic');

    if (_trafficMode) {
        // Show Google Maps with traffic
        googleDiv.hidden = false;
        leafletDiv.style.visibility = 'hidden';
        btn.classList.add('active');

        if (!_googleMap) {
            _googleMap = new google.maps.Map(googleDiv, {
                center: { lat: map.getCenter().lat, lng: map.getCenter().lng },
                zoom: map.getZoom(),
                mapId: 'rv_traffic_map',
                mapTypeControl: false,
                streetViewControl: false,
                fullscreenControl: false,
            });
            _googleTrafficLayer = new google.maps.TrafficLayer();
        }

        // Sync position from Leaflet
        _googleMap.setCenter({ lat: map.getCenter().lat, lng: map.getCenter().lng });
        _googleMap.setZoom(map.getZoom());
        _googleTrafficLayer.setMap(_googleMap);

        // Draw RV route on Google Map and fit to route
        syncRvDataToGoogleMap();

        // Fit to route bounds
        if (_googleRoutePolylines.length > 0) {
            const bounds = new google.maps.LatLngBounds();
            _googleRoutePolylines[0].getPath().forEach(p => bounds.extend(p));
            _googleMap.fitBounds(bounds, 50);
        }

        // Sync pan/zoom from Google → Leaflet
        google.maps.event.addListenerOnce(_googleMap, 'idle', () => {
            google.maps.event.addListener(_googleMap, 'bounds_changed', () => {
                if (!_trafficMode) return;
                const center = _googleMap.getCenter();
                map.setView([center.lat(), center.lng()], _googleMap.getZoom(), { animate: false });
            });
        });
    } else {
        // Back to Leaflet
        googleDiv.hidden = true;
        leafletDiv.style.visibility = 'visible';
        btn.classList.remove('active');

        if (_googleTrafficLayer) _googleTrafficLayer.setMap(null);

        // Sync position back from Google
        if (_googleMap) {
            const center = _googleMap.getCenter();
            map.setView([center.lat(), center.lng()], _googleMap.getZoom(), { animate: false });
        }
    }
}

function syncRvDataToGoogleMap() {
    if (!_googleMap) return;

    // Clear old overlays
    _googleRoutePolylines.forEach(p => p.setMap(null));
    _googleRoutePolylines = [];
    _googleRestrictionMarkers.forEach(m => { m.map = null; });
    _googleRestrictionMarkers = [];

    // Draw HGV route — white outline + blue fill for visibility over traffic
    if (_currentHgvGeojson) {
        const coords = getRouteCoordinates(_currentHgvGeojson);
        if (coords.length > 0) {
            const path = coords.map(c => ({ lat: c[1], lng: c[0] }));
            // White border for contrast
            const outline = new google.maps.Polyline({
                path,
                strokeColor: '#ffffff',
                strokeWeight: 10,
                strokeOpacity: 0.9,
                zIndex: 1,
            });
            outline.setMap(_googleMap);
            _googleRoutePolylines.push(outline);
            // Blue route
            const poly = new google.maps.Polyline({
                path,
                strokeColor: '#2563eb',
                strokeWeight: 6,
                strokeOpacity: 0.95,
                zIndex: 2,
            });
            poly.setMap(_googleMap);
            _googleRoutePolylines.push(poly);
        }
    }

    // Draw restriction markers
    if (_currentRestrictions && _currentRestrictions.length > 0) {
        for (const r of _currentRestrictions) {
            const label = r.type.charAt(0).toUpperCase();
            const bgColor = r.onRoute ? '#dc2626' : '#f59e0b';
            const el = document.createElement('div');
            el.style.cssText = `width:28px;height:28px;border-radius:50%;background:${bgColor};border:2px solid #fff;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:bold;font-size:12px;cursor:pointer;`;
            el.textContent = label;
            el.title = `${r.type}: ${formatRestrictionValue(r.type, r.value)}`;
            const marker = new google.maps.marker.AdvancedMarkerElement({
                position: { lat: r.lat, lng: r.lon },
                map: _googleMap,
                content: el,
            });
            _googleRestrictionMarkers.push(marker);
        }
    }

    // Draw start/end markers
    if (startLatLng) {
        const el = document.createElement('div');
        el.style.cssText = 'width:32px;height:32px;border-radius:50%;background:#16a34a;border:3px solid #fff;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:bold;font-size:14px;';
        el.textContent = 'A';
        const m = new google.maps.marker.AdvancedMarkerElement({
            position: { lat: startLatLng.lat, lng: startLatLng.lng },
            map: _googleMap,
            content: el,
        });
        _googleRestrictionMarkers.push(m);
    }
    if (endLatLng) {
        const el = document.createElement('div');
        el.style.cssText = 'width:32px;height:32px;border-radius:50%;background:#dc2626;border:3px solid #fff;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:bold;font-size:14px;';
        el.textContent = 'B';
        const m = new google.maps.marker.AdvancedMarkerElement({
            position: { lat: endLatLng.lat, lng: endLatLng.lng },
            map: _googleMap,
            content: el,
        });
        _googleRestrictionMarkers.push(m);
    }
}
