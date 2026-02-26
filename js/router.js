// router.js — ORS routing with HGV profile + car comparison
// POST to /v2/directions/{profile}/geojson
// Returns GeoJSON FeatureCollection, feeds directly into Leaflet L.geoJSON()

let _lastHgvResult = null;
let _lastCarResult = null;

async function getHGVRoute(start, end, viaPoints, avoidPolygons) {
    const vehicle = getEffectiveVehicle();

    // Build coordinates: start -> waypoints -> end (ORS expects [lon, lat])
    const coords = [[start.lng, start.lat]];
    if (viaPoints && viaPoints.length > 0) {
        for (const wp of viaPoints) {
            coords.push([wp.lng, wp.lat]);
        }
    }
    coords.push([end.lng, end.lat]);

    const body = {
        coordinates: coords,
        options: {
            vehicle_type: 'hgv',
            profile_params: {
                restrictions: {
                    height: parseFloat(vehicle.height.toFixed(2)),
                    weight: parseFloat(vehicle.weight.toFixed(2)),
                    length: parseFloat(vehicle.length.toFixed(2)),
                    width: parseFloat(vehicle.width.toFixed(2)),
                    axleload: parseFloat(vehicle.axleload.toFixed(2)),
                },
            },
        },
        preference: 'recommended',
        units: 'm',
        geometry: true,
        elevation: true,
        instructions: true,
        instructions_format: 'text',
    };

    // Add avoidance polygons if provided
    if (avoidPolygons && avoidPolygons.length > 0) {
        body.options.avoid_polygons = {
            type: 'MultiPolygon',
            coordinates: avoidPolygons,
        };
    }

    const res = await abortableFetch('route-hgv',
        `${CONFIG.ors.baseUrl}/v2/directions/driving-hgv/geojson`,
        {
            method: 'POST',
            headers: {
                'Authorization': CONFIG.ors.apiKey,
                'Content-Type': 'application/json; charset=utf-8',
                'Accept': 'application/json, application/geo+json',
            },
            body: JSON.stringify(body),
        }
    );

    trackQuota('directions');

    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        const msg = err.error?.message || err.error || `HTTP ${res.status}`;
        throw new Error(`HGV routing failed: ${msg}`);
    }

    const geojson = await res.json();
    const summary = extractSummary(geojson);
    const steps = extractSteps(geojson);
    const elevation = extractElevationProfile(geojson);

    _lastHgvResult = { geojson, summary, steps, elevation };
    return _lastHgvResult;
}

async function getCarRoute(start, end, viaPoints) {
    const coords = [[start.lng, start.lat]];
    if (viaPoints && viaPoints.length > 0) {
        for (const wp of viaPoints) {
            coords.push([wp.lng, wp.lat]);
        }
    }
    coords.push([end.lng, end.lat]);

    const body = {
        coordinates: coords,
        preference: 'recommended',
        units: 'm',
        geometry: true,
        elevation: true,
        instructions: false,
    };

    const res = await abortableFetch('route-car',
        `${CONFIG.ors.baseUrl}/v2/directions/driving-car/geojson`,
        {
            method: 'POST',
            headers: {
                'Authorization': CONFIG.ors.apiKey,
                'Content-Type': 'application/json; charset=utf-8',
                'Accept': 'application/json, application/geo+json',
            },
            body: JSON.stringify(body),
        }
    );

    trackQuota('directions');

    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        const msg = err.error?.message || err.error || `HTTP ${res.status}`;
        throw new Error(`Car routing failed: ${msg}`);
    }

    const geojson = await res.json();
    const summary = extractSummary(geojson);

    _lastCarResult = { geojson, summary };
    return _lastCarResult;
}

