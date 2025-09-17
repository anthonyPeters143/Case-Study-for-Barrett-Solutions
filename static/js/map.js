/**
 * @file map.js
 * @description
 * Provides the `MapManager` class and helpers that wrap Leaflet.js for rendering
 * and interacting with points and polygons on the habitability map.
 *
 * Responsibilities:
 * - Initialize a Leaflet map instance with tile layers, markers, and polygon groups.
 * - Support adding points, focusing/clearing markers, and attaching popups.
 * - Import polygons from custom schema or GeoJSON Features, group them by `aspect`,
 *   and style them with deterministic colors.
 * - Toggle aspect visibility on/off and manage multiple aspect layers.
 * - Handle user interaction for selecting a map center and drawing a radius circle
 *   via double-click + drag, syncing with input fields.
 * - Attach spatial-analysis methods (on the prototype) for:
 *   - Filtering points/polygons within a radius
 *   - Testing point-in-polygon and polygon–circle intersection
 *   - Resolving aspect values at a point or transit-zone info
 *   - Building categorized element channels for habitability scoring
 *   - Collecting transit distances and syncing circle radius with UI inputs
 *
 * External Dependencies:
 * - Leaflet.js (global `L`)
 * - `colorForKey` from utils.js for stable color assignment
 *
 * Used by:
 * - `main.js` (UI bootstrap, habitability score workflow)
 * - `hab_score.js` indirectly through `main.js` bundles
 */

import { colorForKey } from "./utils.js";

/**
 * Transform your “custom polygon” records into GeoJSON Features.
 *
 * Input shape (per record):
 *   {
 *     type: "polygon",
 *     aspect: "air_quality_index" | "crime_rate" | "median_rent" | "school_quality" | "transit_access" | ...,
 *     coordinates: [[lon, lat], ...],        // ring (will be closed if needed)
 *     // and optionally:
 *     value?: number,                         // generic numeric value
 *     air_quality_index?|crime_rate?|...?,    // numeric per-aspect fields (if value missing)
 *     transit_distance?: number               // miles, for transit zones
 *     // any other metadata is preserved in Feature.properties
 *   }
 *
 * @param {Array<Object>} input
 * @returns {Array<import("geojson").Feature<import("geojson").Polygon>>}
 */
function featuresFromCustomPolys(input) {
    if (!Array.isArray(input)) return [];

    return input
        .filter(rec => rec && String(rec.type).toLowerCase() === "polygon" && Array.isArray(rec.coordinates))
        .map((rec) => {
            // Close ring if needed
            const ring = rec.coordinates.slice();
            const first = ring[0];
            const last = ring[ring.length - 1];
            if (!last || last[0] !== first[0] || last[1] !== first[1]) {
                ring.push([first[0], first[1]]);
            }

            const aspect = rec.aspect ?? "unknown";
            const props = { ...rec, aspect };

            return {
                type: "Feature",
                properties: { ...props, aspect },
                geometry: { type: "Polygon", coordinates: [ring] },
            };
        });
}

/**
 * Thin wrapper around Leaflet map + groups for points/polygons.
 * - Double-click the map to place a center, then drag to size a radius circle.
 * - Polygons are grouped by `properties.aspect` and can be toggled as layers.
 */
export class MapManager {
    /**
     * @param {string} [containerId="map"] DOM id of the map container
     */
    constructor(containerId = "map") {
        this.map = L.map(containerId, { doubleClickZoom: false }).setView([40.74, -73.98], 12);

        L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
            maxZoom: 19,
            attribution: '&copy; <a href="http://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        }).addTo(this.map);

        /** @type {L.LayerGroup} */
        this.markerLayer = L.layerGroup().addTo(this.map);

        /** Root container for all aspect groups */
        this.polygonRoot = L.layerGroup().addTo(this.map);

        /**
         * aspect → { layer: L.LayerGroup, visible: boolean }
         * @type {Map<string, {layer: L.LayerGroup, visible: boolean}>}
         */
        this.polygonGroups = new Map();

        /** @type {Array<{marker: L.Marker, data: any}>} */
        this._markers = [];

        // Draw interaction (center + circle)
        this.draw = { center: null, circle: null, isResizing: false };

        this._attachDoubleClickPointAndDragCircle();
    }

