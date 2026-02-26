// config.js — RV Route Planner configuration
// All vehicle dimensions stored internally in metric (what APIs expect)

const CONFIG = {
    google: {
        apiKey: '',
        loaded: false,
    },

    ors: {
        baseUrl: 'https://api.openrouteservice.org',
        apiKey: '',
        quotas: {
            directions: { limit: 2000, used: 0, resetDate: null },
            geocode: { limit: 1000, used: 0, resetDate: null },
            autocomplete: { limit: 1000, used: 0, resetDate: null },
        },
    },

    overpass: {
        baseUrl: 'https://overpass-api.de/api/interpreter',
        timeout: 25,
        maxRouteDistanceKm: 500, // warn user above this for overlay queries
    },

    vehicle: {
        height: 3.96,      // meters (13 ft)
        weight: 8.165,      // metric tons (18,000 lbs)
        length: 10.4,       // meters (34 ft)
        width: 2.6,         // meters (~8.5 ft)
        axleload: 5.0,      // metric tons (estimate)
        wheelbase: 6.7,     // meters (22 ft) — used for turn radius estimation
    },

    safetyBuffer: {
        enabled: true,
        height: 0.15,       // meters (~6 inches)
        length: 0.3,        // meters (~1 ft, for hitch/rack)
    },

    map: {
        defaultCenter: [39.8283, -98.5795],  // center of US
        defaultZoom: 5,
        tileUrl: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
        tileAttribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        maxZoom: 19,
    },

    units: 'imperial', // 'imperial' or 'metric'
};

// Load saved settings from localStorage, merging into CONFIG
function loadConfig() {
    const saved = localStorage.getItem('rv-gps-config');
    if (!saved) return;
    try {
        const parsed = JSON.parse(saved);
        if (parsed.google?.apiKey) CONFIG.google.apiKey = parsed.google.apiKey;
        if (parsed.ors?.apiKey) CONFIG.ors.apiKey = parsed.ors.apiKey;
        if (parsed.vehicle) Object.assign(CONFIG.vehicle, parsed.vehicle);
        if (parsed.safetyBuffer) Object.assign(CONFIG.safetyBuffer, parsed.safetyBuffer);
        if (parsed.units) CONFIG.units = parsed.units;
        if (parsed.map?.tileUrl) CONFIG.map.tileUrl = parsed.map.tileUrl;
        if (parsed.map?.tileAttribution) CONFIG.map.tileAttribution = parsed.map.tileAttribution;
        if (parsed.overpass?.baseUrl) CONFIG.overpass.baseUrl = parsed.overpass.baseUrl;
    } catch (e) {
        console.warn('Failed to load saved config:', e);
    }
    loadQuotas();
}

// Save current config to localStorage
function saveConfig() {
    const toSave = {
        google: { apiKey: CONFIG.google.apiKey },
        ors: { apiKey: CONFIG.ors.apiKey },
        vehicle: { ...CONFIG.vehicle },
        safetyBuffer: { ...CONFIG.safetyBuffer },
        units: CONFIG.units,
        map: { tileUrl: CONFIG.map.tileUrl, tileAttribution: CONFIG.map.tileAttribution },
        overpass: { baseUrl: CONFIG.overpass.baseUrl },
    };
    localStorage.setItem('rv-gps-config', JSON.stringify(toSave));
}

// Quota tracking (advisory only — usage estimate from this browser only)
function loadQuotas() {
    const saved = localStorage.getItem('rv-gps-quotas');
    if (!saved) return;
    try {
        const parsed = JSON.parse(saved);
        const today = new Date().toDateString();
        // Reset if it's a new day
        if (parsed.resetDate !== today) {
            resetQuotas();
            return;
        }
        Object.assign(CONFIG.ors.quotas, parsed);
    } catch (e) {
        resetQuotas();
    }
}

function resetQuotas() {
    const today = new Date().toDateString();
    CONFIG.ors.quotas.directions.used = 0;
    CONFIG.ors.quotas.geocode.used = 0;
    CONFIG.ors.quotas.autocomplete.used = 0;
    CONFIG.ors.quotas.resetDate = today;
    saveQuotas();
}

function saveQuotas() {
    const today = new Date().toDateString();
    localStorage.setItem('rv-gps-quotas', JSON.stringify({
        directions: CONFIG.ors.quotas.directions,
        geocode: CONFIG.ors.quotas.geocode,
        autocomplete: CONFIG.ors.quotas.autocomplete,
        resetDate: today,
    }));
}

function trackQuota(type) {
    const today = new Date().toDateString();
    if (CONFIG.ors.quotas.resetDate !== today) resetQuotas();
    if (CONFIG.ors.quotas[type]) {
        CONFIG.ors.quotas[type].used++;
        saveQuotas();
    }
}

function getQuotaPercent(type) {
    const q = CONFIG.ors.quotas[type];
    if (!q) return 0;
    return Math.round((q.used / q.limit) * 100);
}

// Get effective vehicle dimensions (with safety buffer applied)
function getEffectiveVehicle() {
    const v = { ...CONFIG.vehicle };
    if (CONFIG.safetyBuffer.enabled) {
        v.height += CONFIG.safetyBuffer.height;
        v.length += CONFIG.safetyBuffer.length;
    }
    return v;
}