async function planRoute(start, end, viaPoints, avoidPolygons) {
    // Fire both requests in parallel
    // If HGV fails, fall back to car-only with warning
    let hgvResult = null;
    let carResult = null;
    let hgvError = null;

    const results = await Promise.allSettled([
        getHGVRoute(start, end, viaPoints, avoidPolygons),
        getCarRoute(start, end, viaPoints),
    ]);

    if (results[0].status === 'fulfilled') {
        hgvResult = results[0].value;
    } else {
        hgvError = results[0].reason;
        console.error('HGV route failed:', hgvError);
    }

    if (results[1].status === 'fulfilled') {
        carResult = results[1].value;
    }

    // If both failed, throw
    if (!hgvResult && !carResult) {
        throw hgvError || new Error('Routing failed');
    }

    return { hgvResult, carResult, hgvError };
}

function extractSummary(geojson) {
    // ORS GeoJSON puts summary in feature properties
    const feature = geojson.features?.[0];
    if (!feature) return { distance: 0, duration: 0 };

    const summary = feature.properties?.summary || {};
    return {
        distance: summary.distance || 0, // meters
        duration: summary.duration || 0, // seconds
    };
}

function extractSteps(geojson) {
    const feature = geojson.features?.[0];
    if (!feature) return [];

    const segments = feature.properties?.segments || [];
    const coords = getRouteCoordinates(geojson);
    const steps = [];
    for (const seg of segments) {
        for (const step of (seg.steps || [])) {
            // Get coordinate at the waypoint index for this step
            const wpIdx = step.way_points?.[0];
            const coord = (wpIdx !== undefined && coords[wpIdx]) ? coords[wpIdx] : null;
            steps.push({
                instruction: step.instruction || '',
                distance: step.distance || 0,
                duration: step.duration || 0,
                type: step.type,
                name: step.name || '',
                exit_number: step.exit_number,
                lat: coord ? coord[1] : null,
                lon: coord ? coord[0] : null,
            });
        }
    }
    return addEarlyWarnings(steps);
}

// ORS step types that represent significant maneuvers needing advance notice
// 0=Left, 1=Right, 2=Sharp left, 3=Sharp right, 6=Straight (at junction),
// 7=Enter roundabout, 9=U-turn, 12=Keep left, 13=Keep right
const _SIGNIFICANT_TYPES = new Set([0, 1, 2, 3, 7, 9]);
const _EXIT_TYPES = new Set([4, 5, 6, 12, 13]); // Types often used for highway exits/keeps

function addEarlyWarnings(steps) {
    const enhanced = [];

    for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        const prevStep = i > 0 ? steps[i - 1] : null;

        // Classify this step
        const isExit = isHighwayExit(step);
        const isSignificant = _SIGNIFICANT_TYPES.has(step.type) || isExit;

        // Add early warning BEFORE this step if the previous step has enough distance
        // and this is a significant maneuver
        if (isSignificant && prevStep && prevStep.distance > 400) {
            const leadDist = Math.min(prevStep.distance, 1609); // up to 1 mile warning
            const warningText = buildWarningText(step, leadDist, isExit);
            if (warningText) {
                enhanced.push({
                    instruction: warningText,
                    distance: 0,
                    duration: 0,
                    type: -1, // special: early warning
                    isWarning: true,
                    isExitWarning: isExit,
                    lat: step.lat,
                    lon: step.lon,
                });
            }
        }

        // Tag the step itself
        step.isExit = isExit;
        step.isSignificant = isSignificant;
        enhanced.push(step);
    }

    return enhanced;
}

function isHighwayExit(step) {
    const instr = step.instruction.toLowerCase();
    // Check instruction text for exit/ramp/interchange patterns
    if (step.exit_number) return true;
    if (/\b(take exit|exit onto|take the .* exit|take the ramp|ramp onto)\b/.test(instr)) return true;
    if (/\b(merge onto|enter the highway|onto .*(highway|interstate|freeway|motorway|i-\d))\b/.test(instr)) return true;
    // Keep left/right on highways
    if ((step.type === 12 || step.type === 13) && /\b(keep (left|right))\b/.test(instr) &&
        /\b(toward|i-\d|us-\d|highway|interstate|route \d)\b/.test(instr)) return true;
    return false;
}