    /**
     * Add a single point marker (with popup).
     * @param {{latitude:number, longitude:number, name?:string}} p
     */
    addPoint(p) {
        const m = L.marker([p.latitude, p.longitude]).addTo(this.markerLayer);
        m.bindPopup(`<strong>${p.name ?? "Point"}</strong><br>${p.latitude}, ${p.longitude}`);
        this._markers.push({ marker: m, data: p });
    }

    /**
     * Fly the map to a location, optionally opening a popup there.
     * @param {number} lat
     * @param {number} lng
     * @param {number} [zoom=15]
     * @param {string|null} [popupHtml=null]
     */
    focusOn(lat, lng, zoom = 15, popupHtml = null) {
        this.map.setView([lat, lng], zoom, { animate: true });
        if (popupHtml) L.popup().setLatLng([lat, lng]).setContent(popupHtml).openOn(this.map);
    }

    /** Remove all markers previously added via {@link addPoint}. */
    clearMarkers() {
        this.markerLayer.clearLayers();
        this._markers = [];
    }

    /** Remove all polygons and aspect groups. */
    clearPolygons() {
        this.polygonRoot.clearLayers();
        this.polygonGroups.clear();
    }

    /**
     * Add polygons from your custom schema (see {@link featuresFromCustomPolys}).
     * Features are grouped by `properties.aspect` and styled by {@link colorForKey}.
     * @param {Array<Object>} customPolys
     */
    addPolygonsFromCustom(customPolys) {
        const feats = featuresFromCustomPolys(customPolys);

        // Group by aspect
        const byAspect = new Map();
        for (const f of feats) {
        const aspect = f.properties.aspect ?? "unknown";
        if (!byAspect.has(aspect)) byAspect.set(aspect, []);
        byAspect.get(aspect).push(f);
        }

        // Ensure a layer per aspect and add polygons
        byAspect.forEach((featureList, aspect) => {
            if (!this.polygonGroups.has(aspect)) {
                const layer = L.layerGroup().addTo(this.map);
                this.polygonRoot.addLayer(layer);
                this.polygonGroups.set(aspect, { layer, visible: true });
            }
            const { layer } = this.polygonGroups.get(aspect);

            // Cycle for each entry in the feature list 
            featureList.forEach((f) => {
                const color = colorForKey(aspect);
                try {
                    L.geoJSON(f, {
                        style: () => ({ color, weight: 2, fillOpacity: 0.2 }),
                        onEachFeature: (feature, lyr) => {
                            // Popup that tries aspect → value + zone label if present
                            try {
                                const props  = feature?.properties ?? {};
                                const a      = props.aspect || "unknown";
                                const title  = a.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
                                const valKey = a;
                                const value  = (valKey in props) ? props[valKey] : (props.value ?? null);
                                const zone   = props.zone_type || props.zone || null;

                                let body = `<div><strong>${title}</strong>`;
                                if (value !== null && value !== undefined) body += `: ${value}`;
                                body += `</div>`;
                                if (zone) body += `<div><em>${zone}</em></div>`;
                                lyr.bindPopup(body);
                            } catch {
                                try { lyr.bindPopup(`<pre>${JSON.stringify(feature?.properties || {}, null, 2)}</pre>`); } catch {}
                            }
                        },
                    }).addTo(layer);
                } 
                catch (err) {
                    console.error(`[MapManager] Failed to render polygon for aspect "${aspect}"`, err, f);
                }
            });
        });
    }

    /**
     * Add a single GeoJSON Feature (Polygon) already carrying `properties.aspect`.
     * @param {import("geojson").Feature<import("geojson").Polygon>} feature
     */
    addPolygonFeature(feature) {
        const aspect = feature?.properties?.aspect ?? "unknown";

        if (!this.polygonGroups.has(aspect)) {
            const layer = L.layerGroup().addTo(this.map);
            this.polygonRoot.addLayer(layer);
            this.polygonGroups.set(aspect, { layer, visible: true });
        }
        const { layer } = this.polygonGroups.get(aspect);

        const color = colorForKey(aspect);
        try {
            L.geoJSON(feature, {
                style: () => ({ color, weight: 2, fillOpacity: 0.2 }),
                onEachFeature: (feature, lyr) => {
                try {
                    const props  = feature?.properties ?? {};
                    const a      = props.aspect || "unknown";
                    const title  = a.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
                    const valKey = a;
                    const value  = (valKey in props) ? props[valKey] : (props.value ?? null);
                    const zone   = props.zone_type || props.zone || null;

                    let body = `<div><strong>${title}</strong>`;
                    if (value !== null && value !== undefined) body += `: ${value}`;
                    body += `</div>`;
                    if (zone) body += `<div><em>${zone}</em></div>`;
                    lyr.bindPopup(body);
                } 
                catch {
                    try { lyr.bindPopup(`<pre>${JSON.stringify(feature?.properties || {}, null, 2)}</pre>`); } catch {}
                }
                },
            }).addTo(layer);
        } catch (err) {
        console.error(`[MapManager] Failed to render polygon for aspect "${aspect}"`, err, feature);
        }
    }

