/**
 * @file hab_score.js
 * @description Habitability v3 scorer and small DOM renderer.
 * Produces a bounded 0–100 score from mixed inputs (environment stats + nearby elements).
 *
 * Inputs:
 *  - Stats: air, crime, rent (all prefer lower), school (higher is better).
 *  - Transit: array of distances (km) to transit points/polygons near the location.
 *  - Elements: pairs of [distance_km, sign] where sign ∈ {-1,0,+1} for bad/neutral/good.
 *
 * Outputs:
 *  - An object with per-component utilities and the final Score (0–100).
 *  - An optional DOM render helper that fills `.hab-score-panel` if present.
 */

/**
 * Clamp a number into [0,1].
 * @param {number} x
 * @returns {number}
 */
function clamp01(x){ return Math.max(0, Math.min(1, x)); }

/**
 * Utility curve for attributes where "lower is better"
 * (e.g., air index, crime, rent). Maps x≥0 → (0,1], approaches 1 near 0.
 * Uses 1 / (1 + ln(1 + x)).
 * @param {?number} x
 * @returns {number} Utility in [0,1]
 */
function U_lower_log(x){
    x = Math.max(0, x ?? 0);
    return 1 / (1 + Math.log1p(x));
}

/**
 * Utility for school quality where "higher is better".
 * Simple linear scale normalized to [0,1] with an assumed 0–10 band.
 * @param {?number} x
 * @returns {number} Utility in [0,1]
 */
function U_school(x){
    return clamp01((x ?? 0) / 10);
}

/**
 * Radial decay weight: e^{-d}. Distance is in the same units as inputs to `saturating`.
 * @param {?number} d
 * @returns {number}
 */
function w_decay(d){
    d = Math.max(0, d ?? 0);
    return Math.exp(-d);
}

/**
 * Saturating aggregator for multiple distances:
 *   1 - Π_i (1 - clamp01(rho * e^{-d_i}))
 * Interpretable as "probability at least one nearby thing matters" with decay.
 * @param {number[]} distances - distances in consistent units (km for elements/transit)
 * @param {number} rho - scaling factor (≈1.0 is a good default)
 * @returns {number} value in [0,1]
 */
function saturating(distances, rho){
    let prod = 1.0;
    for (const d of distances || []) {
        const term = clamp01((rho ?? 1) * w_decay(d));
        prod *= (1 - term);
    }
    return 1 - prod;
}

/**
 * Compute habitability v3 as a mean of component utilities.
 *
 * Component utilities pushed into the mean (when present):
 *  - U_air, U_crime, U_rent, U_school (scalar stats)
 *  - U_transit (saturating over transit distances in km)
 *  - P_pos (saturating of positive elements)
 *  - 1 - P_neg (penalty for negative elements, pushed as its "goodness")
 *
 * @param {Object} args
 * @param {?number} args.air     - lower is better (index-like)
 * @param {?number} args.crime   - lower is better
 * @param {?number} args.rent    - lower is better
 * @param {?number} args.school  - higher is better (0–10 assumed)
 * @param {number[]} args.transit - transit distances in kilometers
 * @param {Array<[number, -1|0|1]>} args.elements - [distance_km, sign] pairs
 * @returns {{
 *  Score:number,
 *  U_air?:number, U_crime?:number, U_rent?:number, U_school?:number,
 *  U_transit:number,
 *  P_pos:number,
 *  P_neg_goodness:number,
 *  P_neutral_overlay:number
 * }}
 */
export function score_v3({ air, crime, rent, school, transit, elements }) {
    // Create storage
    const comps = [];
    const out = {};

    // Check if stat value is passed then calc and store the values
    if (air    != null){ out.U_air    = U_lower_log(air);    comps.push(out.U_air); }
    if (crime  != null){ out.U_crime  = U_lower_log(crime);  comps.push(out.U_crime); }
    if (rent   != null){ out.U_rent   = U_lower_log(rent);   comps.push(out.U_rent); }
    if (school != null){ out.U_school = U_school(school);    comps.push(out.U_school); }

    // Transit as saturating function over km distances
    out.U_transit = (transit?.length ? saturating(transit, 1.0) : 0.0);
    comps.push(out.U_transit);

    // Split elements into sign buckets (distance in km)
    const pos = (elements||[]).filter(([d,s])=> s>0).map(([d])=>d);
    const neg = (elements||[]).filter(([d,s])=> s<0).map(([d])=>d);
    const neu = (elements||[]).filter(([d,s])=> s===0).map(([d])=>d);

    // Calc the element values
    out.P_pos = pos.length ? saturating(pos, 0.6) : 0.0;
    const P_neg = neg.length ? saturating(neg, 0.6) : 0.0;
    out.P_neg_goodness = 1 - P_neg;
    out.P_neutral_overlay = neu.length ? saturating(neu, 0.6) : 0.0; // display-only

    // Store the element values
    comps.push(out.P_pos, out.P_neg_goodness);

    // Calc then store hab score
    const mean = comps.length ? (comps.reduce((a,b)=>a+b,0)/comps.length) : 0.0;
    out.Score = 100 * mean;
    
    // Return payload 
    return out;

}

/**
 * Render helper that:
 *  Computes score_v3 from a pre-built bundle (see main.js buildHabBundle),
 *  Shows `.hab-score-panel`, hides `.instructions-panel`,
 *  Writes a short, human-readable summary into `.hab-score-panel`.
 *
 * @param {Object} bundle
 * @param {Object} bundle.aspects
 * @param {Object} bundle.channels
 * @param {number[]} bundle.channels.transit_km - transit distances (km)
 * @param {Array<[number, -1|0|1]>} bundle.channels.elements_pairs
 * @param {Object} bundle.filtered
 * @returns {ReturnType<score_v3>} The computed score object (useful for tests/logging)
 */
export function computeAndRenderHabScore(bundle){
    // Calculate the hab score
    const getVal = (o)=> (o?.out_of_bounds ? null : (o?.value ?? null));
    const result = score_v3({
        air:    getVal(bundle.aspects.air),
        crime:  getVal(bundle.aspects.crime),
        rent:   getVal(bundle.aspects.rent),
        school: getVal(bundle.aspects.school),
        transit: bundle.channels.transit_km,
        elements: bundle.channels.elements_pairs
    });

    // Determine DOM elements
    const scorePanel = document.querySelector(".hab-score-panel");
    const instPanel  = document.querySelector(".instructions-panel");
    
    // Update the elements to hide the instructions and show the score
    if (scorePanel) scorePanel.classList.remove("hidden");
    if (instPanel)  instPanel.classList.add("hidden");

    // Update results output to results panel
    if (scorePanel){
        scorePanel.innerHTML = `
        <div class="score-row"><strong>Habitability Score :</strong> ${result.Score.toFixed(2)} / 100</div>
        <div class="score-row">Scores: ${[["Air",result.U_air],["Crime",result.U_crime],["Rent",result.U_rent],["School",result.U_school],["Transit",result.U_transit]].filter(([k,v])=> v!=null && !Number.isNaN(v)).map(([k,v])=> `${k}: ${v.toFixed(3)}`).join(", ") || "—"}</div>
        <div class="score-row small">
            Inside radius: ${bundle.filtered.points.length} points, ${bundle.filtered.polygons.length} polygons
        </div>
        `;
    }

    // Return payload
    return result;
}
