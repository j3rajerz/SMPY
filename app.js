/* Military GPS Web App for GitHub Pages */

// Map style: dark military (MapLibre-compatible raster tiles from Carto/OSM alternatives)
// We will use Esri Satellite + OSM dark as examples with proper attribution.

let map, draw, drawnItems, trailLine, accuracyCircle;
let watchId = null;
let lastPosition = null;
let trackCoords = [];
let waypoints = [];
const WAYPOINTS_KEY = 'fieldgps.waypoints.v1';
let useOffline = false;
let offlineLayer = null;
let SQL = null;
let mbtilesDb = null;
const SETTINGS_KEY = 'fieldgps.settings.v1';
let settings = { maxAccM: 20, alertRadiusM: 30 };
let speedHistory = []; // last N speeds (km/h)
let altHistory = [];   // last N altitudes (m)
const HIST_LIMIT = 60;
let followMode = false;
let trackingEnabled = true;
let navTarget = null; // {lat, lon, label} or null
let navLine = null;

// UTM helpers using proj4
function getUtmZone(longitude) {
  return Math.floor((longitude + 180) / 6) + 1;
}

function getUtmProj(longitude, latitude) {
  const zone = getUtmZone(longitude);
  const isNorthern = latitude >= 0;
  const projName = `+proj=utm +zone=${zone} ${isNorthern ? "+north" : "+south"} +datum=WGS84 +units=m +no_defs`;
  return { zone, proj: proj4("EPSG:4326", projName) };
}

function toUtm(lat, lon) {
  const { zone, proj } = getUtmProj(lon, lat);
  const [easting, northing] = proj.forward([lon, lat]);
  const band = latToBand(lat);
  return { zone, band, easting: Math.round(easting), northing: Math.round(northing) };
}

function latToBand(lat) {
  const bands = "CDEFGHJKLMNPQRSTUVWX"; // UTM bands
  const index = Math.floor((lat + 80) / 8);
  return bands[Math.max(0, Math.min(bands.length - 1, index))];
}

function fmt(n, digits = 6) { return n.toFixed(digits); }

function initMap() {
  map = L.map('map', {
    zoomControl: true,
    attributionControl: true,
  }).setView([35.6892, 51.3890], 13);

  // Base layers (no API key): OSM, CARTO Dark, ESRI WorldImagery, and Stamen Toner Lite (traffic-like contrast)
  const osm = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© OpenStreetMap', crossOrigin: true
  });
  const cartoDark = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    maxZoom: 20, attribution: '© OpenStreetMap, © CARTO', crossOrigin: true
  });
  const esriSat = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19, attribution: 'Tiles © Esri — Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye', crossOrigin: true
  });
  const tonerLite = L.tileLayer('https://stamen-tiles.a.ssl.fastly.net/toner-lite/{z}/{x}/{y}.png', {
    maxZoom: 20, attribution: 'Map tiles by Stamen Design, CC BY 3.0 — Map data © OpenStreetMap', crossOrigin: true
  });
  cartoDark.addTo(map);

  // Simple traffic-style overlay: use Stamen Toner Lines over satellite/dark
  const tonerLines = L.tileLayer('https://stamen-tiles.a.ssl.fastly.net/toner-lines/{z}/{x}/{y}.png', {
    maxZoom: 20, opacity: 0.6, crossOrigin: true
  });

  L.control.layers(
    {
      'OSM': osm,
      'Dark': cartoDark,
      'Satellite (Esri)': esriSat,
      'Toner Lite (روشن)': tonerLite,
    },
    {
      'راه‌ها (Toner Lines)': tonerLines,
      'آفلاین (MBTiles)': offlineLayer || L.layerGroup(),
    },
    { position: 'topright', collapsed: false }
  ).addTo(map);

  drawnItems = new L.FeatureGroup();
  map.addLayer(drawnItems);

  draw = new L.Control.Draw({
    position: 'topleft',
    draw: {
      circle: false,
      marker: false,
      rectangle: false,
      circlemarker: false,
      polyline: { shapeOptions: { color: '#39ff14', weight: 3 } },
      polygon: { shapeOptions: { color: '#39ff14', weight: 2, fillOpacity: 0.1 } }
    },
    edit: { featureGroup: drawnItems }
  });
  map.addControl(draw);

  // Scale control
  L.control.scale({ imperial: false }).addTo(map);

  // Simple North arrow control (Leaflet is north-up; static arrow)
  const North = L.Control.extend({
    options: { position: 'topright' },
    onAdd: function() {
      const div = L.DomUtil.create('div', 'leaflet-bar');
      div.style.padding = '6px 8px';
      div.style.background = '#0a110d';
      div.style.border = '2px solid #556b2f';
      div.style.color = '#a6ff00';
      div.style.fontWeight = '800';
      div.innerHTML = 'N ↑';
      return div;
    }
  });
  map.addControl(new North());

  map.on(L.Draw.Event.CREATED, (e) => {
    const layer = e.layer;
    drawnItems.addLayer(layer);
    updateMeasurementOverlay(layer);
  });

  map.on(L.Draw.Event.EDITED, (e) => {
    Object.values(e.layers._layers).forEach((layer) => updateMeasurementOverlay(layer));
  });

  map.on('draw:drawvertex', () => {
    // Update live measures while drawing if possible
    const last = Object.values(drawnItems._layers).slice(-1)[0];
    if (last) updateMeasurementOverlay(last);
  });

  // Trail polyline with glow effect (duplicated polyline technique)
  trailLine = L.polyline([], { color: '#39ff14', weight: 3, opacity: 0.9 }).addTo(map);
}

