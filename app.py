"""
@file app.py
@description
Lightweight Flask application serving the habitability scoring UI and its
geospatial data. Provides routes for the main page and two JSON endpoints
(points and polygons) consumed by the front-end JavaScript.

Responsibilities:
- Initialize the Flask app.
- Serve the main HTML template (`index.html`).
- Load and return static JSON data files for points and polygons.
- Run in debug mode when executed directly.

External Dependencies:
- Flask (app framework)
- Jinja2 (via Flask `render_template`)
- json (Python standard library)

Used by:
- Frontend (`main.js` and related scripts) to populate the map and scoring system.
"""

from flask import Flask, render_template
import json

app = Flask(__name__)

# ---------------------- Routes ----------------------

@app.route("/")
def home():
    """
    Render the main UI page.

    Returns:
        str: Rendered HTML from templates/index.html
    """
    return render_template('index.html')

@app.route("/points")
def points():
    """
    Serve the static JSON file containing geospatial points.

    Returns:
        dict: Parsed JSON content of static/data/features.json
    """
    with open('static/data/features.json', 'r') as points_file:
        return json.load(points_file)
    
@app.route("/polygons")
def polygons():
    """
    Serve the static JSON file containing polygon features.

    Returns:
        dict: Parsed JSON content of static/data/features_poly.json
    """
    with open('static/data/features_poly.json', 'r') as polygons_file:
        return json.load(polygons_file)


if __name__ == "__main__":
    app.run(debug=True)