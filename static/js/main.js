/**
 * @file main.js
 * @description App bootstrap & UI wiring for the habitability tool.
 * Loads data, builds the scoring bundle, toggles layers, and renders results.
 *
 * Modules used:
 *  - Map/geometry: MapManager (map.js)
 *  - DOM helpers & UI builders: utils.js
 *  - Scoring + panel render: hab_score.js
 *
 * Units:
 *  - Circle radius on the Leaflet circle is in meters.
 *  - Radius input field is yards (converted here).
 *  - Transit & element distances used by the scorer are in kilometers.
 */

import { MapManager } from "./map.js";
import {
    qs, qsa, unique,
    createElementBar, createPreferenceBar, setupPreferenceToggle,
    colorForKey
} from "./utils.js";
import { computeAndRenderHabScore } from "./hab_score.js";

// ---------- Unit constants ----------
/** 1 yard = 0.9144 meters */
const YARD_TO_M = 0.9144;
/** 1 mile = 1.609344 kilometers */
const MILE_TO_KM = 1.609344;

// ---------- Global runtime state ----------
/**
 * @typedef {Object} AppState
 * @property {Array<Object>} points
 * @property {Array|Object|null} polygons
 * @property {MapManager|null} map
 * @property {Record<string,"good"|"bad"|"na">} preferenceChoice
 * @property {Record<string,boolean>} statToggle
 */

/** @type {AppState} */
const state = {
    points: [],
    polygons: null,
    map: null,
    preferenceChoice: {},
    statToggle: {},
};

// ---------- Stat card helpers ----------
/**
 * Determine if a stat-card is active based on classes.
 * Active when it has 'highlight' OR it lacks 'inactive'.
 * @param {HTMLElement} card
 * @returns {boolean}
 */
function getStatActive(card) {
  	return card.classList.contains("highlight") || !card.classList.contains("inactive");
}

/**
 * Toggle stat-card active classes.
 * @param {HTMLElement} card
 * @param {boolean} on
 */
function setStatActive(card, on) {
	card.classList.toggle("highlight", !!on);
	card.classList.toggle("inactive", !on);
}

// ---------- Fetch ----------
/**
 * Fetch a JSON resource and return parsed data.
 * @param {string} url
 * @returns {Promise<any>}
 * @throws {Error} on non-2xx response
 */
async function fetchJSON(url) {
	const res = await fetch(url, { headers: { "Accept": "application/json" } });
	if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
	return res.json();
}

// ---------- App bootstrap ----------
/**
 * Initialize the page:
 *  - Build minimal instructions UI (minimize toggle only)
 *  - Create the map and layers
 *  - Load /points and /polygons
 *  - Populate element and preference panels
 *  - Wire stat toggles + generate/clear flow
 *  - Sync circle radius with the yards input
 */
async function init() {
	// Map manager instance
	state.map = new MapManager("map");

	// Load data from server
	const [points, polygons] = await Promise.all([
		fetchJSON("/points"),
		fetchJSON("/polygons"),
	]);
	state.points = Array.isArray(points) ? points : points?.points ?? [];
	state.polygons = polygons;

	// Populate UI + map
	populateElementsPanel(state.points);
	Array.isArray(state.polygons)
		? state.map.addPolygonsFromCustom(state.polygons)
		: state.map.addPolygonsByAspect(state.polygons);
	buildPreferenceBarsFromPoints(state.points);
	wireControls();

	// Hook the radius input (yards) → circle (meters)
	const rInput = qs("#radius-input");
	if (rInput) {
		rInput.addEventListener("input", () => {
		const yards = parseFloat(rInput.value || "0") || 0;
		const meters = yards * YARD_TO_M;
		if (state.map?.draw?.circle?.setRadius) {
			state.map.draw.circle.setRadius(meters);
		}
		});
	}
}

/**
 * Populate the Elements panel and add markers to the map.
 * @param {Array<Object>} points
 */
