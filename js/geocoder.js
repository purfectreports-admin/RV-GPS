// geocoder.js — Google Places (New) for address search, ORS fallback
// Uses AutocompleteSuggestion API (replaces deprecated AutocompleteService)

let _geocoderService = null;
const _geocodeCache = new Map();

// Load Google Maps JS API dynamically with async loading
function loadGoogleMapsAPI() {
    return new Promise((resolve, reject) => {
        if (CONFIG.google.loaded && window.google?.maps?.places) {
            resolve();
            return;
        }
        if (!CONFIG.google.apiKey) {
            reject(new Error('Google API key not set'));
            return;
        }

        // Check if already loading
        if (document.getElementById('google-maps-script')) {
            const check = setInterval(() => {
                if (window.google?.maps?.places) {
                    clearInterval(check);
                    CONFIG.google.loaded = true;
                    resolve();
                }
            }, 100);
            setTimeout(() => { clearInterval(check); reject(new Error('Google Maps API load timeout')); }, 10000);
            return;
        }

        window._googleMapsCallback = () => {
            CONFIG.google.loaded = true;
            if (window.google?.maps) {
                _geocoderService = new google.maps.Geocoder();
            }
            resolve();
        };

        const script = document.createElement('script');
        script.id = 'google-maps-script';
        script.async = true;
        script.defer = true;
        script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(CONFIG.google.apiKey)}&libraries=places,marker&callback=_googleMapsCallback&loading=async`;
        script.onerror = () => reject(new Error('Failed to load Google Maps API'));
        document.head.appendChild(script);
    });
}

// Google Places Autocomplete (new AutocompleteSuggestion API)
async function geocodeAutocomplete(query) {
    if (!query || query.length < 3) return [];

    const cacheKey = query.toLowerCase().trim();
    if (_geocodeCache.has(cacheKey)) return _geocodeCache.get(cacheKey);

    // Try Google Places first
    if (CONFIG.google.apiKey) {
        try {
            await loadGoogleMapsAPI();
            const results = await googleAutocomplete(query);
            if (results.length > 0) {
                _geocodeCache.set(cacheKey, results);
                return results;
            }
        } catch (e) {
            console.warn('Google autocomplete failed, falling back to ORS:', e.message);
        }
    }

    // Fallback: ORS autocomplete
    if (CONFIG.ors.apiKey) {
        const results = await orsAutocomplete(query);
        if (results.length > 0) {
            _geocodeCache.set(cacheKey, results);
            return results;
        }
    }

    return [];
}

async function googleAutocomplete(query) {
    // Use the new AutocompleteSuggestion API (replaces deprecated AutocompleteService)
    if (!google?.maps?.places?.AutocompleteSuggestion) {
        console.warn('AutocompleteSuggestion not available, trying legacy API');
        return googleAutocompleteLegacy(query);
    }

    try {
        const request = {
            input: query,
            includedRegionCodes: ['us'],
        };

        // Bias toward current map view
        if (map && map.getBounds()) {
            const bounds = map.getBounds();
            request.locationBias = {
                north: bounds.getNorth(),
                south: bounds.getSouth(),
                east: bounds.getEast(),
                west: bounds.getWest(),
            };
        }

        const { suggestions } = await google.maps.places.AutocompleteSuggestion.fetchAutocompleteSuggestions(request);

        return (suggestions || []).map(s => {
            const prediction = s.placePrediction;
            return {
                label: prediction.text.toString(),
                placeId: prediction.placeId,
                lat: null,
                lon: null,
                source: 'google',
            };
        });
    } catch (e) {
        console.error('Google AutocompleteSuggestion error:', e);
        return [];
    }
}

// Legacy fallback for existing customers still on AutocompleteService
function googleAutocompleteLegacy(query) {
    return new Promise((resolve) => {
        if (!google?.maps?.places?.AutocompleteService) { resolve([]); return; }

        const service = new google.maps.places.AutocompleteService();
        const request = {
            input: query,
            componentRestrictions: { country: 'us' },
        };

        service.getPlacePredictions(request, (predictions, status) => {
            if (status !== google.maps.places.PlacesServiceStatus.OK || !predictions) {
                resolve([]);
                return;
            }
            resolve(predictions.map(p => ({
                label: p.description,
                placeId: p.place_id,
                lat: null,
                lon: null,
                source: 'google',
            })));
        });
    });
}

// Resolve a Google Place ID to lat/lng
async function resolvePlaceId(placeId) {
    // Try new Place class first
    if (google?.maps?.places?.Place) {
        try {
            const place = new google.maps.places.Place({ id: placeId });
            await place.fetchFields({ fields: ['location', 'formattedAddress'] });
            return {
                lat: place.location.lat(),
                lon: place.location.lng(),
                formattedAddress: place.formattedAddress || '',
            };
        } catch (e) {
            console.warn('Place.fetchFields failed, trying Geocoder:', e);
        }
    }

    // Fallback to Geocoder
    return new Promise((resolve, reject) => {
        if (!_geocoderService) { reject(new Error('Geocoder not ready')); return; }

        _geocoderService.geocode({ placeId }, (results, status) => {
            if (status !== 'OK' || !results?.[0]) {
                reject(new Error(`Geocode failed: ${status}`));
                return;
            }
            const loc = results[0].geometry.location;
            resolve({
                lat: loc.lat(),
                lon: loc.lng(),
                formattedAddress: results[0].formatted_address,
            });
        });
    });
}

// ORS autocomplete fallback
async function orsAutocomplete(query) {
    if (!CONFIG.ors.apiKey) return [];

    const center = map ? map.getCenter() : null;
    const params = {
        api_key: CONFIG.ors.apiKey,
        text: query,
        'boundary.country': 'US',
        size: 5,
    };
    if (center) {
        params['focus.point.lat'] = center.lat.toFixed(4);
        params['focus.point.lon'] = center.lng.toFixed(4);
    }

    const url = `${CONFIG.ors.baseUrl}/geocode/autocomplete?` + new URLSearchParams(params);

    try {
        const res = await abortableFetch('geocode', url);
        if (!res.ok) return [];

        trackQuota('autocomplete');
        const data = await res.json();

        return (data.features || []).map(f => ({
            label: f.properties.label || '',
            lat: f.geometry.coordinates[1],
            lon: f.geometry.coordinates[0],
            placeId: null,
            source: 'ors',
        }));
    } catch (e) {
        if (e.name === 'AbortError') return [];
        return [];
    }
}

// Reverse geocode
async function reverseGeocode(lat, lon) {
    const cacheKey = `rev:${lat.toFixed(4)},${lon.toFixed(4)}`;
    if (_geocodeCache.has(cacheKey)) return _geocodeCache.get(cacheKey);

    // Try Google first
    if (CONFIG.google.loaded && _geocoderService) {
        try {
            const result = await new Promise((resolve, reject) => {
                _geocoderService.geocode({ location: { lat, lng: lon } }, (results, status) => {
                    if (status === 'OK' && results?.[0]) {
                        resolve(results[0].formatted_address);
                    } else {
                        reject(new Error(status));
                    }
                });
            });
            _geocodeCache.set(cacheKey, result);
            return result;
        } catch (e) { /* fall through to ORS */ }
    }

    // ORS fallback
    if (CONFIG.ors.apiKey) {
        const url = `${CONFIG.ors.baseUrl}/geocode/reverse?` + new URLSearchParams({
            api_key: CONFIG.ors.apiKey,
            'point.lat': lat,
            'point.lon': lon,
            size: 1,
        });
        try {
            const res = await fetch(url);
            if (res.ok) {
                trackQuota('geocode');
                const data = await res.json();
                const label = data.features?.[0]?.properties?.label || `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
                _geocodeCache.set(cacheKey, label);
                return label;
            }
        } catch (e) { /* fall through */ }
    }

    return `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
}

// Test Google API key
async function testGoogleKey(key) {
    try {
        const testUrl = `https://maps.googleapis.com/maps/api/geocode/json?address=test&key=${encodeURIComponent(key)}`;
        const res = await fetch(testUrl);
        const data = await res.json();
        return data.status !== 'REQUEST_DENIED';
    } catch (e) {
        return false;
    }
}