function updateMeasurementOverlay(layer) {
  const el = document.getElementById('measure-overlay');
  let text = '';
  if (!layer) { el.classList.add('hidden'); return; }
  if (layer.getLatLngs) {
    const coords = layer.getLatLngs();
    let flat = coords;
    if (Array.isArray(coords[0])) flat = coords[0];
    if (flat.length >= 2) {
      const line = turf.lineString(flat.map(ll => [ll.lng, ll.lat]));
      const lengthM = turf.length(line, { units: 'kilometers' }) * 1000;
      text += `Length: ${lengthM.toFixed(1)} m\n`;
    }
    if (flat.length >= 3 && layer instanceof L.Polygon) {
      const poly = turf.polygon([[...flat.map(ll => [ll.lng, ll.lat]), [flat[0].lng, flat[0].lat]]]);
      const areaM2 = turf.area(poly);
      text += `Area: ${areaM2.toFixed(1)} m²`;
    }
  }
  if (text) {
    el.textContent = text;
    el.classList.remove('hidden');
  } else {
    el.classList.add('hidden');
  }
}

function requestHighAccuracyPosition() {
  if (!('geolocation' in navigator)) {
    setGpsStatus(false);
    return;
  }
  watchId = navigator.geolocation.watchPosition(onPosition, onPositionError, {
    enableHighAccuracy: true,
    maximumAge: 1000,
    timeout: 10000,
  });
}

function onPosition(pos) {
  const { latitude, longitude, altitude, accuracy, speed, heading } = pos.coords;
  lastPosition = pos;

  const utm = toUtm(latitude, longitude);
  document.getElementById('utm').textContent = `${utm.zone}${utm.band} ${utm.easting} ${utm.northing}`;
  document.getElementById('latlon').textContent = `${fmt(latitude, 6)}, ${fmt(longitude, 6)}`;
  document.getElementById('alt').textContent = altitude != null ? Math.round(altitude) : '—';
  document.getElementById('acc').textContent = accuracy != null ? Math.round(accuracy) : '—';
  const speedKmh = speed != null ? (speed * 3.6) : null;
  document.getElementById('speed').textContent = speedKmh != null ? speedKmh.toFixed(1) : '—';

  // Heading indicator
  const hdg = (heading != null && !Number.isNaN(heading)) ? heading : computeCourseFromTrack(latitude, longitude);
  setHeading(hdg);

  // Trail update
  trackCoords.push([latitude, longitude]);
  trailLine.addLatLng([latitude, longitude]);

  // Accuracy circle
  if (!accuracyCircle) {
    accuracyCircle = L.circle([latitude, longitude], { radius: accuracy || 0, color: '#a6ff00', weight: 1, fillColor: '#a6ff00', fillOpacity: 0.1 }).addTo(map);
  } else {
    accuracyCircle.setLatLng([latitude, longitude]);
    if (accuracy != null) accuracyCircle.setRadius(accuracy);
  }

  // Center map on first fix
  if (trackCoords.length === 1 || followMode) { map.setView([latitude, longitude], followMode ? map.getZoom() : 17); }

  setGpsStatus(true);

  // Append history and render sparkline
  if (speedKmh != null) { speedHistory.push(speedKmh); if (speedHistory.length > HIST_LIMIT) speedHistory.shift(); }
  if (altitude != null) { altHistory.push(altitude); if (altHistory.length > HIST_LIMIT) altHistory.shift(); }
  renderSparkline();

  // Accuracy filter: ignore points worse than threshold for alerts
  if (accuracy != null && accuracy > settings.maxAccM) return;
  // Proximity alert
  checkProximityAlerts(latitude, longitude);

  // Navigation overlay
  updateNavigationOverlay(latitude, longitude);
}

function onPositionError(err) {
  console.warn('GPS error', err);
  setGpsStatus(false);
}

function computeCourseFromTrack(lat, lon) {
  if (trackCoords.length < 1) return null;
  const [pLat, pLon] = trackCoords[trackCoords.length - 1];
  const bearing = turf.bearing(turf.point([pLon, pLat]), turf.point([lon, lat]));
  return (bearing + 360) % 360;
}

function setHeading(deg) {
  const el = document.getElementById('heading');
  if (deg == null) { el.textContent = '—°'; return; }
  el.textContent = `${deg.toFixed(0)}°`;
  const red = document.getElementById('needle-red');
  const green = document.getElementById('needle-green');
  red.style.transform = `translate(-50%, -90%) rotate(${deg}deg)`;
  green.style.transform = `translate(-50%, -10%) rotate(${deg + 180}deg)`;
}

function setGpsStatus(ok) {
  const el = document.getElementById('gps-status');
  el.textContent = ok ? 'GPS' : 'GPS?';
  el.classList.toggle('offline', !ok);
  el.classList.toggle('online', ok);
}

function setOnlineStatus() {
  const el = document.getElementById('online-status');
  const online = navigator.onLine;
  el.textContent = online ? 'ONLINE' : 'OFFLINE';
  el.classList.toggle('online', online);
}

function addWaypointFromCurrent() {
  if (!lastPosition) return;
  const { latitude, longitude, altitude, accuracy } = lastPosition.coords;
  const utm = toUtm(latitude, longitude);
  const wp = {
    id: Date.now().toString(),
    lat: latitude,
    lon: longitude,
    altitudeM: altitude ?? null,
    accuracyM: accuracy ?? null,
    utmZone: utm.zone,
    utmBand: utm.band,
    easting: utm.easting,
    northing: utm.northing,
    timestamp: new Date().toISOString(),
  };
  waypoints.push(wp);
  saveWaypoints();
  // Use vector-friendly circle marker so leaflet-image captures it
  L.circleMarker([wp.lat, wp.lon], { radius: 5, color: '#ff3b30', weight: 2, fillColor: '#ff3b30', fillOpacity: 0.6 }).addTo(map);
  renderWaypointList();
  hapticBeep();
}