    /**
     * Add a mixed list of Polygon Features (all must carry `properties.aspect`).
     * @param {Array<import("geojson").Feature<import("geojson").Polygon>>} features
     */
    addPolygonFeatures(features) {
        (features ?? []).forEach((f) => this.addPolygonFeature(f));
    }

    /**
     * Toggle visibility of the layer group for a given aspect.
     * @param {string} aspect
     */
    toggleAspect(aspect) {
        const entry = this.polygonGroups.get(aspect);
        if (!entry) return;
        if (entry.visible) {
        this.map.removeLayer(entry.layer);
        entry.visible = false;
        } else {
        entry.layer.addTo(this.map);
        entry.visible = true;
        }
    }

    /**
     * Flexible adder that accepts:
     * - Map/Record of `{ aspect: items }`
     * - OR an Array of custom polygon records (delegates to {@link addPolygonsFromCustom})
     *
     * Items can be:
     * - Array of items
     * - FeatureCollection
     * - Single Feature or `{ type:'Polygon', coordinates }` or `{ geometry:{...} }`
     *
     * Coordinates are assumed `[lon, lat]`.
     *
     * @param {Record<string, any>|Map<string, any>|Array<Object>} byAspectInput
     */
    addPolygonsByAspect(byAspectInput) {
        // Array of custom records → reuse converter
        if (Array.isArray(byAspectInput)) {
            return this.addPolygonsFromCustom(byAspectInput);
        }
        if (!byAspectInput) return;

        // Normalize to entries
        let entries;
        if (byAspectInput instanceof Map) {
            entries = Array.from(byAspectInput.entries());
        } 
        else if (typeof byAspectInput === "object") {
            entries = Object.entries(byAspectInput);
        } 
        else {
            console.warn("[MapManager] addPolygonsByAspect: unsupported input", byAspectInput);
            return;
        }

        for (const [aspectKey, itemsVal] of entries) {
            const aspect = aspectKey ?? "unknown";
            if (!this.polygonGroups.has(aspect)) {
                const layer = L.layerGroup().addTo(this.map);
                this.polygonRoot.addLayer(layer);
                this.polygonGroups.set(aspect, { layer, visible: true });
            }
            const { layer } = this.polygonGroups.get(aspect);
            const color = colorForKey(aspect);

            // Normalize to array
            let list;
            if (Array.isArray(itemsVal)) list = itemsVal;
            else if (itemsVal?.type === "FeatureCollection" && Array.isArray(itemsVal.features)) list = itemsVal.features;
            else if (itemsVal != null) list = [itemsVal];
            else list = [];

            list.forEach((item) => {
                try {
                    let feature = null;

                    if (item?.type === "Feature" && item.geometry) {
                        feature = { ...item, properties: { ...(item.properties || {}), aspect } };
                    } 
                    else if (item?.geometry?.type === "Polygon" && Array.isArray(item.geometry.coordinates)) {
                        const ring0 = item.geometry.coordinates[0] || [];
                        const ring = ring0.slice();
                        const first = ring[0], last = ring[ring.length - 1];
                        if (first && last && (first[0] !== last[0] || first[1] !== last[1])) ring.push([first[0], first[1]]);
                        feature = { type: "Feature", properties: { ...(item.properties || {}), aspect }, geometry: { type: "Polygon", coordinates: [ring] } };
                    } 
                    else if (item?.type === "Polygon" && Array.isArray(item.coordinates)) {
                        const ring = item.coordinates.slice();
                        const first = ring[0], last = ring[ring.length - 1];
                        if (first && last && (first[0] !== last[0] || first[1] !== last[1])) ring.push([first[0], first[1]]);
                        feature = { type: "Feature", properties: { ...(item.properties || {}), aspect }, geometry: { type: "Polygon", coordinates: [ring] } };
                    }

                    if (!feature) {
                        console.warn("[MapManager] addPolygonsByAspect: skipping unsupported item", item);
                        return;
                    }

                    L.geoJSON(feature, { style: () => ({ color, weight: 2, fillOpacity: 0.2 }) }).addTo(layer);
                } 
                catch (err) {
                    console.error(`[MapManager] Failed to add polygon for aspect "${aspect}"`, err, item);
                }
            });
        }
    }

