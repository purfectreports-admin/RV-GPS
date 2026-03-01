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

    return _fetchHGVRoute(body);
}

async function _fetchHGVRoute(body) {
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

    _lastHgvResult = { geojson, summary, steps, elevation, routeAnalysis: null };
    return _lastHgvResult;
}

// Request car alternatives, analyze for safety, then route HGV along safest path
async function getHGVRouteWithAlternatives(start, end, avoidPolygons) {
    // Step 1: Get car alternatives (ORS supports alternatives on driving-car)
    const carCoords = [[start.lng, start.lat], [end.lng, end.lat]];
    const carBody = {
        coordinates: carCoords,
        alternative_routes: {
            target_count: 5,
            weight_factor: 1.8,
            share_factor: 0.6,
        },
        preference: 'recommended',
        units: 'm',
        geometry: true,
        elevation: true,
        instructions: true,
        instructions_format: 'text',
    };

    if (avoidPolygons && avoidPolygons.length > 0) {
        carBody.options = {
            avoid_polygons: {
                type: 'MultiPolygon',
                coordinates: avoidPolygons,
            },
        };
    }

    const carRes = await abortableFetch('route-car-alts',
        `${CONFIG.ors.baseUrl}/v2/directions/driving-car/geojson`,
        {
            method: 'POST',
            headers: {
                'Authorization': CONFIG.ors.apiKey,
                'Content-Type': 'application/json; charset=utf-8',
                'Accept': 'application/json, application/geo+json',
            },
            body: JSON.stringify(carBody),
        }
    );

    trackQuota('directions');

    if (!carRes.ok) {
        // Alternatives failed — fall back to standard HGV route
        console.warn('Car alternatives request failed, falling back to standard HGV route');
        return null;
    }

    const carGeojson = await carRes.json();
    if (!carGeojson.features || carGeojson.features.length <= 1) {
        // Only one route returned — no alternatives to compare
        return null;
    }

    // Step 2: Score all car alternatives
    const analysis = pickSafestRoute(carGeojson);

    // Step 3: Sample waypoints from the safest car route to guide HGV
    const bestCoords = getRouteCoordinates(analysis.geojson);
    const guideWaypoints = _sampleWaypoints(bestCoords, start, end);

    // Step 4: Route HGV through those waypoints for full restriction enforcement
    const vehicle = getEffectiveVehicle();
    const hgvCoords = [[start.lng, start.lat]];
    for (const wp of guideWaypoints) {
        hgvCoords.push(wp);
    }
    hgvCoords.push([end.lng, end.lat]);

    const hgvBody = {
        coordinates: hgvCoords,
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

    if (avoidPolygons && avoidPolygons.length > 0) {
        hgvBody.options.avoid_polygons = {
            type: 'MultiPolygon',
            coordinates: avoidPolygons,
        };
    }

    const hgvResult = await _fetchHGVRoute(hgvBody);
    // Attach the route analysis from the car alternatives comparison
    hgvResult.routeAnalysis = analysis.routeAnalysis;
    return hgvResult;
}

// Sample evenly-spaced waypoints along a route to guide HGV routing
// Returns array of [lon, lat] — skips start/end (already provided)
function _sampleWaypoints(coords, start, end) {
    if (coords.length < 10) return [];

    // Calculate total route length
    let totalDist = 0;
    for (let i = 1; i < coords.length; i++) {
        const p = L.latLng(coords[i - 1][1], coords[i - 1][0]);
        const c = L.latLng(coords[i][1], coords[i][0]);
        totalDist += p.distanceTo(c);
    }

    // For short routes (<10km), don't add waypoints — let ORS find the natural HGV path
    if (totalDist < 10000) return [];

    // Sample ~1 waypoint per 20km, max 8 waypoints (leave room for ORS flexibility)
    const numSamples = Math.min(8, Math.max(1, Math.floor(totalDist / 20000)));
    const interval = totalDist / (numSamples + 1);
    const waypoints = [];
    let cumDist = 0;
    let nextSample = interval;

    for (let i = 1; i < coords.length && waypoints.length < numSamples; i++) {
        const p = L.latLng(coords[i - 1][1], coords[i - 1][0]);
        const c = L.latLng(coords[i][1], coords[i][0]);
        cumDist += p.distanceTo(c);

        if (cumDist >= nextSample) {
            waypoints.push([coords[i][0], coords[i][1]]); // [lon, lat]
            nextSample += interval;
        }
    }

    return waypoints;
}

// Wrap a single GeoJSON feature as a FeatureCollection (so existing extract* functions work)
function _wrapFeature(feature) {
    return { type: 'FeatureCollection', features: [feature] };
}

// Score and rank alternative routes, return the safest one
function pickSafestRoute(geojson) {
    const candidates = [];

    for (let i = 0; i < geojson.features.length; i++) {
        const feature = geojson.features[i];
        const wrapped = _wrapFeature(feature);

        const summary = extractSummary(wrapped);
        const steps = extractSteps(wrapped);
        const elevation = extractElevationProfile(wrapped);
        const hairpins = detectHairpinTurns(wrapped);

        // Count U-turn step types (type 9) from ORS instructions
        const uTurnSteps = steps.filter(s => s.type === 9 && !s.isWarning).length;
        // Count sharp turn step types (types 2, 3) from ORS instructions
        const sharpSteps = steps.filter(s => (s.type === 2 || s.type === 3) && !s.isWarning).length;

        // Hairpin geometry detections
        const hairpinCount = hairpins.filter(t => t.type === 'hairpin').length;
        const sharpTurnCount = hairpins.filter(t => t.type === 'sharp').length;

        // Steep grade segments
        const steepCount = elevation ? elevation.steepSegments.length : 0;

        // Count steps on unnamed roads (no road name = likely residential/backroad)
        const unnamedSteps = steps.filter(s => !s.isWarning && !s.name && s.distance > 50).length;

        // Scoring: lower is better
        // Hairpins heavily penalized (25 pts)
        // Sharp turns moderately penalized (10 pts)
        // U-turn instructions (15 pts)
        // Sharp turn instructions (5 pts)
        // Unnamed/backroad segments (8 pts each — prefer named main roads)
        // Steep grades mildly (3 pts)
        const penalty =
            hairpinCount * 25 +
            sharpTurnCount * 10 +
            uTurnSteps * 15 +
            sharpSteps * 5 +
            unnamedSteps * 8 +
            steepCount * 3;

        candidates.push({
            index: i,
            feature,
            wrapped,
            summary,
            steps,
            elevation,
            hairpins,
            penalty,
            hairpinCount,
            sharpTurnCount,
            uTurnSteps,
            sharpSteps,
            unnamedSteps,
            steepCount,
        });
    }

    // Find shortest distance for distance penalty
    const shortestDist = Math.min(...candidates.map(c => c.summary.distance));

    // Add distance penalty (5 pts per extra km — heavily penalize detours)
    for (const c of candidates) {
        c.distancePenalty = ((c.summary.distance - shortestDist) / 1000) * 5;
        c.totalScore = c.penalty + c.distancePenalty;
    }

    // Sort by score (lowest = safest)
    candidates.sort((a, b) => a.totalScore - b.totalScore);

    const best = candidates[0];
    const analysisLines = [];
    analysisLines.push(`Analyzed ${candidates.length} routes — selected safest:`);

    for (const c of candidates) {
        const isBest = c === best;
        const dist = formatDistance(c.summary.distance);
        const time = formatDuration(c.summary.duration);
        const issues = [];
        if (c.hairpinCount > 0) issues.push(`${c.hairpinCount} hairpin`);
        if (c.sharpTurnCount > 0) issues.push(`${c.sharpTurnCount} sharp turn`);
        if (c.uTurnSteps > 0) issues.push(`${c.uTurnSteps} U-turn`);
        if (c.unnamedSteps > 0) issues.push(`${c.unnamedSteps} unnamed road`);
        if (c.steepCount > 0) issues.push(`${c.steepCount} steep`);
        const issueStr = issues.length > 0 ? issues.join(', ') : 'no issues';
        const label = isBest ? '✓' : ' ';
        analysisLines.push(`${label} Route ${c.index + 1}: ${dist}, ${time} — ${issueStr}`);
    }

    console.log('[Route Analysis]\n' + analysisLines.join('\n'));

    return {
        geojson: best.wrapped,
        summary: best.summary,
        steps: best.steps,
        elevation: best.elevation,
        routeAnalysis: {
            totalRoutes: candidates.length,
            selected: best.index + 1,
            candidates: candidates.map(c => ({
                index: c.index + 1,
                distance: c.summary.distance,
                duration: c.summary.duration,
                hairpinCount: c.hairpinCount,
                sharpTurnCount: c.sharpTurnCount,
                uTurnSteps: c.uTurnSteps,
                steepCount: c.steepCount,
                totalScore: c.totalScore,
                isBest: c === best,
            })),
        },
    };
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
    let hgvResult = null;
    let carResult = null;
    let hgvError = null;

    const canUseAlternatives = !viaPoints || viaPoints.length === 0;

    if (canUseAlternatives) {
        // Strategy: get car alternatives, analyze for safety, route HGV along safest
        // Run standard HGV + car in parallel with car alternatives analysis
        const [stdResults, altResult] = await Promise.allSettled([
            Promise.allSettled([
                getHGVRoute(start, end, viaPoints, avoidPolygons),
                getCarRoute(start, end, viaPoints),
            ]),
            getHGVRouteWithAlternatives(start, end, avoidPolygons),
        ]);

        // Extract standard results
        const std = stdResults.status === 'fulfilled' ? stdResults.value : [
            { status: 'rejected', reason: new Error('failed') },
            { status: 'rejected', reason: new Error('failed') },
        ];

        if (std[1]?.status === 'fulfilled') carResult = std[1].value;

        // Prefer the alternative-analyzed HGV route if it succeeded and isn't wildly longer
        const stdHgv = std[0]?.status === 'fulfilled' ? std[0].value : null;
        const altHgv = (altResult.status === 'fulfilled' && altResult.value) ? altResult.value : null;

        if (altHgv && stdHgv) {
            // Pick whichever is shorter, unless the alternative avoids significantly more hazards
            const altDist = altHgv.summary.distance;
            const stdDist = stdHgv.summary.distance;
            if (altDist > stdDist * 1.5) {
                // Alternative is >50% longer — prefer standard route
                console.warn(`Alternative route too long (${(altDist/1609).toFixed(1)} mi vs ${(stdDist/1609).toFixed(1)} mi) — using standard HGV`);
                hgvResult = stdHgv;
            } else {
                hgvResult = altHgv;
            }
        } else if (altHgv) {
            hgvResult = altHgv;
        } else if (stdHgv) {
            hgvResult = stdHgv;
        } else {
            hgvError = std[0]?.reason || new Error('HGV routing failed');
            console.error('HGV route failed:', hgvError);
        }
    } else {
        // With waypoints, alternatives aren't available — standard parallel routing
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
// Returns array of { lat, lon, angle, type, approachLat, approachLon }
// approachLat/Lon = point ~80m back along route BEFORE the turn,
// so avoidance polygons block the approach road, not the intersection.

function detectHairpinTurns(geojson) {
    const coords = getRouteCoordinates(geojson);
    if (coords.length < 3) return [];

    const turns = [];
    const minSegLen = 15; // meters — skip GPS jitter

    for (let i = 1; i < coords.length - 1; i++) {
        const prev = L.latLng(coords[i - 1][1], coords[i - 1][0]);
        const curr = L.latLng(coords[i][1], coords[i][0]);
        const next = L.latLng(coords[i + 1][1], coords[i + 1][0]);

        const d1 = prev.distanceTo(curr);
        const d2 = curr.distanceTo(next);
        if (d1 < minSegLen || d2 < minSegLen) continue;

        const bearing1 = _bearing(prev.lat, prev.lng, curr.lat, curr.lng);
        const bearing2 = _bearing(curr.lat, curr.lng, next.lat, next.lng);

        let turnAngle = Math.abs(bearing2 - bearing1);
        if (turnAngle > 180) turnAngle = 360 - turnAngle;

        if (turnAngle >= 120) {
            // Find approach point: walk ~80m back along the route from the turn
            const approach = _findApproachPoint(coords, i, 80);

            // De-dupe within 50m
            const lastTurn = turns.length > 0 ? turns[turns.length - 1] : null;
            if (lastTurn && curr.distanceTo(L.latLng(lastTurn.lat, lastTurn.lon)) < 50) {
                if (turnAngle > lastTurn.angle) {
                    turns[turns.length - 1] = {
                        lat: coords[i][1],
                        lon: coords[i][0],
                        angle: turnAngle,
                        type: turnAngle >= 150 ? 'hairpin' : 'sharp',
                        approachLat: approach[1],
                        approachLon: approach[0],
                    };
                }
                continue;
            }
            turns.push({
                lat: coords[i][1],
                lon: coords[i][0],
                angle: turnAngle,
                type: turnAngle >= 150 ? 'hairpin' : 'sharp',
                approachLat: approach[1],
                approachLon: approach[0],
            });
        }
    }

    return turns;
}

// Walk backwards along route coords from index `turnIdx` for ~targetMeters,
// return the [lon, lat] coordinate of the approach point.
function _findApproachPoint(coords, turnIdx, targetMeters) {
    let remaining = targetMeters;
    for (let j = turnIdx; j > 0; j--) {
        const a = L.latLng(coords[j][1], coords[j][0]);
        const b = L.latLng(coords[j - 1][1], coords[j - 1][0]);
        const segDist = a.distanceTo(b);
        if (segDist >= remaining) {
            // Interpolate along this segment
            const frac = remaining / segDist;
            const lat = coords[j][1] + frac * (coords[j - 1][1] - coords[j][1]);
            const lon = coords[j][0] + frac * (coords[j - 1][0] - coords[j][0]);
            return [lon, lat];
        }
        remaining -= segDist;
    }
    // If route is shorter than targetMeters, return the start
    return [coords[0][0], coords[0][1]];
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