function buildWarningText(step, leadDist, isExit) {
    const distText = formatDistance(leadDist);
    const instr = step.instruction;

    if (isExit) {
        // Extract exit name/number if possible
        const exitMatch = instr.match(/exit (\d+\w?)/i);
        const exitId = exitMatch ? `Exit ${exitMatch[1]}` : 'exit';
        const dirHint = getDirectionHint(step.type);
        return `In ${distText}: ${exitId} ahead${dirHint} — move to ${getLaneSide(step.type)} lanes`;
    }

    if (step.type === 7) {
        return `In ${distText}: roundabout ahead — slow down`;
    }

    if (step.type === 9) {
        return `In ${distText}: U-turn ahead — check clearance`;
    }

    // Sharp turns
    if (step.type === 2 || step.type === 3) {
        const dir = step.type === 2 ? 'left' : 'right';
        return `In ${distText}: sharp ${dir} turn ahead — reduce speed`;
    }

    // Regular left/right
    if (step.type === 0 || step.type === 1) {
        const dir = step.type === 0 ? 'left' : 'right';
        const name = step.name ? ` onto ${step.name}` : '';
        return `In ${distText}: turn ${dir}${name} — move to ${dir} lane`;
    }

    return null;
}

function getDirectionHint(type) {
    if (type === 0 || type === 2 || type === 4 || type === 12) return ' on left';
    if (type === 1 || type === 3 || type === 5 || type === 13) return ' on right';
    return '';
}

function getLaneSide(type) {
    if (type === 0 || type === 2 || type === 4 || type === 12) return 'left';
    if (type === 1 || type === 3 || type === 5 || type === 13) return 'right';
    return 'appropriate';
}

function getRouteCoordinates(geojson) {
    const feature = geojson.features?.[0];
    if (!feature || !feature.geometry) return [];
    if (feature.geometry.type === 'LineString') return feature.geometry.coordinates;
    if (feature.geometry.type === 'MultiLineString') return feature.geometry.coordinates.flat();
    return [];
}

// Extract elevation profile from ORS GeoJSON (coordinates are [lon, lat, elevation])
function extractElevationProfile(geojson) {
    const coords = getRouteCoordinates(geojson);
    if (coords.length === 0) return null;

    // Check for 3D coordinates
    if (!coords[0] || coords[0].length < 3) return null;

    const points = [];
    let cumulativeDist = 0;

    for (let i = 0; i < coords.length; i++) {
        if (i > 0) {
            const prev = L.latLng(coords[i - 1][1], coords[i - 1][0]);
            const curr = L.latLng(coords[i][1], coords[i][0]);
            cumulativeDist += prev.distanceTo(curr);
        }
        points.push({
            dist: cumulativeDist,
            ele: coords[i][2],
            lat: coords[i][1],
            lon: coords[i][0],
        });
    }

    // Calculate grades between sampled points (~100m intervals)
    const grades = [];
    const sampleInterval = 100; // meters
    let lastSampleIdx = 0;

    for (let i = 1; i < points.length; i++) {
        const segDist = points[i].dist - points[lastSampleIdx].dist;
        if (segDist >= sampleInterval || i === points.length - 1) {
            const rise = points[i].ele - points[lastSampleIdx].ele;
            const grade = segDist > 0 ? (rise / segDist) * 100 : 0;
            grades.push({
                fromDist: points[lastSampleIdx].dist,
                toDist: points[i].dist,
                grade: grade,
                steep: Math.abs(grade) >= 6,
            });
            lastSampleIdx = i;
        }
    }

    const elevations = points.map(p => p.ele);
    return {
        points,
        grades,
        totalDist: cumulativeDist,
        minEle: Math.min(...elevations),
        maxEle: Math.max(...elevations),
        totalAscent: calcTotalAscent(points),
        totalDescent: calcTotalDescent(points),
        steepSegments: grades.filter(g => g.steep),
    };
}

function calcTotalAscent(points) {
    let ascent = 0;
    for (let i = 1; i < points.length; i++) {
        const diff = points[i].ele - points[i - 1].ele;
        if (diff > 0) ascent += diff;
    }
    return ascent;
}