function redCrossIcon() {
  // Simple red cross using a divIcon
  return L.divIcon({
    className: 'wp-cross',
    html: '<div style="position:relative;width:14px;height:14px;">\
            <div style="position:absolute;left:6px;top:0;width:2px;height:14px;background:#ff3b30;"></div>\
            <div style="position:absolute;left:0;top:6px;width:14px;height:2px;background:#ff3b30;"></div>\
          </div>',
    iconSize: [14, 14],
    iconAnchor: [7, 7]
  });
}

function renderWaypointList() {
  const ul = document.getElementById('waypoint-list');
  ul.innerHTML = '';
  waypoints.slice().reverse().forEach((w) => {
    const li = document.createElement('li');
    const left = document.createElement('div');
    left.textContent = `${w.utmZone}${w.utmBand} ${w.easting} ${w.northing}`;
    left.style.fontFamily = 'IBM Plex Mono, monospace';
    const right = document.createElement('div');
    const btn = document.createElement('button');
    btn.className = 'btn';
    btn.textContent = 'Zoom';
    btn.onclick = () => map.setView([w.lat, w.lon], 18);
    right.appendChild(btn);
    const nav = document.createElement('button');
    nav.className = 'btn';
    nav.textContent = 'ناوبری';
    nav.onclick = () => { setNavTarget(w.id); toast('ناوبری به نقطه فعال شد', 'success'); };
    right.appendChild(nav);
    const del = document.createElement('button');
    del.className = 'btn';
    del.textContent = 'حذف';
    del.onclick = () => { waypoints = waypoints.filter(x => x.id !== w.id); saveWaypoints(); renderWaypointList(); };
    right.appendChild(del);
    li.appendChild(left); li.appendChild(right);
    ul.appendChild(li);
  });
}

function saveWaypoints() {
  try { localStorage.setItem(WAYPOINTS_KEY, JSON.stringify(waypoints)); } catch {}
}

function loadWaypoints() {
  try {
    const s = localStorage.getItem(WAYPOINTS_KEY);
    if (!s) return;
    waypoints = JSON.parse(s) || [];
    for (const w of waypoints) {
      L.circleMarker([w.lat, w.lon], { radius: 5, color: '#ff3b30', weight: 2, fillColor: '#ff3b30', fillOpacity: 0.6 }).addTo(map);
    }
    renderWaypointList();
  } catch {}
}

function exportGPX() {
  const header = `<?xml version="1.0" encoding="UTF-8"?><gpx version="1.1" creator="FieldGPS" xmlns="http://www.topografix.com/GPX/1/1">`;
  const pts = waypoints.map(w => `<wpt lat="${w.lat}" lon="${w.lon}"><time>${w.timestamp}</time><name>${w.id}</name></wpt>`).join('');
  const trkpts = trackCoords.map(([lat, lon]) => `<trkpt lat="${lat}" lon="${lon}"></trkpt>`).join('');
  const trk = trackCoords.length ? `<trk><name>track</name><trkseg>${trkpts}</trkseg></trk>` : '';
  const xml = `${header}${pts}${trk}</gpx>`;
  downloadText('track.gpx', xml, 'application/gpx+xml');
}

function exportKML() {
  const header = `<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document>`;
  const pts = waypoints.map(w => `<Placemark><name>${w.id}</name><Point><coordinates>${w.lon},${w.lat},${w.altitudeM ?? 0}</coordinates></Point></Placemark>`).join('');
  const line = trackCoords.length ? `<Placemark><name>track</name><LineString><coordinates>${trackCoords.map(([lat, lon]) => `${lon},${lat},0`).join(' ')}</coordinates></LineString></Placemark>` : '';
  const xml = `${header}${pts}${line}</Document></kml>`;
  downloadText('track.kml', xml, 'application/vnd.google-earth.kml+xml');
}

function exportDXF() {
  // Minimal DXF R12 with POINTs for waypoints and a LWPOLYLINE for track
  const header = [
    '0','SECTION','2','HEADER','0','ENDSEC',
    '0','SECTION','2','TABLES','0','ENDSEC',
    '0','SECTION','2','ENTITIES'
  ];
  const ents = [];
  // Waypoints as POINT on layer WAYPOINTS
  for (const w of waypoints) {
    ents.push('0','POINT','8','WAYPOINTS','10',String(w.lon),'20',String(w.lat),'30',String(w.altitudeM ?? 0));
  }
  // Track as LWPOLYLINE on layer TRACK (lon/lat space)
  if (trackCoords.length > 1) {
    ents.push('0','LWPOLYLINE','8','TRACK','90',String(trackCoords.length),'70','0');
    for (const [lat, lon] of trackCoords) {
      ents.push('10',String(lon),'20',String(lat));
    }
  }
  const footer = ['0','ENDSEC','0','EOF'];
  const dxf = [...header, ...ents, ...footer].join('\n');
  downloadText('data.dxf', dxf, 'image/vnd.dxf');
}

