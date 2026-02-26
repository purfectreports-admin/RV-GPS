// restrictions.js — Overpass API restriction overlays
// Manual trigger only ("Load restrictions" button). Not an app backend dependency.
// Public Overpass instances are fine for personal/light use.

let _restrictionsLoaded = false;

async function loadRestrictions(geojson) {
    if (!geojson) {
        showToast('No route to load restrictions for.', 'warning');
        return { markers: [], warnings: [] };
    }

    const coords = getRouteCoordinates(geojson);
    if (coords.length === 0) {
        showToast('Could not extract route geometry.', 'warning');
        return { markers: [], warnings: [] };
    }

    // Check route distance — warn if very long
    const routeDistKm = getRouteDistanceKm(extractSummary(geojson));
    if (routeDistKm > CONFIG.overpass.maxRouteDistanceKm) {
        showToast(
            `Route is ${Math.round(routeDistKm)} km. Restriction overlay works best on segments under ${CONFIG.overpass.maxRouteDistanceKm} km. Loading visible area only.`,
            'warning'
        );
        // Fall back to visible map bounds
        return await loadRestrictionsForBounds(map.getBounds());
    }

    // Build corridor bboxes (~2km buffer)
    const bboxes = getRouteCorridorBboxes(coords, 2);

    // Merge small bboxes into larger ones to reduce query count
    const mergedBboxes = mergeBboxes(bboxes, 5); // max 5 queries

    const allResults = [];
    for (const bbox of mergedBboxes) {
        try {
            const results = await queryOverpassBbox(bbox);
            allResults.push(...results);
        } catch (e) {
            if (e.name === 'AbortError') return { markers: [], warnings: [] };
            console.warn('Overpass query failed for chunk:', e);
        }
    }

    return processRestrictions(allResults);
}

async function loadRestrictionsForBounds(bounds) {
    const bbox = {
        south: bounds.getSouth(),
        west: bounds.getWest(),
        north: bounds.getNorth(),
        east: bounds.getEast(),
    };
    try {
        const results = await queryOverpassBbox(bbox);
        return processRestrictions(results);
    } catch (e) {
        console.error('Overpass query failed:', e);
        showToast('Restriction data unavailable. Public Overpass API may be busy.', 'warning');
        return { markers: [], warnings: [] };
    }
}

async function queryOverpassBbox(bbox) {
    const bboxStr = `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`;

    const query = `
[out:json][timeout:${CONFIG.overpass.timeout}];
(
  way["maxheight"](${bboxStr});
  way["maxweight"](${bboxStr});
  way["maxlength"](${bboxStr});
  way["maxaxleload"](${bboxStr});
  way["maxheight:physical"](${bboxStr});
  node["barrier"="height_restrictor"](${bboxStr});
);
out center;
`.trim();

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), CONFIG.overpass.timeout * 1000);

    try {
        const res = await fetch(CONFIG.overpass.baseUrl, {
            method: 'POST',
            body: `data=${encodeURIComponent(query)}`,
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);

        const data = await res.json();
        return data.elements || [];
    } catch (e) {
        clearTimeout(timeoutId);
        throw e;
    }
}

function processRestrictions(elements) {
    const vehicle = getEffectiveVehicle();
    const markers = [];
    const warnings = [];
    const seen = new Set(); // deduplicate by element id

    for (const el of elements) {
        if (seen.has(el.id)) continue;
        seen.add(el.id);

        const lat = el.center?.lat || el.lat;
        const lon = el.center?.lon || el.lon;
        if (!lat || !lon) continue;

        const tags = el.tags || {};

        // Height restrictions
        const maxHeight = parseOSMValue(tags.maxheight || tags['maxheight:physical']);
        if (maxHeight !== null) {
            const dangerous = maxHeight < vehicle.height;
            if (dangerous) {
                markers.push({ lat, lon, type: 'height', value: maxHeight, tags });
                warnings.push({
                    type: 'height',
                    message: `Height restriction: ${formatHeight(maxHeight)} (your RV: ${formatHeight(vehicle.height)})`,
                    dangerous: true,
                });
            }
        }

        // Weight restrictions
        const maxWeight = parseOSMValue(tags.maxweight);
        if (maxWeight !== null) {
            const dangerous = maxWeight < vehicle.weight;
            if (dangerous) {
                markers.push({ lat, lon, type: 'weight', value: maxWeight, tags });
                warnings.push({
                    type: 'weight',
                    message: `Weight restriction: ${formatWeight(maxWeight)} (your RV: ${formatWeight(vehicle.weight)})`,
                    dangerous: true,
                });
            }
        }

        // Length restrictions
        const maxLength = parseOSMValue(tags.maxlength);
        if (maxLength !== null) {
            const dangerous = maxLength < vehicle.length;
            if (dangerous) {
                markers.push({ lat, lon, type: 'length', value: maxLength, tags });
                warnings.push({
                    type: 'length',
                    message: `Length restriction: ${formatLength(maxLength)} (your RV: ${formatLength(vehicle.length)})`,
                    dangerous: true,
                });
            }
        }

        // Axle load restrictions
        const maxAxle = parseOSMValue(tags.maxaxleload);
        if (maxAxle !== null) {
            const dangerous = maxAxle < vehicle.axleload;
            if (dangerous) {
                markers.push({ lat, lon, type: 'axleload', value: maxAxle, tags });
                warnings.push({
                    type: 'axleload',
                    message: `Axle load restriction: ${formatWeight(maxAxle)} (your RV: ${formatWeight(vehicle.axleload)})`,
                    dangerous: true,
                });
            }
        }

        // Height restrictor barriers
        if (tags.barrier === 'height_restrictor') {
            const barrierHeight = parseOSMValue(tags.maxheight || tags.height);
            if (barrierHeight !== null && barrierHeight < vehicle.height) {
                markers.push({ lat, lon, type: 'height', value: barrierHeight, tags });
                warnings.push({
                    type: 'height',
                    message: `Height barrier: ${formatHeight(barrierHeight)} (your RV: ${formatHeight(vehicle.height)})`,
                    dangerous: true,
                });
            }
        }
    }

    return { markers, warnings };
}