    /**
     * Convenience wrapper for adding a FeatureCollection of Polygons.
     * @param {import("geojson").FeatureCollection<import("geojson").Polygon>} fc
     */
    addGeoJSONFeatureCollection(fc) {
        if (!fc || fc.type !== "FeatureCollection" || !Array.isArray(fc.features)) {
        console.warn("[MapManager] addGeoJSONFeatureCollection: not a FeatureCollection", fc);
        return;
        }
        this.addPolygonFeatures(fc.features);
    }

    /**
     * Install double-click (place center) + drag (resize circle) behavior.
     * - Disables normal map interactions while resizing, then restores them.
     * - Mirrors radius into `#radius-input` (meters).
     * @private
     */
    _attachDoubleClickPointAndDragCircle() {
        const map = this.map;
        if (!map) {
            console.error("[MapManager] _attachDoubleClickPointAndDragCircle: map missing");
            return;
        }

        map.doubleClickZoom && map.doubleClickZoom.disable();

        const latEl = document.querySelector("#latitude-input");
        const lonEl = document.querySelector("#longitude-input");
        const radEl = document.querySelector("#radius-input"); // meters

        const setLatLngInputs = (latlng) => {
            if (latEl) latEl.value = Number(latlng.lat).toFixed(6);
            if (lonEl) lonEl.value = Number(latlng.lng).toFixed(6);
        };

        const readRadiusMetersOrZero = () => {
            if (!radEl) return 0;
            const raw = String(radEl.value ?? "").trim();
            if (raw === "") return 0;
            const n = Number(raw);
            return Number.isFinite(n) && n >= 0 ? n : 0;
        };

        const setRadiusInputMeters = (meters) => {
            if (radEl) radEl.value = Math.round(Math.max(0, meters));
        };

        let moveHandler = null;
        let upHandler = null;
        let keyHandler = null;
        let prevInteractivity = null;

        const detachLiveHandlers = () => {
            if (moveHandler) { map.off("mousemove", moveHandler); moveHandler = null; }
            if (upHandler)   { map.off("mouseup",   upHandler);   upHandler   = null; }
            if (keyHandler)  { document.removeEventListener("keyup", keyHandler); keyHandler = null; }
        };

        const restoreInteractivity = () => {
            if (!prevInteractivity) return;
            if (prevInteractivity.dragging) map.dragging.enable();
            if (prevInteractivity.boxZoom) map.boxZoom.enable();
            if (prevInteractivity.scrollWheelZoom) map.scrollWheelZoom.enable();
            if (prevInteractivity.touchZoom) map.touchZoom.enable();
            if (prevInteractivity.keyboard && map.keyboard?.enable) map.keyboard.enable();
            if (prevInteractivity.cursor) map._container.style.cursor = prevInteractivity.cursor;
            prevInteractivity = null;
        };

        const cancelDrawing = () => {
            detachLiveHandlers();
            this.draw.isResizing = false;
            this.draw.center = null;
            if (this.draw.circle) {
                map.removeLayer(this.draw.circle);
                this.draw.circle = null;
            }
            restoreInteractivity();
        };

        map.on("dblclick", (e) => {
            setLatLngInputs(e.latlng);

            // Remove any prior circle
            if (this.draw.circle) {
                map.removeLayer(this.draw.circle);
                this.draw.circle = null;
            }

            this.draw.center = e.latlng;

            // Initial radius from input (meters) or 0
            const initialRadiusMeters = readRadiusMetersOrZero();

            this.draw.circle = L.circle(this.draw.center, {
                radius: initialRadiusMeters, // meters
                color: "#3388ff",
                weight: 2,
                fillColor: "#3388ff",
                fillOpacity: 0.2,
            }).addTo(map);

            setRadiusInputMeters(initialRadiusMeters);

            // Next mousedown → start resizing (and temporarily disable panning)
            const startResize = (downEvt) => {
                this.draw.isResizing = true;

                if (downEvt?.originalEvent) {
                    downEvt.originalEvent.preventDefault();
                    downEvt.originalEvent.stopPropagation();
                }

                // Remember & disable map interactions while resizing
                prevInteractivity = {
                    dragging: map.dragging.enabled(),
                    boxZoom: map.boxZoom.enabled(),
                    scrollWheelZoom: map.scrollWheelZoom.enabled(),
                    touchZoom: map.touchZoom.enabled(),
                    keyboard: map.keyboard && map.keyboard.enabled && map.keyboard.enabled(),
                    cursor: map._container.style.cursor || "",
                };
                map.dragging.disable();
                map.boxZoom.disable();
                map.scrollWheelZoom.disable();
                map.touchZoom.disable();
                if (map.keyboard?.disable) map.keyboard.disable();
                map._container.style.cursor = "crosshair";

                moveHandler = (moveEvt) => {
                    if (!this.draw.isResizing || !this.draw.center || !this.draw.circle) return;
                    const meters = map.distance(this.draw.center, moveEvt.latlng);
                    this.draw.circle.setRadius(Math.max(0, meters));
                    setRadiusInputMeters(meters);
                };

                upHandler = () => {
                    this.draw.isResizing = false;
                    detachLiveHandlers();
                    restoreInteractivity();
                };

                keyHandler = (kev) => {
                    if (kev.key === "Escape") cancelDrawing();
                };

                map.on("mousemove", moveHandler);
                map.on("mouseup",   upHandler);
                document.addEventListener("keyup", keyHandler);

                // Only once after each dblclick
                map.off("mousedown", startResize);
            };

            map.on("mousedown", startResize);
        });

        map.on("unload", cancelDrawing);
    }
}