function exportDXFDrawings() {
  // Gather polylines/polygons from drawnItems and export as DXF (lat/lon space)
  const header = [
    '0','SECTION','2','HEADER','0','ENDSEC',
    '0','SECTION','2','TABLES','0','ENDSEC',
    '0','SECTION','2','ENTITIES'
  ];
  const ents = [];
  drawnItems.eachLayer((layer) => {
    if (layer instanceof L.Polyline && !(layer instanceof L.Polygon)) {
      const pts = layer.getLatLngs();
      ents.push('0','LWPOLYLINE','8','DRAWINGS','90',String(pts.length),'70','0');
      for (const ll of pts) { ents.push('10',String(ll.lng),'20',String(ll.lat)); }
    }
    if (layer instanceof L.Polygon) {
      const rings = layer.getLatLngs();
      const flat = Array.isArray(rings[0]) ? rings[0] : rings;
      ents.push('0','LWPOLYLINE','8','DRAWINGS','90',String(flat.length + 1),'70','1');
      for (const ll of flat) { ents.push('10',String(ll.lng),'20',String(ll.lat)); }
      const first = flat[0]; ents.push('10',String(first.lng),'20',String(first.lat));
    }
  });
  const footer = ['0','ENDSEC','0','EOF'];
  const dxf = [...header, ...ents, ...footer].join('\n');
  downloadText('drawings.dxf', dxf, 'image/vnd.dxf');
}

async function shareFilesIfSupported() {
  if (!('canShare' in navigator) || !('share' in navigator)) return;
  // Prepare a small GPX Blob as example
  const header = `<?xml version="1.0" encoding="UTF-8"?><gpx version="1.1" creator="FieldGPS" xmlns="http://www.topografix.com/GPX/1/1">`;
  const pts = waypoints.map(w => `<wpt lat=\"${w.lat}\" lon=\"${w.lon}\"><time>${w.timestamp}</time><name>${w.id}</name></wpt>`).join('');
  const xml = `${header}${pts}</gpx>`;
  const file = new File([xml], 'points.gpx', { type: 'application/gpx+xml' });
  if (navigator.canShare({ files: [file] })) {
    await navigator.share({ files: [file], title: 'Field GPS', text: 'Waypoints' });
  }
}

