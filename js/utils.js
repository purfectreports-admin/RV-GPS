// utils.js — Unit conversion, debounce, OSM value parsing, helpers

// --- Unit conversion ---

function feetToMeters(ft) { return ft * 0.3048; }
function metersToFeet(m) { return m / 0.3048; }
function lbsToTons(lbs) { return lbs * 0.000453592; } // metric tons
function tonsToLbs(tons) { return tons / 0.000453592; }
function milesToKm(mi) { return mi * 1.60934; }
function kmToMiles(km) { return km / 1.60934; }
function metersToMiles(m) { return m / 1609.34; }
function metersToKm(m) { return m / 1000; }

function formatDistance(meters) {
    if (CONFIG.units === 'imperial') {
        const mi = metersToMiles(meters);
        return mi < 0.1 ? `${Math.round(meters * 3.28084)} ft` : `${mi.toFixed(1)} mi`;
    }
    const km = metersToKm(meters);
    return km < 0.1 ? `${Math.round(meters)} m` : `${km.toFixed(1)} km`;
}

function formatDuration(seconds) {
    if (seconds < 60) return `${Math.round(seconds)}s`;
    const h = Math.floor(seconds / 3600);
    const m = Math.round((seconds % 3600) / 60);
    if (h === 0) return `${m} min`;
    return `${h}h ${m}m`;
}

function formatHeight(meters) {
    if (CONFIG.units === 'imperial') {
        const totalInches = Math.round(meters / 0.0254);
        const ft = Math.floor(totalInches / 12);
        const inches = totalInches % 12;
        return inches > 0 ? `${ft}'${inches}"` : `${ft}'`;
    }
    return `${meters.toFixed(2)} m`;
}

function formatWeight(tons) {
    if (CONFIG.units === 'imperial') {
        return `${Math.round(tonsToLbs(tons)).toLocaleString()} lbs`;
    }
    return `${tons.toFixed(1)} t`;
}

function formatLength(meters) {
    if (CONFIG.units === 'imperial') {
        return `${metersToFeet(meters).toFixed(1)} ft`;
    }
    return `${meters.toFixed(1)} m`;
}

// --- OSM value parsing ---
// Handles: "3.5", "3.5 m", "12 ft", "12'6\"", "18000 lbs", "8.2 t", "none", "default"

function parseOSMValue(value, targetUnit) {
    if (!value || value === 'none' || value === 'default' || value === 'unsigned') return null;

    value = String(value).trim().toLowerCase();

    // feet-inches: 12'6" or 12' 6"
    const feetInchesMatch = value.match(/^(\d+)['']\s*(\d+)?["""]?\s*$/);
    if (feetInchesMatch) {
        const ft = parseInt(feetInchesMatch[1], 10);
        const inches = feetInchesMatch[2] ? parseInt(feetInchesMatch[2], 10) : 0;
        return feetToMeters(ft + inches / 12);
    }

    // number with unit
    const numUnitMatch = value.match(/^([\d.]+)\s*(m|ft|feet|t|tons|lbs|lb|kg|mph|kmh|km\/h)?\s*$/);
    if (numUnitMatch) {
        const num = parseFloat(numUnitMatch[1]);
        const unit = numUnitMatch[2] || '';

        if (isNaN(num)) return null;

        switch (unit) {
            case 'ft': case 'feet': return feetToMeters(num);
            case 'm': case '': return num; // default to meters for height/length
            case 't': case 'tons': return num; // metric tons
            case 'lbs': case 'lb': return lbsToTons(num);
            case 'kg': return num / 1000; // to metric tons
            default: return num;
        }
    }

    return null;
}

// --- Debounce / Throttle ---

function debounce(fn, delay) {
    let timer = null;
    return function (...args) {
        clearTimeout(timer);
        timer = setTimeout(() => fn.apply(this, args), delay);
    };
}

function throttle(fn, limit) {
    let lastCall = 0;
    return function (...args) {
        const now = Date.now();
        if (now - lastCall >= limit) {
            lastCall = now;
            return fn.apply(this, args);
        }
    };
}

// --- localStorage helpers ---

function saveSetting(key, value) {
    try {
        localStorage.setItem(`rv-gps-${key}`, JSON.stringify(value));
    } catch (e) {
        console.warn('Failed to save setting:', key, e);
    }
}

function loadSetting(key, defaultValue) {
    try {
        const stored = localStorage.getItem(`rv-gps-${key}`);
        return stored !== null ? JSON.parse(stored) : defaultValue;
    } catch (e) {
        return defaultValue;
    }
}

// --- Fetch with AbortController ---

function createAbortable() {
    const controller = new AbortController();
    return {
        signal: controller.signal,
        abort() { controller.abort(); },
    };
}

// Managed fetch that auto-tracks an AbortController by key.
// Calling again with the same key aborts the previous request.
const _activeRequests = new Map();

function abortableFetch(key, url, options = {}) {
    // Cancel any in-flight request with this key
    if (_activeRequests.has(key)) {
        _activeRequests.get(key).abort();
    }
    const controller = new AbortController();
    _activeRequests.set(key, controller);

    return fetch(url, { ...options, signal: controller.signal })
        .finally(() => {
            // Clean up only if this is still the active controller
            if (_activeRequests.get(key) === controller) {
                _activeRequests.delete(key);
            }
        });
}

// --- Route geometry helpers ---

function routeBboxToOverpassBbox(bounds) {
    // Leaflet bounds to Overpass bbox string: south,west,north,east
    return `${bounds.getSouth()},${bounds.getWest()},${bounds.getNorth()},${bounds.getEast()}`;
}

function getRouteDistanceKm(routeSummary) {
    if (!routeSummary || !routeSummary.distance) return 0;
    return routeSummary.distance / 1000;
}

// Simple corridor bounding boxes along a route polyline
// Returns array of {south,west,north,east} covering ~bufferKm around the route
function getRouteCorridorBboxes(coordinates, bufferKm) {
    const bufferDeg = bufferKm / 111; // rough km-to-degree
    const bboxes = [];
    const chunkSize = 50; // points per chunk

    for (let i = 0; i < coordinates.length; i += chunkSize) {
        const chunk = coordinates.slice(i, i + chunkSize + 1);
        let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
        for (const coord of chunk) {
            const lat = coord[1], lon = coord[0]; // GeoJSON is [lon, lat]
            if (lat < minLat) minLat = lat;
            if (lat > maxLat) maxLat = lat;
            if (lon < minLon) minLon = lon;
            if (lon > maxLon) maxLon = lon;
        }
        bboxes.push({
            south: minLat - bufferDeg,
            west: minLon - bufferDeg,
            north: maxLat + bufferDeg,
            east: maxLon + bufferDeg,
        });
    }
    return bboxes;
}