function populateElementsPanel(points) {
	const container = qs(".elements-panel");
	if (!container) return;
	container.innerHTML = "";

	// Cycle and add each point to the map and element bar as well set up the click on event
	points.forEach((p) => {
		state.map.addPoint(p);
		const bar = createElementBar(p, (lat, lng) => {
			state.map.focusOn(lat, lng, 15, `<strong>${p.name ?? "Point"}</strong>`);
		});
		container.appendChild(bar);
	});
}

/**
 * Build per-type preference bars (Good/Bad/N/A) in the Preferences panel.
 * @param {Array<Object>} points
 */
function buildPreferenceBarsFromPoints(points) {
	// Determine preference panel and check if valid
	const prefPanel = qs(".preference-panel");
	if (!prefPanel) return;

	// Remove any prev elements
	prefPanel.innerHTML = "";

	// Find the types within the list
	const types = unique(points.map((p) => p.type ?? "Unknown"));

	// Cycle for each element creating preference bars
	types.forEach((t) => {
		const bar = createPreferenceBar(t, (type, value) => {
			state.preferenceChoice[type] = value; // "good" | "bad" | "na"
		});
		prefPanel.appendChild(bar);
	});
}

// ---------- Controls & listeners ----------
/**
 * Wire:
 *  - Preferences toggle (Elements ⇄ Preferences)
 *  - Stat-card toggles → map aspect visibility
 *  - Generate/Clear Habitability Score flow
 */
function wireControls() {
	// Toggle Elements/Preferences
	setupPreferenceToggle("#btn-preference", ".elements-panel", ".preference-panel");

	// Seed stat state & wire toggles; also color cards to match aspects
	qsa(".stats").forEach((card) => {
		// Determine card aspect value (must match the polygon aspect value)
		const aspect = card.id;

		// Color the stat card to match layer color
		const col = colorForKey(aspect);
		card.style.setProperty("--aspect-color", col);
		card.style.borderColor = col;

		// Seed active state & map visibility
		const activeFromDOM = getStatActive(card);
		state.statToggle[aspect] = activeFromDOM;

		// Check if not active and set if not 
		if (!activeFromDOM) {
			state.map.toggleAspect(aspect);
		}

		// Set up event listener for when clicking on the stat panel
		card.addEventListener("click", () => {
			const nowActive = !state.statToggle[aspect];
			setStatActive(card, nowActive);
			state.map.toggleAspect(aspect);
			state.statToggle[aspect] = nowActive;
		});
	});

	// Determine and validate Generate / Clear Habitability Score button
	const btnGen = qs("#btn-generate");
	if (!btnGen) return;

	// Set up Generate / Clear Habitability Score button
	btnGen.addEventListener("click", (e) => {
		e.preventDefault();
		// Determine is on status
		const isOn = btnGen.classList.contains("on");

		// Check if button is active
		if (isOn) {
			// Reset generated state
			restoreFullVisibility();
			showInstructionsPanel();
			clearStatScores();
			btnGen.classList.remove("on");
			btnGen.textContent = "Generate Habitability Score";
			return;
		}

		// Determine raidus of circle
		const centerLL = state.map?.draw?.center;
		const radiusM = (state.map?.draw?.circle?.getRadius?.())
			?? ((parseFloat(qs("#radius-input")?.value || "0") || 0) * YARD_TO_M);

		// Check if there is a lat and long value
		if (!centerLL) {
			alert("Double-click the map to set a center first, then drag to size the circle.");
		return;
		}

		// Determine values for hab score generation
		const center  = { lat: centerLL.lat, lon: centerLL.lng };
		const dataset = { points: state.points, polygons: state.polygons };
		const prefs   = state.preferenceChoice;

		// Create bundle payload for calc
		const bundle = buildHabBundle(center, radiusM, dataset, prefs);

		// Reduce elements to just whats within the circle
		applyRadiusVisibility(bundle);

		// Send the bundle and store calc results
		const result = computeAndRenderHabScore(bundle);
		
		// Update displays with values
		updateStatScoresFromResult(result);
		showScorePanel();
		updateStatCardsFromAspects(bundle.aspects);

		// Update button styling
		btnGen.classList.add("on");
		btnGen.textContent = "Clear Habitability Score";

		// Store values
		state.lastHabBundle = bundle;
	});
}