function downloadText(filename, text, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

function onImportFile(ev) {
  const file = ev.target.files[0]; if (!file) return;
  const name = file.name.toLowerCase();
  const reader = new FileReader();
  reader.onload = () => {
    const text = reader.result;
    try {
      if (name.endsWith('.gpx')) importGPX(text);
      else if (name.endsWith('.kml')) importKML(text);
      toast('داده وارد شد', 'success');
    } catch (e) { console.warn(e); toast('خطا در ورود فایل', 'error'); }
  };
  reader.readAsText(file);
}

function importGPX(xml) {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const wpts = Array.from(doc.getElementsByTagName('wpt'));
  for (const w of wpts) {
    const lat = parseFloat(w.getAttribute('lat')); const lon = parseFloat(w.getAttribute('lon'));
    if (Number.isFinite(lat) && Number.isFinite(lon)) { addWaypointRaw(lat, lon, null); }
  }
  const trkpts = Array.from(doc.getElementsByTagName('trkpt')).map(n => [parseFloat(n.getAttribute('lat')), parseFloat(n.getAttribute('lon'))]).filter(p => Number.isFinite(p[0]) && Number.isFinite(p[1]));
  if (trkpts.length) { trackCoords = trkpts; trailLine.setLatLngs(trkpts); }
}

function importKML(xml) {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const points = Array.from(doc.getElementsByTagName('Point'));
  for (const p of points) {
    const coords = p.getElementsByTagName('coordinates')[0]?.textContent?.trim();
    if (!coords) continue; const [lon, lat] = coords.split(',').map(Number);
    if (Number.isFinite(lat) && Number.isFinite(lon)) { addWaypointRaw(lat, lon, null); }
  }
  const lines = Array.from(doc.getElementsByTagName('LineString'));
  for (const l of lines) {
    const coordsStr = l.getElementsByTagName('coordinates')[0]?.textContent?.trim();
    if (!coordsStr) continue;
    const pts = coordsStr.split(/\s+/).map(s => s.split(',').map(Number)).map(([lon, lat]) => [lat, lon]).filter(p => Number.isFinite(p[0]) && Number.isFinite(p[1]));
    if (pts.length) { trackCoords = pts; trailLine.setLatLngs(pts); }
  }
}

function addWaypointRaw(lat, lon, alt) {
  const utm = toUtm(lat, lon);
  const wp = { id: Date.now().toString() + Math.random().toString(36).slice(2,6), lat, lon, altitudeM: alt ?? null, accuracyM: null, utmZone: utm.zone, utmBand: utm.band, easting: utm.easting, northing: utm.northing, timestamp: new Date().toISOString() };
  waypoints.push(wp); saveWaypoints(); L.circleMarker([lat, lon], { radius: 5, color: '#ff3b30', weight: 2, fillColor: '#ff3b30', fillOpacity: 0.6 }).addTo(map); renderWaypointList();
}

function setNavTarget(target) {
  // target can be a waypoint id or an object {lat, lon, label}
  if (typeof target === 'string') {
    const w = waypoints.find(x => x.id === target);
    navTarget = w ? { lat: w.lat, lon: w.lon, label: w.id } : null;
  } else {
    navTarget = target;
  }
  if (navLine) { map.removeLayer(navLine); navLine = null; }
}

function updateNavigationOverlay(lat, lon) {
  const el = document.getElementById('nav-overlay'); if (!el) return;
  if (!navTarget) { el.classList.add('hidden'); if (navLine) { map.removeLayer(navLine); navLine = null; } return; }
  const target = navTarget;
  const from = turf.point([lon, lat]); const to = turf.point([target.lon, target.lat]);
  const d = turf.distance(from, to, { units: 'meters' });
  const b = (turf.bearing(from, to) + 360) % 360;
  const label = target.label || 'هدف';
  el.textContent = `${label}\nفاصله: ${d.toFixed(1)} m\nسمت: ${b.toFixed(0)}°`;
  el.classList.remove('hidden');
  if (!navLine) navLine = L.polyline([], { color: '#c3ff00', dashArray: '6,6' }).addTo(map);
  navLine.setLatLngs([[lat, lon], [target.lat, target.lon]]);
}

function onGotoUtmSubmit() {
  const zone = parseInt(document.getElementById('utm-zone').value);
  const band = (document.getElementById('utm-band').value || '').toUpperCase();
  const easting = parseFloat(document.getElementById('utm-easting').value);
  const northing = parseFloat(document.getElementById('utm-northing').value);
  if (!Number.isFinite(zone) || !Number.isFinite(easting) || !Number.isFinite(northing)) { toast('ورودی نامعتبر', 'error'); return; }
  // Build UTM projection string
  const isNorthern = band ? (band >= 'N') : true; // heuristic
  const utmProj = `+proj=utm +zone=${zone} ${isNorthern ? '+north' : '+south'} +datum=WGS84 +units=m +no_defs`;
  const inv = proj4(utmProj, 'EPSG:4326');
  const [lon, lat] = inv.inverse ? inv.inverse([easting, northing]) : inv.backward([easting, northing]);
  // Create a temp waypoint and navigate
  const temp = { lat, lon, label: `UTM ${zone}${band} ${easting} ${northing}` };
  setNavTarget(temp);
  // Not storing as permanent waypoint; draw a marker for context
  const marker = L.circleMarker([lat, lon], { radius: 6, color: '#c3ff00', weight: 2, fillColor: '#c3ff00', fillOpacity: 0.3 }).addTo(map);
  // Update overlay using current location in onPosition; also force immediate view to target
  map.setView([lat, lon], 17);
  const el = document.getElementById('nav-overlay'); if (el) { el.classList.remove('hidden'); el.textContent = `هدف UTM\n${zone}${band} ${easting} ${northing}`; }
  document.getElementById('dlg-goto').close();
}

function openWaypointsDialog() {
  document.getElementById('dlg-waypoints').showModal();
}

function closeWaypointsDialog() {
  document.getElementById('dlg-waypoints').close();
}

function openA4Preview() {
  // Render Leaflet snapshot then write to an A4 canvas with decorations
  const canvas = document.getElementById('a4-canvas');
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  leafletImage(map, function(err, mapCanvas) {
    if (err) { console.error(err); return; }
    // Fit map image into A4 with margins
    const margin = 60;
    const targetW = canvas.width - margin * 2;
    const targetH = canvas.height - margin * 2 - 140; // space for footer
    const scale = Math.min(targetW / mapCanvas.width, targetH / mapCanvas.height);
    const drawW = Math.floor(mapCanvas.width * scale);
    const drawH = Math.floor(mapCanvas.height * scale);
    const dx = Math.floor((canvas.width - drawW) / 2);
    const dy = margin;

    ctx.drawImage(mapCanvas, dx, dy, drawW, drawH);

    // Header
    ctx.fillStyle = '#0b1d14';
    ctx.fillRect(0, 0, canvas.width, 48);
    ctx.fillStyle = '#a6ff00';
    ctx.font = 'bold 20px Barlow, Arial';
    ctx.fillText('FIELD GPS — A4 Map Sheet', margin, 32);

    // Footer info: UTM/LatLon/time
    ctx.fillStyle = '#0b1d14';
    ctx.fillRect(0, canvas.height - 100, canvas.width, 100);
    ctx.fillStyle = '#a6ff00';
    ctx.font = '16px IBM Plex Mono, monospace';
    if (lastPosition) {
      const { latitude, longitude } = lastPosition.coords;
      const utm = toUtm(latitude, longitude);
      ctx.fillText(`Center: UTM ${utm.zone}${utm.band} ${utm.easting} ${utm.northing}`, margin, canvas.height - 64);
      ctx.fillText(`Center: Lat/Lon ${latitude.toFixed(6)}, ${longitude.toFixed(6)}`, margin, canvas.height - 40);
    }
    ctx.fillText(`Generated: ${new Date().toLocaleString()}`, margin, canvas.height - 16);

    // Simple north arrow
    drawNorthArrow(ctx, canvas.width - margin - 40, canvas.height - 60);

    // Scale bar (approx, based on current zoom metersPerPixel)
    drawScaleBar(ctx, dx, dy + drawH + 16, drawW);

    document.getElementById('dlg-a4').showModal();
  });
}

function drawNorthArrow(ctx, x, y) {
  ctx.save();
  ctx.fillStyle = '#a6ff00';
  ctx.beginPath();
  ctx.moveTo(x, y - 30); ctx.lineTo(x - 10, y + 10); ctx.lineTo(x + 10, y + 10); ctx.closePath();
  ctx.fill();
  ctx.font = 'bold 12px Arial';
  ctx.fillText('N', x - 6, y + 24);
  ctx.restore();
}

function drawScaleBar(ctx, x, y, width) {
  // Estimate meters per pixel using Leaflet CRS helpers
  const centerLat = map.getCenter().lat;
  const metersPerPixel = 156543.03392 * Math.cos(centerLat * Math.PI / 180) / Math.pow(2, map.getZoom());
  let targetMeters = 100; // start at 100 m
  const maxPx = Math.min(200, width * 0.25);
  while ((targetMeters / metersPerPixel) > maxPx) targetMeters /= 2;
  while ((targetMeters / metersPerPixel) < (maxPx / 2)) targetMeters *= 2;
  const px = targetMeters / metersPerPixel;
  ctx.save();
  ctx.strokeStyle = '#0b1d14'; ctx.lineWidth = 10; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + px, y); ctx.stroke();
  ctx.strokeStyle = '#a6ff00'; ctx.lineWidth = 4; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + px, y); ctx.stroke();
  ctx.fillStyle = '#0b1d14'; ctx.fillRect(x, y - 10, 2, 20); ctx.fillRect(x + px - 2, y - 10, 2, 20);
  ctx.fillStyle = '#a6ff00'; ctx.font = '14px IBM Plex Mono, monospace'; ctx.fillText(`${Math.round(targetMeters)} m`, x + 6, y - 8);
  ctx.restore();
}