// Classify restrictions by distance to route: "on_route" (<200m) vs "nearby"
function classifyRestrictions(markers, routeGeojson) {
    if (!routeGeojson) return markers.map(m => ({ ...m, onRoute: true }));

    const coords = getRouteCoordinates(routeGeojson);
    if (coords.length === 0) return markers.map(m => ({ ...m, onRoute: true }));

    return markers.map(m => {
        const rPoint = L.latLng(m.lat, m.lon);
        let minDist = Infinity;
        for (const c of coords) {
            const d = rPoint.distanceTo(L.latLng(c[1], c[0]));
            if (d < minDist) minDist = d;
        }
        return { ...m, onRoute: minDist < 200, distMeters: Math.round(minDist) };
    });
}

// Query road classification along route corridor
async function loadRoadClassifications(geojson) {
    if (!geojson) return [];

    const coords = getRouteCoordinates(geojson);
    if (coords.length === 0) return [];

    const routeDistKm = getRouteDistanceKm(extractSummary(geojson));
    if (routeDistKm > CONFIG.overpass.maxRouteDistanceKm) return [];

    const bboxes = getRouteCorridorBboxes(coords, 1); // 1km buffer for roads
    const mergedBboxes = mergeBboxes(bboxes, 3);

    const allResults = [];
    for (const bbox of mergedBboxes) {
        try {
            const results = await queryRoadClassBbox(bbox);
            allResults.push(...results);
        } catch (e) {
            if (e.name === 'AbortError') return [];
            console.warn('Road class query failed:', e);
        }
    }

    return analyzeRoadClasses(allResults, coords);
}

async function queryRoadClassBbox(bbox) {
    const bboxStr = `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`;
    const query = `
[out:json][timeout:${CONFIG.overpass.timeout}];
(
  way["highway"="residential"](${bboxStr});
  way["highway"="unclassified"](${bboxStr});
  way["highway"="service"](${bboxStr});
  way["highway"="track"](${bboxStr});
);
out center tags;
`.trim();

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), CONFIG.overpass.timeout * 1000);

    try {
        const res = await fetch(CONFIG.overpass.baseUrl, {
            method: 'POST',
            body: `data=${encodeURIComponent(query)}`,
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            signal: controller.signal,
        });
        clearTimeout(timeoutId);
        if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
        const data = await res.json();
        return data.elements || [];
    } catch (e) {
        clearTimeout(timeoutId);
        throw e;
    }
}

function analyzeRoadClasses(elements, routeCoords) {
    const warnings = [];
    const seen = new Set();
    const classCounts = { residential: 0, unclassified: 0, service: 0, track: 0 };

    // Sample every 3rd route point for performance
    const sampledCoords = routeCoords.filter((_, i) => i % 3 === 0);

    for (const el of elements) {
        if (seen.has(el.id)) continue;
        seen.add(el.id);

        const lat = el.center?.lat;
        const lon = el.center?.lon;
        if (!lat || !lon) continue;

        // Tight 25m threshold — only count roads the route actually travels on
        const rPoint = L.latLng(lat, lon);
        let onRoute = false;
        for (const c of sampledCoords) {
            if (rPoint.distanceTo(L.latLng(c[1], c[0])) < 25) {
                onRoute = true;
                break;
            }
        }
        if (!onRoute) continue;

        // Skip short service roads (parking lots, driveways) by checking name
        const hw = el.tags?.highway;
        if (hw === 'service') {
            const svcType = el.tags?.service || '';
            // Skip parking aisles, driveways, and alleys
            if (['parking_aisle', 'driveway', 'alley'].includes(svcType)) continue;
        }

        if (hw && classCounts[hw] !== undefined) classCounts[hw]++;
    }

    if (classCounts.residential > 5) {
        warnings.push({
            type: 'road-class',
            message: `Route uses ~${classCounts.residential} residential road segments — may be narrow or have parked cars`,
            dangerous: false,
        });
    }
    if (classCounts.unclassified > 3) {
        warnings.push({
            type: 'road-class',
            message: `Route uses ~${classCounts.unclassified} unclassified road segments — verify road width`,
            dangerous: false,
        });
    }
    if (classCounts.service > 3) {
        warnings.push({
            type: 'road-class',
            message: `Route uses ~${classCounts.service} service/access road${classCounts.service > 1 ? 's' : ''} — may be tight for RV`,
            dangerous: false,
        });
    }
    if (classCounts.track > 0) {
        warnings.push({
            type: 'road-class',
            message: `Route uses ${classCounts.track} track/unpaved road${classCounts.track > 1 ? 's' : ''} — not suitable for RV`,
            dangerous: true,
        });
    }

    return warnings;
}

function mergeBboxes(bboxes, maxCount) {
    if (bboxes.length <= maxCount) return bboxes;

    // Merge adjacent bboxes until we're under maxCount
    const merged = [];
    const chunkSize = Math.ceil(bboxes.length / maxCount);

    for (let i = 0; i < bboxes.length; i += chunkSize) {
        const chunk = bboxes.slice(i, i + chunkSize);
        let south = Infinity, west = Infinity, north = -Infinity, east = -Infinity;
        for (const b of chunk) {
            if (b.south < south) south = b.south;
            if (b.west < west) west = b.west;
            if (b.north > north) north = b.north;
            if (b.east > east) east = b.east;
        }
        merged.push({ south, west, north, east });
    }

    return merged;
}