function calcTotalDescent(points) {
    let descent = 0;
    for (let i = 1; i < points.length; i++) {
        const diff = points[i - 1].ele - points[i].ele;
        if (diff > 0) descent += diff;
    }
    return descent;
}

// Create a small square avoidance polygon around a point (~200m radius)
function createAvoidancePolygon(lat, lon, radiusMeters) {
    const r = radiusMeters || 200;
    // Approximate degree offsets
    const dLat = r / 111320;
    const dLon = r / (111320 * Math.cos(lat * Math.PI / 180));
    // GeoJSON polygon: array of [lon, lat] rings, closed
    return [[
        [lon - dLon, lat - dLat],
        [lon + dLon, lat - dLat],
        [lon + dLon, lat + dLat],
        [lon - dLon, lat + dLat],
        [lon - dLon, lat - dLat], // close ring
    ]];
}

// --- Hairpin / sharp turn detection ---
// Analyzes route geometry to find turns too tight for a long RV.
// Returns array of { lat, lon, angle, type: 'hairpin'|'sharp', distAlongRoute }

function detectHairpinTurns(geojson) {
    const coords = getRouteCoordinates(geojson);
    if (coords.length < 3) return [];

    const turns = [];
    // Minimum distance between route points to consider (skip GPS jitter)
    const minSegLen = 15; // meters

    for (let i = 1; i < coords.length - 1; i++) {
        const prev = L.latLng(coords[i - 1][1], coords[i - 1][0]);
        const curr = L.latLng(coords[i][1], coords[i][0]);
        const next = L.latLng(coords[i + 1][1], coords[i + 1][0]);

        const d1 = prev.distanceTo(curr);
        const d2 = curr.distanceTo(next);
        if (d1 < minSegLen || d2 < minSegLen) continue;

        const bearing1 = _bearing(prev.lat, prev.lng, curr.lat, curr.lng);
        const bearing2 = _bearing(curr.lat, curr.lng, next.lat, next.lng);

        // Angle of turn: 0 = straight, 180 = full U-turn
        let turnAngle = Math.abs(bearing2 - bearing1);
        if (turnAngle > 180) turnAngle = 360 - turnAngle;

        // For a 34ft RV:
        // > 150° = hairpin / U-turn — nearly impossible
        // > 120° = very sharp — dangerous, likely need multiple maneuvers
        if (turnAngle >= 120) {
            // Check if this is too close to a previous detection (de-dupe within 50m)
            const lastTurn = turns.length > 0 ? turns[turns.length - 1] : null;
            if (lastTurn && curr.distanceTo(L.latLng(lastTurn.lat, lastTurn.lon)) < 50) {
                // Keep the sharper one
                if (turnAngle > lastTurn.angle) {
                    turns[turns.length - 1] = {
                        lat: coords[i][1],
                        lon: coords[i][0],
                        angle: turnAngle,
                        type: turnAngle >= 150 ? 'hairpin' : 'sharp',
                    };
                }
                continue;
            }
            turns.push({
                lat: coords[i][1],
                lon: coords[i][0],
                angle: turnAngle,
                type: turnAngle >= 150 ? 'hairpin' : 'sharp',
            });
        }
    }

    return turns;
}

// Calculate bearing between two points in degrees (0-360)
function _bearing(lat1, lon1, lat2, lon2) {
    const toRad = Math.PI / 180;
    const dLon = (lon2 - lon1) * toRad;
    const y = Math.sin(dLon) * Math.cos(lat2 * toRad);
    const x = Math.cos(lat1 * toRad) * Math.sin(lat2 * toRad) -
              Math.sin(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.cos(dLon);
    let brng = Math.atan2(y, x) / toRad;
    return (brng + 360) % 360;
}

// Test if ORS API key is valid (simple geocode request)
async function testApiKey(key) {
    try {
        const res = await fetch(
            `${CONFIG.ors.baseUrl}/geocode/search?api_key=${encodeURIComponent(key)}&text=New+York&size=1`
        );
        return res.ok;
    } catch (e) {
        return false;
    }
}