function downloadA4Png() {
  const canvas = document.getElementById('a4-canvas');
  const url = canvas.toDataURL('image/png');
  const a = document.createElement('a');
  a.href = url; a.download = 'map-a4.png'; a.click();
}

function initUI() {
  // Motion/compass permission (Android Chrome requires user gesture)
  const btnCompass = document.getElementById('btn-compass-perm');
  if (btnCompass) {
    btnCompass.onclick = async () => {
      try {
        if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
          const res = await DeviceOrientationEvent.requestPermission();
          if (res !== 'granted') return;
        }
        window.addEventListener('deviceorientationabsolute', onOrientation, true);
        window.addEventListener('deviceorientation', onOrientation, true);
      } catch (e) { console.warn(e); }
    };
  }
  document.getElementById('btn-mark').onclick = addWaypointFromCurrent;
  document.getElementById('btn-draw').onclick = () => {
    // Toggle draw polyline as default
    new L.Draw.Polyline(map, draw.options.draw.polyline).enable();
  };
  document.getElementById('btn-waypoints').onclick = () => { openWaypointsDialog(); };
  document.getElementById('btn-print').onclick = openA4Preview;
  document.getElementById('download-image').onclick = downloadA4Png;
  document.getElementById('close-waypoints').onclick = closeWaypointsDialog;
  document.getElementById('close-a4').onclick = () => document.getElementById('dlg-a4').close();

  document.getElementById('export-gpx').onclick = exportGPX;
  document.getElementById('export-kml').onclick = exportKML;
  const btnDXF = document.getElementById('export-dxf'); if (btnDXF) btnDXF.onclick = exportDXF;
  const btnDXFDraw = document.getElementById('export-dxf-drawings'); if (btnDXFDraw) btnDXFDraw.onclick = exportDXFDrawings;
  const btnShare = document.getElementById('share-files'); if (btnShare) btnShare.onclick = shareFilesIfSupported;
  const btnImport = document.getElementById('import-data'); const inputImport = document.getElementById('import-file');
  if (btnImport && inputImport) { btnImport.onclick = () => inputImport.click(); inputImport.onchange = onImportFile; }

  window.addEventListener('online', setOnlineStatus);
  window.addEventListener('offline', setOnlineStatus);
  setOnlineStatus();

  // Offline toggle
  const toggle = document.getElementById('toggle-offline');
  if (toggle) toggle.onclick = () => {
    useOffline = !useOffline;
    toggle.textContent = useOffline ? 'آنلاین' : 'حالت آفلاین';
    if (useOffline && offlineLayer) {
      offlineLayer.addTo(map);
    } else if (offlineLayer) {
      map.removeLayer(offlineLayer);
    }
  };

  // MBTiles input
  const fileInput = document.getElementById('mbtiles-input');
  if (fileInput) fileInput.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    await ensureSqlLoaded();
    const buf = await file.arrayBuffer();
    mbtilesDb = new SQL.Database(new Uint8Array(buf));
    offlineLayer = createMbtilesLayer(mbtilesDb);
    if (useOffline) offlineLayer.addTo(map);
  };

  // Register service worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./service-worker.js').catch(console.warn);
  }
  // Track toggle
  const btnTrack = document.getElementById('toggle-track');
  if (btnTrack) btnTrack.onclick = () => { trackingEnabled = !trackingEnabled; btnTrack.textContent = trackingEnabled ? 'ثبت مسیر' : 'توقف مسیر'; toast(trackingEnabled ? 'ثبت مسیر فعال' : 'ثبت مسیر متوقف شد', 'success'); };
  // Follow toggle
  const btnFollow = document.getElementById('toggle-follow');
  if (btnFollow) btnFollow.onclick = () => { followMode = !followMode; btnFollow.textContent = followMode ? 'خاموش کردن دنبال' : 'دنبال نقشه'; };
  // Clear navigation
  const btnClearNav = document.getElementById('clear-nav');
  if (btnClearNav) btnClearNav.onclick = () => { setNavTarget(null); toast('ناوبری لغو شد', 'success'); };

  // Go to UTM modal
  const btnGoto = document.getElementById('btn-goto-utm');
  const dlgGoto = document.getElementById('dlg-goto');
  const closeGoto = document.getElementById('close-goto');
  const gotoSubmit = document.getElementById('goto-submit');
  if (btnGoto) btnGoto.onclick = () => dlgGoto.showModal();
  if (closeGoto) closeGoto.onclick = () => dlgGoto.close();
  if (gotoSubmit) gotoSubmit.onclick = onGotoUtmSubmit;
  const q39 = document.getElementById('utm-quick-39'); if (q39) q39.onclick = () => { document.getElementById('utm-zone').value = 39; };
  const q40 = document.getElementById('utm-quick-40'); if (q40) q40.onclick = () => { document.getElementById('utm-zone').value = 40; };

  // Ripple effect delegation for all .btn
  document.body.addEventListener('click', (e) => {
    const target = e.target.closest('.btn');
    if (!target) return;
    const rect = target.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const span = document.createElement('span');
    span.className = 'ripple';
    span.style.left = x + 'px';
    span.style.top = y + 'px';
    target.appendChild(span);
    setTimeout(() => span.remove(), 650);
  }, true);
  // Settings modal
  const settingsBtn = document.getElementById('btn-settings');
  const dlgSettings = document.getElementById('dlg-settings');
  const closeSettings = document.getElementById('close-settings');
  const inputAcc = document.getElementById('set-max-acc');
  const valAcc = document.getElementById('set-max-acc-val');
  const inputRad = document.getElementById('set-alert-radius');
  const valRad = document.getElementById('set-alert-radius-val');
  const saveSettings = document.getElementById('save-settings');
  loadSettings();
  updateSettingsUI();
  if (settingsBtn) settingsBtn.onclick = () => dlgSettings.showModal();
  if (closeSettings) closeSettings.onclick = () => dlgSettings.close();
  function updateSettingsUI() {
    inputAcc.value = settings.maxAccM; valAcc.textContent = settings.maxAccM + ' m';
    inputRad.value = settings.alertRadiusM; valRad.textContent = settings.alertRadiusM + ' m';
  }
  function readSettingsUI() {
    settings.maxAccM = parseInt(inputAcc.value);
    settings.alertRadiusM = parseInt(inputRad.value);
  }
  inputAcc.oninput = () => { valAcc.textContent = inputAcc.value + ' m'; };
  inputRad.oninput = () => { valRad.textContent = inputRad.value + ' m'; };
  saveSettings.onclick = () => { readSettingsUI(); saveSettingsLocal(); dlgSettings.close(); toast('ذخیره شد', 'success'); };

  // Quick measure via long press
  let pressTimer = null, pressStartLatLng = null, measureLine = null;
  map.on('mousedown touchstart', (e) => {
    pressStartLatLng = e.latlng;
    pressTimer = setTimeout(() => {
      if (!pressStartLatLng) return;
      if (measureLine) map.removeLayer(measureLine);
      measureLine = L.polyline([pressStartLatLng], { color: '#a6ff00', dashArray: '4,6' }).addTo(map);
      toast('اندازه‌گیری سریع: نقطه دوم را لمس کنید', 'warn');
      const move = (ev) => { if (measureLine) measureLine.setLatLngs([pressStartLatLng, ev.latlng]); };
      const end = (ev) => {
        map.off('mousemove', move); map.off('touchmove', move); map.off('mouseup', end); map.off('touchend', end);
        if (measureLine) {
          const pts = measureLine.getLatLngs();
          if (pts.length >= 2) {
            const line = turf.lineString(pts.map(ll => [ll.lng, ll.lat]));
            const m = turf.length(line, { units: 'kilometers' }) * 1000;
            toast(`طول: ${m.toFixed(1)} m`, 'success');
          }
          setTimeout(() => { map.removeLayer(measureLine); measureLine = null; }, 800);
        }
      };
      map.on('mousemove', move); map.on('touchmove', move); map.on('mouseup', end); map.on('touchend', end);
    }, 550);
  });
  map.on('mouseup touchend', () => { clearTimeout(pressTimer); pressTimer = null; pressStartLatLng = null; });
}