// ---------- HAB v3: bundle building & visibility ----------
/**
 * Build the scoring bundle:
 *  - Filter points/polygons by radius
 *  - Resolve aspect values at the center
 *  - Prepare channels: transit_km + element pairs
 *
 * @param {{lat:number,lon:number}} center
 * @param {number} radiusM Radius in meters
 * @param {{points:Array, polygons:Array|Object}} dataset
 * @param {Record<string,"good"|"bad"|"na">} prefs
 * @returns {Object} Bundle for score_v3 + renderer
 */
function buildHabBundle(center, radiusM, dataset, prefs) {
	// Deteremine state
	const M = state.map;

	// Filter values for whats withint a radius
	const pointsIn = M.filterPointsInRadius(center, radiusM, dataset.points);
	const polysIn  = M.filterPolygonsInRadius(center, radiusM, dataset.polygons);

	// Resolve aspects
	const byAspect = (name) => {
		// Determine polygons from set
		const polys = dataset.polygons;
		
		// Sorting based on type of input
		if (Array.isArray(polys)) {
			return polys.filter(p => ((p.properties && p.properties.aspect) || p.aspect) === name);
		} 
		else if (polys && typeof polys === "object") {
		
			// Create value bucket
			const bucket = polys[name];

			// Return empty bucket if not valid
			if (!bucket) return [];

			// Return values based on bucket
			if (Array.isArray(bucket)) return bucket;
			if (bucket.type === "FeatureCollection") return bucket.features || [];
			if (bucket.type === "Feature") return [bucket];

			// Return empty bucket if empty
			return [];
		}
		// Return empty bucket if empty
		return [];
	};

	// Determine score based on aspect value
	const air    = M.resolveAspectValueAtPoint(center, byAspect("air_quality_index"));
	const crime  = M.resolveAspectValueAtPoint(center, byAspect("crime_rate"));
	const rent   = M.resolveAspectValueAtPoint(center, byAspect("median_rent"));
	const school = M.resolveAspectValueAtPoint(center, byAspect("school_quality"));
	const transit_zone = M.resolveTransitZoneInfo(center, byAspect("transit_access"));

	// Determine Transit point distances (meters → km)
	let transit_km = M.collectTransitDistancesKm(pointsIn);

	// Fallback to transit polygons if there is no distance value (values in miles → km)
	if (transit_km.length === 0) {
		// Create storage
		const candidates = [];

		// Check if the transit zone is valid
		if (!transit_zone?.out_of_bounds && transit_zone.zone_transit_distance != null) {
			// Add to the candiates list
			candidates.push(Number(transit_zone.zone_transit_distance) * MILE_TO_KM);
		
		}

		// Cycle the polygons checking for transit access aspects and add it to the list if valid
		for (const poly of polysIn) {
			const asp = poly.properties?.aspect || poly.aspect;
			if (asp === "transit_access") {
				const td_miles = poly.properties?.transit_distance ?? poly.transit_distance;
				if (td_miles != null) candidates.push(Number(td_miles) * MILE_TO_KM);
			}
		}

		// Filter values if they are numbers and are greater than 0
		transit_km = candidates.filter(x => Number.isFinite(x) && x >= 0);
	}

	// Build the grouped element values
	const grouped = M.buildElementChannels(center, pointsIn, { perType: prefs });

	// Return the payload
	return {
		center, radius_m: radiusM,
		filtered: { points: pointsIn, polygons: polysIn },
		aspects: { air, crime, rent, school, transit_zone },
		channels: {
		transit_km,
		elements_pairs: grouped.elements_pairs,
		pos_km: grouped.pos_km,
		neg_km: grouped.neg_km,
		neu_km: grouped.neu_km
		}
	};
}

/**
 * Rebuild map & panels to show only inside-radius content from a bundle.
 * @param {Object} bundle
 */