/* ====== Radius & zone helpers (prototype methods, no external deps) ====== */
(function() {
    /** Mean Earth radius in meters (spherical approximation). */
    const EARTH_RADIUS_M = 6371008.8;

    /** Convert degrees to radians. */
    const toRad = (deg) => (deg * Math.PI) / 180;

    /** Tiny epsilon to avoid division-by-zero. */
    const EPS = 1e-9;

    /**
     * Great-circle distance between two lat/lon points using the haversine formula.
     * Inputs/outputs are in **meters**.
     *
     * @param {number} lat1 Latitude of point A (degrees)
     * @param {number} lon1 Longitude of point A (degrees)
     * @param {number} lat2 Latitude of point B (degrees)
     * @param {number} lon2 Longitude of point B (degrees)
     * @returns {number} Distance in meters
     */
    function haversineMeters(lat1, lon1, lat2, lon2) {
        const φ1 = toRad(lat1), λ1 = toRad(lon1);
        const φ2 = toRad(lat2), λ2 = toRad(lon2);
        const dφ = φ2 - φ1, dλ = λ2 - λ1;
        const a = Math.sin(dφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(dλ/2)**2;
        return 2 * EARTH_RADIUS_M * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    /**
     * Locally project a (lat,lon) to a planar XY (meters) around an origin.
     * NOTE: Small-area equirectangular approximation; accurate enough for
     * our short segment distance tests near the selection circle.
     *
     * @param {number} lat0 Origin latitude (degrees)
     * @param {number} lon0 Origin longitude (degrees)
     * @param {number} lat  Target latitude (degrees)
     * @param {number} lon  Target longitude (degrees)
     * @returns {{x:number,y:number}} Local meters relative to (lat0,lon0)
     */
    function projectLocal(lat0, lon0, lat, lon) {
        const x = toRad(lon - lon0) * Math.cos(toRad(lat0)) * EARTH_RADIUS_M;
        const y = toRad(lat - lat0) * EARTH_RADIUS_M;
        return { x, y };
    }

    /**
     * Shortest distance from a point to a line segment on Earth’s surface,
     * computed in a local planar projection centered at the test point.
     * All positions are given as [lon,lat] arrays.
     *
     * @param {number} lat0 Latitude of projection origin (degrees)
     * @param {number} lon0 Longitude of projection origin (degrees)
     * @param {[number,number]} P Test point [lon,lat]
     * @param {[number,number]} A Segment start [lon,lat]
     * @param {[number,number]} B Segment end [lon,lat]
     * @returns {number} Distance in meters
     */
    function distancePointToSegmentMeters(lat0, lon0, P, A, B) {
        const p = projectLocal(lat0, lon0, P[1], P[0]);
        const a = projectLocal(lat0, lon0, A[1], A[0]);
        const b = projectLocal(lat0, lon0, B[1], B[0]);
        const vx = b.x - a.x, vy = b.y - a.y;
        const wx = p.x - a.x, wy = p.y - a.y;
        const c1 = vx*wx + vy*wy;
        const c2 = vx*vx + vy*vy;
        let t = c2 > EPS ? c1 / c2 : 0;
        t = Math.max(0, Math.min(1, t));
        const cx = a.x + t*vx, cy = a.y + t*vy;
        return Math.hypot(p.x - cx, p.y - cy);
    }

    /**
     * Point-in-polygon test (ray casting) for GeoJSON Polygon/MultiPolygon.
     * Coordinates are **[lon,lat]**. Holes are handled by ring parity.
     *
     * @param {[number,number]} point [lon,lat]
     * @param {{type:"Polygon"|"MultiPolygon",coordinates:any}} polygon
     * @returns {boolean} True if the point lies strictly inside the polygon
     */
    function pointInPolygon(point, polygon) {
        const testRings = (rings) => {
            let inside = false;
            for (const ring of rings) {
                for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
                    const xi = ring[i][0], yi = ring[i][1];
                    const xj = ring[j][0], yj = ring[j][1];
                    const intersect = ((yi > point[1]) !== (yj > point[1])) &&
                                        (point[0] < (xj - xi) * (point[1] - yi) / ((yj - yi) || EPS) + xi);
                    if (intersect) inside = !inside;
                }
            }
            return inside;
        };
        if (!polygon) return false;
        if (polygon.type === "Polygon") return testRings(polygon.coordinates);
        if (polygon.type === "MultiPolygon") {
            for (const poly of polygon.coordinates) if (testRings(poly)) return true;
        }
        return false;
    }

    /**
     * Minimum distance from a point to a polygon boundary in **meters**.
     * Used to rank the “nearest zone” when the center isn’t inside any polygon.
     *
     * @param {[number,number]} point [lon,lat]
     * @param {{type:"Polygon"|"MultiPolygon",coordinates:any}} polygon
     * @returns {number} Distance in meters
     */
    function distancePointToPolygonBoundaryMeters(point, polygon) {
        const [lon0, lat0] = point;
        let min = Infinity;
        const scan = (rings) => {
            for (const ring of rings) {
                for (let i = 0; i < ring.length - 1; i++) {
                    const d = distancePointToSegmentMeters(lat0, lon0, point, ring[i], ring[i+1]);
                    if (d < min) min = d;
                }
            }
        };
        if (polygon.type === "Polygon") scan(polygon.coordinates);
        if (polygon.type === "MultiPolygon") for (const poly of polygon.coordinates) scan(poly);
        return min;
    }

    /**
     * Quick intersection test: does a GeoJSON polygon intersect a circle?
     * Returns true if the circle center is inside the polygon OR if any polygon
     * edge is within the radius of the center point.
     *
     * @param {[number,number]} point [lon,lat] circle center
     * @param {number} radiusM Circle radius in meters
     * @param {{type:"Polygon"|"MultiPolygon",coordinates:any}} polygon
     * @returns {boolean} Whether they intersect
     */
    function polygonIntersectsCircle(point, radiusM, polygon) {
        if (pointInPolygon(point, polygon)) return true;
        const within = (rings) => {
            for (const ring of rings) {
                for (let i = 0; i < ring.length - 1; i++) {
                const d = distancePointToSegmentMeters(point[1], point[0], point, ring[i], ring[i+1]);
                if (d <= radiusM) return true;
                }
            }
            return false;
        };
        if (polygon.type === "Polygon") return within(polygon.coordinates);
        if (polygon.type === "MultiPolygon") {
            for (const poly of polygon.coordinates) if (within(poly)) return true;
        }
        return false;
    }

    /* ---------- Prototype methods that consume the helpers above ---------- */

    /**
     * Filter input points to those within a radius of the center.
     * Shallow-copies each point and adds `_distance_m`.
     *
     * @param {{lat:number, lon:number}} center
     * @param {number} radiusM Radius in meters
     * @param {Array<any>} points Input points (supports {lat,lon} or {latitude,longitude})
     * @returns {Array<any & {_distance_m:number}>}
     */
    MapManager.prototype.filterPointsInRadius = function(center, radiusM, points) {
        return points
        .map(p => {
            const lon = p.longitude ?? p.lon ?? p.lng ?? (p.geometry?.coordinates?.[0]);
            const lat = p.latitude  ?? p.lat ?? (p.geometry?.coordinates?.[1]);
            const d = haversineMeters(center.lat, center.lon, lat, lon);
            return { ...p, _distance_m: d };
        })
        .filter(p => p._distance_m <= radiusM);
    };

    /**
     * Filter polygons (custom schema or Feature) to those intersecting a circle.
     * Returns **GeoJSON Features**; preserves original record at `__source` when applicable.
     *
     * @param {{lat:number, lon:number}} center
     * @param {number} radiusM Radius in meters
     * @param {Array<any>} polygons Custom polygon records or Features
     * @returns {Array<import("geojson").Feature<import("geojson").Polygon>>}
     */
    MapManager.prototype.filterPolygonsInRadius = function(center, radiusM, polygons) {
        const point = [center.lon, center.lat];
        const toFeature = (rec) => {
            if (rec.type === "Feature" && rec.geometry) return rec;
            const aspectKey = rec.aspect || rec.properties?.aspect;

            let val = rec.value;
            if (val == null && aspectKey) {
                if (aspectKey === "transit_access") {
                    val = rec.transit_distance ?? rec.properties?.transit_distance ?? null;
                } 
                else {
                    val = rec[aspectKey] ?? rec.properties?.[aspectKey] ?? null;
                }
            }

            return {
                type: "Feature",
                properties: {
                ...(rec.properties || {}),
                aspect: aspectKey,
                value: val,
                transit_distance: rec.transit_distance ?? rec.properties?.transit_distance ?? null,
                },
                geometry: { type: "Polygon", coordinates: [rec.coordinates] },
                __source: rec,
            };
        };

        const feats = polygons.map(toFeature);
        return feats.filter(f => polygonIntersectsCircle(point, radiusM, f.geometry));
    };

    /**
     * Resolve which aspect polygon covers the center (or nearest zone),
     * returning `{ out_of_bounds:true }` if none cover the center and none exist.
     *
     * @param {{lat:number, lon:number}} center
     * @param {Array<any>} aspectPolys Array of custom records or Features (single aspect)
     * @returns {{
     *   out_of_bounds: boolean,
     *   source?: "center_inside" | "near_single_zone",
     *   value?: number|null,
     *   polygon?: import("geojson").Feature<import("geojson").Polygon>,
     *   distance_to_boundary_m?: number
     * }}
     */
    MapManager.prototype.resolveAspectValueAtPoint = function(center, aspectPolys) {
        const point = [center.lon, center.lat];

        const toFeature = (rec) => {
            if (rec.type === "Feature" && rec.geometry) return rec;

            const aspectKey = rec.aspect || rec.properties?.aspect;
            let val = rec.value;
            if (val == null && aspectKey) {
                if (aspectKey === "transit_access") {
                    val = rec.transit_distance ?? rec.properties?.transit_distance ?? null;
                } 
                else {
                    val = rec[aspectKey] ?? rec.properties?.[aspectKey] ?? null;
                }
            }

            // Ensure ring closed
            const ring = rec.coordinates?.slice?.() || rec.geometry?.coordinates?.[0]?.slice?.() || [];
            if (ring.length > 0) {
                const first = ring[0], last = ring[ring.length - 1];
                if (first && last && (first[0] !== last[0] || first[1] !== last[1])) ring.push([first[0], first[1]]);
            }

            return {
                type: "Feature",
                properties: { ...(rec.properties || {}), aspect: aspectKey, value: val, transit_distance: rec.transit_distance ?? rec.properties?.transit_distance ?? null },
                geometry: { type: "Polygon", coordinates: [ring] },
            };
        };

        const feats = (aspectPolys || []).map(toFeature);

        // 1) Inside any polygon?
        for (const poly of feats) {
        if (pointInPolygon(point, poly.geometry)) {
            const distM = distancePointToPolygonBoundaryMeters(point, poly.geometry);
            return { out_of_bounds:false, source:"center_inside", value: poly.properties.value, polygon: poly, distance_to_boundary_m: distM };
        }
        }

        // 2) Otherwise take the nearest boundary among the candidates
        let best = { poly: null, distM: Infinity };
        for (const poly of feats) {
        const d = distancePointToPolygonBoundaryMeters(point, poly.geometry);
        if (d < best.distM) best = { poly, distM: d };
        }
        if (best.poly) {
        return { out_of_bounds:false, source:"near_single_zone", value: best.poly.properties.value, polygon: best.poly, distance_to_boundary_m: best.distM };
        }
        return { out_of_bounds:true };
    };

    /**
     * Transit-specific wrapper that includes distance to the zone edge.
     * `zone_transit_distance` is whatever the polygon provides (miles in your data).
     *
     * @param {{lat:number, lon:number}} center
     * @param {Array<any>} transitPolys Transit aspect polygons
     * @returns {{ out_of_bounds:boolean, source?:string, zone_transit_distance?:number|null, distance_to_zone_edge_m?:number }}
     */
    MapManager.prototype.resolveTransitZoneInfo = function(center, transitPolys) {
        const base = this.resolveAspectValueAtPoint(center, transitPolys);
        if (base.out_of_bounds) return { out_of_bounds:true };
        const point = [center.lon, center.lat];
        const dEdge = pointInPolygon(point, base.polygon.geometry)
        ? distancePointToPolygonBoundaryMeters(point, base.polygon.geometry)
        : (base.distance_to_boundary_m ?? distancePointToPolygonBoundaryMeters(point, base.polygon.geometry));
        return {
            out_of_bounds: false,
            source: base.source,
            zone_transit_distance: base.polygon.properties.transit_distance ?? null, // miles (converted to km later)
            distance_to_zone_edge_m: dEdge
        };
    };

    /**
     * Collect distances to “Transit” points among the pre-filtered set.
     * Distances come from `_distance_m` (set by filterPointsInRadius) and are
     * returned as **kilometers** for the scorer.
     *
     * @param {Array<any & {_distance_m:number}>} pointsIn
     * @returns {number[]} Distances in kilometers
     */
    MapManager.prototype.collectTransitDistancesKm = function(pointsIn) {
        const isTr = (p)=> (p.type==="Transit" || p.category==="Transit" || p.properties?.category==="Transit");
        return pointsIn.filter(isTr).map(p => (p._distance_m ?? 0)/1000);
    };

  /**
   * Build element “channels” used by the scorer: positive / negative / neutral
   * lists of distances (km) and a combined `[distance_km, sign]` array.
   *
   * @param {{lat:number, lon:number}} center
   * @param {Array<any & {_distance_m:number}>} pointsIn
   * @param {{perType?: Record<string,"good"|"bad"|"neutral">}} prefs
   * @returns {{ elements_pairs:Array<[number,-1|0|1]>, pos_km:number[], neg_km:number[], neu_km:number[] }}
   */
    MapManager.prototype.buildElementChannels = function(center, pointsIn, prefs) {
        const elements_pairs = [], pos_km = [], neg_km = [], neu_km = [];
        for (const pt of pointsIn) {
            const kind = pt.type || pt.properties?.type || pt.properties?.category || "Unknown";
            const choice = prefs?.perType?.[kind] ?? prefs?.[kind] ?? "neutral";
            const km = (pt._distance_m ?? 0) / 1000;
            let sign = 0;
            if (choice === "good") sign = +1;
            else if (choice === "bad") sign = -1;
            elements_pairs.push([km, sign]);
            if (sign > 0) pos_km.push(km);
            else if (sign < 0) neg_km.push(km);
            else neu_km.push(km);
        }
        return { elements_pairs, pos_km, neg_km, neu_km };
    };
})();