window.addEventListener('load', () => {
  initMap();
  initUI();
  loadWaypoints();
  requestHighAccuracyPosition();
  generateIconsAndSwapManifest();
});

async function ensureSqlLoaded() {
  if (SQL) return SQL;
  SQL = await window.initSqlJs({ locateFile: file => `https://cdn.jsdelivr.net/npm/sql.js@1.10.2/dist/${file}` });
  return SQL;
}

function createMbtilesLayer(db) {
  const stmt = db.prepare('SELECT value FROM metadata WHERE name = ?');
  let minzoom = 0, maxzoom = 14;
  try {
    stmt.bind(['minzoom']); if (stmt.step()) minzoom = parseInt(stmt.get()[0]); stmt.reset();
    stmt.bind(['maxzoom']); if (stmt.step()) maxzoom = parseInt(stmt.get()[0]);
  } catch {}
  stmt.free();

  const layer = L.gridLayer({ minZoom: minzoom, maxZoom: maxzoom });
  layer.createTile = function(coords) {
    const tile = document.createElement('img');
    tile.alt = '';
    const png = getTilePng(db, coords.z, coords.x, coords.y);
    if (png) {
      const blob = new Blob([png], { type: 'image/png' });
      tile.src = URL.createObjectURL(blob);
    } else {
      // empty tile
      tile.src = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/ctQ3O0AAAAASUVORK5CYII=';
    }
    return tile;
  };
  return layer;
}

function tmsToZxyY(z, x, yTms) {
  const y = Math.pow(2, z) - 1 - yTms; // TMS → XYZ
  return { z, x, y };
}

function getTilePng(db, z, x, y) {
  // MBTiles stores TMS y
  const yTms = Math.pow(2, z) - 1 - y;
  const stmt = db.prepare('SELECT tile_data FROM tiles WHERE zoom_level=? AND tile_column=? AND tile_row=?');
  stmt.bind([z, x, yTms]);
  let data = null;
  if (stmt.step()) {
    const val = stmt.getAsObject().tile_data; // Uint8Array
    data = val;
  }
  stmt.free();
  return data;
}

function loadSettings() {
  try { const s = localStorage.getItem(SETTINGS_KEY); if (s) settings = JSON.parse(s); } catch {}
}
function saveSettingsLocal() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch {}
}

function renderSparkline() {
  const c = document.getElementById('sparkline'); if (!c) return;
  const ctx = c.getContext('2d');
  ctx.clearRect(0,0,c.width,c.height);
  // Draw speed (green) and altitude (yellow-green)
  drawSeries(ctx, speedHistory, '#00d46a');
  drawSeries(ctx, normalizeSeries(altHistory), '#c3ff00');
}