function applyRadiusVisibility(bundle) {
	// Rebuild markers & element bars
	state.map.clearMarkers();
	bundle.filtered.points.forEach(p => state.map.addPoint(p));

	// Determine element bars
	const elementsPanel = qs(".elements-panel");
	if (elementsPanel) {
		elementsPanel.innerHTML = "";

		// For each point in the bundle creating element bars
		bundle.filtered.points.forEach((p) => {
			const bar = createElementBar(p, (lat, lng) => {
				state.map.focusOn(lat, lng, 15, `<strong>${p.name ?? "Point"}</strong>`);
			});
			elementsPanel.appendChild(bar);
		});
	}

	// Rebuild polygons to only those intersecting radius
	state.map.clearPolygons();
	if (Array.isArray(state.polygons)) {
		state.map.addPolygonsFromCustom(bundle.filtered.polygons.map(f => f.__source ?? f));
	} else {
		bundle.filtered.polygons.forEach(f => state.map.addPolygonFeature(f));
	}

	// Reapply current stat toggles
	Object.entries(state.statToggle || {}).forEach(([aspect, on]) => {
		if (!on) state.map.toggleAspect(aspect);
	});
}

/** Restore full visibility (markers + polygons) from original state. */
function restoreFullVisibility() {
	// Rebuild markers & element bars
  	state.map.clearMarkers();
	state.points.forEach(p => state.map.addPoint(p));
	populateElementsPanel(state.points);

	// Rebuild polygons
	state.map.clearPolygons();
	if (Array.isArray(state.polygons)) state.map.addPolygonsFromCustom(state.polygons);
	else state.map.addPolygonsByAspect(state.polygons);

	// Reapply current stat toggles
	Object.entries(state.statToggle || {}).forEach(([aspect, on]) => {
		if (!on) state.map.toggleAspect(aspect);
	});
}

/** Show the score panel, hide instructions. */
function showScorePanel() {
	qs(".hab-score-panel")?.classList.remove("hidden");
	qs(".instructions-panel")?.classList.add("hidden");
}

/** Show instructions, hide the score panel. */
function showInstructionsPanel() {
	qs(".hab-score-panel")?.classList.add("hidden");
	qs(".instructions-panel")?.classList.remove("hidden");
}

/**
 * Mirror raw aspect values onto stat cards (not utilities).
 * @param {{air:any,crime:any,rent:any,school:any}} aspects
 */
function updateStatCardsFromAspects(aspects) {
	const set = (id, val) => {
		const el = qs(`#${id} .stat-value, #card-${id.toLowerCase()} .stat-value`);
		if (el) el.textContent = (val ?? "—");
	};
	const getVal = (o) => (o?.out_of_bounds ? null : o?.value ?? null);
	set("Air",    getVal(aspects.air));
	set("Crime",  getVal(aspects.crime));
	set("Rent",   getVal(aspects.rent));
	set("School", getVal(aspects.school));
}

/**
 * Write per-aspect utility scores (0–1) as 0–100 ints into value elements.
 * Missing/NaN values are hidden.
 * @param {ReturnType<import("./hab_score.js").computeAndRenderHabScore>} result
 */
function updateStatScoresFromResult(result) {
	const MAP = [
		{ key: "U_air",     id: "air_quality_index_value" },
		{ key: "U_crime",   id: "crime_rate_value" },
		{ key: "U_rent",    id: "median_rent_value" },
		{ key: "U_school",  id: "school_quality_value" },
		{ key: "U_transit", id: "transit_access_value" },
	];

	// Cycle for each stat polygons updating 
	for (const { key, id } of MAP) {
		const el = document.getElementById(id);
		if (!el) continue;
		const v = result[key];
		if (v == null || Number.isNaN(v)) {
			el.textContent = "";
			el.classList.add("hidden");
			continue;
		}
		el.textContent = Math.round(v * 100);
		el.classList.remove("hidden");
	}
}

/** Clear any previously written utility values and hide their slots. */
function clearStatScores() {
	[
		"air_quality_index_value",
		"crime_rate_value",
		"median_rent_value",
		"school_quality_value",
		"transit_access_value",
	].forEach(id => {
		const el = document.getElementById(id);
		if (!el) return;
		el.textContent = "";
		el.classList.add("hidden");
	});
}

// ---------- Start ----------
window.addEventListener("DOMContentLoaded", init);