function drawSeries(ctx, series, color) {
  if (!series.length) return;
  const w = ctx.canvas.width, h = ctx.canvas.height;
  const max = Math.max(...series);
  const min = Math.min(...series);
  const dx = series.length > 1 ? (w / (series.length - 1)) : w;
  ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.beginPath();
  series.forEach((v, i) => {
    const x = i * dx;
    const t = max === min ? 0.5 : (v - min) / (max - min);
    const y = h - t * (h - 6) - 3;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();
}

function normalizeSeries(series) {
  if (!series.length) return series;
  const max = Math.max(...series), min = Math.min(...series);
  if (max === min) return series.map(() => 0.5);
  return series.map(v => (v - min) / (max - min));
}

function checkProximityAlerts(lat, lon) {
  if (!waypoints.length) return;
  let nearest = null; let nearestD = Infinity;
  for (const w of waypoints) {
    const d = turf.distance([lon, lat], [w.lon, w.lat], { units: 'meters' });
    if (d < nearestD) { nearest = w; nearestD = d; }
  }
  if (nearest && nearestD <= settings.alertRadiusM) {
    toast(`نزدیک نقطه ${nearest.id} — ${nearestD.toFixed(1)} m`, 'warn');
  }
}

function toast(message, type = 'success') {
  const box = document.getElementById('toasts'); if (!box) return;
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  box.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transform = 'translateY(10px)'; setTimeout(() => el.remove(), 250); }, 2200);
}

// Generate PNG icons and swap manifest + apple-touch-icon at runtime
async function generateIconsAndSwapManifest() {
  try {
    const icon512 = await drawIconPng(512);
    const icon192 = await drawIconPng(192);

    // Swap manifest
    const manifest = {
      name: 'جی‌پی‌اس میدانی',
      short_name: 'GPS Field',
      start_url: '.',
      display: 'standalone',
      background_color: '#0B1D14',
      theme_color: '#0B1D14',
      dir: 'rtl',
      lang: 'fa',
      icons: [
        { src: icon192, sizes: '192x192', type: 'image/png' },
        { src: icon512, sizes: '512x512', type: 'image/png' },
      ]
    };
    const blob = new Blob([JSON.stringify(manifest)], { type: 'application/manifest+json' });
    let link = document.querySelector('link[rel="manifest"]');
    if (!link) {
      link = document.createElement('link');
      link.rel = 'manifest';
      document.head.appendChild(link);
    }
    link.href = URL.createObjectURL(blob);

    // Apple touch icon
    let apple = document.querySelector('link[rel="apple-touch-icon"]');
    if (!apple) {
      apple = document.createElement('link');
      apple.rel = 'apple-touch-icon';
      document.head.appendChild(apple);
    }
    apple.href = icon192;
  } catch (e) { console.warn('icon gen failed', e); }
}

function drawIconPng(size) {
  return new Promise((resolve) => {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d');
    // background gradient
    const g = ctx.createLinearGradient(0, 0, 0, size);
    g.addColorStop(0, '#0B1D14');
    g.addColorStop(1, '#0a110d');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    // rounded mask
    const radius = size * 0.12;
    ctx.globalCompositeOperation = 'destination-in';
    ctx.beginPath();
    roundRectPath(ctx, 0, 0, size, size, radius);
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
    // ring
    ctx.strokeStyle = '#556B2F';
    ctx.lineWidth = Math.max(6, size * 0.03);
    ctx.beginPath();
    ctx.arc(size/2, size/2, size*0.35, 0, Math.PI*2);
    ctx.stroke();
    // crosshairs
    ctx.strokeStyle = '#A6FF00';
    ctx.lineWidth = Math.max(8, size * 0.035);
    ctx.beginPath();
    ctx.moveTo(size/2, size*0.18); ctx.lineTo(size/2, size*0.34);
    ctx.moveTo(size/2, size*0.66); ctx.lineTo(size/2, size*0.82);
    ctx.moveTo(size*0.18, size/2); ctx.lineTo(size*0.34, size/2);
    ctx.moveTo(size*0.66, size/2); ctx.lineTo(size*0.82, size/2);
    ctx.stroke();
    // center dot
    ctx.fillStyle = '#A6FF00';
    ctx.beginPath(); ctx.arc(size/2, size/2, Math.max(3, size*0.012), 0, Math.PI*2); ctx.fill();
    // text GPS
    ctx.fillStyle = '#C3FF00';
    ctx.font = `bold ${Math.floor(size*0.16)}px Arial`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    ctx.fillText('GPS', size/2, size*0.92);
    resolve(c.toDataURL('image/png'));
  });
}

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
}

// Device orientation to update compass heading when GPS heading is absent
function onOrientation(ev) {
  let deg = null;
  if (ev.absolute && typeof ev.alpha === 'number') deg = 360 - ev.alpha; // alpha: 0 = north
  else if (typeof ev.webkitCompassHeading === 'number') deg = ev.webkitCompassHeading; // iOS
  if (deg != null && !Number.isNaN(deg)) setHeading((deg + 360) % 360);
}

// Haptics and beep
function hapticBeep() {
  try { if (navigator.vibrate) navigator.vibrate(50); } catch {}
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'square';
    osc.frequency.value = 1000;
    osc.connect(gain); gain.connect(ctx.destination);
    gain.gain.setValueAtTime(0.05, ctx.currentTime);
    osc.start();
    setTimeout(() => { osc.stop(); ctx.close(); }, 120);
  } catch {}
}

